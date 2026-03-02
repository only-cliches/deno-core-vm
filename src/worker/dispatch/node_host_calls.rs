use neon::prelude::*;

use crate::bridge::errors::host_function_error;
use crate::bridge::types::JsValueBridge;

fn get_thenable<'a>(
    cx: &mut TaskContext<'a>,
    v: Handle<'a, JsValue>,
) -> Option<(Handle<'a, JsObject>, Handle<'a, JsFunction>)> {
    // Thenable detection (not strict Promise check) so userland Promise-like values
    // are routed through async callback path as expected.
    let obj = v.downcast::<JsObject, _>(cx).ok()?;
    let then_any = obj.get_value(cx, "then").ok()?;
    let then_fn = then_any.downcast::<JsFunction, _>(cx).ok()?;
    Some((obj, then_fn))
}

fn thrown_to_bridge<'a>(cx: &mut TaskContext<'a>, thrown: Handle<'a, JsValue>) -> JsValueBridge {
    match crate::bridge::neon_codec::from_neon_value(cx, thrown) {
        Ok(JsValueBridge::Error {
            name,
            message,
            stack,
            code,
            ..
        }) => JsValueBridge::Error {
            name: if name.is_empty() {
                "HostFunctionError".into()
            } else {
                name
            },
            message,
            stack,
            code,
            cause: None,
        },
        Ok(JsValueBridge::String(s)) => host_function_error(s),
        Ok(other) => host_function_error(format!("{:?}", other)),
        Err(e) => host_function_error(e.to_string()),
    }
}

pub fn handle_invoke_sync(
    cx: &mut TaskContext,
    host_functions: &[std::sync::Arc<Root<JsFunction>>],
    func_id: usize,
    args: Vec<JsValueBridge>,
    reply: std::sync::mpsc::Sender<Result<JsValueBridge, JsValueBridge>>,
) -> NeonResult<()> {
    let send = |v: Result<JsValueBridge, JsValueBridge>| {
        let _ = reply.send(v);
    };

    let func_root = match host_functions.get(func_id) {
        Some(f) => f.clone(),
        None => {
            send(Err(host_function_error(format!(
                "Unknown host function id {func_id}"
            ))));
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

    if v.is_a::<neon::types::JsPromise, _>(cx) || get_thenable(cx, v).is_some() {
        if let Some((obj, then_fn)) = get_thenable(cx, v) {
            let on_ok = JsFunction::new(cx, |mut cx| Ok(cx.undefined()))?;
            let on_err = JsFunction::new(cx, |mut cx| Ok(cx.undefined()))?;
            let _ = cx.try_catch(|cx| {
                let args: Vec<Handle<JsValue>> = vec![on_ok.upcast(), on_err.upcast()];
                let _ = then_fn.call(cx, obj, args.as_slice())?;
                Ok(())
            });
        }

        // Sync bridge forbids async return values to prevent deadlock and preserve
        // deterministic call semantics for worker sync op handlers.
        send(Err(host_function_error(
            "Sync host function returned a Promise; use async host function instead",
        )));
        return Ok(());
    }

    match crate::bridge::neon_codec::from_neon_value(cx, v) {
        Ok(b) => send(Ok(b)),
        Err(e) => send(Err(host_function_error(e.to_string()))),
    }

    Ok(())
}

pub fn handle_invoke_async(
    cx: &mut TaskContext,
    host_functions: &[std::sync::Arc<Root<JsFunction>>],
    func_id: usize,
    args: Vec<JsValueBridge>,
    reply: tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>,
) -> NeonResult<()> {
    struct AsyncState {
        reply: std::sync::Mutex<
            Option<tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>>,
        >,
        hooks: std::sync::Mutex<Option<(Root<JsFunction>, Root<JsFunction>)>>,
    }

    impl AsyncState {
        fn send_once(&self, value: Result<JsValueBridge, JsValueBridge>) {
            // Ensure only first settle wins even if user promise resolves/rejects multiple times.
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
            state.send_once(Err(host_function_error(format!(
                "Unknown host function id {func_id}"
            ))));
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

    let thenable = get_thenable(cx, returned);
    if thenable.is_none() {
        // Non-thenable return is valid for async host bridge: resolve immediately.
        match crate::bridge::neon_codec::from_neon_value(cx, returned) {
            Ok(b) => state.send_once(Ok(b)),
            Err(e) => state.send_once(Err(host_function_error(e.to_string()))),
        }
        return Ok(());
    }

    if thenable.is_none() {
        state.send_once(Err(host_function_error(
            "Async host function returned a non-thenable",
        )));
        return Ok(());
    }

    let promise_obj: Handle<JsObject> = match returned.downcast::<JsObject, _>(cx) {
        Ok(o) => o,
        Err(_) => {
            state.send_once(Err(host_function_error(
                "Async host function returned a non-object promise",
            )));
            return Ok(());
        }
    };

    let then_fn: Handle<JsFunction> =
        match cx.try_catch(|cx| promise_obj.get::<JsFunction, _, _>(cx, "then")) {
            Ok(f) => f,
            Err(_) => {
                state.send_once(Err(host_function_error("Promise.then lookup failed")));
                return Ok(());
            }
        };

    let state_ok = state.clone();
    let on_fulfilled = JsFunction::new(cx, move |mut cx| {
        let v = cx.argument::<JsValue>(0)?;
        let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, v)
            .unwrap_or_else(|e| host_function_error(e.to_string()));

        state_ok.send_once(Ok(bridged));
        state_ok.clear_hooks();
        Ok(cx.undefined())
    })?;

    let state_err = state.clone();
    let on_rejected = JsFunction::new(cx, move |mut cx| {
        let v = cx.argument::<JsValue>(0)?;
        let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, v)
            .unwrap_or_else(|e| host_function_error(e.to_string()));

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
        state.send_once(Err(host_function_error("Promise.then invocation failed")));
        state.clear_hooks();
    }

    Ok(())
}
