use deno_error::JsErrorBox;
use deno_runtime::deno_core::{self, ModuleLoader, ModuleSource, ModuleType};
use deno_runtime::transpile::{JsParseDiagnostic, JsTranspileError};

use crate::worker::messages::NodeMsg;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use tokio::sync::mpsc;

use deno_core::url::Url;

fn dbg_imports_enabled() -> bool {
    std::env::var("DENOJS_WORKER_DEBUG_IMPORTS")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        })
        .unwrap_or(false)
}

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
}

#[derive(Clone)]
pub struct ModuleRegistry {
    modules: Arc<Mutex<HashMap<String, ModuleEntry>>>,
    counter: Arc<AtomicUsize>,
}

impl ModuleRegistry {
    pub fn new(_base_url: Url) -> Self {
        Self {
            modules: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn next_virtual_specifier(&self, ext: &str) -> String {
        // Monotonic virtual ids avoid collision across evalModule calls.
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let ext = match ext {
            "js" | "ts" | "tsx" | "jsx" => ext,
            _ => "js",
        };
        format!("denojs-worker://virtual/__vm_{n}.{ext}")
    }

    pub fn has(&self, specifier: &str) -> bool {
        self.modules
            .lock()
            .ok()
            .map(|m| m.contains_key(specifier))
            .unwrap_or(false)
    }

    pub fn put_ephemeral(&self, specifier: &str, code: &str, module_type: ModuleType) {
        let mut map = self.modules.lock().expect("modules lock");
        map.insert(
            specifier.to_string(),
            ModuleEntry {
                code: code.to_string(),
                module_type,
                persistent: false,
                // Ephemeral modules survive a few loads to account for resolve/load
                // retries in the module graph, then are evicted.
                uses_left: Some(3),
            },
        );
    }

    pub fn put_persistent(&self, specifier: &str, code: &str, module_type: ModuleType) {
        let mut map = self.modules.lock().expect("modules lock");
        map.insert(
            specifier.to_string(),
            ModuleEntry {
                code: code.to_string(),
                module_type,
                persistent: true,
                uses_left: None,
            },
        );
    }

    pub fn get_for_load(&self, specifier: &str) -> Option<(String, ModuleType)> {
        let mut map = self.modules.lock().ok()?;
        let entry = map.get_mut(specifier)?;

        if entry.persistent {
            return Some((entry.code.clone(), entry.module_type.clone()));
        }

        match entry.uses_left.as_mut() {
            Some(n) if *n > 0 => {
                *n -= 1;
                let out = entry.code.clone();
                let module_type = entry.module_type.clone();
                // Remove once budget is consumed so transient eval modules do not leak.
                if *n == 0 {
                    map.remove(specifier);
                }
                Some((out, module_type))
            }
            _ => {
                map.remove(specifier);
                None
            }
        }
    }
}

pub struct DynamicModuleLoader {
    pub reg: ModuleRegistry,
    pub node_tx: mpsc::Sender<NodeMsg>,
    pub imports_policy: crate::worker::state::ImportsPolicy,
    pub node_resolve: bool,
    pub node_compat: bool,
    pub sandbox_root: PathBuf,
    pub fs_loader: Arc<deno_core::FsModuleLoader>,
    pub module_loader: Option<crate::worker::state::ModuleLoaderConfig>,
    pub permissions: Option<serde_json::Value>,
}

impl DynamicModuleLoader {
    fn node_disk_resolve_enabled(&self) -> bool {
        self.node_resolve || self.node_compat
    }

    pub fn is_internal_virtual_url(u: &Url) -> bool {
        u.scheme() == "denojs-worker" && u.host_str() == Some("virtual")
    }

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

    pub fn encode_resolve_url(&self, specifier: &str, referrer: &str) -> Url {
        let mut u = Url::parse("denojs-worker://resolve").expect("parse resolve url");
        u.query_pairs_mut()
            .append_pair("specifier", specifier)
            .append_pair("referrer", referrer);
        u
    }

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

    pub fn within_sandbox(&self, _file_url: &Url) -> bool {
        let root_abs =
            std::fs::canonicalize(&self.sandbox_root).unwrap_or_else(|_| self.sandbox_root.clone());

        let Ok(path) = _file_url.to_file_path() else {
            return false;
        };

        let cand_abs = std::fs::canonicalize(&path).unwrap_or(path);
        cand_abs.starts_with(&root_abs)
    }

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

    pub fn clone_for_async(&self) -> Self {
        Self {
            reg: self.reg.clone(),
            node_tx: self.node_tx.clone(),
            imports_policy: self.imports_policy.clone(),
            node_resolve: self.node_resolve,
            node_compat: self.node_compat,
            sandbox_root: self.sandbox_root.clone(),
            fs_loader: self.fs_loader.clone(),
            module_loader: self.module_loader.clone(),
            permissions: self.permissions.clone(),
        }
    }

    fn permissions_cfg(&self) -> Option<&serde_json::Value> {
        self.permissions.as_ref()
    }

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
                        if u.as_str().starts_with(s) {
                            return true;
                        }
                        if let Ok(au) = Url::parse(s) {
                            if let (Some(ah), Some(h)) = (au.host_str(), u.host_str()) {
                                if ah.eq_ignore_ascii_case(h)
                                    && (au.port_or_known_default().is_none()
                                        || au.port_or_known_default() == u.port_or_known_default())
                                {
                                    return true;
                                }
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

    fn module_loader_cfg(&self) -> crate::worker::state::ModuleLoaderConfig {
        self.module_loader.clone().unwrap_or_default()
    }

    fn deno_remote_enabled(&self) -> bool {
        self.module_loader_cfg().deno_remote
    }

    fn transpile_ts_enabled(&self) -> bool {
        self.module_loader_cfg().transpile_ts
    }

    fn module_ext(u: &Url) -> Option<String> {
        let p = u.path().to_ascii_lowercase();
        p.rsplit('.').next().map(|s| s.to_string())
    }

    fn is_ts_like_ext(ext: &str) -> bool {
        matches!(ext, "ts" | "tsx" | "jsx")
    }

    fn media_type_for_ext(ext: &str) -> deno_ast::MediaType {
        match ext {
            "ts" => deno_ast::MediaType::TypeScript,
            "tsx" => deno_ast::MediaType::Tsx,
            "jsx" => deno_ast::MediaType::Jsx,
            _ => deno_ast::MediaType::JavaScript,
        }
    }

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

    async fn fetch_remote_text(module_specifier: &Url) -> Result<String, JsErrorBox> {
        let out = std::process::Command::new("curl")
            .arg("--fail")
            .arg("--silent")
            .arg("--show-error")
            .arg("--location")
            .arg(module_specifier.as_str())
            .output()
            .map_err(|e| JsErrorBox::generic(format!("Remote fetch failed: {e}")))?;

        if !out.status.success() {
            return Err(JsErrorBox::generic(format!(
                "Remote fetch failed (status={}): {}",
                out.status, module_specifier
            )));
        }

        String::from_utf8(out.stdout)
            .map_err(|e| JsErrorBox::generic(format!("Remote body decode failed: {e}")))
    }

    fn module_type_for_url(module_specifier: &Url) -> ModuleType {
        let ext = Self::module_ext(module_specifier).unwrap_or_default();
        if ext == "json" {
            ModuleType::Json
        } else {
            ModuleType::JavaScript
        }
    }

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
Enable it with moduleLoader: {{ transpileTs: true }}. Specifier: {}",
                module_specifier
            )));
        }

        let media_type = Self::media_type_for_ext(ext);
        let parsed = deno_ast::parse_module(deno_ast::ParseParams {
            specifier: module_specifier.clone(),
            text: code.into(),
            media_type,
            capture_tokens: false,
            scope_analysis: false,
            maybe_syntax: None,
        })
        .map_err(|e| JsErrorBox::from_err(JsParseDiagnostic(e)))?;

        let cfg = self.module_loader_cfg();
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

        Ok(transpiled.text)
    }
}

impl ModuleLoader for DynamicModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: deno_core::ResolutionKind,
    ) -> Result<Url, JsErrorBox> {
        // Allow internal virtual URLs to pass through unchanged.
        if let Ok(u) = Url::parse(specifier) {
            if Self::is_internal_virtual_url(&u) {
                return Ok(u);
            }
        }

        // Allow direct hits for registry specifiers.
        if self.reg.has(specifier) {
            if let Ok(u) = Url::parse(specifier) {
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
        if self.deno_remote_enabled()
            && (specifier.starts_with("http://") || specifier.starts_with("https://"))
        {
            return self.try_deno_resolve(specifier, referrer);
        }

        // Deno resolver, but normalize virtual referrers into file://<cwd>/ for relative imports.
        self.try_deno_resolve(specifier, referrer)
    }

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

        let spec = module_specifier.as_str().to_string();

        let referrer_from_runtime = maybe_referrer
            .map(|r| r.specifier.as_str().to_string())
            .unwrap_or_default();

        // 1) Serve in-memory modules first
        if let Some((code, module_type)) = self.reg.get_for_load(&spec) {
            let source = ModuleSource::new(
                module_type,
                deno_core::ModuleSourceCode::String(code.into()),
                module_specifier,
                None,
            );
            return deno_core::ModuleLoadResponse::Sync(Ok(source));
        }

        // 2) Decode synthetic resolve URL (callback path)
        let decoded = Self::decode_resolve_url(module_specifier);
        let (orig_spec, orig_referrer) = decoded
            .clone()
            .unwrap_or_else(|| (spec.clone(), referrer_from_runtime.clone()));

        // 3) Enforce imports policy for real module loads
        match self.imports_policy {
            crate::worker::state::ImportsPolicy::DenyAll => {
                return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(format!(
                    "Import blocked (imports disabled): {orig_spec}"
                ))));
            }
            crate::worker::state::ImportsPolicy::AllowDisk => {}
            crate::worker::state::ImportsPolicy::Callback => {}
        }

        // 4) Callback path
        if matches!(
            self.imports_policy,
            crate::worker::state::ImportsPolicy::Callback
        ) {
            let node_tx = self.node_tx.clone();
            let fs_loader = self.fs_loader.clone();
            let this_loader = self.clone_for_async();

            let requested_specifier = module_specifier.clone();
            let maybe_referrer_owned: Option<deno_core::ModuleLoadReferrer> =
                maybe_referrer.cloned();

            return deno_core::ModuleLoadResponse::Async(Box::pin(async move {
                use crate::worker::messages::ImportDecision;

                let (tx, rx) = tokio::sync::oneshot::channel::<ImportDecision>();

                if node_tx
                    .send(NodeMsg::ImportRequest {
                        specifier: orig_spec.clone(),
                        referrer: orig_referrer.clone(),
                        is_dynamic_import: options.is_dynamic_import,
                        reply: tx,
                    })
                    .await
                    .is_err()
                {
                    return Err(JsErrorBox::generic("Imports callback unavailable"));
                }

                let decision = rx.await.unwrap_or(ImportDecision::Block);

                match decision {
                    ImportDecision::Block => Err(JsErrorBox::generic(format!(
                        "Import blocked: {}",
                        orig_spec
                    ))),

                    ImportDecision::AllowDisk => {
                        let resolved = this_loader
                            .try_node_resolve_disk(&orig_spec, &orig_referrer)
                            .or_else(|| {
                                this_loader
                                    .try_deno_resolve(&orig_spec, &orig_referrer)
                                    .ok()
                            })
                            .ok_or_else(|| {
                                JsErrorBox::generic(format!(
                                    "Unable to resolve import: {}",
                                    orig_spec
                                ))
                            })?;

                        if resolved.scheme() == "file" && !this_loader.within_sandbox(&resolved) {
                            return Err(JsErrorBox::generic("Import blocked: outside sandbox"));
                        }

                        let loaded =
                            match fs_loader.load(&resolved, maybe_referrer_owned.as_ref(), options)
                            {
                                deno_core::ModuleLoadResponse::Sync(r) => r,
                                deno_core::ModuleLoadResponse::Async(fut) => fut.await,
                            };

                        loaded.map(|mut src| {
                            if requested_specifier.scheme() == "denojs-worker" {
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

                    ImportDecision::Resolve(new_spec) => {
                        let ns = new_spec.trim();

                        let resolved = Url::parse(ns)
                            .ok()
                            .or_else(|| this_loader.try_node_resolve_disk(ns, &orig_referrer))
                            .or_else(|| this_loader.try_deno_resolve(ns, &orig_referrer).ok())
                            .ok_or_else(|| {
                                JsErrorBox::generic(format!(
                                    "Unable to resolve rewritten import: {}",
                                    new_spec
                                ))
                            })?;

                        if resolved.scheme() == "file" && !this_loader.within_sandbox(&resolved) {
                            return Err(JsErrorBox::generic("Import blocked: outside sandbox"));
                        }

                        let loaded =
                            match fs_loader.load(&resolved, maybe_referrer_owned.as_ref(), options)
                            {
                                deno_core::ModuleLoadResponse::Sync(r) => r,
                                deno_core::ModuleLoadResponse::Async(fut) => fut.await,
                            };

                        loaded.map(|mut src| {
                            if requested_specifier.scheme() == "denojs-worker" {
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

                    ImportDecision::SourceTyped { ext, code } => {
                        let mut final_code = code;
                        if DynamicModuleLoader::is_ts_like_ext(&ext) {
                            final_code = this_loader.maybe_transpile_ts_like(
                                &requested_specifier,
                                &ext,
                                final_code,
                            )?;
                        }

                        let virt = this_loader.reg.next_virtual_specifier("js");
                        this_loader
                            .reg
                            .put_persistent(&virt, &final_code, ModuleType::JavaScript);

                        let wrapper = format!(
                            "export * from {v};\nexport {{ default }} from {v};\n",
                            v = serde_json::to_string(&virt).unwrap_or_else(|_| {
                                "\"denojs-worker://virtual/__vm_bad.js\"".into()
                            })
                        );

                        Ok(ModuleSource::new(
                            ModuleType::JavaScript,
                            deno_core::ModuleSourceCode::String(wrapper.into()),
                            &requested_specifier,
                            None,
                        ))
                    }
                }
            }));
        }

        // 5) Non-callback: allow disk loads directly
        if (module_specifier.scheme() == "http" || module_specifier.scheme() == "https")
            && self.deno_remote_enabled()
        {
            let this_loader = self.clone_for_async();
            let module_specifier = module_specifier.clone();

            return deno_core::ModuleLoadResponse::Async(Box::pin(async move {
                this_loader.ensure_remote_permissions(&module_specifier)?;
                let ext = DynamicModuleLoader::module_ext(&module_specifier).unwrap_or_default();

                let cfg = this_loader.module_loader_cfg();
                let cache_path = this_loader.remote_cache_path(&module_specifier);
                let mut maybe_cached = None;
                if !cfg.reload {
                    maybe_cached = tokio::fs::read_to_string(&cache_path).await.ok();
                }

                let code = match maybe_cached {
                    Some(s) => s,
                    None => {
                        let s = DynamicModuleLoader::fetch_remote_text(&module_specifier).await?;
                        if let Some(parent) = cache_path.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        let _ = tokio::fs::write(&cache_path, s.as_bytes()).await;
                        s
                    }
                };

                let module_type = DynamicModuleLoader::module_type_for_url(&module_specifier);
                let final_code =
                    this_loader.maybe_transpile_ts_like(&module_specifier, &ext, code)?;
                let final_module_type = if DynamicModuleLoader::is_ts_like_ext(&ext) {
                    ModuleType::JavaScript
                } else {
                    module_type
                };
                Ok(ModuleSource::new(
                    final_module_type,
                    deno_core::ModuleSourceCode::String(final_code.into()),
                    &module_specifier,
                    None,
                ))
            }));
        }

        if module_specifier.scheme() == "file" && !self.within_sandbox(module_specifier) {
            return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(
                "Import blocked: outside sandbox",
            )));
        }

        self.fs_loader
            .load(module_specifier, maybe_referrer, options)
    }
}
