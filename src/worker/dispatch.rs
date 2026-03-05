use neon::prelude::*;

use crate::bridge::types::JsValueBridge;
use crate::worker::messages::{NodeMsg, ResolvePayload};

mod deno_commands;
mod node_events;
mod node_host_calls;
mod node_imports;

pub use deno_commands::handle_deno_msg;

/// Dispatch node msg.
pub fn dispatch_node_msg(worker_id: usize, msg: NodeMsg) {
    // Snapshot callback/function roots under lock, then release the lock before
    // scheduling onto the Neon channel to avoid lock inversion with callbacks.
    let (channel, handle_snapshot) = match crate::WORKERS.read() {
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
        // Dispatch must not unwind through Neon channel boundary.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _outer = cx.try_catch(|cx| match msg {
                NodeMsg::Resolve { settler, payload } => {
                    if let ResolvePayload::Result { stats, .. } = &payload {
                        if let Ok(mut g) = last_stats.lock() {
                            *g = Some(stats.clone());
                        }
                    }

                    match payload {
                        ResolvePayload::Void => {
                            settler.resolve_with_value_in_cx(cx, &JsValueBridge::Null)
                        }
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

                NodeMsg::ImportRequest {
                    specifier,
                    referrer,
                    is_dynamic_import,
                    reply,
                } => node_imports::handle_import_request(
                    cx,
                    &callbacks,
                    specifier,
                    referrer,
                    is_dynamic_import,
                    reply,
                ),

                NodeMsg::EmitMessage { value } => {
                    node_events::handle_emit_message(cx, &callbacks, value)
                }

                NodeMsg::EmitClose => node_events::handle_emit_close(cx, worker_id, &callbacks),
                NodeMsg::EmitRuntimeEvent { value } => {
                    node_events::handle_emit_runtime(cx, &callbacks, value)
                }

                NodeMsg::InvokeHostFunctionSync {
                    func_id,
                    args,
                    reply,
                } => node_host_calls::handle_invoke_sync(
                    cx,
                    host_functions.as_slice(),
                    func_id,
                    args,
                    reply,
                ),

                NodeMsg::InvokeHostFunctionAsync {
                    func_id,
                    args,
                    reply,
                } => node_host_calls::handle_invoke_async(
                    cx,
                    host_functions.as_slice(),
                    func_id,
                    args,
                    reply,
                ),
            });

            let _ = _outer;
        }));

        Ok(())
    });
}
