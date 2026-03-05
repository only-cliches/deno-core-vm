use crate::bridge::promise::PromiseSettler;
use crate::bridge::types::{EvalOptions, JsValueBridge};
use tokio::sync::oneshot;

#[derive(Debug, Clone)]
pub struct ExecStats {
    /// Process CPU consumed during one eval operation.
    pub cpu_time_ms: f64,
    /// Wall-clock latency for the same operation.
    pub eval_time_ms: f64,
}

#[derive(Debug, Clone)]
pub enum ImportDecision {
    Block,
    AllowDisk,

    /// Virtual module source. `ext` controls how the runtime should parse it.
    /// Supported: "js", "ts", "tsx", "jsx"
    SourceTyped {
        ext: String,
        code: String,
    },

    /// Rewrite the specifier and then resolve/load it (node then deno).
    Resolve(String),
}

#[derive(Debug, Clone)]
pub enum EvalReply {
    Ok {
        value: JsValueBridge,
        stats: ExecStats,
    },
    Err {
        error: JsValueBridge,
        stats: ExecStats,
    },
}

pub enum DenoMsg {
    /// Execute source in runtime. Exactly one of `deferred` / `sync_reply` is typically set.
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
    PostMessageTyped {
        message_type: String,
        id: u32,
        payload: JsValueBridge,
    },
    PostStreamChunk {
        stream_id: String,
        payload: JsValueBridge,
    },
    PostStreamChunkRaw {
        stream_id: u32,
        payload: JsValueBridge,
        credit: Option<u32>,
    },
    PostStreamChunkRawBin {
        stream_id: u32,
        payload: Vec<u8>,
        credit: Option<u32>,
    },
    PostStreamChunks {
        stream_id: String,
        payloads: Vec<JsValueBridge>,
    },
    PostStreamChunksRaw {
        stream_id: u32,
        payload: JsValueBridge,
    },
    PostStreamControl {
        kind: String,
        stream_id: String,
        aux: Option<String>,
    },
    Memory {
        deferred: PromiseSettler,
    },
    Close {
        deferred: PromiseSettler,
    },
    RegisterModule {
        module_name: String,
        source: String,
        deferred: PromiseSettler,
    },
    ClearModule {
        module_name: String,
        deferred: PromiseSettler,
    },
}

impl DenoMsg {
    /// Checks whether data plane and returns the boolean result for runtime bridge internals.
    pub fn is_data_plane(&self) -> bool {
        matches!(
            self,
            DenoMsg::PostMessage { .. }
                | DenoMsg::PostMessageTyped { .. }
                | DenoMsg::PostStreamChunk { .. }
                | DenoMsg::PostStreamChunkRaw { .. }
                | DenoMsg::PostStreamChunkRawBin { .. }
                | DenoMsg::PostStreamChunks { .. }
                | DenoMsg::PostStreamChunksRaw { .. }
                | DenoMsg::PostStreamControl { .. }
        )
    }
}

pub enum ResolvePayload {
    Void,
    Json(serde_json::Value),

    /// Result of an operation that returns a bridge value.
    /// `Ok(value)` resolves, `Err(error_value)` rejects.
    Result {
        result: Result<JsValueBridge, JsValueBridge>,
        stats: ExecStats,
    },
}

pub enum NodeMsg {
    /// Emit worker postMessage payload on Node callback thread.
    EmitMessage {
        value: JsValueBridge,
    },
    /// Runtime is closing; invoke close callback and remove handle.
    EmitClose,
    EmitRuntimeEvent {
        value: JsValueBridge,
    },

    Resolve {
        settler: PromiseSettler,
        payload: ResolvePayload,
    },

    ImportRequest {
        specifier: String,
        referrer: String,
        is_dynamic_import: bool,
        reply: tokio::sync::oneshot::Sender<ImportDecision>,
    },

    InvokeHostFunctionSync {
        func_id: usize,
        args: Vec<JsValueBridge>,
        // Uses std::mpsc because the caller is a sync op and cannot await.
        reply: std::sync::mpsc::Sender<Result<JsValueBridge, JsValueBridge>>,
    },

    InvokeHostFunctionAsync {
        func_id: usize,
        args: Vec<JsValueBridge>,
        reply: tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>,
    },
}
