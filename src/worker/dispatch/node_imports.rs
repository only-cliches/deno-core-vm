use neon::prelude::*;

use crate::worker::messages::ImportDecision;
use crate::worker::state::NodeCallbacks;

struct ImportState {
    reply: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<ImportDecision>>>,
    hooks: std::sync::Mutex<Option<(Root<JsFunction>, Root<JsFunction>)>>,
}

impl ImportState {
    // Send once.
    fn send_once(&self, value: ImportDecision) {
        // Guard against double-settle when callback misbehaves.
        let tx_opt = self.reply.lock().ok().and_then(|mut g| g.take());
        if let Some(tx) = tx_opt {
            let _ = tx.send(value);
        }
    }

    // Clear hooks.
    fn clear_hooks(&self) {
        let _ = self.hooks.lock().ok().and_then(|mut g| g.take());
    }
}

// Interpret value.
fn interpret_value(cx: &mut TaskContext, v: Handle<JsValue>) -> Option<ImportDecision> {
    // Promise is handled by async branch in handle_import_request.
    if v.is_a::<neon::types::JsPromise, _>(cx) {
        return None;
    }

    if let Ok(s) = v.downcast::<JsString, _>(cx) {
        return Some(ImportDecision::SourceTyped {
            ext: "js".into(),
            code: s.value(cx),
        });
    }

    if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
        return Some(if b.value(cx) {
            ImportDecision::AllowDisk
        } else {
            ImportDecision::Block
        });
    }

    let Ok(obj) = v.downcast::<JsObject, _>(cx) else {
        return None;
    };

    if let Ok(rv) = obj.get_value(cx, "resolve") {
        if let Ok(rs) = rv.downcast::<JsString, _>(cx) {
            let s = rs.value(cx).trim().to_string();
            if s.is_empty() {
                return Some(ImportDecision::Block);
            }
            return Some(ImportDecision::Resolve(s));
        }
    }

    if let Ok(source_val) = obj.get_value(cx, "src") {
        if let Ok(source_str) = source_val.downcast::<JsString, _>(cx) {
            let mut loader = "js".to_string();
            if let Ok(loader_val) = obj.get_value(cx, "srcLoader") {
                if let Ok(loader_str) = loader_val.downcast::<JsString, _>(cx) {
                    let maybe_loader = loader_str.value(cx);
                    if matches!(maybe_loader.as_str(), "js" | "ts" | "tsx" | "jsx") {
                        loader = maybe_loader;
                    } else {
                        return Some(ImportDecision::Block);
                    }
                } else if !(loader_val.is_a::<JsUndefined, _>(cx) || loader_val.is_a::<JsNull, _>(cx)) {
                    return Some(ImportDecision::Block);
                }
            }
            return Some(ImportDecision::SourceTyped {
                ext: loader,
                code: source_str.value(cx),
            });
        }
    }

    None
}

/// Handle import request.
pub fn handle_import_request(
    cx: &mut TaskContext,
    callbacks: &NodeCallbacks,
    specifier: String,
    referrer: String,
    is_dynamic_import: bool,
    reply: tokio::sync::oneshot::Sender<ImportDecision>,
) -> NeonResult<()> {
    if std::env::var("DENOJS_WORKER_DEBUG_IMPORTS").is_ok() {
        println!(
            "[denojs-worker][imports] NodeMsg::ImportRequest specifier={} referrer={} is_dynamic_import={}",
            specifier, referrer, is_dynamic_import
        );
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
    let js_dynamic = cx.boolean(is_dynamic_import);

    let this = cx.undefined();
    let returned = match cx.try_catch(|cx| {
        cb.call(
            cx,
            this,
            &[js_spec.upcast(), js_ref.upcast(), js_dynamic.upcast()],
        )
    }) {
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
        // Async import callback path: attach then/catch and resolve once.
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
