use deno_runtime::deno_core::{JsBuffer, OpState, op2};
use tokio::sync::oneshot;

use crate::bridge::types::JsValueBridge;
use crate::worker::env::{EnvRuntimeState, valid_env_key};
use crate::worker::messages::NodeMsg;
use crate::worker::op_reply::{err_reply, err_wire, ok_reply, ok_wire};
use crate::worker::runtime::{SyncNodeDispatchAck, SyncNodeDispatchRequest, WorkerOpContext};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

// Internal helper for runtime<->host op handling; it handles ctx from state.
fn ctx_from_state(state: &OpState) -> Option<WorkerOpContext> {
    state.try_borrow::<WorkerOpContext>().cloned()
}

// Internal helper for runtime<->host op handling; it handles env state from state.
fn env_state_from_state(state: &OpState) -> Option<&EnvRuntimeState> {
    state.try_borrow::<EnvRuntimeState>()
}

// Wraps raw bytes as a `Uint8Array` bridge value for zero-copy-friendly binary dispatch.
fn bytes_to_u8_bridge(bytes: &[u8]) -> JsValueBridge {
    // Keep byte payloads in BufferView form so downstream bridge paths avoid
    // JSON array materialization and can preserve binary throughput.
    JsValueBridge::BufferView {
        kind: "Uint8Array".into(),
        bytes: bytes.to_vec(),
        byte_offset: 0,
        length: bytes.len(),
    }
}

// Returns a wire error reply when host callbacks are attempted during `evalSync`.
fn host_call_blocked_during_evalsync(ctx: &WorkerOpContext) -> Option<serde_json::Value> {
    if ctx.eval_sync_active.load(std::sync::atomic::Ordering::SeqCst) {
        return Some(serde_json::json!({
            "ok": false,
            "error": err_wire(
                "HostFunctionError",
                "Host callbacks are unavailable during evalSync; use eval(...) for cross-runtime calls"
            )
        }));
    }
    None
}

enum NodeSendWaitError {
    Closed,
    TimedOut,
}

// Sends a Node dispatch message and waits for bounded delivery acknowledgment.
fn send_node_msg_wait(
    ctx: &WorkerOpContext,
    msg: NodeMsg,
    timeout: Duration,
) -> Result<(), NodeSendWaitError> {
    let (ack_tx, ack_rx) = std_mpsc::channel::<SyncNodeDispatchAck>();
    if ctx
        .sync_node_dispatch_tx
        .send(SyncNodeDispatchRequest { msg, ack: ack_tx })
        .is_err()
    {
        return Err(NodeSendWaitError::Closed);
    }

    match ack_rx.recv_timeout(timeout) {
        Ok(SyncNodeDispatchAck::Sent) => Ok(()),
        Ok(SyncNodeDispatchAck::Closed) => Err(NodeSendWaitError::Closed),
        Err(std_mpsc::RecvTimeoutError::Timeout) => Err(NodeSendWaitError::TimedOut),
        Err(std_mpsc::RecvTimeoutError::Disconnected) => Err(NodeSendWaitError::Closed),
    }
}

// Worker -> Node: hostPostMessage() op
#[op2]
pub fn op_denojs_worker_post_message(state: &mut OpState, #[serde] msg: serde_json::Value) -> bool {
    let Some(ctx) = ctx_from_state(state) else {
        return false;
    };

    // Input is wire-JSON from bootstrap hostPostMessage wrapper.
    let value: JsValueBridge = crate::bridge::wire::from_wire_json(msg);
    send_node_msg_wait(&ctx, NodeMsg::EmitMessage { value }, Duration::from_secs(2)).is_ok()
}

// Worker -> Node: hostPostMessage() binary fast path
#[op2]
pub fn op_denojs_worker_post_message_bin(state: &mut OpState, #[buffer] msg: JsBuffer) -> bool {
    let Some(ctx) = ctx_from_state(state) else {
        return false;
    };

    let value = bytes_to_u8_bridge(&msg);
    send_node_msg_wait(&ctx, NodeMsg::EmitMessage { value }, Duration::from_secs(2)).is_ok()
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
    if let Some(v) = host_call_blocked_during_evalsync(&ctx) {
        return v;
    }

    let bridged_args = args
        .into_iter()
        .map(crate::bridge::wire::from_wire_json)
        .collect::<Vec<_>>();

    // Sync host calls use std::mpsc because op2 sync handlers cannot await.
    let (tx, rx) = mpsc::channel::<Result<JsValueBridge, JsValueBridge>>();

    if let Err(e) = send_node_msg_wait(
        &ctx,
        NodeMsg::InvokeHostFunctionSync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        },
        Duration::from_secs(5),
    ) {
        let msg = match e {
            NodeSendWaitError::Closed => "Node channel closed",
            NodeSendWaitError::TimedOut => "Node channel saturated",
        };
        return serde_json::json!({
            "ok": false,
            "error": err_wire("HostFunctionError", msg)
        });
    }

    // Bounded wait prevents deadlock if Node callback path stalls.
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

// Worker -> Node: host function call (sync, single Uint8Array arg)
#[op2]
#[serde]
pub fn op_denojs_worker_host_call_sync_bin(
    state: &mut OpState,
    #[smi] func_id: i32,
    #[buffer] arg: JsBuffer,
) -> serde_json::Value {
    use std::sync::mpsc;
    use std::time::Duration;

    let Some(ctx) = ctx_from_state(state) else {
        return serde_json::json!({
            "ok": false,
            "error": err_wire("OpStateError", "WorkerOpContext missing in OpState")
        });
    };
    if let Some(v) = host_call_blocked_during_evalsync(&ctx) {
        return v;
    }

    let bridged_args = vec![bytes_to_u8_bridge(&arg)];
    let (tx, rx) = mpsc::channel::<Result<JsValueBridge, JsValueBridge>>();

    if let Err(e) = send_node_msg_wait(
        &ctx,
        NodeMsg::InvokeHostFunctionSync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        },
        Duration::from_secs(5),
    ) {
        let msg = match e {
            NodeSendWaitError::Closed => "Node channel closed",
            NodeSendWaitError::TimedOut => "Node channel saturated",
        };
        return serde_json::json!({
            "ok": false,
            "error": err_wire("HostFunctionError", msg)
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

// Worker -> Node: host function call (sync, first arg Uint8Array + JSON rest)
#[op2]
#[serde]
pub fn op_denojs_worker_host_call_sync_bin_mixed(
    state: &mut OpState,
    #[smi] func_id: i32,
    #[buffer] arg0: JsBuffer,
    #[serde] rest: Vec<serde_json::Value>,
) -> serde_json::Value {
    use std::sync::mpsc;
    use std::time::Duration;

    let Some(ctx) = ctx_from_state(state) else {
        return serde_json::json!({
            "ok": false,
            "error": err_wire("OpStateError", "WorkerOpContext missing in OpState")
        });
    };
    if let Some(v) = host_call_blocked_during_evalsync(&ctx) {
        return v;
    }

    let mut bridged_args = Vec::with_capacity(rest.len() + 1);
    bridged_args.push(bytes_to_u8_bridge(&arg0));
    bridged_args.extend(rest.into_iter().map(crate::bridge::wire::from_wire_json));

    let (tx, rx) = mpsc::channel::<Result<JsValueBridge, JsValueBridge>>();
    if let Err(e) = send_node_msg_wait(
        &ctx,
        NodeMsg::InvokeHostFunctionSync {
            func_id: func_id as usize,
            args: bridged_args,
            reply: tx,
        },
        Duration::from_secs(5),
    ) {
        let msg = match e {
            NodeSendWaitError::Closed => "Node channel closed",
            NodeSendWaitError::TimedOut => "Node channel saturated",
        };
        return serde_json::json!({
            "ok": false,
            "error": err_wire("HostFunctionError", msg)
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
    if let Some(v) = host_call_blocked_during_evalsync(&ctx) {
        return v;
    }

    let bridged_args = args
        .into_iter()
        .map(crate::bridge::wire::from_wire_json)
        .collect::<Vec<_>>();

    // Async ops can suspend naturally, so oneshot is the lightest reply channel.
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

// Worker -> Node: host function call (async, single Uint8Array arg)
#[op2(async(lazy))]
#[serde]
pub async fn op_denojs_worker_host_call_async_bin(
    state: std::rc::Rc<std::cell::RefCell<OpState>>,
    #[smi] func_id: i32,
    #[buffer] arg: JsBuffer,
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
    if let Some(v) = host_call_blocked_during_evalsync(&ctx) {
        return v;
    }

    let bridged_args = vec![bytes_to_u8_bridge(&arg)];
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

// Worker -> Node: host function call (async, first arg Uint8Array + JSON rest)
#[op2(async(lazy))]
#[serde]
pub async fn op_denojs_worker_host_call_async_bin_mixed(
    state: std::rc::Rc<std::cell::RefCell<OpState>>,
    #[smi] func_id: i32,
    #[buffer] arg0: JsBuffer,
    #[serde] rest: Vec<serde_json::Value>,
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
    if let Some(v) = host_call_blocked_during_evalsync(&ctx) {
        return v;
    }

    let mut bridged_args = Vec::with_capacity(rest.len() + 1);
    bridged_args.push(bytes_to_u8_bridge(&arg0));
    bridged_args.extend(rest.into_iter().map(crate::bridge::wire::from_wire_json));

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

#[op2]
#[serde]
/// Internal helper for runtime<->host op handling; it handles op denojs worker env get.
pub fn op_denojs_worker_env_get(state: &mut OpState, #[string] key: String) -> serde_json::Value {
    let Some(env_state) = env_state_from_state(state) else {
        return err_reply("OpStateError", "EnvRuntimeState missing in OpState");
    };

    if !valid_env_key(&key) {
        return err_reply("TypeError", "Invalid environment variable key");
    }

    if !env_state.access.allows(&key) {
        return err_reply(
            "PermissionDenied",
            format!("Requires env access to \"{key}\""),
        );
    }

    let v = env_state
        .vars
        .lock()
        .ok()
        .and_then(|vars| vars.get(&key).cloned());

    match v {
        Some(s) => ok_reply(JsValueBridge::String(s)),
        None => ok_reply(JsValueBridge::Undefined),
    }
}

#[op2]
#[serde]
/// Internal helper for runtime<->host op handling; it handles op denojs worker env set.
pub fn op_denojs_worker_env_set(
    state: &mut OpState,
    #[string] key: String,
    #[string] value: String,
) -> serde_json::Value {
    let Some(env_state) = env_state_from_state(state) else {
        return err_reply("OpStateError", "EnvRuntimeState missing in OpState");
    };

    if !valid_env_key(&key) {
        return err_reply("TypeError", "Invalid environment variable key");
    }

    if !env_state.access.allows(&key) {
        return err_reply(
            "PermissionDenied",
            format!("Requires env access to \"{key}\""),
        );
    }

    match env_state.vars.lock() {
        Ok(mut vars) => {
            vars.insert(key, value);
            ok_reply(JsValueBridge::Null)
        }
        Err(_) => err_reply("Error", "Environment map lock poisoned"),
    }
}

#[op2]
#[serde]
/// Internal helper for runtime<->host op handling; it handles op denojs worker env delete.
pub fn op_denojs_worker_env_delete(
    state: &mut OpState,
    #[string] key: String,
) -> serde_json::Value {
    let Some(env_state) = env_state_from_state(state) else {
        return err_reply("OpStateError", "EnvRuntimeState missing in OpState");
    };

    if !valid_env_key(&key) {
        return err_reply("TypeError", "Invalid environment variable key");
    }

    if !env_state.access.allows(&key) {
        return err_reply(
            "PermissionDenied",
            format!("Requires env access to \"{key}\""),
        );
    }

    match env_state.vars.lock() {
        Ok(mut vars) => ok_reply(JsValueBridge::Bool(vars.remove(&key).is_some())),
        Err(_) => err_reply("Error", "Environment map lock poisoned"),
    }
}

#[op2]
#[serde]
/// Internal helper for runtime<->host op handling; it handles op denojs worker env to object.
pub fn op_denojs_worker_env_to_object(state: &mut OpState) -> serde_json::Value {
    let Some(env_state) = env_state_from_state(state) else {
        return err_reply("OpStateError", "EnvRuntimeState missing in OpState");
    };

    let mut out = serde_json::Map::new();
    match env_state.vars.lock() {
        Ok(vars) => {
            for (k, v) in vars.iter() {
                if env_state.access.allows(k) {
                    out.insert(k.clone(), serde_json::Value::String(v.clone()));
                }
            }
            ok_reply(JsValueBridge::Json(serde_json::Value::Object(out)))
        }
        Err(_) => err_reply("Error", "Environment map lock poisoned"),
    }
}
