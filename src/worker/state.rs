use crate::bridge::neon_codec::from_neon_value;
use crate::bridge::types::JsValueBridge;
use crate::worker::messages::{DenoMsg, ExecStats, NodeMsg};
use crate::worker::stream_plane::NativeIncomingPlane;
use neon::prelude::*;
use neon::result::Throw;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
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
    /// Insert.
    pub fn insert(&self, settler: PromiseSettler) -> u64 {
        // Never return 0 so "missing id" and "first id" are distinguishable in logs.
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).max(1);
        self.map.lock().unwrap().insert(id, settler);
        id
    }

    /// Take.
    pub fn take(&self, id: u64) -> Option<PromiseSettler> {
        self.map.lock().unwrap().remove(&id)
    }

    /// Reject all.
    pub fn reject_all(&self, message: &str) {
        let mut guard = self.map.lock().unwrap();
        let pending: Vec<_> = guard.drain().map(|(_, v)| v).collect();
        drop(guard);

        for settler in pending {
            settler.reject_with_error(message.to_string());
        }
    }

    /// Len.
    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

#[derive(Default, Debug, Clone)]
pub struct NodeCallbacks {
    pub on_message: Option<Arc<Root<JsFunction>>>,
    pub on_close: Option<Arc<Root<JsFunction>>>,
    pub on_runtime: Option<Arc<Root<JsFunction>>>,
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
    pub cache_dir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModuleLoaderConfig {
    pub https_resolve: bool,
    pub http_resolve: bool,
    pub node_resolve: bool,
    pub jsr_resolve: bool,
    pub transpile_ts: bool,
    pub ts_compiler: Option<TsCompilerConfig>,
    pub cache_dir: Option<String>,
    pub reload: bool,
    pub max_payload_bytes: i64,
}

impl Default for ModuleLoaderConfig {
    // Provides default default values used by worker configuration/state parsing and runtime limits.
    fn default() -> Self {
        Self {
            https_resolve: false,
            http_resolve: false,
            node_resolve: false,
            jsr_resolve: false,
            transpile_ts: false,
            ts_compiler: None,
            cache_dir: None,
            reload: false,
            // 10 MiB default cap for remote module payloads.
            max_payload_bytes: 10 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeLimits {
    pub max_memory_bytes: Option<u64>,
    pub max_eval_ms: Option<u64>,
    pub max_cpu_ms: Option<u64>,
    pub wasm: bool,

    pub imports: ImportsPolicy,

    pub cwd: Option<String>,
    pub permissions: Option<serde_json::Value>,
    pub startup: Option<String>,

    pub node_resolve: bool,
    pub node_compat: bool,

    pub console: Option<serde_json::Value>,
    pub inspect: Option<InspectConfig>,
    pub module_loader: Option<ModuleLoaderConfig>,
    pub bridge: Option<BridgeConfig>,
    pub startup_warnings: Vec<String>,

    /// env:
    /// - None: default Deno behavior
    /// - Some(Map): env vars to set (loaded from either string file path or object map in JS)
    pub env: Option<EnvConfig>,
}

impl Default for RuntimeLimits {
    // Returns default values used by worker option/state normalization.
    fn default() -> Self {
        Self {
            max_memory_bytes: None,
            max_eval_ms: None,
            max_cpu_ms: None,
            wasm: true,
            imports: ImportsPolicy::default(),
            cwd: None,
            permissions: None,
            startup: None,
            node_resolve: false,
            node_compat: false,
            console: None,
            inspect: None,
            module_loader: None,
            bridge: None,
            startup_warnings: Vec::new(),
            env: None,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    pub stream_window_bytes: Option<u64>,
    pub stream_credit_flush_bytes: Option<u64>,
    pub stream_high_water_mark_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerCreateOptions {
    pub channel_size: usize,
    pub runtime_options: RuntimeLimits,
}

// Parses dotenv text strict from input data and validates it for worker configuration/state parsing and runtime limits.
fn parse_dotenv_text_strict(text: &str) -> Vec<(String, String)> {
    // Unquote.
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

// Resolves env path according to rules used by worker configuration/state parsing and runtime limits.
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

// Canonicalize or lexical.
fn canonicalize_or_lexical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| crate::worker::filesystem::normalize_lexical_path(path))
}

// Checks whether base dir and returns the boolean result for worker configuration/state parsing and runtime limits.
fn within_base_dir(base_dir: &Path, candidate: &Path) -> bool {
    let base_abs = canonicalize_or_lexical(base_dir);
    let cand_abs = canonicalize_or_lexical(candidate);
    cand_abs.starts_with(&base_abs)
}

// Find dotenv upwards.
fn find_dotenv_upwards(start_dir: &Path) -> Option<PathBuf> {
    // Walk up to filesystem root, first .env wins.
    let mut cur = canonicalize_or_lexical(start_dir);
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

// Env map from js object.
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

// Parses ts compiler config from input data and validates it for worker configuration/state parsing and runtime limits.
fn parse_ts_compiler_config<'a>(
    cx: &mut FunctionContext<'a>,
    tco: Handle<'a, JsObject>,
) -> Option<TsCompilerConfig> {
    let mut tc = TsCompilerConfig::default();

    if let Ok(jv) = tco.get::<JsValue, _, _>(cx, "jsx") {
        if let Ok(js) = jv.downcast::<JsString, _>(cx) {
            let s = js.value(cx);
            let t = s.trim();
            if matches!(t, "react" | "react-jsx" | "react-jsxdev" | "preserve") {
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

    if let Ok(cv) = tco.get::<JsValue, _, _>(cx, "cacheDir") {
        if let Ok(cs) = cv.downcast::<JsString, _>(cx) {
            let s = cs.value(cx);
            let t = s.trim();
            if !t.is_empty() {
                tc.cache_dir = Some(t.to_string());
            }
        }
    }

    if tc.jsx.is_some()
        || tc.jsx_factory.is_some()
        || tc.jsx_fragment_factory.is_some()
        || tc.cache_dir.is_some()
    {
        Some(tc)
    } else {
        None
    }
}

// Loads dotenv file strict during worker configuration/state parsing and runtime limits.
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

fn expand_permissions_shorthand(value: serde_json::Value) -> serde_json::Value {
    let serde_json::Value::Bool(all) = value else {
        return value;
    };
    let mut out = serde_json::Map::new();
    for key in [
        "read", "write", "net", "env", "run", "ffi", "sys", "import", "hrtime", "wasm",
    ] {
        out.insert(key.to_string(), serde_json::Value::Bool(all));
    }
    serde_json::Value::Object(out)
}

// Ensure env permission enabled.
fn ensure_env_permission_enabled(
    permissions: Option<serde_json::Value>,
    env_keys: Option<&HashMap<String, String>>,
) -> (Option<serde_json::Value>, Vec<String>) {
    let Some(env_keys) = env_keys else {
        return (permissions, Vec::new());
    };

    let env_keys_set: std::collections::HashSet<String> = env_keys.keys().cloned().collect();
    let mut warnings = Vec::new();

    let permissions = permissions.map(expand_permissions_shorthand);
    let mut out = match permissions {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    let env_keys_json = || {
        let mut keys: Vec<String> = env_keys_set.iter().cloned().collect();
        keys.sort();
        serde_json::Value::Array(keys.into_iter().map(serde_json::Value::String).collect())
    };

    let effective_allow: Option<std::collections::HashSet<String>> = match out.get("env") {
        None => {
            out.insert("env".to_string(), env_keys_json());
            Some(env_keys_set.clone())
        }
        Some(serde_json::Value::Array(arr)) if arr.is_empty() => {
            out.insert("env".to_string(), env_keys_json());
            Some(env_keys_set.clone())
        }
        Some(serde_json::Value::Array(arr)) => {
            let mut allow = std::collections::HashSet::new();
            for k in arr.iter().filter_map(|v| v.as_str()) {
                allow.insert(k.to_string());
            }
            Some(allow)
        }
        Some(serde_json::Value::Bool(true)) => None,
        Some(_) => Some(std::collections::HashSet::new()),
    };

    if let Some(allow) = effective_allow {
        let mut blocked: Vec<String> = env_keys_set
            .iter()
            .filter(|k| !allow.contains(*k))
            .cloned()
            .collect();
        blocked.sort();
        if !blocked.is_empty() {
            warnings.push(format!(
                "Some env keys are configured but not readable by permissions.env: {}",
                blocked.join(", ")
            ));
        }
    }

    (Some(serde_json::Value::Object(out)), warnings)
}

// Checks whether `permissions.run` enables subprocess execution.
fn run_permission_enabled(permissions: Option<&serde_json::Value>) -> bool {
    if permissions == Some(&serde_json::Value::Bool(true)) {
        return true;
    }
    let Some(obj) = permissions.and_then(|v| v.as_object()) else {
        return false;
    };
    let Some(run) = obj.get("run") else {
        return false;
    };

    match run {
        serde_json::Value::Bool(v) => *v,
        serde_json::Value::Array(arr) => !arr.is_empty(),
        _ => false,
    }
}

impl WorkerCreateOptions {
    /// Constructs neon from source input for worker configuration/state parsing and runtime limits.
    pub fn from_neon<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> Result<Self, Throw> {
        let mut out = Self {
            channel_size: 512,
            ..Default::default()
        };
        out.runtime_options.wasm = true;

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
                        let j = expand_permissions_shorthand(j);
                        if let Some(w) = j.get("wasm").and_then(|v| v.as_bool()) {
                            out.runtime_options.wasm = w;
                        }
                        out.runtime_options.permissions = Some(j);
                    }
                }
            }
        }

        // `bridge`: { channelSize?, streamWindowBytes?, streamCreditFlushBytes?, streamHighWaterMarkBytes? }.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "bridge") {
            if let Ok(o) = v.downcast::<JsObject, _>(cx) {
                let mut cfg = BridgeConfig::default();
                let mut saw_bridge = false;

                if let Ok(cv) = o.get::<JsValue, _, _>(cx, "channelSize") {
                    if let Ok(cn) = cv.downcast::<JsNumber, _>(cx) {
                        let n = cn.value(cx);
                        if n.is_finite() && n >= 1.0 {
                            out.channel_size = n as usize;
                            saw_bridge = true;
                        }
                    }
                }

                if let Ok(sv) = o.get::<JsValue, _, _>(cx, "streamWindowBytes") {
                    if let Ok(sn) = sv.downcast::<JsNumber, _>(cx) {
                        let n = sn.value(cx);
                        if n.is_finite() && n >= 1.0 {
                            cfg.stream_window_bytes = Some(n as u64);
                            saw_bridge = true;
                        }
                    }
                }

                if let Ok(fv) = o.get::<JsValue, _, _>(cx, "streamCreditFlushBytes") {
                    if let Ok(fn_) = fv.downcast::<JsNumber, _>(cx) {
                        let n = fn_.value(cx);
                        if n.is_finite() && n >= 1.0 {
                            cfg.stream_credit_flush_bytes = Some(n as u64);
                            saw_bridge = true;
                        }
                    }
                }

                if let Ok(hv) = o.get::<JsValue, _, _>(cx, "streamHighWaterMarkBytes") {
                    if let Ok(hn) = hv.downcast::<JsNumber, _>(cx) {
                        let n = hn.value(cx);
                        if n.is_finite() && n >= 1.0 {
                            cfg.stream_high_water_mark_bytes = Some(n as u64);
                            saw_bridge = true;
                        }
                    }
                }

                if saw_bridge {
                    out.runtime_options.bridge = Some(cfg);
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

        // `maxCpuMs`.
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxCpuMs") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let ms = n.value(cx);
                if ms.is_finite() && ms > 0.0 {
                    out.runtime_options.max_cpu_ms = Some(ms as u64);
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
                        if !within_base_dir(&base_cwd, &p) {
                            return cx.throw_error("envFile path must stay within worker cwd sandbox");
                        }
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
                    if !within_base_dir(&base_cwd, &path) {
                        return cx.throw_error("env path must stay within worker cwd sandbox");
                    }
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
                        if n.is_finite() && n >= 0.0 && n <= 65535.0 {
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
        //   httpsResolve?: boolean;
        //   httpResolve?: boolean;
        //   nodeResolve?: boolean;
        //   jsrResolve?: boolean;
        //   cacheDir?: string;
        //   reload?: boolean;
        //   maxPayloadBytes?: number;
        // }
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "moduleLoader") {
            if let Ok(o) = v.downcast::<JsObject, _>(cx) {
                let mut cfg = ModuleLoaderConfig::default();

                if let Ok(rv) = o.get::<JsValue, _, _>(cx, "httpsResolve") {
                    if let Ok(rb) = rv.downcast::<JsBoolean, _>(cx) {
                        cfg.https_resolve = rb.value(cx);
                    }
                }

                if let Ok(nv) = o.get::<JsValue, _, _>(cx, "nodeResolve") {
                    if let Ok(nb) = nv.downcast::<JsBoolean, _>(cx) {
                        cfg.node_resolve = nb.value(cx);
                        out.runtime_options.node_resolve = cfg.node_resolve;
                    }
                }

                if let Ok(hv) = o.get::<JsValue, _, _>(cx, "httpResolve") {
                    if let Ok(hb) = hv.downcast::<JsBoolean, _>(cx) {
                        cfg.http_resolve = hb.value(cx);
                    }
                }

                if let Ok(jv) = o.get::<JsValue, _, _>(cx, "jsrResolve") {
                    if let Ok(jb) = jv.downcast::<JsBoolean, _>(cx) {
                        cfg.jsr_resolve = jb.value(cx);
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

                if let Ok(mv) = o.get::<JsValue, _, _>(cx, "maxPayloadBytes") {
                    if let Ok(mn) = mv.downcast::<JsNumber, _>(cx) {
                        let n = mn.value(cx);
                        if n.is_finite() {
                            cfg.max_payload_bytes = n as i64;
                        }
                    }
                }

                out.runtime_options.module_loader = Some(cfg);
            }
        }

        // Top-level `transpileTs`.
        let mut top_level_transpile: Option<bool> = None;
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "transpileTs") {
            if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                top_level_transpile = Some(b.value(cx));
            }
        }
        if let Some(enabled) = top_level_transpile {
            let cfg = out.runtime_options.module_loader.get_or_insert_with(Default::default);
            cfg.transpile_ts = enabled;
        }

        // Top-level `tsCompiler` (preferred).
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "tsCompiler") {
            if let Ok(tco) = v.downcast::<JsObject, _>(cx) {
                if let Some(tc) = parse_ts_compiler_config(cx, tco) {
                    let cfg = out.runtime_options.module_loader.get_or_insert_with(Default::default);
                    cfg.ts_compiler = Some(tc);
                }
            }
        }

        let env_keys = out.runtime_options.env.as_ref().and_then(|cfg| match cfg {
            EnvConfig::Map(map) => Some(map),
        });
        let (permissions, env_warnings) = ensure_env_permission_enabled(
            out.runtime_options.permissions.take(),
            env_keys,
        );
        out.runtime_options.permissions = permissions;
        out.runtime_options.startup_warnings.extend(env_warnings);
        if run_permission_enabled(out.runtime_options.permissions.as_ref()) {
            out.runtime_options.startup_warnings.push(
                "permissions.run is enabled: subprocesses may observe host environment values unless command env is explicitly constrained."
                    .to_string(),
            );
        }

        if out
            .runtime_options
            .module_loader
            .as_ref()
            .map(|m| m.http_resolve)
            .unwrap_or(false)
        {
            out.runtime_options.startup_warnings.push(
                "moduleLoader.httpResolve is enabled; HTTP imports are insecure and can be tampered with in transit."
                    .to_string(),
            );
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure_env_permission_enabled, run_permission_enabled, within_base_dir};
    use std::collections::HashMap;
    use std::path::PathBuf;

    // Env map.
    fn env_map(keys: &[&str]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for k in keys {
            out.insert((*k).to_string(), "v".to_string());
        }
        out
    }

    #[test]
    // Ensure env permission enabled keeps permissions when env not configured.
    fn ensure_env_permission_enabled_keeps_permissions_when_env_not_configured() {
        let original = Some(serde_json::json!({ "read": true, "env": false }));
        let (out, warnings) = ensure_env_permission_enabled(original.clone(), None);
        assert_eq!(out, original);
        assert!(warnings.is_empty());
    }

    #[test]
    // Ensure env permission enabled sets env allow list when missing.
    fn ensure_env_permission_enabled_sets_env_allow_list_when_missing() {
        let env = env_map(&["A", "B"]);
        let (out, warnings) =
            ensure_env_permission_enabled(Some(serde_json::json!({ "read": true })), Some(&env));
        let obj = out.expect("permissions");
        let env_val = obj
            .as_object()
            .and_then(|o| o.get("env"))
            .and_then(|v| v.as_array())
            .expect("env list");
        assert_eq!(env_val.len(), 2);
        assert!(warnings.is_empty());
    }

    #[test]
    // Ensure env permission enabled keeps existing env allow list.
    fn ensure_env_permission_enabled_keeps_existing_env_allow_list() {
        let env = env_map(&["A", "B"]);
        let (out, warnings) = ensure_env_permission_enabled(
            Some(serde_json::json!({ "env": ["A"], "write": ["./tmp"] })),
            Some(&env),
        );
        assert_eq!(
            out,
            Some(serde_json::json!({ "env": ["A"], "write": ["./tmp"] }))
        );
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("B"));
    }

    #[test]
    // Ensure env permission enabled keeps env false and warns.
    fn ensure_env_permission_enabled_keeps_env_false_and_warns() {
        let env = env_map(&["A"]);
        let (out, warnings) =
            ensure_env_permission_enabled(Some(serde_json::json!({ "env": false })), Some(&env));
        assert_eq!(out, Some(serde_json::json!({ "env": false })));
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    // Ensure shorthand permissions=true expands to allow-all semantics.
    fn ensure_env_permission_enabled_expands_permissions_true_shorthand() {
        let env = env_map(&["A"]);
        let (out, warnings) = ensure_env_permission_enabled(Some(serde_json::Value::Bool(true)), Some(&env));
        let env_allow = out
            .and_then(|v| v.as_object().cloned())
            .and_then(|o| o.get("env").cloned())
            .and_then(|v| v.as_bool());
        assert_eq!(env_allow, Some(true));
        assert!(warnings.is_empty());
    }

    #[test]
    // Checks whether permissions run enables subprocess execution.
    fn run_permission_enabled_detects_supported_forms() {
        assert!(run_permission_enabled(Some(&serde_json::Value::Bool(true))));
        assert!(run_permission_enabled(Some(&serde_json::json!({ "run": true }))));
        assert!(run_permission_enabled(Some(&serde_json::json!({ "run": ["deno"] }))));
        assert!(!run_permission_enabled(Some(&serde_json::json!({ "run": false }))));
        assert!(!run_permission_enabled(Some(&serde_json::json!({ "run": [] }))));
        assert!(!run_permission_enabled(Some(&serde_json::json!({ "read": true }))));
        assert!(!run_permission_enabled(None));
    }

    #[test]
    // Checks whether base dir rejects parent escape and returns the boolean result for worker configuration/state parsing and runtime limits.
    fn within_base_dir_rejects_parent_escape() {
        let base = if cfg!(windows) {
            PathBuf::from(r"C:\tmp\deno-director-sandbox")
        } else {
            PathBuf::from("/tmp/deno-director-sandbox")
        };
        let inside = base.join("a").join("b.env");
        let outside = base.join("..").join("outside.env");

        assert!(within_base_dir(&base, &inside));
        assert!(!within_base_dir(&base, &outside));
    }
}

#[derive(Debug, Clone)]
pub enum ImportsPolicy {
    DenyAll,
    AllowDisk,
    Callback,
}

impl Default for ImportsPolicy {
    // Provides default default values used by worker configuration/state parsing and runtime limits.
    fn default() -> Self {
        ImportsPolicy::DenyAll
    }
}

#[derive(Clone)]
pub struct WorkerHandle {
    pub id: usize,
    // Control plane: eval/evalModule/evalSync, setGlobal, memory, close.
    pub deno_tx: mpsc::Sender<DenoMsg>,
    // Data plane: postMessage + stream frames carried over postMessage.
    pub deno_data_tx: mpsc::Sender<DenoMsg>,
    pub node_tx: mpsc::Sender<NodeMsg>,
    pub channel: Channel,
    pub callbacks: NodeCallbacks,
    pub host_functions: Vec<Arc<Root<JsFunction>>>,
    pub closed: Arc<AtomicBool>,
    pub pending: Arc<PendingRequests>,
    pub last_stats: Arc<Mutex<Option<ExecStats>>>,
    pub eval_sync_active: Arc<AtomicBool>,
    pub inspect_bound_port: Arc<AtomicU16>,
    pub native_stream_plane: Arc<Mutex<Option<Arc<NativeIncomingPlane>>>>,
}

impl WorkerHandle {
    /// Creates a new instance initialized for worker option/state normalization.
    pub fn new(
        id: usize,
        channel: Channel,
        channel_size: usize,
    ) -> (
        Self,
        mpsc::Receiver<DenoMsg>,
        mpsc::Receiver<DenoMsg>,
        mpsc::Receiver<NodeMsg>,
    ) {
        let (deno_tx, deno_rx) = mpsc::channel(channel_size);
        let (deno_data_tx, deno_data_rx) = mpsc::channel(channel_size);
        let (node_tx, node_rx) = mpsc::channel(channel_size);

        let handle = Self {
            id,
            deno_tx,
            deno_data_tx,
            node_tx,
            channel,
            callbacks: NodeCallbacks::default(),
            host_functions: Vec::new(),
            closed: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(PendingRequests::default()),
            last_stats: Arc::new(Mutex::new(None)),
            eval_sync_active: Arc::new(AtomicBool::new(false)),
            inspect_bound_port: Arc::new(AtomicU16::new(0)),
            native_stream_plane: Arc::new(Mutex::new(None)),
        };

        (handle, deno_rx, deno_data_rx, node_rx)
    }

    /// Registers global fn in shared state used by worker configuration/state parsing and runtime limits.
    pub fn register_global_fn(&mut self, root: Root<JsFunction>) -> usize {
        let id = self.host_functions.len();
        self.host_functions.push(Arc::new(root));
        id
    }
}
