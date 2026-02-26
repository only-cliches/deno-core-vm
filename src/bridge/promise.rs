use neon::prelude::*;

use crate::bridge::types::JsValueBridge;

/// If a Deferred is dropped while unsettled, Neon reports loudly.
/// This guard ensures that if a scheduled task never runs, we leak the Deferred
/// rather than dropping it unsettled.
struct DeferredGuard {
    deferred: Option<neon::types::Deferred>,
}

fn safe_to_neon<'a, C: Context<'a>>(
    cx: &mut C,
    value: &crate::bridge::types::JsValueBridge,
) -> Handle<'a, JsValue> {
    // Crucial: try_catch clears pending exceptions. Without it, a Throw returned from
    // to_neon_value leaves a pending JS exception, and Deferred::resolve panics.
    cx.try_catch(|cx| crate::bridge::neon_codec::to_neon_value(cx, value))
        .unwrap_or_else(|_| cx.undefined().upcast())
}

impl DeferredGuard {
    fn new(deferred: neon::types::Deferred) -> Self {
        Self {
            deferred: Some(deferred),
        }
    }

    fn take(&mut self) -> neon::types::Deferred {
        self.deferred.take().expect("deferred already taken")
    }
}

impl Drop for DeferredGuard {
    fn drop(&mut self) {
        if let Some(d) = self.deferred.take() {
            // Last-resort: avoid "Deferred dropped without being settled"
            std::mem::forget(d);
        }
    }
}

/// Settles a Neon Promise from either:
/// - an active JS context (`*_in_cx`)
/// - a background thread (`*_via_channel`)
///
/// Invariant: never drop an unsettled Deferred.
pub struct PromiseSettler {
    deferred: Option<neon::types::Deferred>,
    channel: Channel,
}

impl PromiseSettler {
    pub fn new(deferred: neon::types::Deferred, channel: Channel) -> Self {
        Self {
            deferred: Some(deferred),
            channel,
        }
    }

    fn take_deferred(&mut self) -> Option<neon::types::Deferred> {
        self.deferred.take()
    }

    fn try_send_task<F>(&self, deferred: neon::types::Deferred, f: F)
    where
        F: for<'a> FnOnce(&mut TaskContext<'a>, neon::types::Deferred) + Send + 'static,
    {
        // Put deferred behind a guard so if enqueue fails, Drop leaks it.
        let mut guard = DeferredGuard::new(deferred);

        let _ = self.channel.try_send(move |mut cx| {
            let d = guard.take();
            f(&mut cx, d);
            Ok(())
        });
    }

    // -----------------------
    // Background-thread APIs
    // -----------------------

    pub fn reject_with_error(mut self, message: impl Into<String>) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        let message = message.into();

        self.try_send_task(deferred, move |cx, deferred| {
            let err_val: Handle<JsValue> = match cx.error(message) {
                Ok(e) => e.upcast(),
                Err(_) => cx.string("Promise rejected").upcast(),
            };
            deferred.reject(cx, err_val);
        });
    }

    pub fn resolve_with_value_via_channel(mut self, value: JsValueBridge) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        self.try_send_task(deferred, move |cx, deferred| {
            // IMPORTANT: run conversion inside try_catch so a Throw does not leave
            // a pending exception in this Channel callback.
            let v: Handle<JsValue> = cx
                .try_catch(|cx| crate::bridge::neon_codec::to_neon_value(cx, &value))
                .unwrap_or_else(|_| cx.undefined().upcast());

            deferred.resolve(cx, v);
        });
    }

    pub fn reject_with_value_via_channel(mut self, value: JsValueBridge) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        self.try_send_task(deferred, move |cx, deferred| {
            // IMPORTANT: run conversion inside try_catch so a Throw does not leave
            // a pending exception in this Channel callback.
            let v: Handle<JsValue> = cx
                .try_catch(|cx| crate::bridge::neon_codec::to_neon_value(cx, &value))
                .unwrap_or_else(|_| {
                    cx.error("Promise rejected")
                        .map(|e| e.upcast())
                        .unwrap_or_else(|_| cx.string("Promise rejected").upcast())
                });

            deferred.reject(cx, v);
        });
    }

    // -------------------
    // In-context APIs
    // -------------------

    pub fn resolve_with_value_in_cx<'a, C: Context<'a>>(
        mut self,
        cx: &mut C,
        value: &JsValueBridge,
    ) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        let v = safe_to_neon(cx, value);
        deferred.resolve(cx, v);
    }

    pub fn reject_with_value_in_cx<'a, C: Context<'a>>(
        mut self,
        cx: &mut C,
        value: &JsValueBridge,
    ) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        let v = cx
            .try_catch(|cx| crate::bridge::neon_codec::to_neon_value(cx, value))
            .unwrap_or_else(|_| {
                cx.error("Promise rejected")
                    .map(|e| e.upcast())
                    .unwrap_or_else(|_| cx.string("Promise rejected").upcast())
            });

        deferred.reject(cx, v);
    }

    pub fn resolve_with_json_in_cx<'a, C: Context<'a>>(mut self, cx: &mut C, json_text: &str) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        let fallback = cx.string(json_text).upcast::<JsValue>();

        // Catch any thrown exception so Neon never leaves a pending exception in this callback.
        let parsed: Option<Handle<JsValue>> = cx
            .try_catch(|cx| {
                let global_json: Handle<JsObject> = cx.global("JSON")?;
                let parse: Handle<JsFunction> = global_json.get(cx, "parse")?;
                let s = cx.string(json_text);

                // Set `this` to JSON explicitly
                let v = parse
                    .call_with(cx)
                    .this(global_json)
                    .arg(s)
                    .apply::<JsValue, _>(cx)?;

                Ok(v)
            })
            .ok();

        match parsed {
            Some(v) => deferred.resolve(cx, v),
            None => deferred.resolve(cx, fallback),
        }
    }

    pub fn reject_with_error_in_cx<'a, C: Context<'a>>(
        mut self,
        cx: &mut C,
        message: impl AsRef<str>,
    ) {
        let Some(deferred) = self.take_deferred() else {
            return;
        };

        let msg = message.as_ref();
        let err_handle: Handle<JsValue> = cx
            .error(msg)
            .map(|e| e.upcast())
            .unwrap_or_else(|_| cx.string(msg).upcast());

        deferred.reject(cx, err_handle);
    }
}

impl Drop for PromiseSettler {
    fn drop(&mut self) {
        let Some(deferred) = self.deferred.take() else {
            return;
        };

        // Reject on drop. If we cannot enqueue, the guard leaks the Deferred.
        let mut guard = DeferredGuard::new(deferred);

        let _ = self.channel.try_send(move |mut cx| {
            let deferred = guard.take();
            let err_handle: Handle<JsValue> = cx
                .error("Internal error: promise was dropped without being settled")
                .map(|e| e.upcast())
                .unwrap_or_else(|_| cx.string("Internal error").upcast());

            deferred.reject(&mut cx, err_handle);

            Ok(())
        });
    }
}
