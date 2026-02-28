use deno_runtime::deno_core::v8;
use deno_runtime::worker::MainWorker;
use neon::prelude::*;
use tokio::sync::mpsc;

use crate::bridge::types::JsValueBridge;
use crate::worker::eval::eval_in_runtime;
use crate::worker::messages::{DenoMsg, EvalReply, ExecStats, NodeMsg, ResolvePayload};
use crate::worker::state::RuntimeLimits;

pub fn dispatch_node_msg(worker_id: usize, msg: NodeMsg) {
    let (channel, handle_snapshot) = match crate::WORKERS.lock() {
        Ok(map) => {
            if let Some(w) = map.get(&worker_id) {
                (
                    w.channel.clone(),
                    Some((
                        w.callbacks.clone(),
                        w.host_functions.clone(),
                        w.last_stats.clone(),
                    )),
                )
            } else {
                return;
            }
        }
        Err(_) => return,
    };

    let Some((callbacks, host_functions, last_stats)) = handle_snapshot else {
        return;
    };

    let _ = channel.send(move |mut cx| {
        fn swallow_js_exn<'a, F, T>(cx: &mut TaskContext<'a>, f: F) -> Option<T>
        where
            F: FnOnce(&mut TaskContext<'a>) -> NeonResult<T>,
        {
            cx.try_catch(f).ok()
        }

        fn thrown_to_bridge<'a>(
            cx: &mut TaskContext<'a>,
            thrown: Handle<'a, JsValue>,
        ) -> JsValueBridge {
            match crate::bridge::neon_codec::from_neon_value(cx, thrown) {
                Ok(JsValueBridge::Error {
                    name,
                    message,
                    stack,
                    code,
                }) => JsValueBridge::Error {
                    name: if name.is_empty() { "HostFunctionError".into() } else { name },
                    message,
                    stack,
                    code,
                },
                Ok(JsValueBridge::String(s)) => JsValueBridge::Error {
                    name: "HostFunctionError".into(),
                    message: s,
                    stack: None,
                    code: None,
                },
                Ok(other) => JsValueBridge::Error {
                    name: "HostFunctionError".into(),
                    message: format!("{:?}", other),
                    stack: None,
                    code: None,
                },
                Err(e) => JsValueBridge::Error {
                    name: "HostFunctionError".into(),
                    message: e.to_string(),
                    stack: None,
                    code: None,
                },
            }
        }

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _outer = cx.try_catch(|cx| match msg {
                NodeMsg::Resolve { settler, payload } => {
                    if let ResolvePayload::Result { stats, .. } = &payload {
                        if let Ok(mut g) = last_stats.lock() {
                            *g = Some(stats.clone());
                        }
                    }

                    match payload {
                        ResolvePayload::Void => settler.resolve_with_value_in_cx(cx, &JsValueBridge::Null),
                        ResolvePayload::Json(json) => {
                            let s = serde_json::to_string(&json).unwrap_or_else(|_| "null".into());
                            settler.resolve_with_json_in_cx(cx, &s);
                        }
                        ResolvePayload::Result { result, .. } => match result {
                            Ok(v) => settler.resolve_with_value_in_cx(cx, &v),
                            Err(e) => settler.reject_with_value_in_cx(cx, &e),
                        },
                    }
                    Ok(())
                }

                NodeMsg::ImportRequest { specifier, referrer, reply } => {
                    use crate::worker::messages::ImportDecision;

                    if std::env::var("DENOJS_WORKER_DEBUG_IMPORTS").is_ok() {
                        println!(
                            "[denojs-worker][imports] NodeMsg::ImportRequest specifier={} referrer={}",
                            specifier, referrer
                        );
                    }

                    struct ImportState {
                        reply: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<ImportDecision>>>,
                        hooks: std::sync::Mutex<Option<(Root<JsFunction>, Root<JsFunction>)>>,
                    }

                    impl ImportState {
                        fn send_once(&self, value: ImportDecision) {
                            let tx_opt = self.reply.lock().ok().and_then(|mut g| g.take());
                            if let Some(tx) = tx_opt {
                                let _ = tx.send(value);
                            }
                        }

                        fn clear_hooks(&self) {
                            let _ = self.hooks.lock().ok().and_then(|mut g| g.take());
                        }
                    }

                    fn interpret_value<'a>(
                        cx: &mut TaskContext<'a>,
                        v: Handle<'a, JsValue>,
                    ) -> Option<crate::worker::messages::ImportDecision> {
                        use crate::worker::messages::ImportDecision;

                        let debug = std::env::var("DENOJS_WORKER_DEBUG_IMPORTS")
                            .ok()
                            .map(|s| {
                                let s = s.trim().to_ascii_lowercase();
                                s == "1" || s == "true" || s == "yes" || s == "on"
                            })
                            .unwrap_or(false);

                        let log = |msg: String| {
                            if debug {
                                println!("[denojs-worker][imports] {}", msg);
                            }
                        };

                        // If it's a Promise, defer to the Promise handling path.
                        if v.is_a::<neon::types::JsPromise, _>(cx) {
                            log("interpret_value: got JsPromise => defer".to_string());
                            return None;
                        }

                        // String means JS source (legacy behavior)
                        if let Ok(s) = v.downcast::<JsString, _>(cx) {
                            let code = s.value(cx);
                            log(format!(
                                "interpret_value: got JsString => SourceTyped ext=js bytes={}",
                                code.len()
                            ));
                            return Some(ImportDecision::SourceTyped {
                                ext: "js".into(),
                                code,
                            });
                        }

                        // Boolean means allow/block disk resolution
                        if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                            let allowed = b.value(cx);
                            log(format!(
                                "interpret_value: got JsBoolean={} => {}",
                                allowed,
                                if allowed { "AllowDisk" } else { "Block" }
                            ));
                            return Some(if allowed {
                                ImportDecision::AllowDisk
                            } else {
                                ImportDecision::Block
                            });
                        }

                        // Object forms:
                        // - { js: "..." } | { ts: "..." } | { tsx: "..." } | { jsx: "..." }
                        // - { resolve: "..." }
                        let Ok(obj) = v.downcast::<JsObject, _>(cx) else {
                            if debug {
                                log("interpret_value: unsupported (not string/bool/object) => None".to_string());
                            }
                            return None;
                        };

                        // { resolve: string }
                        if let Ok(rv) = obj.get_value(cx, "resolve") {
                            if let Ok(rs) = rv.downcast::<JsString, _>(cx) {
                                let s = rs.value(cx);
                                let trimmed = s.trim().to_string();
                                if trimmed.is_empty() {
                                    log("interpret_value: object { resolve: \"\" } => Block".to_string());
                                    return Some(ImportDecision::Block);
                                }
                                log(format!(
                                    "interpret_value: object {{ resolve: ... }} => Resolve({})",
                                    trimmed
                                ));
                                return Some(ImportDecision::Resolve(trimmed));
                            } else if debug && !rv.is_a::<JsUndefined, _>(cx) && !rv.is_a::<JsNull, _>(cx) {
                                log("interpret_value: object has 'resolve' but it's not a string (ignored)".to_string());
                            }
                        }

                        // { js|ts|tsx|jsx: string }
                        for ext in ["js", "ts", "tsx", "jsx"] {
                            if let Ok(vv) = obj.get_value(cx, ext) {
                                if let Ok(ss) = vv.downcast::<JsString, _>(cx) {
                                    let code = ss.value(cx);
                                    log(format!(
                                        "interpret_value: object {{ {}: <string> }} => SourceTyped ext={} bytes={}",
                                        ext,
                                        ext,
                                        code.len()
                                    ));
                                    return Some(ImportDecision::SourceTyped {
                                        ext: ext.to_string(),
                                        code,
                                    });
                                } else if debug && !vv.is_a::<JsUndefined, _>(cx) && !vv.is_a::<JsNull, _>(cx) {
                                    log(format!(
                                        "interpret_value: object has key '{}' but value is not a string (ignored)",
                                        ext
                                    ));
                                }
                            }
                        }

                        // Important: do not default-block here, because Promises are objects.
                        // Unknown objects will be blocked by the caller if they are not Promises.
                        log("interpret_value: object shape not recognized => defer".to_string());
                        None
                    }

                    let Some(cb_root) = callbacks.imports.as_ref() else {
                        let _ = reply.send(ImportDecision::Block);
                        return Ok(());
                    };

                    let state = std::sync::Arc::new(ImportState {
                        reply: std::sync::Mutex::new(Some(reply)),
                        hooks: std::sync::Mutex::new(None),
                    });

                    let cb = cb_root.to_inner(cx);
                    let js_spec = cx.string(&specifier);
                    let js_ref = cx.string(&referrer);

                    let this = cx.undefined();
                    let returned = match cx.try_catch(|cx| cb.call(cx, this, &[js_spec.upcast(), js_ref.upcast()])) {
                        Ok(v) => v,
                        Err(_) => {
                            state.send_once(ImportDecision::Block);
                            return Ok(());
                        }
                    };


                    if let Some(d) = interpret_value(cx, returned) {
                        state.send_once(d);
                        return Ok(());
                    }

                    if returned.is_a::<neon::types::JsPromise, _>(cx) {
                        let promise_obj: Handle<JsObject> = match returned.downcast::<JsObject, _>(cx) {
                            Ok(o) => o,
                            Err(_) => {
                                state.send_once(ImportDecision::Block);
                                return Ok(());
                            }
                        };

                        let then_fn: Handle<JsFunction> =
                            match cx.try_catch(|cx| promise_obj.get::<JsFunction, _, _>(cx, "then")) {
                                Ok(f) => f,
                                Err(_) => {
                                    state.send_once(ImportDecision::Block);
                                    return Ok(());
                                }
                            };

                        let st_ok = state.clone();
                        let on_fulfilled = JsFunction::new(cx, move |mut cx| {
                            let v = cx.argument::<JsValue>(0)?;
                            let decision = interpret_value(&mut cx, v).unwrap_or(ImportDecision::Block);
                            st_ok.send_once(decision);
                            st_ok.clear_hooks();
                            Ok(cx.undefined())
                        })?;

                        let st_err = state.clone();
                        let on_rejected = JsFunction::new(cx, move |mut cx| {
                            st_err.send_once(ImportDecision::Block);
                            st_err.clear_hooks();
                            Ok(cx.undefined())
                        })?;

                        {
                            let f_root = on_fulfilled.root(cx);
                            let r_root = on_rejected.root(cx);
                            if let Ok(mut g) = state.hooks.lock() {
                                *g = Some((f_root, r_root));
                            }
                        }

                        let (on_fulfilled_handle, on_rejected_handle) = {
                            let g = state
                                .hooks
                                .lock()
                                .ok()
                                .and_then(|g| g.as_ref().map(|(f, r)| (f.clone(cx), r.clone(cx))));
                            match g {
                                Some((f, r)) => (f.to_inner(cx), r.to_inner(cx)),
                                None => (on_fulfilled, on_rejected),
                            }
                        };

                        let attached = cx.try_catch(|cx| {
                            let args: Vec<Handle<JsValue>> = vec![
                                on_fulfilled_handle.upcast::<JsValue>(),
                                on_rejected_handle.upcast::<JsValue>(),
                            ];
                            let _ = then_fn.call(cx, promise_obj, args.as_slice())?;
                            Ok(())
                        });

                        if attached.is_err() {
                            state.send_once(ImportDecision::Block);
                            state.clear_hooks();
                        }

                        return Ok(());
                    }

                    state.send_once(ImportDecision::Block);
                    Ok(())
                }

                NodeMsg::EmitMessage { value } => {
                    let Some(cb_root) = callbacks.on_message.as_ref() else {
                        return Ok(());
                    };

                    let cb = cb_root.to_inner(cx);
                    let arg = crate::bridge::neon_codec::to_neon_value(cx, &value)
                        .unwrap_or_else(|_| cx.undefined().upcast());

                    let this = cx.undefined();
                    let _ = swallow_js_exn(cx, |cx| {
                        cb.call(cx, this, &[arg])?;
                        Ok(())
                    });

                    Ok(())
                }

                NodeMsg::EmitClose => {
                    if let Some(cb_root) = callbacks.on_close.as_ref() {
                        let cb = cb_root.to_inner(cx);
                        let this = cx.undefined();
                        let _ = swallow_js_exn(cx, |cx| {
                            cb.call(cx, this, &[])?;
                            Ok(())
                        });
                    }

                    if let Ok(mut map) = crate::WORKERS.lock() {
                        let _ = map.remove(&worker_id);
                    }

                    Ok(())
                }

                NodeMsg::InvokeHostFunctionSync { func_id, args, reply } => {
                    let send = |v: Result<JsValueBridge, JsValueBridge>| {
                        let _ = reply.send(v);
                    };

                    let func_root = match host_functions.get(func_id) {
                        Some(f) => f.clone(),
                        None => {
                            send(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: format!("Unknown host function id {func_id}"),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let func = func_root.to_inner(cx);

                    let mut js_argv: Vec<Handle<JsValue>> = Vec::with_capacity(args.len());
                    for a in &args {
                        let v = crate::bridge::neon_codec::to_neon_value(cx, a)
                            .unwrap_or_else(|_| cx.undefined().upcast());
                        js_argv.push(v);
                    }

                    let this = cx.undefined();
                    let called = cx.try_catch(|cx| func.call(cx, this, js_argv.as_slice()));

                    let v = match called {
                        Ok(v) => v,
                        Err(thrown) => {
                            send(Err(thrown_to_bridge(cx, thrown)));
                            return Ok(());
                        }
                    };

                    if v.is_a::<neon::types::JsPromise, _>(cx) {
                        // Suppress unhandled rejection warnings.
                        if let Ok(promise_obj) = v.downcast::<JsObject, _>(cx) {
                            let noop_reject = JsFunction::new(cx, |mut cx| Ok(cx.undefined()))?;
                            let rooted = noop_reject.root(cx);
                            std::mem::forget(rooted);

                            if let Ok(catch_fn) = promise_obj.get::<JsFunction, _, _>(cx, "catch") {
                                let _ = cx.try_catch(|cx| {
                                    let _ = catch_fn.call(cx, promise_obj, &[noop_reject.upcast::<JsValue>()])?;
                                    Ok(())
                                });
                            } else if let Ok(then_fn) = promise_obj.get::<JsFunction, _, _>(cx, "then") {
                                let undef = cx.undefined().upcast::<JsValue>();
                                let _ = cx.try_catch(|cx| {
                                    let _ = then_fn.call(cx, promise_obj, &[undef, noop_reject.upcast()])?;
                                    Ok(())
                                });
                            }
                        }

                        send(Err(JsValueBridge::Error {
                            name: "HostFunctionError".into(),
                            message: "Sync host function returned a Promise; use async host function instead"
                                .into(),
                            stack: None,
                            code: None,
                        }));
                        return Ok(());
                    }

                    match crate::bridge::neon_codec::from_neon_value(cx, v) {
                        Ok(b) => send(Ok(b)),
                        Err(e) => send(Err(JsValueBridge::Error {
                            name: "HostFunctionError".into(),
                            message: e.to_string(),
                            stack: None,
                            code: None,
                        })),
                    }

                    Ok(())
                }

                NodeMsg::InvokeHostFunctionAsync { func_id, args, reply } => {
                    struct AsyncState {
                        reply: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>>>,
                        hooks: std::sync::Mutex<Option<(Root<JsFunction>, Root<JsFunction>)>>,
                    }

                    impl AsyncState {
                        fn send_once(&self, value: Result<JsValueBridge, JsValueBridge>) {
                            let tx_opt = self.reply.lock().ok().and_then(|mut g| g.take());
                            if let Some(tx) = tx_opt {
                                let _ = tx.send(value);
                            }
                        }

                        fn clear_hooks(&self) {
                            let _ = self.hooks.lock().ok().and_then(|mut g| g.take());
                        }
                    }

                    let state = std::sync::Arc::new(AsyncState {
                        reply: std::sync::Mutex::new(Some(reply)),
                        hooks: std::sync::Mutex::new(None),
                    });

                    let func_root = match host_functions.get(func_id) {
                        Some(f) => f.clone(),
                        None => {
                            state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: format!("Unknown host function id {func_id}"),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let func = func_root.to_inner(cx);

                    let mut js_argv: Vec<Handle<JsValue>> = Vec::with_capacity(args.len());
                    for a in &args {
                        let v = crate::bridge::neon_codec::to_neon_value(cx, a)
                            .unwrap_or_else(|_| cx.undefined().upcast());
                        js_argv.push(v);
                    }

                    let this = cx.undefined();

                    let returned = match cx.try_catch(|cx| func.call(cx, this, js_argv.as_slice())) {
                        Ok(v) => v,
                        Err(thrown) => {
                            state.send_once(Err(thrown_to_bridge(cx, thrown)));
                            state.clear_hooks();
                            return Ok(());
                        }
                    };

                    let is_promise = returned.is_a::<neon::types::JsPromise, _>(cx);

                    if !is_promise {
                        match crate::bridge::neon_codec::from_neon_value(cx, returned) {
                            Ok(b) => state.send_once(Ok(b)),
                            Err(e) => state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: e.to_string(),
                                stack: None,
                                code: None,
                            })),
                        }
                        return Ok(());
                    }

                    let promise_obj: Handle<JsObject> = match returned.downcast::<JsObject, _>(cx) {
                        Ok(o) => o,
                        Err(_) => {
                            state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: "Async host function returned a non-object promise".into(),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let then_fn: Handle<JsFunction> =
                        match cx.try_catch(|cx| promise_obj.get::<JsFunction, _, _>(cx, "then")) {
                            Ok(f) => f,
                            Err(_) => {
                                state.send_once(Err(JsValueBridge::Error {
                                    name: "HostFunctionError".into(),
                                    message: "Promise.then lookup failed".into(),
                                    stack: None,
                                    code: None,
                                }));
                                return Ok(());
                            }
                        };

                    let state_ok = state.clone();
                    let on_fulfilled = JsFunction::new(cx, move |mut cx| {
                        let v = cx.argument::<JsValue>(0)?;
                        let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, v).unwrap_or_else(|e| {
                            JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: e.to_string(),
                                stack: None,
                                code: None,
                            }
                        });

                        state_ok.send_once(Ok(bridged));
                        state_ok.clear_hooks();
                        Ok(cx.undefined())
                    })?;

                    let state_err = state.clone();
                    let on_rejected = JsFunction::new(cx, move |mut cx| {
                        let v = cx.argument::<JsValue>(0)?;
                        let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, v).unwrap_or_else(|e| {
                            JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: e.to_string(),
                                stack: None,
                                code: None,
                            }
                        });

                        state_err.send_once(Err(bridged));
                        state_err.clear_hooks();
                        Ok(cx.undefined())
                    })?;

                    {
                        let f_root = on_fulfilled.root(cx);
                        let r_root = on_rejected.root(cx);
                        if let Ok(mut g) = state.hooks.lock() {
                            *g = Some((f_root, r_root));
                        }
                    }

                    let (on_fulfilled_handle, on_rejected_handle) = {
                        let g = state.hooks.lock().ok().and_then(|g| g.as_ref().map(|(f, r)| (f.clone(cx), r.clone(cx))));
                        match g {
                            Some((f, r)) => (f.to_inner(cx), r.to_inner(cx)),
                            None => (on_fulfilled, on_rejected),
                        }
                    };

                    let attached = cx.try_catch(|cx| {
                        let args: Vec<Handle<JsValue>> = vec![
                            on_fulfilled_handle.upcast::<JsValue>(),
                            on_rejected_handle.upcast::<JsValue>(),
                        ];
                        let _ = then_fn.call(cx, promise_obj, args.as_slice())?;
                        Ok(())
                    });

                    if attached.is_err() {
                        state.send_once(Err(JsValueBridge::Error {
                            name: "HostFunctionError".into(),
                            message: "Promise.then invocation failed".into(),
                            stack: None,
                            code: None,
                        }));
                        state.clear_hooks();
                    }

                    Ok(())
                }
            });

            let _ = _outer;
        }));

        Ok(())
    });
}

pub async fn handle_deno_msg(
    worker: &mut MainWorker,
    worker_id: usize,
    limits: &RuntimeLimits,
    msg: DenoMsg,
) -> bool {
    match msg {
        DenoMsg::Close { deferred } => {
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

        DenoMsg::Memory { deferred } => {
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

        DenoMsg::PostMessage { value } => {
            let payload = serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
                .unwrap_or_else(|_| "null".into());
            let script =
                format!("globalThis.__dispatchNodeMessage(globalThis.__hydrate({payload}))");

            let _ = worker.js_runtime.execute_script("<postMessage>", script);
            false
        }

        // DenoMsg::Pump { deferred } => {
        //     let res = worker.run_event_loop(false).await;

        //     match res {
        //         Ok(()) => deferred.resolve_with_value_via_channel(JsValueBridge::Undefined),
        //         Err(e) => deferred.reject_with_error(e.to_string()),
        //     }

        //     false
        // }
        DenoMsg::SetGlobal {
            key,
            value,
            deferred,
        } => {
            let json = serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
                .unwrap_or_else(|_| "null".into());
            let key_json = serde_json::to_string(&key).unwrap_or_else(|_| "\"\"".into());
            let script =
                format!("globalThis.__globals[{key_json}] = {json}; globalThis.__applyGlobals();");

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
                        let err = JsValueBridge::Error {
                            name: "Error".into(),
                            message: e.to_string(),
                            stack: None,
                            code: None,
                        };
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

        DenoMsg::Eval {
            source,
            options,
            deferred,
            sync_reply,
        } => {
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
    }
}

async fn send_node_msg_or_reject(node_tx: &mpsc::Sender<NodeMsg>, msg: NodeMsg) {
    if let Err(send_err) = node_tx.send(msg).await {
        if let NodeMsg::Resolve { settler, .. } = send_err.0 {
            settler.reject_with_error("Node thread is unavailable");
        }
    }
}

pub fn get_node_tx(worker_id: usize) -> Option<mpsc::Sender<NodeMsg>> {
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
