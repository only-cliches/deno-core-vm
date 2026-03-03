use neon::prelude::*;

use crate::bridge::types::JsValueBridge;
use crate::worker::state::NodeCallbacks;

pub fn handle_emit_message(
    cx: &mut TaskContext,
    callbacks: &NodeCallbacks,
    value: JsValueBridge,
) -> NeonResult<()> {
    // No-op when user did not register on("message").
    let Some(cb_root) = callbacks.on_message.as_ref() else {
        return Ok(());
    };

    let cb = cb_root.to_inner(cx);
    let arg = crate::bridge::neon_codec::to_neon_value(cx, &value)
        .unwrap_or_else(|_| cx.undefined().upcast());

    let this = cx.undefined();
    // User callback errors are swallowed to keep bridge delivery alive.
    let _ = cx.try_catch(|cx| {
        cb.call(cx, this, &[arg])?;
        Ok(())
    });

    Ok(())
}

pub fn handle_emit_close(
    cx: &mut TaskContext,
    worker_id: usize,
    callbacks: &NodeCallbacks,
) -> NeonResult<()> {
    if let Some(cb_root) = callbacks.on_close.as_ref() {
        let cb = cb_root.to_inner(cx);
        let this = cx.undefined();
        let _ = cx.try_catch(|cx| {
            cb.call(cx, this, &[])?;
            Ok(())
        });
    }

    // Close event is terminal for this handle; remove from global registry.
    if let Ok(mut map) = crate::WORKERS.write() {
        let _ = map.remove(&worker_id);
    }

    Ok(())
}
