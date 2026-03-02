use crate::bridge::neon_codec::from_neon_value;
use crate::bridge::types::JsValueBridge;
use crate::worker::messages::{DenoMsg, ExecStats, NodeMsg};
use neon::prelude::*;
use neon::result::Throw;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use crate::bridge::promise::PromiseSettler;

#[derive(Default)]
pub struct PendingRequests {
    // Monotonic request id source for pending Promise settlers.
    next_id: AtomicU64,
    // In-flight request -> settler map. Drained on forced shutdown/restart.
    map: Mutex<HashMap<u64, PromiseSettler>>,
}

impl PendingRequests {
    pub fn insert(&self, settler: PromiseSettler) -> u64 {
        // Never return 0 so "missing id" and "first id" are distinguishable in logs.
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

#[derive(Debug, Clone)]
pub enum EnvConfig {
    Map(HashMap<String, String>),
}

#[derive(Debug, Clone, Default)]
pub struct InspectConfig {
    pub host: String,
    pub port: u16,
    pub break_on_first_statement: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TsCompilerConfig {
    pub jsx: Option<String>,
    pub jsx_factory: Option<String>,
    pub jsx_fragment_factory: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ModuleLoaderConfig {
    pub deno_remote: bool,
    pub transpile_ts: bool,
    pub ts_compiler: Option<TsCompilerConfig>,
    pub cache_dir: Option<String>,
    pub reload: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeLimits {
    pub max_memory_bytes: Option<u64>,
    pub max_stack_size_bytes: Option<u64>,
    pub max_eval_ms: Option<u64>,

    pub imports: ImportsPolicy,

    pub cwd: Option<String>,
    pub permissions: Option<serde_json::Value>,
    pub startup: Option<String>,

    pub node_resolve: bool,
    pub node_compat: bool,

    pub console: Option<serde_json::Value>,
    pub inspect: Option<InspectConfig>,
    pub module_loader: Option<ModuleLoaderConfig>,

    /// env:
    /// - None: default Deno behavior
    /// - Some(Map): env vars to set (loaded from either string file path or object map in JS)
    pub env: Option<EnvConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerCreateOptions {
    pub channel_size: usize,
    pub runtime_options: RuntimeLimits,
}

fn parse_dotenv_text_strict(text: &str) -> Vec<(String, String)> {
    fn unquote(s: &str) -> String {
        let ss = s.trim();
        if ss.len() >= 2 {
            let b = ss.as_bytes();
            if (b[0] == b'"' && b[ss.len() - 1] == b'"')
                || (b[0] == b'\'' && b[ss.len() - 1] == b'\'')
            {
                return ss[1..ss.len() - 1].to_string();
            }
        }
        ss.to_string()
    }

    let mut out = Vec::new();

    // Intentionally strict/minimal parser: KEY=VALUE with optional quotes/comments.
    for line in text.lines() {
        let mut l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }

        if l.starts_with("export ") {
            l = l.trim_start_matches("export ").trim();
        }

        let Some(eq) = l.find('=') else {
            continue;
        };

        let key = l[..eq].trim();
        if key.is_empty() {
            continue;
        }

        let mut val = l[eq + 1..].trim();

        let is_quoted = val.starts_with('"') || val.starts_with('\'');
        if !is_quoted {
            if let Some(hash) = val.find(" #") {
                val = val[..hash].trim();
            }
        }

        out.push((key.to_string(), unquote(val)));
    }

    out
}

fn resolve_env_path(base_cwd: &Path, raw: &str) -> PathBuf {
    let s = raw.trim();

    // Accept file:// for parity with module/url-heavy config surfaces.
    if s.starts_with("file://") {
        if let Ok(u) = deno_core::url::Url::parse(s) {
            if let Ok(p) = u.to_file_path() {
                return p;
            }
        }
    }

    let p = Path::new(s);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base_cwd.join(p)
    }
}

fn find_dotenv_upwards(start_dir: &Path) -> Option<PathBuf> {
    // Walk up to filesystem root, first .env wins.
    let mut cur = std::fs::canonicalize(start_dir).unwrap_or_else(|_| start_dir.to_path_buf());
    loop {
        let cand = cur.join(".env");
        if cand.is_file() {
            return Some(cand);
        }
        let parent = cur.parent().map(|p| p.to_path_buf());
        let Some(p) = parent else {
            return None;
        };
        if p == cur {
            return None;
        }
        cur = p;
    }
}

fn env_map_from_js_object(j: &serde_json::Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(map) = j.as_object() else {
        return out;
    };

    for (k, v) in map.iter() {
        if !crate::worker::env::valid_env_key(k) {
            continue;
        }
        if let Some(s) = v.as_str() {
            out.insert(k.to_string(), s.to_string());
        }
    }

    out
}

fn load_dotenv_file_strict(
    cx: &mut FunctionContext,
    path: &Path,
) -> Result<HashMap<String, String>, Throw> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        cx.throw_error::<_, Throw>(format!(
            "env file read failed: {} ({})",
            path.to_string_lossy(),
            e
        ))
        .unwrap_err()
    })?;

    let pairs = parse_dotenv_text_strict(&text);
    let mut map = HashMap::new();
    for (k, vv) in pairs {
        if !crate::worker::env::valid_env_key(&k) {
            continue;
        }
        map.insert(k, vv);
    }
    Ok(map)
}

fn ensure_env_permission_enabled(
    permissions: Option<serde_json::Value>,
    env_is_configured: bool,
) -> Option<serde_json::Value> {
    if !env_is_configured {
        return permissions;
    }

    // If custom env is configured, force env permission on to keep runtime access coherent.
    let mut out = match permissions {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };

    out.insert("env".to_string(), serde_json::Value::Bool(true));
    Some(serde_json::Value::Object(out))
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

        // `cwd`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "cwd") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                let raw = s.value(cx);
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    out.runtime_options.cwd = Some(trimmed.to_string());
                }
            }
        }

        // `startup`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "startup") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                let raw = s.value(cx);
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    out.runtime_options.startup = Some(trimmed.to_string());
                }
            }
        }

        // `nodeResolve`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "nodeResolve") {
            if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                out.runtime_options.node_resolve = b.value(cx);
            }
        }

        // `nodeCompat`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "nodeCompat") {
            if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                out.runtime_options.node_compat = b.value(cx);
            }
        }

        // `permissions`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "permissions") {
            if !v.is_a::<JsNull, _>(cx) && !v.is_a::<JsUndefined, _>(cx) {
                if let Ok(bridged) = from_neon_value(cx, v) {
                    if let JsValueBridge::Json(j) = bridged {
                        out.runtime_options.permissions = Some(j);
                    }
                }
            }
        }

        // `channelSize`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "channelSize") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let s = n.value(cx);
                if s.is_finite() && s >= 1.0 {
                    out.channel_size = s as usize;
                }
            }
        }

        // `maxEvalMs`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxEvalMs") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let ms = n.value(cx);
                if ms.is_finite() && ms > 0.0 {
                    out.runtime_options.max_eval_ms = Some(ms as u64);
                }
            }
        }

        // `maxMemoryBytes`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxMemoryBytes") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let mb = n.value(cx);
                if mb.is_finite() && mb > 0.0 {
                    out.runtime_options.max_memory_bytes = Some(mb as u64);
                }
            }
        }

        // `maxStackSizeBytes`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxStackSizeBytes") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let sb = n.value(cx);
                if sb.is_finite() && sb > 0.0 {
                    out.runtime_options.max_stack_size_bytes = Some(sb as u64);
                }
            }
        }

        // `imports`: boolean | function.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "imports") {
            if v.is_a::<JsBoolean, _>(cx) {
                if let Ok(bv) = v.downcast::<JsBoolean, _>(cx) {
                    out.runtime_options.imports = if bv.value(cx) {
                        ImportsPolicy::AllowDisk
                    } else {
                        ImportsPolicy::DenyAll
                    };
                }
            } else if v.is_a::<JsFunction, _>(cx) {
                out.runtime_options.imports = ImportsPolicy::Callback;
            }
        }

        // Base cwd for `env`/`envFile` resolution.
        let base_cwd = out
            .runtime_options
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        // `envFile`: boolean | string(path).
        // - `true`: search `.env` upward from cwd.
        // - `string`: load explicit path.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "envFile") {
            if !(v.is_a::<JsUndefined, _>(cx) || v.is_a::<JsNull, _>(cx)) {
                if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                    if b.value(cx) {
                        if let Some(p) = find_dotenv_upwards(&base_cwd) {
                            let map = load_dotenv_file_strict(cx, &p)?;
                            out.runtime_options.env = Some(EnvConfig::Map(map));
                        }
                    }
                } else if let Ok(s) = v.downcast::<JsString, _>(cx) {
                    let raw_path = s.value(cx);
                    let trimmed = raw_path.trim();
                    if !trimmed.is_empty() {
                        let p = resolve_env_path(&base_cwd, trimmed);
                        let map = load_dotenv_file_strict(cx, &p)?;
                        out.runtime_options.env = Some(EnvConfig::Map(map));
                    }
                }
            }
        }

        // `env`: undefined | string(path) | Record<string,string>.
        // Note: `env` overrides `envFile` if both are provided.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "env") {
            if v.is_a::<JsUndefined, _>(cx) || v.is_a::<JsNull, _>(cx) {
                // Default behavior.
            } else if let Ok(s) = v.downcast::<JsString, _>(cx) {
                let raw_path = s.value(cx);
                let trimmed = raw_path.trim();
                if !trimmed.is_empty() {
                    let path = resolve_env_path(&base_cwd, trimmed);
                    let map = load_dotenv_file_strict(cx, &path)?;
                    out.runtime_options.env = Some(EnvConfig::Map(map));
                }
            } else if let Ok(bridged) = from_neon_value(cx, v) {
                if let JsValueBridge::Json(j) = bridged {
                    let map = env_map_from_js_object(&j);
                    out.runtime_options.env = Some(EnvConfig::Map(map));
                }
            }
        }

        // `inspect`: boolean | { host?: string; port?: number; break?: boolean }.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "inspect") {
            if v.is_a::<JsUndefined, _>(cx) || v.is_a::<JsNull, _>(cx) {
                // No inspect config.
            } else if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                if b.value(cx) {
                    out.runtime_options.inspect = Some(InspectConfig {
                        host: "127.0.0.1".to_string(),
                        port: 9229,
                        break_on_first_statement: false,
                    });
                }
            } else if let Ok(o) = v.downcast::<JsObject, _>(cx) {
                let mut host = "127.0.0.1".to_string();
                let mut port: u16 = 9229;
                let mut brk = false;

                if let Ok(hv) = o.get::<JsValue, _, _>(cx, "host") {
                    if let Ok(hs) = hv.downcast::<JsString, _>(cx) {
                        let raw = hs.value(cx);
                        let trimmed = raw.trim();
                        if !trimmed.is_empty() {
                            host = trimmed.to_string();
                        }
                    }
                }

                if let Ok(pv) = o.get::<JsValue, _, _>(cx, "port") {
                    if let Ok(pn) = pv.downcast::<JsNumber, _>(cx) {
                        let n = pn.value(cx);
                        if n.is_finite() && n > 0.0 && n <= 65535.0 {
                            port = n as u16;
                        }
                    }
                }

                if let Ok(bv) = o.get::<JsValue, _, _>(cx, "break") {
                    if let Ok(bb) = bv.downcast::<JsBoolean, _>(cx) {
                        brk = bb.value(cx);
                    }
                }

                out.runtime_options.inspect = Some(InspectConfig {
                    host,
                    port,
                    break_on_first_statement: brk,
                });
            }
        }

        // `moduleLoader`:
        // {
        //   denoRemote?: boolean;
        //   transpileTs?: boolean;
        //   tsCompiler?: {
        //     jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
        //     jsxFactory?: string;
        //     jsxFragmentFactory?: string;
        //   };
        //   cacheDir?: string;
        //   reload?: boolean;
        // }
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "moduleLoader") {
            if let Ok(o) = v.downcast::<JsObject, _>(cx) {
                let mut cfg = ModuleLoaderConfig::default();

                if let Ok(rv) = o.get::<JsValue, _, _>(cx, "denoRemote") {
                    if let Ok(rb) = rv.downcast::<JsBoolean, _>(cx) {
                        cfg.deno_remote = rb.value(cx);
                    }
                }

                if let Ok(tv) = o.get::<JsValue, _, _>(cx, "transpileTs") {
                    if let Ok(tb) = tv.downcast::<JsBoolean, _>(cx) {
                        cfg.transpile_ts = tb.value(cx);
                    }
                }

                if let Ok(tcv) = o.get::<JsValue, _, _>(cx, "tsCompiler") {
                    if let Ok(tco) = tcv.downcast::<JsObject, _>(cx) {
                        let mut tc = TsCompilerConfig::default();

                        if let Ok(jv) = tco.get::<JsValue, _, _>(cx, "jsx") {
                            if let Ok(js) = jv.downcast::<JsString, _>(cx) {
                                let s = js.value(cx);
                                let t = s.trim();
                                if matches!(t, "react" | "react-jsx" | "react-jsxdev" | "preserve")
                                {
                                    tc.jsx = Some(t.to_string());
                                }
                            }
                        }

                        if let Ok(fv) = tco.get::<JsValue, _, _>(cx, "jsxFactory") {
                            if let Ok(fs) = fv.downcast::<JsString, _>(cx) {
                                let s = fs.value(cx);
                                let t = s.trim();
                                if !t.is_empty() {
                                    tc.jsx_factory = Some(t.to_string());
                                }
                            }
                        }

                        if let Ok(ffv) = tco.get::<JsValue, _, _>(cx, "jsxFragmentFactory") {
                            if let Ok(ffs) = ffv.downcast::<JsString, _>(cx) {
                                let s = ffs.value(cx);
                                let t = s.trim();
                                if !t.is_empty() {
                                    tc.jsx_fragment_factory = Some(t.to_string());
                                }
                            }
                        }

                        if tc.jsx.is_some()
                            || tc.jsx_factory.is_some()
                            || tc.jsx_fragment_factory.is_some()
                        {
                            cfg.ts_compiler = Some(tc);
                        }
                    }
                }

                if let Ok(cv) = o.get::<JsValue, _, _>(cx, "cacheDir") {
                    if let Ok(cs) = cv.downcast::<JsString, _>(cx) {
                        let s = cs.value(cx);
                        let t = s.trim();
                        if !t.is_empty() {
                            cfg.cache_dir = Some(t.to_string());
                        }
                    }
                }

                if let Ok(rv) = o.get::<JsValue, _, _>(cx, "reload") {
                    if let Ok(rb) = rv.downcast::<JsBoolean, _>(cx) {
                        cfg.reload = rb.value(cx);
                    }
                }

                out.runtime_options.module_loader = Some(cfg);
            }
        }

        out.runtime_options.permissions = ensure_env_permission_enabled(
            out.runtime_options.permissions.take(),
            out.runtime_options.env.is_some(),
        );

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_env_permission_enabled;

    #[test]
    fn ensure_env_permission_enabled_keeps_permissions_when_env_not_configured() {
        let original = Some(serde_json::json!({ "read": true, "env": false }));
        let out = ensure_env_permission_enabled(original.clone(), false);
        assert_eq!(out, original);
    }

    #[test]
    fn ensure_env_permission_enabled_sets_env_true_when_missing() {
        let out = ensure_env_permission_enabled(Some(serde_json::json!({ "read": true })), true);
        assert_eq!(out, Some(serde_json::json!({ "read": true, "env": true })));
    }

    #[test]
    fn ensure_env_permission_enabled_overrides_explicit_env_false() {
        let out = ensure_env_permission_enabled(
            Some(serde_json::json!({ "env": false, "write": ["./tmp"] })),
            true,
        );
        assert_eq!(out, Some(serde_json::json!({ "env": true, "write": ["./tmp"] })));
    }

    #[test]
    fn ensure_env_permission_enabled_handles_non_object_permissions() {
        let out = ensure_env_permission_enabled(Some(serde_json::Value::Bool(true)), true);
        assert_eq!(out, Some(serde_json::json!({ "env": true })));

        let out_none = ensure_env_permission_enabled(None, true);
        assert_eq!(out_none, Some(serde_json::json!({ "env": true })));
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
