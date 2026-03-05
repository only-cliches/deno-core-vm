use deno_runtime::deno_core::v8;
use deno_runtime::worker::MainWorker;
use neon::prelude::*;
use tokio::sync::mpsc;
use bytes::Bytes;

use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::worker::eval::eval_in_runtime;
use crate::worker::messages::{DenoMsg, EvalReply, ExecStats, NodeMsg, ResolvePayload};
use crate::worker::state::RuntimeLimits;

/// Handle deno msg.
pub async fn handle_deno_msg(
    worker: &mut MainWorker,
    worker_id: usize,
    limits: &RuntimeLimits,
    msg: DenoMsg,
) -> bool {
    // Return true only for terminal/close path; false keeps event loop running.
    match msg {
        DenoMsg::Close { deferred } => handle_close_msg(worker_id, deferred),
        DenoMsg::Memory { deferred } => handle_memory_msg(worker, worker_id, deferred).await,
        DenoMsg::PostMessage { value } => handle_post_message_msg(worker, value),
        DenoMsg::PostMessageTyped {
            message_type,
            id,
            payload,
        } => handle_post_message_typed_msg(worker, message_type, id, payload),
        DenoMsg::PostStreamChunk { stream_id, payload } => {
            handle_post_stream_chunk_msg(worker, stream_id, payload)
        }
        DenoMsg::PostStreamChunkRaw {
            stream_id,
            payload,
            credit,
        } => handle_post_stream_chunk_raw_msg(worker, stream_id, payload, credit),
        DenoMsg::PostStreamChunks { stream_id, payloads } => {
            handle_post_stream_chunks_msg(worker, stream_id, payloads)
        }
        DenoMsg::PostStreamChunksRaw { stream_id, payload } => {
            handle_post_stream_chunks_raw_msg(worker, stream_id, payload)
        }
        DenoMsg::PostStreamControl {
            kind,
            stream_id,
            aux,
        } => handle_post_stream_control_msg(worker, kind, stream_id, aux),
        DenoMsg::SetGlobal {
            key,
            value,
            deferred,
        } => handle_set_global_msg(worker, worker_id, key, value, deferred).await,
        DenoMsg::Eval {
            source,
            options,
            deferred,
            sync_reply,
        } => {
            handle_eval_msg(
                worker, worker_id, limits, source, options, deferred, sync_reply,
            )
            .await
        }
    }
}

fn payload_to_chunk_bytes(payload: &JsValueBridge) -> Option<&[u8]> {
    let JsValueBridge::BufferView {
        bytes,
        byte_offset,
        length,
        ..
    } = payload
    else {
        return None;
    };
    let start = (*byte_offset).min(bytes.len());
    let end = start.checked_add(*length)?.min(bytes.len());
    Some(&bytes.as_ref()[start..end])
}

// Handle close msg.
fn handle_close_msg(worker_id: usize, deferred: crate::bridge::promise::PromiseSettler) -> bool {
    deferred.resolve_with_value_via_channel(JsValueBridge::Undefined);

    if let Ok(map) = crate::WORKERS.read() {
        if let Some(w) = map.get(&worker_id) {
            w.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    // Prefer routing close through NodeMsg so it runs on Neon callback thread.
    // Fallback to direct channel callback if node_tx is gone/full.
    let mut try_direct_cleanup = false;

    if let Some(tx) = get_node_tx(worker_id) {
        if tx.try_send(NodeMsg::EmitClose).is_err() {
            try_direct_cleanup = true;
        }
    } else {
        try_direct_cleanup = true;
    }

    if try_direct_cleanup {
        let (channel, on_close_cb_opt) = match crate::WORKERS.read() {
            Ok(map) => {
                if let Some(w) = map.get(&worker_id) {
                    (w.channel.clone(), w.callbacks.on_close.clone())
                } else {
                    return true;
                }
            }
            Err(_) => return true,
        };

        let wid = worker_id;
        if channel
            .try_send(move |mut cx| {
                if let Some(cb_arc) = on_close_cb_opt.as_ref() {
                    let cb = cb_arc.to_inner(&mut cx);
                    let this = cx.undefined();
                    let _ = cb.call(&mut cx, this, &[]);
                }

            if let Ok(mut map) = crate::WORKERS.write() {
                let _ = map.remove(&wid);
            }

                Ok(())
            })
            .is_err()
        {
            if let Ok(mut map) = crate::WORKERS.write() {
                let _ = map.remove(&wid);
            }
        }
    }

    true
}

// Handle memory msg.
async fn handle_memory_msg(
    worker: &mut MainWorker,
    worker_id: usize,
    deferred: crate::bridge::promise::PromiseSettler,
) -> bool {
    let mem = {
        let isolate = worker.js_runtime.v8_isolate();
        let hs = isolate.get_heap_statistics();

        serde_json::json!({
            "ok": true,
            "heapStatistics": heap_stats_to_json(&hs),
            "heapSpaceStatistics": heap_space_stats_to_json(isolate),
        })
    };

    if let Some(tx) = get_node_tx(worker_id) {
        send_node_msg_or_reject(
            &tx,
            NodeMsg::Resolve {
                settler: deferred,
                payload: ResolvePayload::Json(mem),
            },
        )
        .await;
    } else {
        deferred.reject_with_error("Node thread is unavailable");
    }

    false
}

// Handle post message msg.
fn handle_post_message_msg(worker: &mut MainWorker, value: JsValueBridge) -> bool {
    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeMessage") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };

        let Ok(arg) = crate::bridge::v8_codec::to_v8(scope, &value) else {
            return false;
        };

        dispatch_fn.call(scope, global.into(), &[arg]).is_some()
    };

    if !dispatched {
        // Fallback script path if direct V8 invocation fails; keeps semantics stable.
        let payload = serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
            .unwrap_or_else(|_| "null".into());
        let script = format!("globalThis.__dispatchNodeMessage(globalThis.__hydrate({payload}))");
        let _ = worker.js_runtime.execute_script("<postMessage>", script);
    }
    false
}

// Handle post message typed msg.
fn handle_post_message_typed_msg(
    worker: &mut MainWorker,
    message_type: String,
    id: u32,
    payload: JsValueBridge,
) -> bool {
    let dispatched_fast = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        if let Some(key) = v8::String::new(scope, "__dispatchNodeTypedMessage") {
            let ctx = scope.get_current_context();
            let global = ctx.global(scope);
            if let Some(fn_any) = global.get(scope, key.into()) {
                if let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) {
                    if let Some(type_val) = v8::String::new(scope, message_type.as_str()) {
                        let id_val = v8::Integer::new_from_unsigned(scope, id);
                        if let Ok(payload_val) = crate::bridge::v8_codec::to_v8(scope, &payload) {
                            let ok = dispatch_fn
                                .call(
                                    scope,
                                    global.into(),
                                    &[type_val.into(), id_val.into(), payload_val],
                                )
                                .is_some();
                            if ok {
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        }
    };
    if dispatched_fast {
        return false;
    }

    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeMessage") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };

        let msg_obj = v8::Object::new(scope);
        let Some(type_key) = v8::String::new(scope, "type") else {
            return false;
        };
        let Some(id_key) = v8::String::new(scope, "id") else {
            return false;
        };
        let Some(payload_key) = v8::String::new(scope, "payload") else {
            return false;
        };
        let Some(type_val) = v8::String::new(scope, message_type.as_str()) else {
            return false;
        };
        let id_val = v8::Integer::new_from_unsigned(scope, id);

        let Ok(payload_val) = crate::bridge::v8_codec::to_v8(scope, &payload) else {
            return false;
        };

        let _ = msg_obj.set(scope, type_key.into(), type_val.into());
        let _ = msg_obj.set(scope, id_key.into(), id_val.into());
        let _ = msg_obj.set(scope, payload_key.into(), payload_val);
        dispatch_fn.call(scope, global.into(), &[msg_obj.into()]).is_some()
    };

    if !dispatched {
        let value = JsValueBridge::Json(serde_json::json!({
            "type": message_type,
            "id": id,
            "payload": crate::bridge::wire::to_wire_json(&payload),
        }));
        return handle_post_message_msg(worker, value);
    }
    false
}

// Handle post stream chunk msg.
fn handle_post_stream_chunk_msg(
    worker: &mut MainWorker,
    stream_id: String,
    payload: JsValueBridge,
) -> bool {
    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeStreamChunk") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };
        let Some(id_val) = v8::String::new(scope, stream_id.as_str()) else {
            return false;
        };
        let Ok(payload_val) = crate::bridge::v8_codec::to_v8(scope, &payload) else {
            return false;
        };
        dispatch_fn
            .call(scope, global.into(), &[id_val.into(), payload_val])
            .is_some()
    };

    if !dispatched {
        return handle_post_message_typed_msg(
            worker,
            format!("__denojs_worker_stream_chunk_v1:{stream_id}"),
            0,
            payload,
        );
    }
    false
}

// Handle post stream chunks msg.
fn handle_post_stream_chunks_msg(
    worker: &mut MainWorker,
    stream_id: String,
    payloads: Vec<JsValueBridge>,
) -> bool {
    // Vectorize into one binary payload when all chunks are binary payloads.
    let mut merged = Vec::<u8>::new();
    let mut all_binary = !payloads.is_empty();
    for payload in &payloads {
        let Some(chunk) = payload_to_chunk_bytes(payload) else {
            all_binary = false;
            break;
        };
        merged.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
        merged.extend_from_slice(chunk);
    }
    if all_binary {
        let id_num = stream_id.parse::<u32>().unwrap_or(0);
        if id_num > 0 {
            let merged_len = merged.len();
            return handle_post_stream_chunks_raw_msg(
                worker,
                id_num,
                JsValueBridge::BufferView {
                    kind: "Uint8Array".into(),
                    bytes: Bytes::from(merged),
                    byte_offset: 0,
                    length: merged_len,
                },
            );
        }
    }

    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeStreamChunks") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };
        let Some(id_val) = v8::String::new(scope, stream_id.as_str()) else {
            return false;
        };
        let arr = v8::Array::new(scope, payloads.len() as i32);
        for (i, payload) in payloads.iter().enumerate() {
            let Ok(payload_val) = crate::bridge::v8_codec::to_v8(scope, payload) else {
                return false;
            };
            let _ = arr.set_index(scope, i as u32, payload_val);
        }
        dispatch_fn
            .call(scope, global.into(), &[id_val.into(), arr.into()])
            .is_some()
    };

    if !dispatched {
        for payload in payloads {
            let _ = handle_post_stream_chunk_msg(worker, stream_id.clone(), payload);
        }
    }
    false
}

fn handle_post_stream_chunk_raw_msg(
    worker: &mut MainWorker,
    stream_id: u32,
    payload: JsValueBridge,
    credit: Option<u32>,
) -> bool {
    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeStreamChunkRaw") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };
        let id_val = v8::Integer::new_from_unsigned(scope, stream_id);
        let Ok(payload_val) = crate::bridge::v8_codec::to_v8(scope, &payload) else {
            return false;
        };
        let credit_val: v8::Local<v8::Value> = match credit {
            Some(v) => v8::Integer::new_from_unsigned(scope, v).into(),
            None => v8::undefined(scope).into(),
        };
        dispatch_fn
            .call(scope, global.into(), &[id_val.into(), payload_val, credit_val])
            .is_some()
    };

    if !dispatched {
        return handle_post_stream_chunk_msg(worker, stream_id.to_string(), payload);
    }
    false
}

fn handle_post_stream_chunks_raw_msg(
    worker: &mut MainWorker,
    stream_id: u32,
    payload: JsValueBridge,
) -> bool {
    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeStreamChunkVectorized") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };
        let id_val = v8::Integer::new_from_unsigned(scope, stream_id);
        let Ok(payload_val) = crate::bridge::v8_codec::to_v8(scope, &payload) else {
            return false;
        };
        dispatch_fn
            .call(scope, global.into(), &[id_val.into(), payload_val])
            .is_some()
    };

    if !dispatched {
        return handle_post_stream_chunk_raw_msg(worker, stream_id, payload, None);
    }
    false
}

// Handle post stream control msg.
fn handle_post_stream_control_msg(
    worker: &mut MainWorker,
    kind: String,
    stream_id: String,
    aux: Option<String>,
) -> bool {
    let dispatched = {
        deno_core::scope!(scope, &mut worker.js_runtime);
        let Some(key) = v8::String::new(scope, "__dispatchNodeStreamControl") else {
            return false;
        };
        let ctx = scope.get_current_context();
        let global = ctx.global(scope);
        let Some(fn_any) = global.get(scope, key.into()) else {
            return false;
        };
        let Ok(dispatch_fn) = v8::Local::<v8::Function>::try_from(fn_any) else {
            return false;
        };
        let Some(kind_val) = v8::String::new(scope, kind.as_str()) else {
            return false;
        };
        let Some(id_val) = v8::String::new(scope, stream_id.as_str()) else {
            return false;
        };
        let aux_val: v8::Local<v8::Value> = if let Some(a) = aux.as_deref() {
            let Some(s) = v8::String::new(scope, a) else {
                return false;
            };
            s.into()
        } else {
            v8::undefined(scope).into()
        };
        dispatch_fn
            .call(scope, global.into(), &[kind_val.into(), id_val.into(), aux_val])
            .is_some()
    };

    if !dispatched {
        let message_type = format!("__denojs_worker_stream_control_v1:{kind}:{stream_id}");
        return handle_post_message_typed_msg(
            worker,
            message_type,
            0,
            JsValueBridge::String(aux.unwrap_or_default()),
        );
    }
    false
}

// Handle set global msg.
async fn handle_set_global_msg(
    worker: &mut MainWorker,
    worker_id: usize,
    key: String,
    value: JsValueBridge,
    deferred: crate::bridge::promise::PromiseSettler,
) -> bool {
    let json = if matches!(value, JsValueBridge::Undefined) {
        "null".to_string()
    } else {
        serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
            .unwrap_or_else(|_| "null".into())
    };

    let key_json = serde_json::to_string(&key).unwrap_or_else(|_| "\"\"".into());
    let script = format!("globalThis.__globals[{key_json}] = {json}; globalThis.__applyGlobals();");

    let res = worker.js_runtime.execute_script("<setGlobal>", script);

    if let Some(tx) = get_node_tx(worker_id) {
        match res {
            Ok(_) => {
                send_node_msg_or_reject(
                    &tx,
                    NodeMsg::Resolve {
                        settler: deferred,
                        payload: ResolvePayload::Void,
                    },
                )
                .await;
            }
            Err(e) => {
                let err = crate::bridge::errors::error("Error", e.to_string());

                send_node_msg_or_reject(
                    &tx,
                    NodeMsg::Resolve {
                        settler: deferred,
                        payload: ResolvePayload::Result {
                            result: Err(err),
                            stats: ExecStats {
                                cpu_time_ms: 0.0,
                                eval_time_ms: 0.0,
                            },
                        },
                    },
                )
                .await;
            }
        }
    } else {
        deferred.reject_with_error("Node thread is unavailable");
    }

    false
}

// Handle eval msg.
async fn handle_eval_msg(
    worker: &mut MainWorker,
    worker_id: usize,
    limits: &RuntimeLimits,
    source: String,
    options: EvalOptions,
    deferred: Option<crate::bridge::promise::PromiseSettler>,
    sync_reply: Option<tokio::sync::oneshot::Sender<EvalReply>>,
) -> bool {
    let reply = eval_in_runtime(worker, limits, &source, options).await;

    // Sync API path short-circuits via oneshot and bypasses Promise settler.
    if let Some(tx) = sync_reply {
        let _ = tx.send(reply);
        return false;
    }

    let Some(deferred) = deferred else {
        return false;
    };

    if let Some(node_tx) = get_node_tx(worker_id) {
        let payload = match &reply {
            EvalReply::Ok { value, stats } => ResolvePayload::Result {
                result: Ok(value.clone()),
                stats: stats.clone(),
            },
            EvalReply::Err { error, stats } => ResolvePayload::Result {
                result: Err(error.clone()),
                stats: stats.clone(),
            },
        };

        send_node_msg_or_reject(
            &node_tx,
            NodeMsg::Resolve {
                settler: deferred,
                payload,
            },
        )
        .await;
    } else {
        deferred.reject_with_error("Node thread is unavailable");
    }

    false
}

// Send node msg or reject.
async fn send_node_msg_or_reject(node_tx: &mpsc::Sender<NodeMsg>, msg: NodeMsg) {
    // If node side is gone, reject pending promise instead of dropping silently.
    if let Err(send_err) = node_tx.send(msg).await {
        if let NodeMsg::Resolve { settler, .. } = send_err.0 {
            settler.reject_with_error("Node thread is unavailable");
        }
    }
}

// Returns node tx from state used by runtime bridge internals.
fn get_node_tx(worker_id: usize) -> Option<mpsc::Sender<NodeMsg>> {
    crate::WORKERS
        .read()
        .ok()?
        .get(&worker_id)
        .map(|w| w.node_tx.clone())
}

// Heap stats to json.
fn heap_stats_to_json(stats: &v8::HeapStatistics) -> serde_json::Value {
    serde_json::json!({
        "totalHeapSize": stats.total_heap_size(),
        "totalHeapSizeExecutable": stats.total_heap_size_executable(),
        "totalPhysicalSize": stats.total_physical_size(),
        "totalAvailableSize": stats.total_available_size(),
        "usedHeapSize": stats.used_heap_size(),
        "heapSizeLimit": stats.heap_size_limit(),
        "mallocedMemory": stats.malloced_memory(),
        "externalMemory": stats.external_memory(),
        "peakMallocedMemory": stats.peak_malloced_memory(),
        "numberOfNativeContexts": stats.number_of_native_contexts(),
        "numberOfDetachedContexts": stats.number_of_detached_contexts(),
        "doesZapGarbage": stats.does_zap_garbage(),
    })
}

// Heap space stats to json.
fn heap_space_stats_to_json(isolate: &mut v8::Isolate) -> serde_json::Value {
    let count = isolate.number_of_heap_spaces();
    let mut out = Vec::with_capacity(count as usize);

    for i in 0..count {
        if let Some(hs) = isolate.get_heap_space_statistics(i) {
            out.push(serde_json::json!({
                "spaceName": hs.space_name(),
                "physicalSpaceSize": hs.physical_space_size(),
                "spaceSize": hs.space_size(),
                "spaceUsedSize": hs.space_used_size(),
                "spaceAvailableSize": hs.space_available_size(),
            }));
        }
    }

    serde_json::Value::Array(out)
}
