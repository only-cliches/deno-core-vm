use crate::bridge::neon_codec::from_neon_value;
use crate::bridge::types::JsValueBridge;
use crate::worker::messages::{DenoMsg, ExecStats, NodeMsg};
use neon::prelude::*;
use neon::result::Throw;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::bridge::promise::PromiseSettler; // can keep for local Node-side settlement only

#[derive(Default)]
pub struct PendingRequests {
    next_id: AtomicU64,
    map: Mutex<HashMap<u64, PromiseSettler>>,
}

impl PendingRequests {
    pub fn insert(&self, settler: PromiseSettler) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).max(1);
        self.map.lock().unwrap().insert(id, settler);
        id
    }

    pub fn take(&self, id: u64) -> Option<PromiseSettler> {
        self.map.lock().unwrap().remove(&id)
    }

    pub fn reject_all(&self, message: &str) {
        let mut guard = self.map.lock().unwrap();
        let pending: Vec<_> = guard.drain().map(|(_, v)| v).collect();
        drop(guard);

        for settler in pending {
            settler.reject_with_error(message.to_string());
        }
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

#[derive(Default, Debug, Clone)]
pub struct NodeCallbacks {
    pub on_message: Option<Arc<Root<JsFunction>>>,
    pub on_close: Option<Arc<Root<JsFunction>>>,
    pub imports: Option<Arc<Root<JsFunction>>>,
    pub console_log: Option<Arc<Root<JsFunction>>>,
    pub console_info: Option<Arc<Root<JsFunction>>>,
    pub console_warn: Option<Arc<Root<JsFunction>>>,
    pub console_error: Option<Arc<Root<JsFunction>>>,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeLimits {
    pub max_memory_bytes: Option<u64>,
    pub max_stack_size_bytes: Option<u64>,
    pub max_eval_ms: Option<u64>,
    pub imports: ImportsPolicy,
    pub cwd: Option<String>,
    pub node_compat: bool,
    pub permissions: Option<serde_json::Value>,
    pub startup: Option<String>,

    // Wire JSON applied to globalThis.__globals["__denojs_worker_console"] before startup runs.
    pub console: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerCreateOptions {
    pub channel_size: usize,
    pub runtime_options: RuntimeLimits,
}

impl WorkerCreateOptions {
    pub fn from_neon<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> Result<Self, Throw> {
        let mut out = Self {
            channel_size: 512,
            ..Default::default()
        };
        if (idx as usize) >= cx.len() {
            return Ok(out);
        }
        let raw = cx.argument::<JsValue>(idx as usize)?;

        let obj = match raw.downcast::<JsObject, _>(cx) {
            Ok(v) => v,
            Err(_) => return Ok(out),
        };

        // Retire moduleRoot, replace with cwd. Keep legacy fallback.
        let mut cwd_opt: Option<String> = None;
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "cwd") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                let raw = s.value(cx);
                if !raw.trim().is_empty() {
                    cwd_opt = Some(raw);
                }
            }
        }
        if cwd_opt.is_none() {
            if let Ok(v) = obj.get::<JsValue, _, _>(cx, "moduleRoot") {
                if let Ok(s) = v.downcast::<JsString, _>(cx) {
                    let raw = s.value(cx);
                    if !raw.trim().is_empty() {
                        cwd_opt = Some(raw);
                    }
                }
            }
        }
        out.runtime_options.cwd = cwd_opt;

        // startup (and legacy alias: index)
        let mut startup_opt: Option<String> = None;

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "startup") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                let raw = s.value(cx);
                if !raw.trim().is_empty() {
                    startup_opt = Some(raw);
                }
            }
        }

        if startup_opt.is_none() {
            if let Ok(v) = obj.get::<JsValue, _, _>(cx, "index") {
                if let Ok(s) = v.downcast::<JsString, _>(cx) {
                    let raw = s.value(cx);
                    if !raw.trim().is_empty() {
                        startup_opt = Some(raw);
                    }
                }
            }
        }

        out.runtime_options.startup = startup_opt;

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "nodeCompat") {
            if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                out.runtime_options.node_compat = b.value(cx);
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "permissions") {
            if !v.is_a::<JsNull, _>(cx) && !v.is_a::<JsUndefined, _>(cx) {
                if let Ok(bridged) = from_neon_value(cx, v) {
                    if let JsValueBridge::Json(j) = bridged {
                        out.runtime_options.permissions = Some(j);
                    }
                }
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "channelSize") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let s = n.value(cx);
                if s.is_finite() && s >= 1.0 {
                    out.channel_size = s as usize;
                }
            }
        }
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxEvalMs") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                out.runtime_options.max_eval_ms = Some(n.value(cx) as u64);
            }
        }
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxMemoryBytes") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                out.runtime_options.max_memory_bytes = Some(n.value(cx) as u64);
            }
        }
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxStackSizeBytes") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                out.runtime_options.max_stack_size_bytes = Some(n.value(cx) as u64);
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "imports") {
            if v.is_a::<JsBoolean, _>(cx) {
                if let Ok(bv) = v.downcast::<JsBoolean, _>(cx) {
                    let b = bv.value(cx);
                    out.runtime_options.imports = if b {
                        ImportsPolicy::AllowDisk
                    } else {
                        ImportsPolicy::DenyAll
                    };
                }
            } else if v.is_a::<JsFunction, _>(cx) {
                out.runtime_options.imports = ImportsPolicy::Callback;
            }
        }
        Ok(out)
    }
}

#[derive(Debug, Clone)]
pub enum ImportsPolicy {
    DenyAll,
    AllowDisk,
    Callback,
}

impl Default for ImportsPolicy {
    fn default() -> Self {
        // Safer default: deny disk imports unless explicitly enabled
        ImportsPolicy::DenyAll
    }
}

#[derive(Clone)]
pub struct WorkerHandle {
    pub id: usize,
    pub deno_tx: mpsc::Sender<DenoMsg>,
    pub node_tx: mpsc::Sender<NodeMsg>,
    pub channel: Channel,
    pub callbacks: NodeCallbacks,
    pub host_functions: Vec<Arc<Root<JsFunction>>>,
    pub closed: Arc<AtomicBool>,
    pub pending: Arc<PendingRequests>,
    pub last_stats: Arc<Mutex<Option<ExecStats>>>,
}

impl WorkerHandle {
    pub fn new(
        id: usize,
        channel: Channel,
        channel_size: usize,
    ) -> (Self, mpsc::Receiver<DenoMsg>, mpsc::Receiver<NodeMsg>) {
        let (deno_tx, deno_rx) = mpsc::channel(channel_size);
        let (node_tx, node_rx) = mpsc::channel(channel_size);

        let handle = Self {
            id,
            deno_tx,
            node_tx,
            channel,
            callbacks: NodeCallbacks::default(),
            host_functions: Vec::new(),
            closed: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(PendingRequests::default()),
            last_stats: Arc::new(Mutex::new(None)),
        };

        (handle, deno_rx, node_rx)
    }

    pub fn register_global_fn(&mut self, root: Root<JsFunction>) -> usize {
        let id = self.host_functions.len();
        self.host_functions.push(Arc::new(root));
        id
    }
}