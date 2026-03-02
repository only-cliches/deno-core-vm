use deno_runtime::deno_core::v8;
use deno_runtime::worker::MainWorker;
use neon::prelude::*;
use tokio::sync::mpsc;

use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::worker::eval::eval_in_runtime;
use crate::worker::messages::{DenoMsg, EvalReply, ExecStats, NodeMsg, ResolvePayload};
use crate::worker::state::RuntimeLimits;

pub async fn handle_deno_msg(
    worker: &mut MainWorker,
    worker_id: usize,
    limits: &RuntimeLimits,
    msg: DenoMsg,
) -> bool {
    match msg {
        DenoMsg::Close { deferred } => handle_close_msg(worker_id, deferred),
        DenoMsg::Memory { deferred } => handle_memory_msg(worker, worker_id, deferred).await,
        DenoMsg::PostMessage { value } => handle_post_message_msg(worker, value),
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

fn handle_close_msg(worker_id: usize, deferred: crate::bridge::promise::PromiseSettler) -> bool {
    deferred.resolve_with_value_via_channel(JsValueBridge::Undefined);

    if let Ok(map) = crate::WORKERS.lock() {
        if let Some(w) = map.get(&worker_id) {
            w.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    let mut try_direct_cleanup = false;

    if let Some(tx) = get_node_tx(worker_id) {
        if tx.try_send(NodeMsg::EmitClose).is_err() {
            try_direct_cleanup = true;
        }
    } else {
        try_direct_cleanup = true;
    }

    if try_direct_cleanup {
        let (channel, on_close_cb_opt) = match crate::WORKERS.lock() {
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
        let _ = channel.try_send(move |mut cx| {
            if let Some(cb_arc) = on_close_cb_opt.as_ref() {
                let cb = cb_arc.to_inner(&mut cx);
                let this = cx.undefined();
                let _ = cb.call(&mut cx, this, &[]);
            }

            if let Ok(mut map) = crate::WORKERS.lock() {
                let _ = map.remove(&wid);
            }

            Ok(())
        });
    }

    true
}

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
        let payload = serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
            .unwrap_or_else(|_| "null".into());
        let script = format!("globalThis.__dispatchNodeMessage(globalThis.__hydrate({payload}))");
        let _ = worker.js_runtime.execute_script("<postMessage>", script);
    }
    false
}

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

async fn send_node_msg_or_reject(node_tx: &mpsc::Sender<NodeMsg>, msg: NodeMsg) {
    if let Err(send_err) = node_tx.send(msg).await {
        if let NodeMsg::Resolve { settler, .. } = send_err.0 {
            settler.reject_with_error("Node thread is unavailable");
        }
    }
}

fn get_node_tx(worker_id: usize) -> Option<mpsc::Sender<NodeMsg>> {
    crate::WORKERS
        .lock()
        .ok()?
        .get(&worker_id)
        .map(|w| w.node_tx.clone())
}

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
