use deno_runtime::deno_core::{OpState, op2};
use std::io;
use tokio::sync::oneshot;

use crate::bridge::types::JsValueBridge;
use crate::worker::messages::NodeMsg;
use crate::worker::runtime::WorkerOpContext;

#[op2]
#[serde]
pub fn op_post_message(
    state: &mut OpState,
    #[serde] msg: serde_json::Value,
) -> Result<(), io::Error> {
    let ctx = state.borrow::<WorkerOpContext>().clone();
    let value = JsValueBridge::Json(msg);
    let _ = ctx.node_tx.try_send(NodeMsg::EmitMessage { value });
    Ok(())
}

#[op2]
#[serde]
pub fn op_host_call_sync(
    state: &mut OpState,
    #[smi] func_id: i32,
    #[serde] args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, io::Error> {
    use std::sync::mpsc;
    use std::time::Duration;

    let ctx = state.borrow::<WorkerOpContext>().clone();
    let bridged_args = args.into_iter().map(JsValueBridge::Json).collect::<Vec<_>>();

    let (tx, rx) = mpsc::channel::<Result<JsValueBridge, JsValueBridge>>();

    ctx.node_tx
        .try_send(NodeMsg::InvokeHostFunctionSync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        })
        .map_err(|_| io::Error::other("node channel full or closed"))?;

    // Sync semantics with timeout to avoid deadlock.
    let reply = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| io::Error::other("sync host call timed out"))?;

    match reply {
        Ok(v) => Ok(serde_json::json!({ "ok": true, "value": to_json_reply(v) })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": to_json_reply(e) })),
    }
}

#[op2(async(lazy))]
#[serde]
pub async fn op_host_call_async(
    state: std::rc::Rc<std::cell::RefCell<OpState>>,
    #[smi] func_id: i32,
    #[serde] args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, io::Error> {
    let ctx = state.borrow().borrow::<WorkerOpContext>().clone();
    let (tx, rx) = oneshot::channel();

    let bridged_args = args.into_iter().map(JsValueBridge::Json).collect();

    ctx.node_tx
        .send(NodeMsg::InvokeHostFunctionAsync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        })
        .await
        .map_err(|_| io::Error::other("node channel closed"))?;

    let reply = rx.await.map_err(|_| io::Error::other("reply dropped"))?;

    match reply {
        Ok(v) => Ok(serde_json::json!({ "ok": true, "value": to_json_reply(v) })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": to_json_reply(e) })),
    }
}

fn to_json_reply(v: JsValueBridge) -> serde_json::Value {
    match v {
        JsValueBridge::Undefined => serde_json::Value::Null,
        JsValueBridge::Null => serde_json::Value::Null,
        JsValueBridge::Bool(b) => serde_json::json!(b),
        JsValueBridge::Number(n) => serde_json::json!(n),
        JsValueBridge::String(s) => serde_json::json!(s),
        JsValueBridge::DateMs(ms) => serde_json::json!({ "__date": ms }),
        JsValueBridge::Bytes(b) => serde_json::json!({ "__bytes": b }),
        JsValueBridge::Json(v) => v,
        JsValueBridge::V8Serialized(b) => serde_json::json!({ "__v8": b }),
        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
        } => serde_json::json!({
            "name": name,
            "message": message,
            "stack": stack,
            "code": code,
            "__denojs_worker_type": "error"
        }),
        JsValueBridge::HostFunction { id, is_async } => serde_json::json!({
            "__denojs_worker_type": "function",
            "id": id,
            "async": is_async
        }),
    }
}
