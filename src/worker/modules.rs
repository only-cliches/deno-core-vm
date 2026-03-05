use deno_error::JsErrorBox;
use deno_runtime::deno_core::{self, ModuleLoader, ModuleSource, ModuleType};
use deno_runtime::transpile::{JsParseDiagnostic, JsTranspileError};

use crate::worker::messages::NodeMsg;

use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::mpsc;

use deno_core::url::Url;

enum CallbackDecisionWait {
    Decision(crate::worker::messages::ImportDecision),
    ChannelClosed,
    TimedOut,
}

// Controls debug logging behavior used by module loading and import policy flow.
fn dbg_imports_enabled() -> bool {
    std::env::var("DENOJS_WORKER_DEBUG_IMPORTS")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        })
        .unwrap_or(false)
}

// Emits module-loader debug logs when import debug mode is active.
fn dbg_imports(msg: impl AsRef<str>) {
    if dbg_imports_enabled() {
        println!("[denojs-worker][imports] {}", msg.as_ref());
    }
}

#[derive(Clone, Debug)]
struct ModuleEntry {
    code: String,
    module_type: ModuleType,
    persistent: bool,
    uses_left: Option<usize>,
    loaded_once: bool,
}

struct ModuleRegistryState {
    modules: HashMap<String, ModuleEntry>,
    aliases: HashMap<String, String>,
    persistent_lru: VecDeque<String>,
    persistent_limit: usize,
}

#[derive(Clone)]
pub struct ModuleRegistry {
    state: Arc<Mutex<ModuleRegistryState>>,
    counter: Arc<AtomicUsize>,
}

impl ModuleRegistry {
    const DEFAULT_PERSISTENT_LIMIT: usize = 512;

    // Internal helper for module loading and import policy flow; it handles configured persistent limit.
    fn configured_persistent_limit() -> usize {
        std::env::var("DENOJS_WORKER_PERSISTENT_MODULE_LIMIT")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(Self::DEFAULT_PERSISTENT_LIMIT)
    }

    // Constructs a module registry with an explicit persistent entry cap.
    fn with_persistent_limit(persistent_limit: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(ModuleRegistryState {
                modules: HashMap::new(),
                aliases: HashMap::new(),
                persistent_lru: VecDeque::new(),
                persistent_limit,
            })),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Creates a new instance initialized for module loading and import policy flow.
    pub fn new(_base_url: Url) -> Self {
        Self::with_persistent_limit(Self::configured_persistent_limit())
    }

    #[cfg(test)]
    // Constructs a test registry with a deterministic persistent limit.
    fn with_persistent_limit_for_test(persistent_limit: usize) -> Self {
        Self::with_persistent_limit(persistent_limit)
    }

    // Moves a specifier to most-recent position in persistent-module LRU order.
    fn touch_lru(lru: &mut VecDeque<String>, specifier: &str) {
        if let Some(i) = lru.iter().position(|s| s == specifier) {
            lru.remove(i);
        }
        lru.push_back(specifier.to_string());
    }

    // Evicts least-recently-used loaded persistent modules when over configured limit.
    fn evict_persistent_if_needed(state: &mut ModuleRegistryState) {
        let mut persistent_count = state.modules.values().filter(|e| e.persistent).count();
        if persistent_count <= state.persistent_limit {
            return;
        }

        let mut checks_remaining = state.persistent_lru.len();
        while persistent_count > state.persistent_limit && checks_remaining > 0 {
            let Some(candidate) = state.persistent_lru.pop_front() else {
                break;
            };

            let can_evict = state
                .modules
                .get(&candidate)
                .map(|entry| entry.persistent && entry.loaded_once)
                .unwrap_or(false);

            if can_evict {
                state.modules.remove(&candidate);
                persistent_count -= 1;
                checks_remaining = state.persistent_lru.len();
            } else {
                state.persistent_lru.push_back(candidate);
                checks_remaining -= 1;
            }
        }
    }

    // Returns a deterministic internal virtual URL for a user-provided module name.
    fn named_virtual_specifier(module_name: &str) -> String {
        let mut encoded = String::with_capacity(module_name.len() * 2);
        for b in module_name.as_bytes() {
            let _ = std::fmt::Write::write_fmt(&mut encoded, format_args!("{b:02x}"));
        }
        format!("denojs-worker://virtual/__named_{encoded}.js")
    }

    /// Returns a unique virtual module specifier for generated source modules.
    pub fn next_virtual_specifier(&self, ext: &str) -> String {
        // Monotonic virtual ids avoid collision across evalModule calls.
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let ext = match ext {
            "js" | "ts" | "tsx" | "jsx" => ext,
            _ => "js",
        };
        format!("denojs-worker://virtual/__vm_{n}.{ext}")
    }

    /// Checks whether has and returns the boolean result for module resolution, policy, and remote loading.
    pub fn has(&self, specifier: &str) -> bool {
        self.state
            .lock()
            .ok()
            .map(|s| {
                if s.modules.contains_key(specifier) {
                    return true;
                }
                s.aliases
                    .get(specifier)
                    .map(|resolved| s.modules.contains_key(resolved))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// Resolves input specifier to canonical registry key when present.
    pub fn resolve_specifier(&self, specifier: &str) -> Option<String> {
        let state = self.state.lock().ok()?;
        if state.modules.contains_key(specifier) {
            return Some(specifier.to_string());
        }
        state.aliases.get(specifier).cloned()
    }

    /// Stores ephemeral in caches/state used by module resolution, policy, and remote loading.
    pub fn put_ephemeral(&self, specifier: &str, code: &str, module_type: ModuleType) {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.modules.insert(
            specifier.to_string(),
            ModuleEntry {
                code: code.to_string(),
                module_type,
                persistent: false,
                // Ephemeral modules survive a few loads to account for resolve/load
                // retries in the module graph, then are evicted.
                uses_left: Some(3),
                loaded_once: false,
            },
        );
        if let Some(i) = state.persistent_lru.iter().position(|s| s == specifier) {
            state.persistent_lru.remove(i);
        }
    }

    /// Stores persistent in caches/state used by module resolution, policy, and remote loading.
    pub fn put_persistent(&self, specifier: &str, code: &str, module_type: ModuleType) {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.modules.insert(
            specifier.to_string(),
            ModuleEntry {
                code: code.to_string(),
                module_type,
                persistent: true,
                uses_left: None,
                loaded_once: false,
            },
        );
        Self::touch_lru(&mut state.persistent_lru, specifier);
        Self::evict_persistent_if_needed(&mut state);
    }

    /// Stores a persistent module registered under user module name and canonical internal URL.
    pub fn put_named_persistent(&self, module_name: &str, code: &str, module_type: ModuleType) {
        let canonical = Self::named_virtual_specifier(module_name);
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        state.aliases.insert(module_name.to_string(), canonical.clone());
        state.modules.insert(
            canonical.clone(),
            ModuleEntry {
                code: code.to_string(),
                module_type,
                persistent: true,
                uses_left: None,
                loaded_once: false,
            },
        );
        Self::touch_lru(&mut state.persistent_lru, &canonical);
        Self::evict_persistent_if_needed(&mut state);
    }

    /// Removes remove from tracked state used by module resolution, policy, and remote loading.
    pub fn remove(&self, specifier: &str) {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.modules.remove(specifier);
        if let Some(canonical) = state.aliases.remove(specifier) {
            state.modules.remove(&canonical);
            if let Some(i) = state.persistent_lru.iter().position(|s| s == &canonical) {
                state.persistent_lru.remove(i);
            }
        }
        if let Some(i) = state.persistent_lru.iter().position(|s| s == specifier) {
            state.persistent_lru.remove(i);
        }
        state.aliases.retain(|_, v| v != specifier);
    }

    /// Removes a module registered by name; returns whether anything was removed.
    pub fn remove_named(&self, module_name: &str) -> bool {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let canonical = state.aliases.remove(module_name);
        let removed_alias = canonical.is_some();
        let removed_module = canonical
            .as_ref()
            .map(|key| state.modules.remove(key).is_some())
            .unwrap_or(false);
        if let Some(key) = canonical.as_ref() {
            if let Some(i) = state.persistent_lru.iter().position(|s| s == key) {
                state.persistent_lru.remove(i);
            }
        }
        removed_alias || removed_module
    }

    /// Returns module source for a load request and updates entry lifecycle/eviction state.
    pub fn get_for_load(&self, specifier: &str) -> Option<(String, ModuleType)> {
        let mut state = self.state.lock().ok()?;
        let lookup_key = state
            .aliases
            .get(specifier)
            .cloned()
            .unwrap_or_else(|| specifier.to_string());

        if let Some(entry) = state.modules.get_mut(&lookup_key) {
            if entry.persistent {
                entry.loaded_once = true;
                let out = (entry.code.clone(), entry.module_type.clone());
                Self::touch_lru(&mut state.persistent_lru, &lookup_key);
                return Some(out);
            }
        }

        let entry = state.modules.get_mut(&lookup_key)?;
        match entry.uses_left.as_mut() {
            Some(n) if *n > 0 => {
                *n -= 1;
                let out = entry.code.clone();
                let module_type = entry.module_type.clone();
                // Remove once budget is consumed so transient eval modules do not leak.
                if *n == 0 {
                    state.modules.remove(&lookup_key);
                }
                Some((out, module_type))
            }
            _ => {
                state.modules.remove(&lookup_key);
                None
            }
        }
    }
}

pub struct DynamicModuleLoader {
    pub reg: ModuleRegistry,
    pub node_tx: mpsc::Sender<NodeMsg>,
    pub imports_policy: crate::worker::state::ImportsPolicy,
    pub wasm: bool,
    pub node_resolve: bool,
    pub node_compat: bool,
    pub sandbox_root: PathBuf,
    pub fs_loader: Arc<deno_core::FsModuleLoader>,
    pub module_loader: Option<crate::worker::state::ModuleLoaderConfig>,
    pub permissions: Option<serde_json::Value>,
    pub eval_sync_active: Option<Arc<AtomicBool>>,
}

impl DynamicModuleLoader {
    // Returns the shared HTTP client used for remote module fetches.
    fn shared_http_client() -> Result<&'static reqwest::Client, JsErrorBox> {
        static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
        let built = CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .map_err(|e| format!("Remote fetch client build failed: {e}"))
        });
        match built {
            Ok(c) => Ok(c),
            Err(msg) => Err(JsErrorBox::generic(msg.clone())),
        }
    }

    // Checks whether request path matches an allow-list path boundary.
    fn path_is_prefix_boundary(allow_path: &str, req_path: &str) -> bool {
        if allow_path.is_empty() || allow_path == "/" {
            return true;
        }
        if req_path == allow_path {
            return true;
        }
        req_path.starts_with(allow_path)
            && req_path
                .as_bytes()
                .get(allow_path.len())
                .map(|b| *b == b'/')
                .unwrap_or(false)
    }

    // Checks scheme/host/port/path prefix match for URL-based import permissions.
    fn match_allow_url_prefix(allow: &Url, req: &Url) -> bool {
        if !allow.scheme().eq_ignore_ascii_case(req.scheme()) {
            return false;
        }
        let (Some(allow_host), Some(req_host)) = (allow.host_str(), req.host_str()) else {
            return false;
        };
        if !allow_host.eq_ignore_ascii_case(req_host) {
            return false;
        }
        let allow_port = allow.port_or_known_default();
        let req_port = req.port_or_known_default();
        if allow_port.is_some() && allow_port != req_port {
            return false;
        }
        Self::path_is_prefix_boundary(allow.path(), req.path())
    }

    // Internal helper for module loading and import policy flow; it handles node disk resolve enabled.
    fn node_disk_resolve_enabled(&self) -> bool {
        self.node_resolve
            || self.node_compat
            || self
                .module_loader
                .as_ref()
                .map(|m| m.node_resolve)
                .unwrap_or(false)
    }

    // Internal helper for module loading and import policy flow; it handles jsr resolve enabled.
    fn jsr_resolve_enabled(&self) -> bool {
        self.module_loader_cfg().jsr_resolve
    }

    /// Checks whether internal virtual url and returns the boolean result for module resolution, policy, and remote loading.
    pub fn is_internal_virtual_url(u: &Url) -> bool {
        u.scheme() == "denojs-worker" && u.host_str() == Some("virtual")
    }

    /// Checks whether bare specifier and returns the boolean result for module resolution, policy, and remote loading.
    pub fn is_bare_specifier(specifier: &str) -> bool {
        if specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/')
        {
            return false;
        }
        if specifier.contains("://") {
            return false;
        }
        if specifier.starts_with("data:") {
            return false;
        }
        true
    }

    // Maps `jsr:` or `@std/*` specifiers to `https://jsr.io/...` URLs.
    fn map_jsr_specifier(specifier: &str) -> Option<String> {
        if let Some(rest) = specifier.strip_prefix("jsr:") {
            let rest = rest.trim().trim_start_matches('/');
            if rest.is_empty() {
                return None;
            }
            return Some(format!("https://jsr.io/{rest}"));
        }

        if specifier.starts_with("@std/") {
            return Some(format!("https://jsr.io/{specifier}"));
        }

        None
    }

    /// Encodes resolve url into transport-safe form for module resolution, policy, and remote loading.
    pub fn encode_resolve_url(&self, specifier: &str, referrer: &str) -> Url {
        let mut u = Url::parse("denojs-worker://resolve").expect("parse resolve url");
        u.query_pairs_mut()
            .append_pair("specifier", specifier)
            .append_pair("referrer", referrer);
        u
    }

    /// Decodes resolve url from wire/serialized form for module resolution, policy, and remote loading.
    pub fn decode_resolve_url(u: &Url) -> Option<(String, String)> {
        if u.scheme() != "denojs-worker" {
            return None;
        }
        let mut spec = None;
        let mut referrer = None;
        for (k, v) in u.query_pairs() {
            if k == "specifier" {
                spec = Some(v.to_string());
            } else if k == "referrer" {
                referrer = Some(v.to_string());
            }
        }
        Some((spec?, referrer.unwrap_or_default()))
    }

    /// Checks whether sandbox and returns the boolean result for module resolution, policy, and remote loading.
    pub fn within_sandbox(&self, _file_url: &Url) -> bool {
        let root_abs =
            std::fs::canonicalize(&self.sandbox_root).unwrap_or_else(|_| self.sandbox_root.clone());

        let Ok(path) = _file_url.to_file_path() else {
            return false;
        };

        let cand_abs = std::fs::canonicalize(&path)
            .unwrap_or_else(|_| crate::worker::filesystem::normalize_lexical_path(&path));
        cand_abs.starts_with(&root_abs)
    }

    /// Attempts Node-style disk resolution for a specifier/referrer pair.
    pub fn try_node_resolve_disk(&self, specifier: &str, referrer: &str) -> Option<Url> {
        if !self.node_disk_resolve_enabled() {
            return None;
        }

        // Determine the base directory for resolution.
        let base_dir = if referrer.starts_with("file://") {
            Url::parse(referrer)
                .ok()
                .and_then(|u| u.to_file_path().ok())
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf()))
                .unwrap_or_else(|| self.sandbox_root.clone())
        } else {
            self.sandbox_root.clone()
        };

        // Relative/absolute path resolution with Node-style extension/index fallback.
        if specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/')
        {
            let p = if specifier.starts_with('/') {
                PathBuf::from(specifier)
            } else {
                base_dir.join(specifier)
            };

            if p.exists() {
                return Url::from_file_path(p).ok();
            }

            let exts = ["js", "mjs", "cjs", "ts", "mts"];
            for ext in exts {
                let mut pp = p.clone();
                pp.set_extension(ext);
                if pp.exists() {
                    return Url::from_file_path(pp).ok();
                }
            }

            if p.extension().is_none() && p.is_dir() {
                for ext in exts {
                    let idx = p.join(format!("index.{ext}"));
                    if idx.exists() {
                        return Url::from_file_path(idx).ok();
                    }
                }
            }

            return None;
        }

        // Bare specifier: constrained node_modules lookup under sandbox root only.
        if Self::is_bare_specifier(specifier) {
            let (pkg, subpath) = if specifier.starts_with('@') {
                // @scope/name[/...]
                let mut parts = specifier.splitn(3, '/');
                let a = parts.next()?;
                let b = parts.next()?;
                let pkg = format!("{a}/{b}");
                let rest = parts.next().map(|s| s.to_string());
                (pkg, rest)
            } else {
                let mut parts = specifier.splitn(2, '/');
                (
                    parts.next()?.to_string(),
                    parts.next().map(|s| s.to_string()),
                )
            };

            let pkg_dir = self.sandbox_root.join("node_modules").join(&pkg);
            if !pkg_dir.exists() {
                return None;
            }

            if let Some(sp) = subpath {
                let candidate = pkg_dir.join(sp);
                if candidate.exists() {
                    return Url::from_file_path(candidate).ok();
                }
                let exts = ["js", "mjs", "cjs", "ts", "mts"];
                for ext in exts {
                    let mut pp = candidate.clone();
                    pp.set_extension(ext);
                    if pp.exists() {
                        return Url::from_file_path(pp).ok();
                    }
                }
                return None;
            }

            // Use package.json module/main fallback, then index.*.
            let pkg_json = pkg_dir.join("package.json");
            if pkg_json.exists() {
                if let Ok(text) = std::fs::read_to_string(&pkg_json) {
                    if let Ok(j) = serde_json::from_str::<serde_json::Value>(&text) {
                        let entry = j
                            .get("module")
                            .and_then(|v| v.as_str())
                            .or_else(|| j.get("main").and_then(|v| v.as_str()))
                            .map(|s| s.to_string());

                        if let Some(entry) = entry {
                            let cand = pkg_dir.join(entry);
                            if cand.exists() {
                                return Url::from_file_path(cand).ok();
                            }
                            let exts = ["js", "mjs", "cjs"];
                            for ext in exts {
                                let mut pp = cand.clone();
                                pp.set_extension(ext);
                                if pp.exists() {
                                    return Url::from_file_path(pp).ok();
                                }
                            }
                        }
                    }
                }
            }

            let exts = ["js", "mjs", "cjs"];
            for ext in exts {
                let idx = pkg_dir.join(format!("index.{ext}"));
                if idx.exists() {
                    return Url::from_file_path(idx).ok();
                }
            }
        }

        None
    }

    /// Attempts Deno module resolution with import policy integration.
    pub fn try_deno_resolve(&self, specifier: &str, referrer: &str) -> Result<Url, JsErrorBox> {
        // Deno's resolver is strict about the referrer being a valid URL (often file://).
        // When our referrer is an internal virtual URL, treat it like "cwd/" for resolution.
        let effective_referrer = if referrer.starts_with("denojs-worker://virtual/") {
            // base_url for the sandbox root
            crate::worker::filesystem::dir_url_from_path(&self.sandbox_root).to_string()
        } else {
            referrer.to_string()
        };

        deno_core::resolve_import(specifier, &effective_referrer)
            .map_err(|e| JsErrorBox::generic(e.to_string()))
    }

    /// Clones module loader state for async load/resolve operations.
    pub fn clone_for_async(&self) -> Self {
        Self {
            reg: self.reg.clone(),
            node_tx: self.node_tx.clone(),
            imports_policy: self.imports_policy.clone(),
            wasm: self.wasm,
            node_resolve: self.node_resolve,
            node_compat: self.node_compat,
            sandbox_root: self.sandbox_root.clone(),
            fs_loader: self.fs_loader.clone(),
            module_loader: self.module_loader.clone(),
            permissions: self.permissions.clone(),
            eval_sync_active: self.eval_sync_active.clone(),
        }
    }

    // Best-effort runtime event emitter for Node-side runtime listeners.
    fn emit_runtime_event(&self, event: serde_json::Value) {
        let _ = self.node_tx.try_send(NodeMsg::EmitRuntimeEvent {
            value: crate::bridge::types::JsValueBridge::Json(event),
        });
    }

    // Emits `import.requested` event.
    fn emit_import_requested(
        &self,
        specifier: &str,
        referrer: &str,
        is_dynamic_import: bool,
        cache_hit: bool,
    ) {
        self.emit_runtime_event(serde_json::json!({
            "kind": "import.requested",
            "ts": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            "specifier": specifier,
            "referrer": referrer,
            "isDynamicImport": is_dynamic_import,
            "cacheHit": cache_hit
        }));
    }

    // Emits `import.resolved` event.
    fn emit_import_resolved(
        &self,
        specifier: &str,
        referrer: &str,
        is_dynamic_import: bool,
        cache_hit: bool,
        resolved_specifier: Option<&str>,
        source: &str,
        blocked: bool,
    ) {
        self.emit_runtime_event(serde_json::json!({
            "kind": "import.resolved",
            "ts": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            "specifier": specifier,
            "referrer": referrer,
            "isDynamicImport": is_dynamic_import,
            "cacheHit": cache_hit,
            "resolvedSpecifier": resolved_specifier,
            "source": source,
            "blocked": blocked
        }));
    }

    // Extracts original specifier/referrer from wrapped resolve URLs when present.
    fn original_spec_and_referrer(
        module_specifier: &Url,
        maybe_referrer: Option<&deno_core::ModuleLoadReferrer>,
    ) -> (String, String) {
        let spec = module_specifier.as_str().to_string();
        let referrer_from_runtime = maybe_referrer
            .map(|r| r.specifier.as_str().to_string())
            .unwrap_or_default();

        Self::decode_resolve_url(module_specifier)
            .unwrap_or_else(|| (spec, referrer_from_runtime))
    }

    // Internal helper for module loading and import policy flow; it handles imports policy error.
    fn imports_policy_error(&self, orig_spec: &str) -> Option<JsErrorBox> {
        match self.imports_policy {
            crate::worker::state::ImportsPolicy::DenyAll => Some(JsErrorBox::generic(format!(
                "Import blocked (imports disabled): {orig_spec}"
            ))),
            crate::worker::state::ImportsPolicy::AllowDisk
            | crate::worker::state::ImportsPolicy::Callback => None,
        }
    }

    // Internal helper for module loading and import policy flow; it handles callback imports blocked during eval sync.
    fn callback_imports_blocked_during_eval_sync(&self) -> bool {
        self.eval_sync_active
            .as_ref()
            .map(|v| v.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    // Checks whether wrap with redirect and returns the boolean result for module resolution, policy, and remote loading.
    fn should_wrap_with_redirect(requested_specifier: &Url) -> bool {
        requested_specifier.scheme() == "denojs-worker"
    }

    // Resolves allowed disk target according to rules used by module resolution, policy, and remote loading.
    fn resolve_allowed_disk_target(&self, orig_spec: &str, orig_referrer: &str) -> Option<Url> {
        self.try_node_resolve_disk(orig_spec, orig_referrer)
            .or_else(|| {
                DynamicModuleLoader::map_jsr_specifier(orig_spec)
                    .and_then(|jsr_spec| self.try_deno_resolve(&jsr_spec, orig_referrer).ok())
            })
            .or_else(|| self.try_deno_resolve(orig_spec, orig_referrer).ok())
    }

    // Resolves rewritten target according to rules used by module resolution, policy, and remote loading.
    fn resolve_rewritten_target(&self, rewritten_spec: &str, orig_referrer: &str) -> Option<Url> {
        let ns = rewritten_spec.trim();
        Url::parse(ns)
            .ok()
            .or_else(|| self.try_node_resolve_disk(ns, orig_referrer))
            .or_else(|| {
                DynamicModuleLoader::map_jsr_specifier(ns)
                    .and_then(|jsr_spec| self.try_deno_resolve(&jsr_spec, orig_referrer).ok())
            })
            .or_else(|| self.try_deno_resolve(ns, orig_referrer).ok())
    }

    // Resolves allow disk or error according to rules used by module resolution, policy, and remote loading.
    fn resolve_allow_disk_or_error(
        &self,
        orig_spec: &str,
        orig_referrer: &str,
    ) -> Result<Url, JsErrorBox> {
        self.resolve_allowed_disk_target(orig_spec, orig_referrer)
            .ok_or_else(|| JsErrorBox::generic(format!("Unable to resolve import: {}", orig_spec)))
    }

    // Resolves rewritten or error according to rules used by module resolution, policy, and remote loading.
    fn resolve_rewritten_or_error(
        &self,
        new_spec: &str,
        orig_referrer: &str,
    ) -> Result<Url, JsErrorBox> {
        self.resolve_rewritten_target(new_spec, orig_referrer).ok_or_else(|| {
            JsErrorBox::generic(format!(
                "Unable to resolve rewritten import: {}",
                new_spec
            ))
        })
    }

    // Checks whether load remote non callback and returns the boolean result for module resolution, policy, and remote loading.
    fn should_load_remote_non_callback(&self, module_specifier: &Url) -> bool {
        (module_specifier.scheme() == "http" && self.http_resolve_enabled())
            || (module_specifier.scheme() == "https" && self.https_resolve_enabled())
    }

    // Loads resolved module during module resolution, policy, and remote loading.
    async fn load_resolved_module(
        &self,
        requested_specifier: Url,
        resolved: Url,
        maybe_referrer_owned: Option<deno_core::ModuleLoadReferrer>,
        options: deno_core::ModuleLoadOptions,
    ) -> Result<ModuleSource, JsErrorBox> {
        self.ensure_wasm_allowed(&resolved)?;
        self.ensure_remote_load_allowed(&resolved)?;

        if resolved.scheme() == "file" && !self.within_sandbox(&resolved) {
            return Err(JsErrorBox::generic("Import blocked: outside sandbox"));
        }

        let loaded = match self
            .fs_loader
            .load(&resolved, maybe_referrer_owned.as_ref(), options)
        {
            deno_core::ModuleLoadResponse::Sync(r) => r,
            deno_core::ModuleLoadResponse::Async(fut) => fut.await,
        };

        loaded.map(|mut src| {
            if Self::should_wrap_with_redirect(&requested_specifier) {
                let code = src.cheap_copy_code();
                let module_type = src.module_type;
                let code_cache = src.code_cache.take();

                ModuleSource::new_with_redirect(
                    module_type,
                    code,
                    &requested_specifier,
                    &resolved,
                    code_cache,
                )
            } else {
                src
            }
        })
    }

    // Reads or fetch remote source for module resolution, policy, and remote loading.
    async fn read_or_fetch_remote_source(&self, module_specifier: &Url) -> Result<String, JsErrorBox> {
        let cfg = self.module_loader_cfg();
        let cache_path = self.remote_cache_path(module_specifier);

        if !cfg.reload {
            if let Ok(hit) = tokio::fs::read_to_string(&cache_path).await {
                return Ok(hit);
            }
        }

        let s = DynamicModuleLoader::fetch_remote_text(module_specifier, self.max_payload_bytes()).await?;
        if let Some(parent) = cache_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&cache_path, s.as_bytes()).await;
        Ok(s)
    }

    // Determines final module type for remote source, including TS-like coercions.
    fn final_module_type_for_remote(ext: &str, base: ModuleType) -> ModuleType {
        if DynamicModuleLoader::is_ts_like_ext(ext) {
            ModuleType::JavaScript
        } else {
            base
        }
    }

    // Loads remote non callback module during module resolution, policy, and remote loading.
    async fn load_remote_non_callback_module(
        &self,
        module_specifier: Url,
    ) -> Result<ModuleSource, JsErrorBox> {
        self.ensure_wasm_allowed(&module_specifier)?;
        self.ensure_remote_permissions(&module_specifier)?;
        let ext = DynamicModuleLoader::module_ext(&module_specifier).unwrap_or_default();
        let code = self.read_or_fetch_remote_source(&module_specifier).await?;
        let module_type = DynamicModuleLoader::module_type_for_url(&module_specifier);
        let final_code = self.maybe_transpile_ts_like(&module_specifier, &ext, code)?;
        let final_module_type = Self::final_module_type_for_remote(&ext, module_type);

        Ok(ModuleSource::new(
            final_module_type,
            deno_core::ModuleSourceCode::String(final_code.into()),
            &module_specifier,
            None,
        ))
    }

    // Normalizes callback decision into a canonical form before it is used by module resolution, policy, and remote loading.
    fn normalize_callback_decision(
        wait: CallbackDecisionWait,
        orig_spec: &str,
    ) -> Result<crate::worker::messages::ImportDecision, JsErrorBox> {
        match wait {
            CallbackDecisionWait::Decision(decision) => Ok(decision),
            CallbackDecisionWait::ChannelClosed => Ok(crate::worker::messages::ImportDecision::Block),
            CallbackDecisionWait::TimedOut => Err(JsErrorBox::generic(format!(
                "Import callback timed out: {}",
                orig_spec
            ))),
        }
    }

    // Internal helper for module loading and import policy flow; it handles source typed wrapper.
    fn source_typed_wrapper(virt: &str) -> String {
        format!(
            "export * from {v};\nexport {{ default }} from {v};\n",
            v = serde_json::to_string(virt)
                .unwrap_or_else(|_| "\"denojs-worker://virtual/__vm_bad.js\"".into())
        )
    }

    // Builds source typed module required by module resolution, policy, and remote loading.
    fn build_source_typed_module(
        &self,
        requested_specifier: &Url,
        ext: &str,
        code: String,
    ) -> Result<ModuleSource, JsErrorBox> {
        let mut final_code = code;
        if DynamicModuleLoader::is_ts_like_ext(ext) {
            final_code = self.maybe_transpile_ts_like(requested_specifier, ext, final_code)?;
        }

        let virt = self.reg.next_virtual_specifier("js");
        self.reg
            .put_persistent(&virt, &final_code, ModuleType::JavaScript);

        let wrapper = DynamicModuleLoader::source_typed_wrapper(&virt);
        Ok(ModuleSource::new(
            ModuleType::JavaScript,
            deno_core::ModuleSourceCode::String(wrapper.into()),
            requested_specifier,
            None,
        ))
    }

    // Requests import decision from Node callback channel.
    async fn request_import_decision(
        node_tx: &mpsc::Sender<NodeMsg>,
        orig_spec: &str,
        orig_referrer: &str,
        is_dynamic_import: bool,
    ) -> Result<crate::worker::messages::ImportDecision, JsErrorBox> {
        Self::request_import_decision_with_timeout(
            node_tx,
            orig_spec,
            orig_referrer,
            is_dynamic_import,
            Duration::from_secs(5),
        )
        .await
    }

    // Requests import decision with timeout and channel-closure handling.
    async fn request_import_decision_with_timeout(
        node_tx: &mpsc::Sender<NodeMsg>,
        orig_spec: &str,
        orig_referrer: &str,
        is_dynamic_import: bool,
        timeout: Duration,
    ) -> Result<crate::worker::messages::ImportDecision, JsErrorBox> {
        let (tx, rx) = tokio::sync::oneshot::channel::<crate::worker::messages::ImportDecision>();

        if node_tx
            .send(NodeMsg::ImportRequest {
                specifier: orig_spec.to_string(),
                referrer: orig_referrer.to_string(),
                is_dynamic_import,
                reply: tx,
            })
            .await
            .is_err()
        {
            return Err(JsErrorBox::generic("Imports callback unavailable"));
        }

        let wait = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(decision)) => CallbackDecisionWait::Decision(decision),
            Ok(Err(_)) => CallbackDecisionWait::ChannelClosed,
            Err(_) => CallbackDecisionWait::TimedOut,
        };
        Self::normalize_callback_decision(wait, orig_spec)
    }

    // Returns parsed permissions config used by module permission checks.
    fn permissions_cfg(&self) -> Option<&serde_json::Value> {
        self.permissions.as_ref()
    }

    // Matches host[:port] allow-list entries against URL host and effective port.
    fn match_host_port(allow: &str, host: &str, port: Option<u16>) -> bool {
        let allow = allow.trim();
        if allow.is_empty() {
            return false;
        }
        if allow == "*" {
            return true;
        }

        if allow.starts_with("http://") || allow.starts_with("https://") {
            let Ok(u) = Url::parse(allow) else {
                return false;
            };
            let Some(h) = u.host_str() else {
                return false;
            };
            if !h.eq_ignore_ascii_case(host) {
                return false;
            }
            let ap = u.port_or_known_default();
            return ap.is_none() || ap == port;
        }

        if let Some((h, p)) = allow.rsplit_once(':') {
            if h.contains(']') || h.contains('[') {
                return h.eq_ignore_ascii_case(host);
            }
            let Ok(pp) = p.parse::<u16>() else {
                return false;
            };
            return h.eq_ignore_ascii_case(host) && Some(pp) == port;
        }

        allow.eq_ignore_ascii_case(host)
    }

    // Checks whether import url and returns the boolean result for module resolution, policy, and remote loading.
    fn allows_import_url(&self, u: &Url) -> bool {
        let Some(cfg) = self.permissions_cfg() else {
            return false;
        };
        let Some(v) = cfg.get("import") else {
            return false;
        };

        if v == &serde_json::Value::Bool(true) {
            return true;
        }
        if v != &serde_json::Value::Bool(false) {
            if let Some(arr) = v.as_array() {
                for item in arr.iter().filter_map(|x| x.as_str()) {
                    let s = item.trim();
                    if s == "*" {
                        return true;
                    }
                    if s.starts_with("http://") || s.starts_with("https://") {
                        if let Ok(au) = Url::parse(s) {
                            if Self::match_allow_url_prefix(&au, u) {
                                return true;
                            }
                        }
                        continue;
                    }
                    if let Some(h) = u.host_str() {
                        if Self::match_host_port(s, h, u.port_or_known_default()) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    // Checks whether net url and returns the boolean result for module resolution, policy, and remote loading.
    fn allows_net_url(&self, u: &Url) -> bool {
        let Some(cfg) = self.permissions_cfg() else {
            return false;
        };
        let Some(v) = cfg.get("net") else {
            return false;
        };

        if v == &serde_json::Value::Bool(true) {
            return true;
        }
        if v != &serde_json::Value::Bool(false) {
            if let Some(arr) = v.as_array() {
                for item in arr.iter().filter_map(|x| x.as_str()) {
                    if let Some(h) = u.host_str() {
                        if Self::match_host_port(item, h, u.port_or_known_default()) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    // Validates remote import against import/net permission requirements.
    fn ensure_remote_permissions(&self, module_specifier: &Url) -> Result<(), JsErrorBox> {
        if !self.allows_import_url(module_specifier) {
            return Err(JsErrorBox::generic(format!(
                "Remote import denied by permissions.import: {}",
                module_specifier
            )));
        }
        if !self.allows_net_url(module_specifier) {
            return Err(JsErrorBox::generic(format!(
                "Remote import denied by permissions.net: {}",
                module_specifier
            )));
        }
        Ok(())
    }

    // Validates resolved remote URL against loader feature flags and permissions.
    fn ensure_remote_load_allowed(&self, resolved: &Url) -> Result<(), JsErrorBox> {
        if resolved.scheme() != "http" && resolved.scheme() != "https" {
            return Ok(());
        }

        if resolved.scheme() == "https" && !self.https_resolve_enabled() {
            return Err(JsErrorBox::generic(format!(
                "Remote HTTPS import blocked (moduleLoader.httpsResolve disabled): {}",
                resolved
            )));
        }

        if resolved.scheme() == "http" && !self.http_resolve_enabled() {
            return Err(JsErrorBox::generic(format!(
                "Remote HTTP import blocked (moduleLoader.httpResolve disabled): {}",
                resolved
            )));
        }

        self.ensure_remote_permissions(resolved)
    }

    // Returns effective module-loader configuration with defaults.
    fn module_loader_cfg(&self) -> crate::worker::state::ModuleLoaderConfig {
        self.module_loader.clone().unwrap_or_default()
    }

    // Internal helper for module loading and import policy flow; it handles https resolve enabled.
    fn https_resolve_enabled(&self) -> bool {
        self.module_loader_cfg().https_resolve
    }

    // Internal helper for module loading and import policy flow; it handles http resolve enabled.
    fn http_resolve_enabled(&self) -> bool {
        self.module_loader_cfg().http_resolve
    }

    // Returns configured remote payload byte limit.
    fn max_payload_bytes(&self) -> i64 {
        self.module_loader_cfg().max_payload_bytes
    }

    // Transpiles ts enabled as part of module resolution, policy, and remote loading.
    fn transpile_ts_enabled(&self) -> bool {
        self.module_loader_cfg().transpile_ts
    }

    // Extracts lowercased extension from module URL path.
    fn module_ext(u: &Url) -> Option<String> {
        let p = u.path().to_ascii_lowercase();
        p.rsplit('.').next().map(|s| s.to_string())
    }

    // Checks whether a module URL points to a `.wasm` file.
    fn is_wasm_url(u: &Url) -> bool {
        Self::module_ext(u).as_deref() == Some("wasm")
    }

    // Checks whether a raw module specifier references a `.wasm` path.
    fn is_wasm_specifier(specifier: &str) -> bool {
        if let Ok(u) = Url::parse(specifier) {
            return Self::is_wasm_url(&u);
        }
        let base = specifier.split('#').next().unwrap_or(specifier);
        let path_only = base.split('?').next().unwrap_or(base);
        path_only.to_ascii_lowercase().ends_with(".wasm")
    }

    // Enforces `permissions.wasm` for module loading paths.
    fn ensure_wasm_allowed(&self, module_specifier: &Url) -> Result<(), JsErrorBox> {
        if self.wasm || !Self::is_wasm_url(module_specifier) {
            return Ok(());
        }
        Err(JsErrorBox::generic(format!(
            "WASM module loading is disabled by permissions.wasm: {}",
            module_specifier
        )))
    }

    // Checks whether ts like ext and returns the boolean result for module resolution, policy, and remote loading.
    fn is_ts_like_ext(ext: &str) -> bool {
        matches!(ext, "ts" | "tsx" | "jsx")
    }

    // Maps file extension to Deno AST media type for transpilation.
    fn media_type_for_ext(ext: &str) -> deno_ast::MediaType {
        match ext {
            "ts" => deno_ast::MediaType::TypeScript,
            "tsx" => deno_ast::MediaType::Tsx,
            "jsx" => deno_ast::MediaType::Jsx,
            _ => deno_ast::MediaType::JavaScript,
        }
    }

    // Computes cache file path for a remote module URL.
    fn remote_cache_path(&self, module_specifier: &Url) -> PathBuf {
        let cfg = self.module_loader_cfg();
        let base = cfg
            .cache_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| self.sandbox_root.join(".deno_remote_cache"));

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        module_specifier.as_str().hash(&mut hasher);
        let h = hasher.finish();
        let ext = Self::module_ext(module_specifier).unwrap_or_else(|| "js".to_string());
        base.join(format!("{h:016x}.{ext}"))
    }

    // Fetches remote module text with payload guards and descriptive errors.
    async fn fetch_remote_text(
        module_specifier: &Url,
        max_payload_bytes: i64,
    ) -> Result<String, JsErrorBox> {
        let client = Self::shared_http_client()?;

        let mut resp = client
            .get(module_specifier.clone())
            .send()
            .await
            .map_err(|e| JsErrorBox::generic(format!("Remote fetch failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            return Err(JsErrorBox::generic(format!(
                "Remote fetch failed (status={}): {}",
                status, module_specifier
            )));
        }

        let limit = if max_payload_bytes < 0 {
            None
        } else {
            Some(max_payload_bytes as usize)
        };

        if let (Some(limit), Some(content_len)) = (limit, resp.content_length()) {
            if content_len > limit as u64 {
                return Err(JsErrorBox::generic(format!(
                    "Remote payload too large: {} bytes exceeds limit {} for {}",
                    content_len, limit, module_specifier
                )));
            }
        }

        let mut bytes: Vec<u8> = Vec::new();
        loop {
            let next = resp
                .chunk()
                .await
                .map_err(|e| JsErrorBox::generic(format!("Remote body read failed: {e}")))?;
            let Some(chunk) = next else { break };
            if let Some(limit) = limit {
                let next_len = bytes.len().saturating_add(chunk.len());
                if next_len > limit {
                    return Err(JsErrorBox::generic(format!(
                        "Remote payload too large: exceeds limit {} for {}",
                        limit, module_specifier
                    )));
                }
            }
            bytes.extend_from_slice(&chunk);
        }

        String::from_utf8(bytes)
            .map_err(|e| JsErrorBox::generic(format!("Remote body decode failed: {e}")))
    }

    // Determines module type from URL extension and runtime loading rules.
    fn module_type_for_url(module_specifier: &Url) -> ModuleType {
        let ext = Self::module_ext(module_specifier).unwrap_or_default();
        if ext == "json" {
            ModuleType::Json
        } else {
            ModuleType::JavaScript
        }
    }

    // Transpiles options from cfg as part of module resolution, policy, and remote loading.
    fn transpile_options_from_cfg(
        cfg: &crate::worker::state::ModuleLoaderConfig,
    ) -> deno_ast::TranspileOptions {
        let mut out = deno_ast::TranspileOptions::default();
        if let Some(tc) = cfg.ts_compiler.as_ref() {
            let jsx_mode = tc.jsx.as_deref().unwrap_or("react");
            out.jsx = match jsx_mode {
                "preserve" => None,
                "react-jsx" => Some(deno_ast::JsxRuntime::Automatic(
                    deno_ast::JsxAutomaticOptions {
                        development: false,
                        import_source: None,
                    },
                )),
                "react-jsxdev" => Some(deno_ast::JsxRuntime::Automatic(
                    deno_ast::JsxAutomaticOptions {
                        development: true,
                        import_source: None,
                    },
                )),
                _ => {
                    let mut classic = deno_ast::JsxClassicOptions::default();
                    if let Some(factory) = tc.jsx_factory.as_ref() {
                        classic.factory = factory.clone();
                    }
                    if let Some(fragment) = tc.jsx_fragment_factory.as_ref() {
                        classic.fragment_factory = fragment.clone();
                    }
                    Some(deno_ast::JsxRuntime::Classic(classic))
                }
            };
        }
        out
    }

    // Returns optional transpiler cache directory from module-loader config.
    fn compiler_cache_dir_from_cfg(
        cfg: &crate::worker::state::ModuleLoaderConfig,
    ) -> Option<PathBuf> {
        cfg.ts_compiler
            .as_ref()
            .and_then(|tc| tc.cache_dir.as_ref())
            .map(PathBuf::from)
    }

    // Computes stable transpile cache path from source, specifier, and compiler config.
    fn transpile_cache_path(
        cache_dir: &PathBuf,
        module_specifier: &Url,
        ext: &str,
        code: &str,
        cfg: &crate::worker::state::ModuleLoaderConfig,
    ) -> PathBuf {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        module_specifier.as_str().hash(&mut hasher);
        ext.hash(&mut hasher);
        code.hash(&mut hasher);
        if let Some(tc) = cfg.ts_compiler.as_ref() {
            tc.jsx.hash(&mut hasher);
            tc.jsx_factory.hash(&mut hasher);
            tc.jsx_fragment_factory.hash(&mut hasher);
        }
        let h = hasher.finish();
        cache_dir.join(format!("{h:016x}.js"))
    }

    // Internal helper for module loading and import policy flow; it handles maybe transpile ts like.
    fn maybe_transpile_ts_like(
        &self,
        module_specifier: &Url,
        ext: &str,
        code: String,
    ) -> Result<String, JsErrorBox> {
        if !Self::is_ts_like_ext(ext) {
            return Ok(code);
        }

        if !self.transpile_ts_enabled() {
            return Err(JsErrorBox::generic(format!(
                "Import returned .{ext} source but TypeScript transpilation is disabled. \
Enable it with transpileTs: true. Specifier: {}",
                module_specifier
            )));
        }

        let media_type = Self::media_type_for_ext(ext);
        let cfg = self.module_loader_cfg();
        let maybe_cache_path =
            Self::compiler_cache_dir_from_cfg(&cfg)
                .map(|dir| Self::transpile_cache_path(&dir, module_specifier, ext, &code, &cfg));
        if !cfg.reload {
            if let Some(cache_path) = maybe_cache_path.as_ref() {
                if let Ok(hit) = std::fs::read_to_string(cache_path) {
                    return Ok(hit);
                }
            }
        }

        let parsed = deno_ast::parse_module(deno_ast::ParseParams {
            specifier: module_specifier.clone(),
            text: code.into(),
            media_type,
            capture_tokens: false,
            scope_analysis: false,
            maybe_syntax: None,
        })
        .map_err(|e| JsErrorBox::from_err(JsParseDiagnostic(e)))?;

        let transpiled = parsed
            .transpile(
                &Self::transpile_options_from_cfg(&cfg),
                &deno_ast::TranspileModuleOptions::default(),
                &deno_ast::EmitOptions {
                    source_map: deno_ast::SourceMapOption::None,
                    ..Default::default()
                },
            )
            .map_err(|e| JsErrorBox::from_err(JsTranspileError(e)))?
            .into_source();

        if let Some(cache_path) = maybe_cache_path.as_ref() {
            if let Some(parent) = cache_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(cache_path, transpiled.text.as_bytes());
        }

        Ok(transpiled.text)
    }
}

impl ModuleLoader for DynamicModuleLoader {
    // Resolves resolve according to rules used by module resolution, policy, and remote loading.
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: deno_core::ResolutionKind,
    ) -> Result<Url, JsErrorBox> {
        if !self.wasm && Self::is_wasm_specifier(specifier) {
            return Err(JsErrorBox::generic(format!(
                "WASM module loading is disabled by permissions.wasm: {}",
                specifier
            )));
        }

        // Allow internal virtual URLs to pass through unchanged.
        if let Ok(u) = Url::parse(specifier) {
            if Self::is_internal_virtual_url(&u) {
                return Ok(u);
            }
        }

        // Allow direct hits for registry specifiers, including user aliases.
        if let Some(resolved_key) = self.reg.resolve_specifier(specifier) {
            if let Ok(u) = Url::parse(&resolved_key) {
                return Ok(u);
            }
        }

        // Callback path: always route via synthetic resolve URL.
        if matches!(
            self.imports_policy,
            crate::worker::state::ImportsPolicy::Callback
        ) {
            return Ok(self.encode_resolve_url(specifier, referrer));
        }

        // Node-style disk resolution (when enabled).
        if let Some(u) = self.try_node_resolve_disk(specifier, referrer) {
            return Ok(u);
        }

        // Optional Deno-style remote imports.
        if self.jsr_resolve_enabled() {
            if let Some(jsr_spec) = Self::map_jsr_specifier(specifier) {
                return self.try_deno_resolve(&jsr_spec, referrer);
            }
        }

        // Fast-fail unsupported bare specifiers so imports do not hang waiting
        // on fallback resolvers when neither Node nor JSR resolution is enabled.
        if Self::is_bare_specifier(specifier) && !self.node_disk_resolve_enabled() {
            return Err(JsErrorBox::generic(format!(
                "Bare import cannot be resolved without moduleLoader.nodeResolve or moduleLoader.jsrResolve: {specifier}"
            )));
        }

        if (specifier.starts_with("http://") && self.http_resolve_enabled())
            || (specifier.starts_with("https://") && self.https_resolve_enabled())
        {
            return self.try_deno_resolve(specifier, referrer);
        }

        // Deno resolver, but normalize virtual referrers into file://<cwd>/ for relative imports.
        self.try_deno_resolve(specifier, referrer)
    }

    // Loads load during module resolution, policy, and remote loading.
    fn load(
        &self,
        module_specifier: &Url,
        maybe_referrer: Option<&deno_core::ModuleLoadReferrer>,
        options: deno_core::ModuleLoadOptions,
    ) -> deno_core::ModuleLoadResponse {
        dbg_imports(format!(
            "load() module_specifier={} runtime_referrer={}",
            module_specifier,
            maybe_referrer
                .map(|r| r.specifier.as_str())
                .unwrap_or("<none>")
        ));

        if let Err(err) = self.ensure_wasm_allowed(module_specifier) {
            return deno_core::ModuleLoadResponse::Sync(Err(err));
        }

        let (orig_spec, orig_referrer) =
            Self::original_spec_and_referrer(module_specifier, maybe_referrer);
        let is_dynamic_import = options.is_dynamic_import;
        let cache_hit = self.reg.has(module_specifier.as_str()) || self.reg.has(&orig_spec);
        self.emit_import_requested(&orig_spec, &orig_referrer, is_dynamic_import, cache_hit);

        // 1) Serve in-memory modules first
        if let Some((code, module_type)) = self.reg.get_for_load(module_specifier.as_str()) {
            self.emit_import_resolved(
                &orig_spec,
                &orig_referrer,
                is_dynamic_import,
                true,
                Some(module_specifier.as_str()),
                "registry",
                false,
            );
            let source = ModuleSource::new(
                module_type,
                deno_core::ModuleSourceCode::String(code.into()),
                module_specifier,
                None,
            );
            return deno_core::ModuleLoadResponse::Sync(Ok(source));
        }

        // 2) Enforce imports policy for real module loads
        if let Some(err) = self.imports_policy_error(&orig_spec) {
            self.emit_import_resolved(
                &orig_spec,
                &orig_referrer,
                is_dynamic_import,
                false,
                None,
                "policy",
                true,
            );
            return deno_core::ModuleLoadResponse::Sync(Err(err));
        }

        // 3) Callback path
        if matches!(
            self.imports_policy,
            crate::worker::state::ImportsPolicy::Callback
        ) {
            if self.callback_imports_blocked_during_eval_sync() {
                self.emit_import_resolved(
                    &orig_spec,
                    &orig_referrer,
                    is_dynamic_import,
                    false,
                    None,
                    "callback",
                    true,
                );
                return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(
                    "Import callbacks are unavailable during evalSync. Use eval() instead.",
                )));
            }

            let node_tx = self.node_tx.clone();
            let this_loader = self.clone_for_async();

            let requested_specifier = module_specifier.clone();
            let maybe_referrer_owned: Option<deno_core::ModuleLoadReferrer> =
                maybe_referrer.cloned();

            return deno_core::ModuleLoadResponse::Async(Box::pin(async move {
                use crate::worker::messages::ImportDecision;
                let decision = DynamicModuleLoader::request_import_decision(
                    &node_tx,
                    &orig_spec,
                    &orig_referrer,
                    options.is_dynamic_import,
                )
                .await?;

                match decision {
                    ImportDecision::Block => {
                        this_loader.emit_import_resolved(
                            &orig_spec,
                            &orig_referrer,
                            options.is_dynamic_import,
                            false,
                            None,
                            "callback.block",
                            true,
                        );
                        Err(JsErrorBox::generic(format!("Import blocked: {}", orig_spec)))
                    }

                    ImportDecision::AllowDisk => {
                        let resolved = this_loader
                            .resolve_allow_disk_or_error(&orig_spec, &orig_referrer)?;

                        this_loader.emit_import_resolved(
                            &orig_spec,
                            &orig_referrer,
                            options.is_dynamic_import,
                            false,
                            Some(resolved.as_str()),
                            "callback.allowDisk",
                            false,
                        );

                        this_loader
                            .load_resolved_module(
                                requested_specifier.clone(),
                                resolved,
                                maybe_referrer_owned.clone(),
                                options,
                            )
                            .await
                    }

                    ImportDecision::Resolve(new_spec) => {
                        let resolved = this_loader
                            .resolve_rewritten_or_error(&new_spec, &orig_referrer)?;

                        this_loader.emit_import_resolved(
                            &orig_spec,
                            &orig_referrer,
                            options.is_dynamic_import,
                            false,
                            Some(resolved.as_str()),
                            "callback.resolve",
                            false,
                        );

                        this_loader
                            .load_resolved_module(
                                requested_specifier.clone(),
                                resolved,
                                maybe_referrer_owned.clone(),
                                options,
                            )
                            .await
                    }

                    ImportDecision::SourceTyped { ext, code } => this_loader
                        .build_source_typed_module(&requested_specifier, &ext, code)
                        .inspect(|_| {
                            this_loader.emit_import_resolved(
                                &orig_spec,
                                &orig_referrer,
                                options.is_dynamic_import,
                                false,
                                Some(requested_specifier.as_str()),
                                "callback.source",
                                false,
                            );
                        }),
                }
            }));
        }

        // 4) Non-callback: allow disk loads directly
        if self.should_load_remote_non_callback(module_specifier) {
            let this_loader = self.clone_for_async();
            let module_specifier = module_specifier.clone();
            self.emit_import_resolved(
                &orig_spec,
                &orig_referrer,
                is_dynamic_import,
                false,
                Some(module_specifier.as_str()),
                "remote",
                false,
            );

            return deno_core::ModuleLoadResponse::Async(Box::pin(async move {
                this_loader
                    .load_remote_non_callback_module(module_specifier)
                    .await
            }));
        }

        if module_specifier.scheme() == "file" && !self.within_sandbox(module_specifier) {
            self.emit_import_resolved(
                &orig_spec,
                &orig_referrer,
                is_dynamic_import,
                false,
                Some(module_specifier.as_str()),
                "sandbox",
                true,
            );
            return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(
                "Import blocked: outside sandbox",
            )));
        }

        self.emit_import_resolved(
            &orig_spec,
            &orig_referrer,
            is_dynamic_import,
            false,
            Some(module_specifier.as_str()),
            "fs",
            false,
        );
        self.fs_loader
            .load(module_specifier, maybe_referrer, options)
    }
}

#[cfg(test)]
mod tests {
    use super::{CallbackDecisionWait, DynamicModuleLoader, ModuleRegistry};
    use crate::worker::messages::{ImportDecision, NodeMsg};
    use crate::worker::state::{ImportsPolicy, ModuleLoaderConfig};
    use deno_core::url::Url;
    use deno_runtime::deno_core;
    use deno_runtime::deno_core::ModuleType;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;

    // Test helper used by module-loader unit tests.
    fn test_registry(limit: usize) -> ModuleRegistry {
        ModuleRegistry::with_persistent_limit_for_test(limit)
    }

    // Test helper used by module-loader unit tests.
    fn test_loader(https_resolve: bool, permissions: serde_json::Value) -> DynamicModuleLoader {
        let (node_tx, _node_rx) = mpsc::channel(1);
        DynamicModuleLoader {
            reg: ModuleRegistry::new(Url::parse("file:///tmp/").expect("url")),
            node_tx,
            imports_policy: ImportsPolicy::Callback,
            wasm: true,
            node_resolve: false,
            node_compat: false,
            sandbox_root: PathBuf::from("/tmp"),
            fs_loader: Arc::new(deno_core::FsModuleLoader),
            module_loader: Some(ModuleLoaderConfig {
                https_resolve,
                ..ModuleLoaderConfig::default()
            }),
            permissions: Some(permissions),
            eval_sync_active: None,
        }
    }

    // Internal helper for module loading and import policy flow; it handles run async.
    fn run_async<T>(fut: impl std::future::Future<Output = T>) -> T {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(fut)
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles persistent entries are evicted after first load when over limit.
    fn persistent_entries_are_evicted_after_first_load_when_over_limit() {
        let reg = test_registry(2);
        let base = Url::parse("file:///tmp/").expect("url");

        let a = format!("{}/a.js", base.as_str().trim_end_matches('/'));
        let b = format!("{}/b.js", base.as_str().trim_end_matches('/'));
        let c = format!("{}/c.js", base.as_str().trim_end_matches('/'));

        reg.put_persistent(&a, "export const a = 1;", ModuleType::JavaScript);
        reg.put_persistent(&b, "export const b = 1;", ModuleType::JavaScript);
        assert!(reg.get_for_load(&a).is_some());
        assert!(reg.get_for_load(&b).is_some());

        reg.put_persistent(&c, "export const c = 1;", ModuleType::JavaScript);

        assert!(!reg.has(&a));
        assert!(reg.has(&b));
        assert!(reg.has(&c));
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles never loaded persistent entries are not evicted.
    fn never_loaded_persistent_entries_are_not_evicted() {
        let reg = test_registry(1);
        let base = Url::parse("file:///tmp/").expect("url");

        let a = format!("{}/a.js", base.as_str().trim_end_matches('/'));
        let b = format!("{}/b.js", base.as_str().trim_end_matches('/'));

        reg.put_persistent(&a, "export const a = 1;", ModuleType::JavaScript);
        reg.put_persistent(&b, "export const b = 1;", ModuleType::JavaScript);

        assert!(reg.has(&a));
        assert!(reg.has(&b));

        // Once an entry has been loaded, it becomes evictable under pressure.
        assert!(reg.get_for_load(&a).is_some());
        let c = format!("{}/c.js", base.as_str().trim_end_matches('/'));
        reg.put_persistent(&c, "export const c = 1;", ModuleType::JavaScript);
        assert!(!reg.has(&a));
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles remote load blocked when https resolve disabled.
    fn remote_load_blocked_when_https_resolve_disabled() {
        let loader = test_loader(false, serde_json::json!({ "import": true, "net": true }));
        let url = Url::parse("https://example.com/mod.ts").expect("url");
        assert!(loader.ensure_remote_load_allowed(&url).is_err());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles remote load requires import and net permissions.
    fn remote_load_requires_import_and_net_permissions() {
        let loader = test_loader(true, serde_json::json!({ "import": true, "net": false }));
        let url = Url::parse("https://example.com/mod.ts").expect("url");
        assert!(loader.ensure_remote_load_allowed(&url).is_err());

        let loader2 = test_loader(true, serde_json::json!({ "import": false, "net": true }));
        assert!(loader2.ensure_remote_load_allowed(&url).is_err());

        let ok = test_loader(true, serde_json::json!({ "import": true, "net": true }));
        assert!(ok.ensure_remote_load_allowed(&url).is_ok());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles import allow url does not match host prefix confusion.
    fn import_allow_url_does_not_match_host_prefix_confusion() {
        let loader = test_loader(
            true,
            serde_json::json!({
                "import": ["https://example.com"],
                "net": true
            }),
        );

        let ok = Url::parse("https://example.com/mod.ts").expect("url");
        let bad = Url::parse("https://example.com.attacker.tld/mod.ts").expect("url");

        assert!(loader.ensure_remote_load_allowed(&ok).is_ok());
        assert!(loader.ensure_remote_load_allowed(&bad).is_err());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles import allow url honors path boundary.
    fn import_allow_url_honors_path_boundary() {
        let loader = test_loader(
            true,
            serde_json::json!({
                "import": ["https://example.com/api"],
                "net": true
            }),
        );

        let ok = Url::parse("https://example.com/api/v1/mod.ts").expect("url");
        let bad = Url::parse("https://example.com/apix/mod.ts").expect("url");

        assert!(loader.ensure_remote_load_allowed(&ok).is_ok());
        assert!(loader.ensure_remote_load_allowed(&bad).is_err());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles map jsr specifier maps jsr and std forms.
    fn map_jsr_specifier_maps_jsr_and_std_forms() {
        let a = DynamicModuleLoader::map_jsr_specifier("jsr:@std/assert");
        assert_eq!(a.as_deref(), Some("https://jsr.io/@std/assert"));

        let b = DynamicModuleLoader::map_jsr_specifier("@std/assert/equals");
        assert_eq!(b.as_deref(), Some("https://jsr.io/@std/assert/equals"));

        let c = DynamicModuleLoader::map_jsr_specifier("@scope/pkg");
        assert!(c.is_none());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles original spec and referrer prefers decoded resolve url.
    fn original_spec_and_referrer_prefers_decoded_resolve_url() {
        let u = Url::parse(
            "denojs-worker://resolve?specifier=https%3A%2F%2Fexample.com%2Fa.ts&referrer=file%3A%2F%2F%2Ftmp%2Fmain.ts",
        )
        .expect("url");
        let (spec, referrer) = DynamicModuleLoader::original_spec_and_referrer(&u, None);
        assert_eq!(spec, "https://example.com/a.ts");
        assert_eq!(referrer, "file:///tmp/main.ts");
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles original spec and referrer falls back to runtime referrer.
    fn original_spec_and_referrer_falls_back_to_runtime_referrer() {
        let module = Url::parse("file:///tmp/mod.ts").expect("url");
        let runtime_ref = deno_core::ModuleLoadReferrer {
            specifier: Url::parse("file:///tmp/main.ts").expect("url"),
            line_number: 0,
            column_number: 0,
        };
        let (spec, referrer) =
            DynamicModuleLoader::original_spec_and_referrer(&module, Some(&runtime_ref));
        assert_eq!(spec, "file:///tmp/mod.ts");
        assert_eq!(referrer, "file:///tmp/main.ts");
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles imports policy error only for deny all.
    fn imports_policy_error_only_for_deny_all() {
        let deny = DynamicModuleLoader {
            imports_policy: ImportsPolicy::DenyAll,
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };
        let allow_disk = DynamicModuleLoader {
            imports_policy: ImportsPolicy::AllowDisk,
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };
        let callback = DynamicModuleLoader {
            imports_policy: ImportsPolicy::Callback,
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };

        assert!(deny
            .imports_policy_error("https://example.com/mod.ts")
            .is_some());
        assert!(allow_disk
            .imports_policy_error("https://example.com/mod.ts")
            .is_none());
        assert!(callback
            .imports_policy_error("https://example.com/mod.ts")
            .is_none());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles callback imports blocked during eval sync tracks atomic state.
    fn callback_imports_blocked_during_eval_sync_tracks_atomic_state() {
        let active = Arc::new(AtomicBool::new(false));
        let loader = DynamicModuleLoader {
            eval_sync_active: Some(active.clone()),
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };

        assert!(!loader.callback_imports_blocked_during_eval_sync());
        active.store(true, Ordering::SeqCst);
        assert!(loader.callback_imports_blocked_during_eval_sync());
    }

    #[test]
    // Checks whether wrap with redirect is true only for internal resolve scheme and returns the boolean result for module resolution, policy, and remote loading.
    fn should_wrap_with_redirect_is_true_only_for_internal_resolve_scheme() {
        let internal = Url::parse("denojs-worker://resolve?specifier=x").expect("url");
        let file = Url::parse("file:///tmp/mod.ts").expect("url");
        let https = Url::parse("https://example.com/mod.ts").expect("url");

        assert!(DynamicModuleLoader::should_wrap_with_redirect(&internal));
        assert!(!DynamicModuleLoader::should_wrap_with_redirect(&file));
        assert!(!DynamicModuleLoader::should_wrap_with_redirect(&https));
    }

    #[test]
    // Resolves allowed disk target resolves direct remote urls according to rules used by module resolution, policy, and remote loading.
    fn resolve_allowed_disk_target_resolves_direct_remote_urls() {
        let loader = test_loader(true, serde_json::json!({ "import": true, "net": true }));
        let out = loader
            .resolve_allowed_disk_target("https://example.com/mod.ts", "file:///tmp/main.ts")
            .expect("resolved");
        assert_eq!(out.as_str(), "https://example.com/mod.ts");
    }

    #[test]
    // Resolves rewritten target supports absolute url and trim according to rules used by module resolution, policy, and remote loading.
    fn resolve_rewritten_target_supports_absolute_url_and_trim() {
        let loader = test_loader(true, serde_json::json!({ "import": true, "net": true }));
        let out = loader
            .resolve_rewritten_target("  https://example.com/rewrite.ts  ", "file:///tmp/main.ts")
            .expect("resolved");
        assert_eq!(out.as_str(), "https://example.com/rewrite.ts");
    }

    #[test]
    // Checks whether load remote non callback respects scheme and config and returns the boolean result for module resolution, policy, and remote loading.
    fn should_load_remote_non_callback_respects_scheme_and_config() {
        let https_only = DynamicModuleLoader {
            module_loader: Some(ModuleLoaderConfig {
                https_resolve: true,
                http_resolve: false,
                ..ModuleLoaderConfig::default()
            }),
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };
        let http_only = DynamicModuleLoader {
            module_loader: Some(ModuleLoaderConfig {
                https_resolve: false,
                http_resolve: true,
                ..ModuleLoaderConfig::default()
            }),
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };

        let https = Url::parse("https://example.com/mod.ts").expect("url");
        let http = Url::parse("http://example.com/mod.ts").expect("url");
        let file = Url::parse("file:///tmp/mod.ts").expect("url");

        assert!(https_only.should_load_remote_non_callback(&https));
        assert!(!https_only.should_load_remote_non_callback(&http));
        assert!(!https_only.should_load_remote_non_callback(&file));

        assert!(http_only.should_load_remote_non_callback(&http));
        assert!(!http_only.should_load_remote_non_callback(&https));
        assert!(!http_only.should_load_remote_non_callback(&file));
    }

    #[test]
    // Checks `permissions.wasm` enforcement for wasm module URLs.
    fn ensure_wasm_allowed_blocks_wasm_when_disabled() {
        let disabled = DynamicModuleLoader {
            wasm: false,
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };
        let enabled = DynamicModuleLoader {
            wasm: true,
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };

        let wasm = Url::parse("file:///tmp/mod.wasm").expect("url");
        let js = Url::parse("file:///tmp/mod.js").expect("url");

        assert!(disabled.ensure_wasm_allowed(&wasm).is_err());
        assert!(disabled.ensure_wasm_allowed(&js).is_ok());
        assert!(enabled.ensure_wasm_allowed(&wasm).is_ok());
    }

    #[test]
    // Checks resolve-time wasm blocking for disabled permissions.wasm.
    fn resolve_blocks_wasm_when_disabled() {
        let disabled = DynamicModuleLoader {
            wasm: false,
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };
        let out = deno_core::ModuleLoader::resolve(
            &disabled,
            "file:///tmp/mod.wasm",
            "file:///tmp/main.ts",
            deno_core::ResolutionKind::Import,
        );
        assert!(out.is_err());
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles final module type for remote forces js for ts like ext.
    fn final_module_type_for_remote_forces_js_for_ts_like_ext() {
        assert_eq!(
            DynamicModuleLoader::final_module_type_for_remote("ts", ModuleType::Json),
            ModuleType::JavaScript
        );
        assert_eq!(
            DynamicModuleLoader::final_module_type_for_remote("tsx", ModuleType::Json),
            ModuleType::JavaScript
        );
        assert_eq!(
            DynamicModuleLoader::final_module_type_for_remote("jsx", ModuleType::Json),
            ModuleType::JavaScript
        );
        assert_eq!(
            DynamicModuleLoader::final_module_type_for_remote("json", ModuleType::Json),
            ModuleType::Json
        );
    }

    #[test]
    // Normalizes callback decision maps channel closed to block into a canonical form before it is used by module resolution, policy, and remote loading.
    fn normalize_callback_decision_maps_channel_closed_to_block() {
        let out = DynamicModuleLoader::normalize_callback_decision(
            CallbackDecisionWait::ChannelClosed,
            "https://example.com/mod.ts",
        )
        .expect("decision");
        assert!(matches!(out, ImportDecision::Block));
    }

    #[test]
    // Normalizes callback decision preserves decision variant into a canonical form before it is used by module resolution, policy, and remote loading.
    fn normalize_callback_decision_preserves_decision_variant() {
        let out = DynamicModuleLoader::normalize_callback_decision(
            CallbackDecisionWait::Decision(ImportDecision::Resolve(
                "https://example.com/rewrite.ts".to_string(),
            )),
            "https://example.com/mod.ts",
        )
        .expect("decision");
        match out {
            ImportDecision::Resolve(s) => assert_eq!(s, "https://example.com/rewrite.ts"),
            other => panic!("unexpected decision: {:?}", other),
        }
    }

    #[test]
    // Normalizes callback decision reports timeout with specifier into a canonical form before it is used by module resolution, policy, and remote loading.
    fn normalize_callback_decision_reports_timeout_with_specifier() {
        let err = DynamicModuleLoader::normalize_callback_decision(
            CallbackDecisionWait::TimedOut,
            "https://example.com/slow.ts",
        )
        .expect_err("timeout error");
        assert!(err
            .to_string()
            .contains("Import callback timed out: https://example.com/slow.ts"));
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles source typed wrapper quotes virtual specifier.
    fn source_typed_wrapper_quotes_virtual_specifier() {
        let virt = "denojs-worker://virtual/__vm_42.js";
        let wrapper = DynamicModuleLoader::source_typed_wrapper(virt);
        assert!(wrapper.contains("export * from \"denojs-worker://virtual/__vm_42.js\";"));
        assert!(wrapper.contains(
            "export { default } from \"denojs-worker://virtual/__vm_42.js\";"
        ));
    }

    #[test]
    // Resolves allow disk or error produces expected success and error according to rules used by module resolution, policy, and remote loading.
    fn resolve_allow_disk_or_error_produces_expected_success_and_error() {
        let loader = test_loader(true, serde_json::json!({ "import": true, "net": true }));

        let ok = loader
            .resolve_allow_disk_or_error("https://example.com/mod.ts", "file:///tmp/main.ts")
            .expect("resolved");
        assert_eq!(ok.as_str(), "https://example.com/mod.ts");

        let err = loader
            .resolve_allow_disk_or_error("@bad/bare", "file:///tmp/main.ts")
            .expect_err("unresolved");
        assert!(err.to_string().contains("Unable to resolve import: @bad/bare"));
    }

    #[test]
    // Resolves rewritten or error produces expected success and error according to rules used by module resolution, policy, and remote loading.
    fn resolve_rewritten_or_error_produces_expected_success_and_error() {
        let loader = test_loader(true, serde_json::json!({ "import": true, "net": true }));

        let ok = loader
            .resolve_rewritten_or_error("https://example.com/rewrite.ts", "file:///tmp/main.ts")
            .expect("resolved");
        assert_eq!(ok.as_str(), "https://example.com/rewrite.ts");

        let err = loader
            .resolve_rewritten_or_error("@bad/rewrite", "file:///tmp/main.ts")
            .expect_err("unresolved");
        assert!(err
            .to_string()
            .contains("Unable to resolve rewritten import: @bad/rewrite"));
    }

    #[test]
    // Builds source typed module registers virtual module for js required by module resolution, policy, and remote loading.
    fn build_source_typed_module_registers_virtual_module_for_js() {
        let loader = test_loader(true, serde_json::json!({ "import": true, "net": true }));
        let requested = Url::parse("denojs-worker://resolve?specifier=x").expect("url");
        let _out = loader
            .build_source_typed_module(&requested, "js", "export const x = 1;".to_string())
            .expect("module");

        let virt = "denojs-worker://virtual/__vm_1.js";
        assert!(loader.reg.has(virt));
    }

    #[test]
    // Builds source typed module rejects ts when transpile disabled required by module resolution, policy, and remote loading.
    fn build_source_typed_module_rejects_ts_when_transpile_disabled() {
        let loader = DynamicModuleLoader {
            module_loader: Some(ModuleLoaderConfig {
                transpile_ts: false,
                ..ModuleLoaderConfig::default()
            }),
            ..test_loader(true, serde_json::json!({ "import": true, "net": true }))
        };
        let requested = Url::parse("denojs-worker://resolve?specifier=x").expect("url");
        let err = loader
            .build_source_typed_module(&requested, "ts", "export const x: number = 1;".to_string())
            .expect_err("expected transpile-disabled error");
        assert!(err.to_string().contains("TypeScript transpilation is disabled"));
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles request import decision returns reply from node channel.
    fn request_import_decision_returns_reply_from_node_channel() {
        run_async(async {
            let (tx, mut rx) = mpsc::channel(1);
            tokio::spawn(async move {
                if let Some(NodeMsg::ImportRequest { reply, .. }) = rx.recv().await {
                    let _ = reply.send(ImportDecision::AllowDisk);
                }
            });

            let out = DynamicModuleLoader::request_import_decision_with_timeout(
                &tx,
                "https://example.com/mod.ts",
                "file:///tmp/main.ts",
                false,
                Duration::from_millis(50),
            )
            .await
            .expect("decision");
            assert!(matches!(out, ImportDecision::AllowDisk));
        });
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles request import decision channel closed maps to block.
    fn request_import_decision_channel_closed_maps_to_block() {
        run_async(async {
            let (tx, mut rx) = mpsc::channel(1);
            tokio::spawn(async move {
                if let Some(NodeMsg::ImportRequest { .. }) = rx.recv().await {
                    // Drop oneshot sender without replying.
                }
            });

            let out = DynamicModuleLoader::request_import_decision_with_timeout(
                &tx,
                "https://example.com/mod.ts",
                "file:///tmp/main.ts",
                false,
                Duration::from_millis(50),
            )
            .await
            .expect("decision");
            assert!(matches!(out, ImportDecision::Block));
        });
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles request import decision timeout returns error.
    fn request_import_decision_timeout_returns_error() {
        run_async(async {
            let (tx, mut rx) = mpsc::channel(1);
            tokio::spawn(async move {
                if let Some(NodeMsg::ImportRequest { .. }) = rx.recv().await {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            });

            let err = DynamicModuleLoader::request_import_decision_with_timeout(
                &tx,
                "https://example.com/slow.ts",
                "file:///tmp/main.ts",
                true,
                Duration::from_millis(20),
            )
            .await
            .expect_err("timeout");
            assert!(err
                .to_string()
                .contains("Import callback timed out: https://example.com/slow.ts"));
        });
    }

    #[test]
    // Internal helper for module loading and import policy flow; it handles request import decision unavailable when channel closed.
    fn request_import_decision_unavailable_when_channel_closed() {
        run_async(async {
            let (tx, rx) = mpsc::channel(1);
            drop(rx);

            let err = DynamicModuleLoader::request_import_decision_with_timeout(
                &tx,
                "https://example.com/mod.ts",
                "file:///tmp/main.ts",
                false,
                Duration::from_millis(20),
            )
            .await
            .expect_err("closed");
            assert!(err.to_string().contains("Imports callback unavailable"));
        });
    }
}
