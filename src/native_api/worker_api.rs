use neon::prelude::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::bridge::promise::PromiseSettler;
use crate::bridge::tags::{TYPE_FUNCTION, TYPE_KEY};
use crate::bridge::types::JsValueBridge;
use crate::queue_deno_msg_or_reject;
use crate::try_send_deno_msg_or_reject;
use crate::worker;
use crate::worker::messages::{DenoMsg, EvalReply};
use crate::worker::state::WorkerHandle;
use crate::{NEXT_ID, WORKERS, deno_tx_for_worker, mk_err, parse_eval_options};
use neon::result::Throw;
use neon::types::JsDate;

fn get_string_prop<'a, C: Context<'a>>(
    cx: &mut C,
    obj: Handle<'a, JsObject>,
    key: &str,
) -> Option<String> {
    let v = obj.get_value(cx, key).ok()?;
    let s = v.downcast::<JsString, _>(cx).ok()?;
    Some(s.value(cx))
}

fn host_fn_tag(id: usize, is_async: bool) -> serde_json::Value {
    json!({
        TYPE_KEY: TYPE_FUNCTION,
        "id": id,
        "async": is_async
    })
}

fn register_host_fn<'a>(
    worker_id: usize,
    cx: &mut FunctionContext<'a>,
    func: Handle<'a, JsFunction>,
) -> Option<usize> {
    let rooted = func.root(cx);
    let mut map = WORKERS.lock().ok()?;
    let w = map.get_mut(&worker_id)?;
    Some(w.register_global_fn(rooted))
}

fn build_node_console_bridge_fn<'a>(
    cx: &mut FunctionContext<'a>,
    method: &'static str,
) -> NeonResult<Handle<'a, JsFunction>> {
    let method_str: String = method.to_string();
    JsFunction::new(cx, move |mut cx| {
        let console_obj = match cx.global::<JsObject>("console") {
            Ok(c) => c,
            Err(_) => return Ok(cx.undefined()),
        };

        let func_any = match console_obj.get_value(&mut cx, method_str.as_str()) {
            Ok(v) => v,
            Err(_) => return Ok(cx.undefined()),
        };

        let Ok(func) = func_any.downcast::<JsFunction, _>(&mut cx) else {
            return Ok(cx.undefined());
        };

        let argc = cx.len();
        let mut argv: Vec<Handle<JsValue>> = Vec::with_capacity(argc);
        for i in 0..argc {
            let v = cx.argument::<JsValue>(i)?;

            // Jest worker transport cannot JSON stringify BigInt, so sanitize here.
            let v2: Handle<JsValue> = if v.is_a::<neon::types::JsBigInt, _>(&mut cx) {
                let s = cx
                    .try_catch(|cx| v.to_string(cx))
                    .ok()
                    .map(|ss| ss.value(&mut cx))
                    .unwrap_or_else(|| "0".to_string());
                cx.string(format!("{s}n")).upcast()
            } else {
                v
            };

            argv.push(v2);
        }

        let _ = cx.try_catch(|cx| {
            let _ = func.call(cx, console_obj, argv.as_slice())?;
            Ok(())
        });

        Ok(cx.undefined())
    })
}

fn is_async_like<'a>(cx: &mut FunctionContext<'a>, func: Handle<'a, JsFunction>) -> bool {
    let candidate: Handle<'a, JsFunction> = func;

    let tag_is_async = (|| -> Option<bool> {
        let object_ctor: Handle<JsFunction> = cx.global("Object").ok()?;
        let proto_val = object_ctor.get_value(cx, "prototype").ok()?;
        let proto = proto_val.downcast::<JsObject, _>(cx).ok()?;
        let to_string_val = proto.get_value(cx, "toString").ok()?;
        let to_string = to_string_val.downcast::<JsFunction, _>(cx).ok()?;

        let s = to_string
            .call_with(cx)
            .this(candidate)
            .apply::<JsString, _>(cx)
            .ok()?
            .value(cx);

        Some(s == "[object AsyncFunction]")
    })()
    .unwrap_or(false);

    if tag_is_async {
        return true;
    }

    (|| -> Option<bool> {
        let obj = candidate.upcast::<JsObject>();
        let ctor_val = obj.get_value(cx, "constructor").ok()?;
        let ctor_obj = ctor_val.downcast::<JsObject, _>(cx).ok()?;
        let name_val = ctor_obj.get_value(cx, "name").ok()?;
        let name = name_val.downcast::<JsString, _>(cx).ok()?.value(cx);
        Some(name == "AsyncFunction")
    })()
    .unwrap_or(false)
}

fn build_console_config_from_neon<'a>(
    cx: &mut FunctionContext<'a>,
    worker_id: usize,
    raw_console: Handle<'a, JsValue>,
) -> Option<serde_json::Value> {
    if raw_console.is_a::<JsUndefined, _>(cx) || raw_console.is_a::<JsNull, _>(cx) {
        return None;
    }

    if let Ok(b) = raw_console.downcast::<JsBoolean, _>(cx) {
        if b.value(cx) == false {
            return Some(serde_json::Value::Bool(false));
        }
        return None;
    }

    let Ok(obj) = raw_console.downcast::<JsObject, _>(cx) else {
        return None;
    };

    // Marker mode: { __denojs_worker_console_mode: "node" }
    // This should be synchronous so logs stream during long sync CPU loops.
    if get_string_prop(cx, obj, "__denojs_worker_console_mode").as_deref() == Some("node") {
        let methods: &[(&str, &'static str)] = &[
            ("log", "log"),
            ("info", "info"),
            ("warn", "warn"),
            ("error", "error"),
            ("debug", "debug"),
            ("trace", "trace"),
        ];

        let mut map = serde_json::Map::new();

        for (k, m) in methods {
            if let Ok(f) = build_node_console_bridge_fn(cx, m) {
                if let Some(id) = register_host_fn(worker_id, cx, f) {
                    // Node console routing should be sync.
                    map.insert((*k).to_string(), host_fn_tag(id, false));
                }
            }
        }

        if map.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(map))
        }
    } else {
        // Per-method mode: { log, info, warn, error, debug, trace }
        // - function: sync by default
        // - async function: use async host call
        // - false: ignore
        // - missing: default behavior (restore originals in worker)
        let keys: &[&str] = &["log", "info", "warn", "error", "debug", "trace"];
        let mut map = serde_json::Map::new();

        for k in keys {
            let v = match obj.get_value(cx, *k) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if v.is_a::<JsUndefined, _>(cx) || v.is_a::<JsNull, _>(cx) {
                continue;
            }

            if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                if b.value(cx) == false {
                    map.insert((*k).to_string(), serde_json::Value::Bool(false));
                }
                continue;
            }

            if let Ok(f) = v.downcast::<JsFunction, _>(cx) {
                let async_like = is_async_like(cx, f);
                if let Some(id) = register_host_fn(worker_id, cx, f) {
                    map.insert((*k).to_string(), host_fn_tag(id, async_like));
                }
                continue;
            }
        }

        if map.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(map))
        }
    }
}

fn strict_channel() -> bool {
    std::env::var("DENOJS_WORKER_STRICT_CHANNEL")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        })
        .unwrap_or(false)
}

fn object_to_string_tag<'a>(
    cx: &mut FunctionContext<'a>,
    value: Handle<'a, JsValue>,
) -> Option<String> {
    let object_ctor: Handle<JsFunction> = cx.global("Object").ok()?;
    let proto_any = object_ctor.get_value(cx, "prototype").ok()?;
    let proto = proto_any.downcast::<JsObject, _>(cx).ok()?;
    let to_string_any = proto.get_value(cx, "toString").ok()?;
    let to_string = to_string_any.downcast::<JsFunction, _>(cx).ok()?;
    let s = to_string
        .call_with(cx)
        .this(value)
        .apply::<JsString, _>(cx)
        .ok()?;
    Some(s.value(cx))
}

fn is_arraybuffer_view<'a>(cx: &mut FunctionContext<'a>, value: Handle<'a, JsValue>) -> bool {
    cx.try_catch(|cx| {
        let ab_ctor: Handle<JsFunction> = cx.global("ArrayBuffer")?;
        let is_view = ab_ctor.get::<JsFunction, _, _>(cx, "isView")?;
        let out = is_view
            .call_with(cx)
            .this(ab_ctor)
            .arg(value)
            .apply::<JsBoolean, _>(cx)?
            .value(cx);
        Ok(out)
    })
    .unwrap_or(false)
}

fn should_expand_object<'a>(
    cx: &mut FunctionContext<'a>,
    value: Handle<'a, JsValue>,
    obj: Handle<'a, JsObject>,
) -> bool {
    if value.is_a::<JsDate, _>(cx)
        || value.is_a::<JsBuffer, _>(cx)
        || value.is_a::<JsError, _>(cx)
        || value.is_a::<JsArray, _>(cx)
    {
        return false;
    }

    if is_arraybuffer_view(cx, value) {
        return false;
    }

    if let Some(tag) = object_to_string_tag(cx, value) {
        match tag.as_str() {
            "[object Date]"
            | "[object RegExp]"
            | "[object Map]"
            | "[object Set]"
            | "[object URL]"
            | "[object URLSearchParams]"
            | "[object ArrayBuffer]"
            | "[object SharedArrayBuffer]"
            | "[object DataView]"
            | "[object Promise]" => return false,
            _ => {}
        }
    }

    // For plain containers (including module namespace-like objects), walk keys
    // recursively so nested JS functions are converted to host-callable bridge
    // tags instead of being silently dropped.
    !own_enumerable_string_keys(cx, obj).is_empty()
}

fn is_special_wire_json_object(v: &serde_json::Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };

    if let Some(t) = obj
        .get("__denojs_worker_type")
        .and_then(|x| x.as_str())
        .filter(|x| *x == "error" || *x == "function")
    {
        let _ = t;
        return true;
    }

    // These tags represent already-encoded wire payloads and must not be
    // traversed/expanded again, or type markers can be corrupted.
    const SPECIAL_KEYS: [&str; 11] = [
        "__buffer",
        "__map",
        "__set",
        "__url",
        "__urlSearchParams",
        "__date",
        "__bigint",
        "__regexp",
        "__num",
        "__denojs_worker_num",
        "__undef",
    ];

    SPECIAL_KEYS.iter().any(|k| obj.contains_key(*k))
}

fn own_enumerable_string_keys<'a>(
    cx: &mut FunctionContext<'a>,
    obj: Handle<'a, JsObject>,
) -> Vec<String> {
    cx.try_catch(|cx| {
        let object_ctor: Handle<JsFunction> = cx.global("Object")?;
        let keys_fn = object_ctor.get::<JsFunction, _, _>(cx, "keys")?;
        let keys_arr = keys_fn
            .call_with(cx)
            .this(object_ctor)
            .arg(obj)
            .apply::<JsArray, _>(cx)?;

        let mut out = Vec::with_capacity(keys_arr.len(cx) as usize);
        for i in 0..keys_arr.len(cx) {
            let v = keys_arr.get_value(cx, i)?;
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                out.push(s.value(cx));
            }
        }
        Ok(out)
    })
    .unwrap_or_default()
}

fn encode_set_global_value<'a>(
    cx: &mut FunctionContext<'a>,
    worker: &mut WorkerHandle,
    value: Handle<'a, JsValue>,
    depth: usize,
) -> Result<JsValueBridge, Throw> {
    if depth > 32 {
        return Ok(JsValueBridge::Undefined);
    }

    if let Ok(func) = value.downcast::<JsFunction, _>(cx) {
        // Functions become callback IDs that can be invoked from the worker via ops.
        let is_async = is_async_like(cx, func);
        let callback_id = worker.register_global_fn(func.root(cx));
        return Ok(JsValueBridge::HostFunction {
            id: callback_id,
            is_async,
        });
    }

    if let Ok(arr) = value.downcast::<JsArray, _>(cx) {
        let mut out = Vec::with_capacity(arr.len(cx) as usize);
        for i in 0..arr.len(cx) {
            let item = arr
                .get_value(cx, i)
                .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
            let bridged = encode_set_global_value(cx, worker, item, depth + 1)?;
            out.push(crate::bridge::wire::to_wire_json(&bridged));
        }
        return Ok(JsValueBridge::Json(serde_json::Value::Array(out)));
    }

    if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
        // Baseline codec already handles rich JS types (Date/Map/Set/Error/TypedArray).
        let baseline = crate::bridge::neon_codec::from_neon_value(cx, value)?;
        if let JsValueBridge::Json(j) = &baseline {
            if is_special_wire_json_object(j) {
                return Ok(baseline);
            }
        }

        if should_expand_object(cx, value, obj) {
            let keys = own_enumerable_string_keys(cx, obj);
            let mut out = serde_json::Map::new();
            for key in keys {
                let vv = obj
                    .get_value(cx, key.as_str())
                    .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
                let bridged = encode_set_global_value(cx, worker, vv, depth + 1)?;
                out.insert(key, crate::bridge::wire::to_wire_json(&bridged));
            }
            return Ok(JsValueBridge::Json(serde_json::Value::Object(out)));
        }

        return Ok(baseline);
    }

    crate::bridge::neon_codec::from_neon_value(cx, value)
}

pub fn create_worker(mut cx: FunctionContext) -> JsResult<JsObject> {
    let mut opts = worker::state::WorkerCreateOptions::from_neon(&mut cx, 0).unwrap_or_default();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let channel = cx.channel();

    let (handle, deno_rx, node_rx) = WorkerHandle::new(id, channel.clone(), opts.channel_size);

    {
        let mut map = WORKERS
            .lock()
            .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
        map.insert(id, handle.clone());
    }

    // imports option: if provided as a function, store it in callbacks.imports
    {
        let raw_opts = cx.argument_opt(0);
        if let Some(raw) = raw_opts {
            if let Ok(obj) = raw.downcast::<JsObject, _>(&mut cx) {
                if let Ok(v) = obj.get_value(&mut cx, "imports") {
                    if let Ok(f) = v.downcast::<JsFunction, _>(&mut cx) {
                        let rooted = f.root(&mut cx);

                        if let Ok(mut map) = WORKERS.lock() {
                            if let Some(w) = map.get_mut(&id) {
                                w.callbacks.imports = Some(Arc::new(rooted));
                            }
                        }
                    }
                }
            }
        }
    }

    // console option: if provided, build wire JSON config and apply before startup
    {
        let raw_opts = cx.argument_opt(0);
        if let Some(raw) = raw_opts {
            if let Ok(obj) = raw.downcast::<JsObject, _>(&mut cx) {
                if let Ok(v) = obj.get_value(&mut cx, "console") {
                    opts.runtime_options.console = build_console_config_from_neon(&mut cx, id, v);
                }
            }
        }
    }

    worker::runtime::spawn_worker_thread(id, opts.runtime_options, deno_rx, node_rx);

    let api = cx.empty_object();

    // postMessage(msg) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let value = cx.argument::<JsValue>(0)?;
            let msg = crate::bridge::neon_codec::from_neon_value(&mut cx, value)?;

            let tx = deno_tx_for_worker(id2);

            let Some(tx) = tx else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postMessage)");
                }
                return Ok(cx.boolean(false));
            };

            match tx.try_send(DenoMsg::PostMessage { value: msg }) {
                Ok(()) => Ok(cx.boolean(true)),
                Err(_) => {
                    if strict_channel() {
                        cx.throw_error("postMessage dropped: worker queue full or closed")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postMessage", f)?;
    }

    // postMessages(msgs) -> number (accepted count)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let values = cx.argument::<JsValue>(0)?;
            let arr = match values.downcast::<JsArray, _>(&mut cx) {
                Ok(a) => a,
                Err(_) => return Ok(cx.number(0.0)),
            };

            let tx = deno_tx_for_worker(id2);
            let Some(tx) = tx else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postMessages)");
                }
                return Ok(cx.number(0.0));
            };

            let mut sent: usize = 0;
            for i in 0..arr.len(&mut cx) {
                let v = arr.get_value(&mut cx, i)?;
                let msg = crate::bridge::neon_codec::from_neon_value(&mut cx, v)?;
                match tx.try_send(DenoMsg::PostMessage { value: msg }) {
                    Ok(()) => sent += 1,
                    Err(_) => {
                        if strict_channel() {
                            return cx.throw_error("postMessages dropped: worker queue full or closed");
                        }
                        break;
                    }
                }
            }

            Ok(cx.number(sent as f64))
        })?;
        api.set(&mut cx, "postMessages", f)?;
    }

    // on(event, cb)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let event = cx.argument::<JsString>(0)?.value(&mut cx);
            let cb = cx.argument::<JsFunction>(1)?.root(&mut cx);

            let mut map = WORKERS
                .lock()
                .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
            let worker = map
                .get_mut(&id2)
                .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

            match event.as_str() {
                "message" => worker.callbacks.on_message = Some(Arc::new(cb)),
                "close" => worker.callbacks.on_close = Some(Arc::new(cb)),
                _ => {}
            }

            Ok(cx.undefined())
        })?;
        api.set(&mut cx, "on", f)?;
    }

    // isClosed()
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let closed = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2)
                    .map(|w| w.closed.load(Ordering::SeqCst))
                    .unwrap_or(true)
            };
            Ok(cx.boolean(closed))
        })?;
        api.set(&mut cx, "isClosed", f)?;
    }

    // close(): Promise<void>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Close { deferred });

            Ok(promise)
        })?;
        api.set(&mut cx, "close", f)?;
    }

    // memory(): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Memory { deferred });

            Ok(promise)
        })?;
        api.set(&mut cx, "memory", f)?;
    }

    // setGlobal(key, value): Promise<void>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let key = cx.argument::<JsString>(0)?.value(&mut cx);
            let js = cx.argument::<JsValue>(1)?;

            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());

            let tx_and_value = {
                let mut map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                let worker = map
                    .get_mut(&id2)
                    .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

                let value = encode_set_global_value(&mut cx, worker, js, 0)?;

                Some((worker.deno_tx.clone(), value))
            };

            if let Some((tx, value)) = tx_and_value {
                try_send_deno_msg_or_reject(
                    &tx,
                    DenoMsg::SetGlobal {
                        key,
                        value,
                        deferred: settler,
                    },
                );
            } else {
                settler.reject_with_value_via_channel(mk_err(
                    "Runtime is closed or request queue is full",
                ));
            }

            Ok(promise)
        })?;
        api.set(&mut cx, "setGlobal", f)?;
    }

    // eval(src, options?): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let src = cx.argument::<JsString>(0)?.value(&mut cx);
            let options = parse_eval_options(&mut cx, 1);

            let (deferred, promise) = cx.promise();
            let mut settler = PromiseSettler::new(deferred, cx.channel());
            if let Ok(date_ctor) = cx.global::<JsFunction>("Date") {
                settler = settler.with_date_ctor(date_ctor.root(&mut cx));
            }

            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Eval {
                source: src,
                options,
                deferred: Some(deferred),
                sync_reply: None,
            });

            Ok(promise)
        })?;
        api.set(&mut cx, "eval", f)?;
    }

    // evalSync(src, options?): any
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let src = cx.argument::<JsString>(0)?.value(&mut cx);
            let options = parse_eval_options(&mut cx, 1);

            let tx = deno_tx_for_worker(id2)
                .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            tx.blocking_send(DenoMsg::Eval {
                source: src,
                options,
                deferred: None,
                sync_reply: Some(reply_tx),
            })
            .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

            let result = reply_rx
                .blocking_recv()
                .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

            {
                if let Ok(mut map) = WORKERS.lock() {
                    if let Some(w) = map.get_mut(&id2) {
                        let stats = match &result {
                            EvalReply::Ok { stats, .. } => stats.clone(),
                            EvalReply::Err { stats, .. } => stats.clone(),
                        };
                        if let Ok(mut g) = w.last_stats.lock() {
                            *g = Some(stats);
                        }
                    }
                }
            }

            crate::bridge::neon_codec::eval_result_to_neon(&mut cx, result)
        })?;
        api.set(&mut cx, "evalSync", f)?;
    }

    // evalModule(src, options?): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let src = cx.argument::<JsString>(0)?.value(&mut cx);

            let mut options = parse_eval_options(&mut cx, 1);
            options.is_module = true;

            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());

            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Eval {
                source: src,
                options,
                deferred: Some(deferred),
                sync_reply: None,
            });

            Ok(promise)
        })?;
        api.set(&mut cx, "evalModule", f)?;
    }

    // lastExecutionStats getter
    {
        let id2 = id;

        let getter = JsFunction::new(&mut cx, move |mut cx| -> JsResult<JsValue> {
            let stats_opt = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

                map.get(&id2)
                    .and_then(|w| w.last_stats.lock().ok().and_then(|g| (*g).clone()))
            };

            match stats_opt {
                Some(st) => {
                    let obj = cx.empty_object();
                    let cpu_time = cx.number(st.cpu_time_ms);
                    let eval_time = cx.number(st.eval_time_ms);
                    obj.set(&mut cx, "cpuTimeMs", cpu_time)?;
                    obj.set(&mut cx, "evalTimeMs", eval_time)?;
                    Ok(obj.upcast())
                }
                None => Ok(cx.empty_object().upcast()),
            }
        })?;

        let object_ctor: Option<Handle<JsFunction>> = cx.global("Object").ok();
        if let Some(object_ctor) = object_ctor {
            let object_obj: Handle<JsObject> = object_ctor.upcast();

            let define_prop: Option<Handle<JsFunction>> =
                object_obj.get(&mut cx, "defineProperty").ok();

            if let Some(define_prop) = define_prop {
                let desc = cx.empty_object();
                let bool_true = cx.boolean(true);
                desc.set(&mut cx, "get", getter)?;
                desc.set(&mut cx, "enumerable", bool_true)?;
                desc.set(&mut cx, "configurable", bool_true)?;

                let prop_name = cx.string("lastExecutionStats");
                let _ = define_prop.call(
                    &mut cx,
                    object_obj,
                    &[api.upcast(), prop_name.upcast(), desc.upcast()],
                );
            }
        }
    };

    Ok(api)
}
