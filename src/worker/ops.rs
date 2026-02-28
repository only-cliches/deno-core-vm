// src/worker/ops.rs
use deno_runtime::deno_core::{op2, OpState};
use tokio::sync::oneshot;

use crate::bridge::types::JsValueBridge;
use crate::worker::messages::NodeMsg;
use crate::worker::runtime::WorkerOpContext;

fn err_wire(name: &str, message: impl Into<String>) -> serde_json::Value {
    let e = JsValueBridge::Error {
        name: name.into(),
        message: message.into(),
        stack: None,
        code: None,
    };
    crate::bridge::wire::to_wire_json(&e)
}

fn ok_wire(value: JsValueBridge) -> serde_json::Value {
    crate::bridge::wire::to_wire_json(&value)
}

fn ctx_from_state(state: &OpState) -> Option<WorkerOpContext> {
    state.try_borrow::<WorkerOpContext>().cloned()
}

// Worker -> Node: hostPostMessage() op
#[op2]
pub fn op_denojs_worker_post_message(state: &mut OpState, #[serde] msg: serde_json::Value) -> bool {
    let Some(ctx) = ctx_from_state(state) else {
        return false;
    };

    let value: JsValueBridge = crate::bridge::wire::from_wire_json(msg);

    ctx.node_tx.try_send(NodeMsg::EmitMessage { value }).is_ok()
}

// Worker -> Node: host function call (sync)
#[op2]
#[serde]
pub fn op_denojs_worker_host_call_sync(
    state: &mut OpState,
    #[smi] func_id: i32,
    #[serde] args: Vec<serde_json::Value>,
) -> serde_json::Value {
    use std::sync::mpsc;
    use std::time::Duration;

    let Some(ctx) = ctx_from_state(state) else {
        return serde_json::json!({
            "ok": false,
            "error": err_wire("OpStateError", "WorkerOpContext missing in OpState")
        });
    };

    let bridged_args = args
        .into_iter()
        .map(crate::bridge::wire::from_wire_json)
        .collect::<Vec<_>>();

    let (tx, rx) = mpsc::channel::<Result<JsValueBridge, JsValueBridge>>();

    if ctx
        .node_tx
        .try_send(NodeMsg::InvokeHostFunctionSync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        })
        .is_err()
    {
        return serde_json::json!({
            "ok": false,
            "error": err_wire("HostFunctionError", "Node channel full or closed")
        });
    }

    let reply = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(v) => v,
        Err(_) => {
            return serde_json::json!({
                "ok": false,
                "error": err_wire("HostFunctionError", "Sync host call timed out")
            });
        }
    };

    match reply {
        Ok(v) => serde_json::json!({ "ok": true, "value": ok_wire(v) }),
        Err(e) => serde_json::json!({ "ok": false, "error": ok_wire(e) }),
    }
}

// Worker -> Node: host function call (async)
#[op2(async(lazy))]
#[serde]
pub async fn op_denojs_worker_host_call_async(
    state: std::rc::Rc<std::cell::RefCell<OpState>>,
    #[smi] func_id: i32,
    #[serde] args: Vec<serde_json::Value>,
) -> serde_json::Value {
    let ctx = match state.borrow().try_borrow::<WorkerOpContext>() {
        Some(v) => v.clone(),
        None => {
            return serde_json::json!({
                "ok": false,
                "error": err_wire("OpStateError", "WorkerOpContext missing in OpState")
            });
        }
    };

    let bridged_args = args
        .into_iter()
        .map(crate::bridge::wire::from_wire_json)
        .collect::<Vec<_>>();

    let (tx, rx) = oneshot::channel::<Result<JsValueBridge, JsValueBridge>>();

    if ctx
        .node_tx
        .send(NodeMsg::InvokeHostFunctionAsync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        })
        .await
        .is_err()
    {
        return serde_json::json!({
            "ok": false,
            "error": err_wire("HostFunctionError", "Node channel closed")
        });
    }

    let reply = match rx.await {
        Ok(v) => v,
        Err(_) => {
            return serde_json::json!({
                "ok": false,
                "error": err_wire("HostFunctionError", "Async reply dropped")
            });
        }
    };

    match reply {
        Ok(v) => serde_json::json!({ "ok": true, "value": ok_wire(v) }),
        Err(e) => serde_json::json!({ "ok": false, "error": ok_wire(e) }),
    }
}