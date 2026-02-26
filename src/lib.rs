use lazy_static::lazy_static;
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::error::TrySendError;

mod bridge;
mod deno_thread;
mod log;
mod worker;

use crate::bridge::promise::PromiseSettler;
use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::worker::messages::{DenoMsg, EvalReply};
use crate::worker::state::WorkerHandle;

lazy_static! {
    pub static ref WORKERS: Mutex<HashMap<usize, WorkerHandle>> = Mutex::new(HashMap::new());
    static ref NEXT_ID: AtomicUsize = AtomicUsize::new(1);
}

fn parse_eval_options<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> EvalOptions {
    EvalOptions::from_neon(cx, idx).unwrap_or_default()
}

fn mk_err(message: impl Into<String>) -> JsValueBridge {
    JsValueBridge::Error {
        name: "Error".into(),
        message: message.into(),
        stack: None,
        code: None,
    }
}

// Stage 1+2 architecture: fail-closed helper that always settles any deferred carried by `msg`.
fn try_send_deno_msg_or_reject(tx: &tokio::sync::mpsc::Sender<DenoMsg>, msg: DenoMsg) {
    match tx.try_send(msg) {
        Ok(()) => {}
        Err(TrySendError::Full(msg)) | Err(TrySendError::Closed(msg)) => match msg {
            DenoMsg::Eval {
                deferred: Some(deferred),
                ..
            } => {
                deferred.reject_with_error("Runtime is closed or request queue is full");
            }

            DenoMsg::Close { deferred }
            | DenoMsg::Memory { deferred }
            | DenoMsg::SetGlobal { deferred, .. } => {
                deferred.reject_with_error("Runtime is closed or request queue is full");
            }

            // No deferred to settle for these
            DenoMsg::Eval { deferred: None, .. } | DenoMsg::PostMessage { .. } => {}
        },
    }
}

fn is_async_function<'a>(cx: &mut FunctionContext<'a>, f: Handle<'a, JsFunction>) -> bool {
    // Best-effort: fn.constructor.name === "AsyncFunction"
    let ctor: Handle<JsValue> = match f.get(cx, "constructor") {
        Ok(v) => v,
        Err(_) => return false,
    };

    let ctor_obj: Handle<JsObject> = match ctor.downcast::<JsObject, _>(cx) {
        Ok(o) => o,
        Err(_) => return false,
    };

    let name: Handle<JsValue> = match ctor_obj.get(cx, "name") {
        Ok(v) => v,
        Err(_) => return false,
    };

    let name_str: Handle<JsString> = match name.downcast::<JsString, _>(cx) {
        Ok(s) => s,
        Err(_) => return false,
    };

    name_str.value(cx) == "AsyncFunction"
}

fn create_worker(mut cx: FunctionContext) -> JsResult<JsObject> {
    let opts = worker::state::WorkerCreateOptions::from_neon(&mut cx, 0).unwrap_or_default();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let channel = cx.channel();

    let (handle, deno_rx, node_rx) = WorkerHandle::new(id, channel.clone(), opts.channel_size);

    {
        let mut map = WORKERS
            .lock()
            .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
        map.insert(id, handle.clone());
    }

    worker::runtime::spawn_worker_thread(id, opts.runtime_options, deno_rx, node_rx);

    let api = cx.empty_object();

    // postMessage(msg)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let value = cx.argument::<JsValue>(0)?;
            let msg = crate::bridge::neon_codec::from_neon_value(&mut cx, value)?;

            let tx = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2).map(|w| w.deno_tx.clone())
            };

            if let Some(tx) = tx {
                let _ = tx.try_send(DenoMsg::PostMessage { value: msg });
                Ok(cx.undefined())
            } else {
                cx.throw_error("Runtime is closed")
            }
        })?;
        api.set(&mut cx, "postMessage", f)?;
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
                    .map(|w| w.closed.load(std::sync::atomic::Ordering::SeqCst))
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
            let settler = PromiseSettler::new(deferred, cx.channel(), "close");

            let tx = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2).map(|w| w.deno_tx.clone())
            };

            match tx {
                Some(tx) => try_send_deno_msg_or_reject(&tx, DenoMsg::Close { deferred: settler }),
                None => settler.reject_with_value_in_cx(
                    &mut cx,
                    &mk_err("Runtime is closed or request queue is full"),
                ),
            }

            Ok(promise)
        })?;
        api.set(&mut cx, "close", f)?;
    }

    // memory(): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel(), "memory");

            let tx = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2).map(|w| w.deno_tx.clone())
            };

            match tx {
                Some(tx) => try_send_deno_msg_or_reject(&tx, DenoMsg::Memory { deferred: settler }),
                None => settler.reject_with_value_in_cx(
                    &mut cx,
                    &mk_err("Runtime is closed or request queue is full"),
                ),
            }

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
            let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, js)?;

            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel(), "setGlobal");

            let tx_and_value = {
                let mut map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                let worker = map
                    .get_mut(&id2)
                    .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

                let value = if let Ok(func) = js.downcast::<JsFunction, _>(&mut cx) {
                    // Detect AsyncFunction by constructor.name
                    let is_async = (|| -> Option<bool> {
                        let func_obj = func.upcast::<JsObject>();
                        let ctor = func_obj.get_value(&mut cx, "constructor").ok()?;
                        let ctor_obj = ctor.downcast::<JsObject, _>(&mut cx).ok()?;
                        let name = ctor_obj.get_value(&mut cx, "name").ok()?;
                        let name_s = name.downcast::<JsString, _>(&mut cx).ok()?.value(&mut cx);
                        Some(name_s == "AsyncFunction")
                    })()
                    .unwrap_or(false);

                    let callback_id = worker.register_global_fn(func.root(&mut cx));
                    JsValueBridge::HostFunction {
                        id: callback_id,
                        is_async,
                    }
                } else {
                    bridged
                };

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
                settler.reject_with_value_in_cx(
                    &mut cx,
                    &mk_err("Runtime is closed or request queue is full"),
                );
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
            let settler = PromiseSettler::new(deferred, cx.channel(), "eval");

            let tx = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2).map(|w| w.deno_tx.clone())
            };

            match tx {
                Some(tx) => try_send_deno_msg_or_reject(
                    &tx,
                    DenoMsg::Eval {
                        source: src,
                        options,
                        deferred: Some(settler),
                        sync_reply: None,
                    },
                ),
                None => settler.reject_with_value_in_cx(
                    &mut cx,
                    &mk_err("Runtime is closed or request queue is full"),
                ),
            }

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

            let tx = {
                let map = WORKERS
                    .lock()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2)
                    .map(|w| w.deno_tx.clone())
                    .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?
            };

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

            // Update lastExecutionStats for evalSync
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

    // lastExecutionStats getter (best-effort, never abort worker construction)
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

        // Best-effort: if globals are polluted, just skip defining the property.
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

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    dw_log!("START WORKER");
    cx.export_function("DenoWorker", create_worker)?;
    Ok(())
}