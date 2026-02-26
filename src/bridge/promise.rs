use neon::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::{bridge::types::JsValueBridge, dw_log};

static NEXT_PROMISE_ID: AtomicU64 = AtomicU64::new(1);

/// If a Deferred is dropped while unsettled, Neon reports loudly.
/// This guard ensures that if a scheduled task never runs, we leak the Deferred
/// rather than dropping it unsettled.
struct DeferredGuard {
    deferred: Option<neon::types::Deferred>,
    id: u64,
    tag: &'static str,
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
    fn new(deferred: neon::types::Deferred, id: u64, tag: &'static str) -> Self {
        Self {
            deferred: Some(deferred),
            id,
            tag,
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
            dw_log!(
                "[PromiseSettler:guard_drop_leak] id={} tag={} (task never ran or enqueue failed)",
                self.id,
                self.tag
            );
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
    id: u64,
    tag: &'static str,
    deferred: Option<neon::types::Deferred>,
    channel: Channel,
}

impl PromiseSettler {
    pub fn new(deferred: neon::types::Deferred, channel: Channel, tag: &'static str) -> Self {
        let id = NEXT_PROMISE_ID.fetch_add(1, Ordering::Relaxed);
        dw_log!("[PromiseSettler:new] id={} tag={}", id, tag);
        Self {
            id,
            tag,
            deferred: Some(deferred),
            channel,
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn tag(&self) -> &'static str {
        self.tag
    }

    fn take_deferred(&mut self) -> Option<neon::types::Deferred> {
        self.deferred.take()
    }

    fn try_send_task<F>(&self, deferred: neon::types::Deferred, what: &'static str, f: F)
    where
        F: for<'a> FnOnce(&mut TaskContext<'a>, neon::types::Deferred) + Send + 'static,
    {
        let id = self.id;
        let tag = self.tag;

        dw_log!("[PromiseSettler:enqueue] id={} tag={} op={}", id, tag, what);

        // Put deferred behind a guard so if enqueue fails, Drop leaks it.
        let mut guard = DeferredGuard::new(deferred, id, tag);

        let res = self.channel.try_send(move |mut cx| {
            dw_log!(
                "[PromiseSettler:task_run] id={} tag={} op={}",
                id,
                tag,
                what
            );
            let d = guard.take();
            f(&mut cx, d);
            Ok(())
        });

        if res.is_err() {
            // Closure (with guard) is dropped here, guard Drop logs + leaks deferred.
            dw_log!(
                "[PromiseSettler:enqueue_failed] id={} tag={} op={}",
                id,
                tag,
                what
            );
        }
    }

    // -----------------------
    // Background-thread APIs
    // -----------------------

    pub fn reject_with_error(mut self, message: impl Into<String>) {
        let Some(deferred) = self.take_deferred() else {
            dw_log!(
                "[PromiseSettler:reject_with_error] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        let id = self.id;
        let tag = self.tag;
        let message = message.into();

        dw_log!(
            "[PromiseSettler:reject_with_error] id={} tag={} msg={}",
            id,
            tag,
            message
        );

        self.try_send_task(deferred, "reject_with_error", move |cx, deferred| {
            let err_val: Handle<JsValue> = match cx.error(message) {
                Ok(e) => e.upcast(),
                Err(_) => cx.string("Promise rejected").upcast(),
            };
            deferred.reject(cx, err_val);
            dw_log!(
                "[PromiseSettler:settled] id={} tag={} op=reject_with_error",
                id,
                tag
            );
        });
    }
    pub fn resolve_with_value_via_channel(mut self, value: JsValueBridge) {
        let Some(deferred) = self.take_deferred() else {
            dw_log!(
                "[PromiseSettler:resolve_via_channel] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        let id = self.id;
        let tag = self.tag;

        dw_log!("[PromiseSettler:resolve_via_channel] id={} tag={}", id, tag);

        self.try_send_task(
            deferred,
            "resolve_with_value_via_channel",
            move |cx, deferred| {
                // IMPORTANT: run conversion inside try_catch so a Throw does not leave
                // a pending exception in this Channel callback.
                let v: Handle<JsValue> = cx
                    .try_catch(|cx| crate::bridge::neon_codec::to_neon_value(cx, &value))
                    .unwrap_or_else(|_| cx.undefined().upcast());

                deferred.resolve(cx, v);

                dw_log!(
                    "[PromiseSettler:settled] id={} tag={} op=resolve_via_channel",
                    id,
                    tag
                );
            },
        );
    }

    pub fn reject_with_value_via_channel(mut self, value: JsValueBridge) {
        let Some(deferred) = self.take_deferred() else {
            dw_log!(
                "[PromiseSettler:reject_via_channel] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        let id = self.id;
        let tag = self.tag;

        dw_log!("[PromiseSettler:reject_via_channel] id={} tag={}", id, tag);

        self.try_send_task(
            deferred,
            "reject_with_value_via_channel",
            move |cx, deferred| {
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

                dw_log!(
                    "[PromiseSettler:settled] id={} tag={} op=reject_via_channel",
                    id,
                    tag
                );
            },
        );
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
            dw_log!(
                "[PromiseSettler:resolve_in_cx] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        dw_log!(
            "[PromiseSettler:resolve_in_cx] id={} tag={}",
            self.id,
            self.tag
        );

        let v = safe_to_neon(cx, value);
        deferred.resolve(cx, v);

        dw_log!(
            "[PromiseSettler:settled] id={} tag={} op=resolve_in_cx",
            self.id,
            self.tag
        );
    }

    pub fn reject_with_value_in_cx<'a, C: Context<'a>>(
        mut self,
        cx: &mut C,
        value: &JsValueBridge,
    ) {
        let Some(deferred) = self.take_deferred() else {
            dw_log!(
                "[PromiseSettler:reject_in_cx] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        dw_log!(
            "[PromiseSettler:reject_in_cx] id={} tag={}",
            self.id,
            self.tag
        );

        let v = cx
            .try_catch(|cx| crate::bridge::neon_codec::to_neon_value(cx, value))
            .unwrap_or_else(|_| {
                cx.error("Promise rejected")
                    .map(|e| e.upcast())
                    .unwrap_or_else(|_| cx.string("Promise rejected").upcast())
            });

        deferred.reject(cx, v);

        dw_log!(
            "[PromiseSettler:settled] id={} tag={} op=reject_in_cx",
            self.id,
            self.tag
        );
    }

    pub fn resolve_with_json_in_cx<'a, C: Context<'a>>(mut self, cx: &mut C, json_text: &str) {
        let Some(deferred) = self.take_deferred() else {
            dw_log!(
                "[PromiseSettler:resolve_json_in_cx] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        dw_log!(
            "[PromiseSettler:resolve_json_in_cx] id={} tag={}",
            self.id,
            self.tag
        );

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

        dw_log!(
            "[PromiseSettler:settled] id={} tag={} op=resolve_json_in_cx",
            self.id,
            self.tag
        );
    }

    pub fn reject_with_error_in_cx<'a, C: Context<'a>>(
        mut self,
        cx: &mut C,
        message: impl AsRef<str>,
    ) {
        let Some(deferred) = self.take_deferred() else {
            dw_log!(
                "[PromiseSettler:reject_error_in_cx] id={} tag={} (already taken)",
                self.id,
                self.tag
            );
            return;
        };

        let msg = message.as_ref();
        dw_log!(
            "[PromiseSettler:reject_error_in_cx] id={} tag={} msg={}",
            self.id,
            self.tag,
            msg
        );

        let err_handle: Handle<JsValue> = cx
            .error(msg)
            .map(|e| e.upcast())
            .unwrap_or_else(|_| cx.string(msg).upcast());

        deferred.reject(cx, err_handle);

        dw_log!(
            "[PromiseSettler:settled] id={} tag={} op=reject_error_in_cx",
            self.id,
            self.tag
        );
    }
}

impl Drop for PromiseSettler {
    fn drop(&mut self) {
        let Some(deferred) = self.deferred.take() else {
            return;
        };

        let id = self.id;
        let tag = self.tag;

        dw_log!(
            "[PromiseSettler:drop_unsettled] id={} tag={} -> scheduling reject-on-drop",
            id,
            tag
        );

        // Reject on drop. If we cannot enqueue, the guard leaks the Deferred.
        let mut guard = DeferredGuard::new(deferred, id, tag);

        let res = self.channel.try_send(move |mut cx| {
            dw_log!(
                "[PromiseSettler:drop_task_run] id={} tag={} -> rejecting",
                id,
                tag
            );

            let deferred = guard.take();
            let err_handle: Handle<JsValue> = cx
                .error("Internal error: promise was dropped without being settled")
                .map(|e| e.upcast())
                .unwrap_or_else(|_| cx.string("Internal error").upcast());

            deferred.reject(&mut cx, err_handle);

            dw_log!(
                "[PromiseSettler:settled] id={} tag={} op=drop_reject",
                id,
                tag
            );

            Ok(())
        });

        if res.is_err() {
            dw_log!(
                "[PromiseSettler:drop_enqueue_failed] id={} tag={} (will leak via guard)",
                id,
                tag
            );
        }
    }
}