use tokio::sync::oneshot;
use crate::bridge::promise::PromiseSettler;
use crate::bridge::types::{EvalOptions, JsValueBridge};

#[derive(Debug, Clone)]
pub struct ExecStats {
    pub cpu_time_ms: f64,
    pub eval_time_ms: f64,
}

#[derive(Debug, Clone)]
pub enum EvalReply {
    Ok { value: JsValueBridge, stats: ExecStats },
    Err { error: JsValueBridge, stats: ExecStats }, // error is a JsValueBridge::Error{...}
}

pub enum DenoMsg {
    Eval {
        source: String,
        options: EvalOptions,
        deferred: Option<PromiseSettler>,
        sync_reply: Option<oneshot::Sender<EvalReply>>,
    },
    SetGlobal {
        key: String,
        value: JsValueBridge,
        deferred: PromiseSettler,
    },
    PostMessage {
        value: JsValueBridge,
    },
    Memory {
        deferred: PromiseSettler,
    },
    Close {
        deferred: PromiseSettler,
    },
}

pub enum ResolvePayload {
    Void,
    Json(serde_json::Value),

    /// Result of an operation that returns a bridge value.
    /// `Ok(value)` resolves, `Err(error_value)` rejects.
    ///
    /// `error_value` should normally be `JsValueBridge::Error { ... }`,
    /// but it can be any bridge value.
    Result {
        result: Result<JsValueBridge, JsValueBridge>,
        stats: ExecStats,
    },
}

pub enum NodeMsg {
    EmitMessage { value: JsValueBridge },
    EmitClose,

    /// The ONLY message that carries a PromiseSettler.
    Resolve {
        settler: PromiseSettler,
        payload: ResolvePayload,
    },

    InvokeHostFunctionSync {
        func_id: usize,
        args: Vec<JsValueBridge>,
        reply: std::sync::mpsc::Sender<Result<JsValueBridge, JsValueBridge>>,
    },

    InvokeHostFunctionAsync {
        func_id: usize,
        args: Vec<JsValueBridge>,
        reply: tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>
    },
}
