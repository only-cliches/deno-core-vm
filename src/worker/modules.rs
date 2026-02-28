use cpu_time::ProcessTime;
use deno_core::error::CoreError;
use deno_core::{FastString, extension};
use deno_error::JsErrorBox;
use deno_runtime::BootstrapOptions;
use deno_runtime::deno_core::{self, ModuleLoader, ModuleSource, ModuleType, resolve_url, v8};
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::{MainWorker, WorkerOptions, WorkerServiceOptions};

use deno_permissions::PermissionDescriptorParser;

use deno_fs::{FileSystem, FsFileType, OpenOptions, RealFs};
use deno_io::fs::FsResult;
use deno_permissions::{CheckedPath, CheckedPathBuf};
use deno_resolver::npm::{DenoInNpmPackageChecker, NpmResolver};
use sys_traits::impls::RealSys;

use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::bridge::v8_codec;
use crate::worker::dispatch::{dispatch_node_msg, handle_deno_msg};
use crate::worker::messages::{DenoMsg, EvalReply, ExecStats, NodeMsg};
use crate::worker::state::RuntimeLimits;

use deno_permissions::{Permissions, PermissionsContainer, PermissionsOptions};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

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
    persistent: bool,
    uses_left: Option<usize>,
}

#[derive(Clone)]
pub struct ModuleRegistry {
    modules: Arc<Mutex<HashMap<String, ModuleEntry>>>,
    counter: Arc<AtomicUsize>,
    base_url: Url,
}

impl ModuleRegistry {
    pub fn new(base_url: Url) -> Self {
        Self {
            modules: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(AtomicUsize::new(0)),
            base_url,
        }
    }

    pub fn next_virtual_specifier(&self, ext: &str) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let ext = match ext {
            "js" | "ts" | "tsx" => ext,
            _ => "js",
        };
        format!("denojs-worker://virtual/__vm_{n}.{ext}")
    }

    pub fn next_specifier(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let name = format!("__denojs_worker_module_{}.js", n);
        let mut u = self.base_url.clone();
        u.set_path(&format!("{}{}", u.path(), name));
        u.to_string()
    }

    pub fn has(&self, specifier: &str) -> bool {
        self.modules
            .lock()
            .ok()
            .map(|m| m.contains_key(specifier))
            .unwrap_or(false)
    }

    /// Ephemeral module (default for evalModule entrypoints).
    /// `uses_left` allows the runtime to request the same module multiple times during graph building.
    pub fn put_ephemeral(&self, specifier: &str, code: &str) {
        let mut map = self.modules.lock().expect("modules lock");
        map.insert(
            specifier.to_string(),
            ModuleEntry {
                code: code.to_string(),
                persistent: false,
                uses_left: Some(3), // matches your logs showing multiple resolves/loads for the same entry module
            },
        );
    }

    /// Persistent module (used for internal virtual modules you may want to re-export multiple times).
    pub fn put_persistent(&self, specifier: &str, code: &str) {
        let mut map = self.modules.lock().expect("modules lock");
        map.insert(
            specifier.to_string(),
            ModuleEntry {
                code: code.to_string(),
                persistent: true,
                uses_left: None,
            },
        );
    }

    /// Called by ModuleLoader::load. Returns source if present, and decrements uses for ephemeral entries.
    pub fn get_for_load(&self, specifier: &str) -> Option<String> {
        let mut map = self.modules.lock().ok()?;
        let entry = map.get_mut(specifier)?;

        if entry.persistent {
            return Some(entry.code.clone());
        }

        match entry.uses_left.as_mut() {
            Some(n) if *n > 0 => {
                *n -= 1;
                let out = entry.code.clone();
                if *n == 0 {
                    map.remove(specifier);
                }
                Some(out)
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
    pub node_compat: bool,
    pub sandbox_root: PathBuf,
    pub fs_loader: Arc<deno_core::FsModuleLoader>,
}

impl DynamicModuleLoader {
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
        // If imports are enabled, allow disk imports anywhere.
        // Imports are already gated by `imports` configuration (DenyAll vs AllowDisk vs Callback).
        true
    }

    pub fn try_node_resolve_disk(&self, specifier: &str, referrer: &str) -> Option<Url> {
        if !self.node_compat {
            return None;
        }

        // Allow explicit node: specifiers
        if specifier.starts_with("node:") {
            return Url::parse(specifier).ok();
        }

        // Treat known node builtins as node:*
        // Minimal mapping: common builtins only.
        const BUILTINS: &[&str] = &[
            "fs",
            "path",
            "os",
            "crypto",
            "buffer",
            "util",
            "stream",
            "events",
            "url",
            "http",
            "https",
            "zlib",
            "assert",
            "module",
            "process",
            "child_process",
            "net",
            "tls",
        ];
        if BUILTINS.contains(&specifier) {
            return Url::parse(&format!("node:{specifier}")).ok();
        }

        // Determine base directory for resolution
        let base_dir = if referrer.starts_with("file://") {
            Url::parse(referrer)
                .ok()
                .and_then(|u| u.to_file_path().ok())
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf()))
                .unwrap_or_else(|| self.sandbox_root.clone())
        } else {
            self.sandbox_root.clone()
        };

        // Relative or absolute path without extension: try Node-style extensions.
        if specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/')
        {
            let mut p = if specifier.starts_with('/') {
                PathBuf::from(specifier)
            } else {
                base_dir.join(specifier)
            };

            // If exact path exists, use it.
            if p.exists() {
                return Url::from_file_path(p).ok();
            }

            // Try file extensions
            let exts = ["js", "mjs", "cjs", "ts", "mts"];
            for ext in exts {
                let mut pp = p.clone();
                pp.set_extension(ext);
                if pp.exists() {
                    return Url::from_file_path(pp).ok();
                }
            }

            // Try directory index
            if !p.extension().is_some() {
                if p.is_dir() {
                    for ext in exts {
                        let idx = p.join(format!("index.{ext}"));
                        if idx.exists() {
                            return Url::from_file_path(idx).ok();
                        }
                    }
                }
            }

            return None;
        }

        // Bare specifier: node_modules lookup under sandbox root only.
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

            // package.json main/module fallback, else index.*
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
        deno_core::resolve_import(specifier, referrer)
            .map_err(|e| JsErrorBox::generic(e.to_string()))
    }

    pub fn clone_for_async(&self) -> Self {
        Self {
            reg: self.reg.clone(),
            node_tx: self.node_tx.clone(),
            imports_policy: self.imports_policy.clone(),
            node_compat: self.node_compat,
            sandbox_root: self.sandbox_root.clone(),
            fs_loader: self.fs_loader.clone(),
        }
    }
}

impl ModuleLoader for DynamicModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: deno_core::ResolutionKind,
    ) -> Result<Url, JsErrorBox> {
        // Allow internal virtual modules without consulting callback
        if let Ok(u) = Url::parse(specifier) {
            if Self::is_internal_virtual_url(&u) {
                return Ok(u);
            }
        }

        // NEW: If this specifier is a registry-backed ephemeral module, do not
        // consult the imports callback. It must be loadable from memory even
        // when imports policy is Callback.
        if self.reg.has(specifier) {
            if let Ok(u) = Url::parse(specifier) {
                return Ok(u);
            }
        }

        // Callback-first for every specifier (except the bypass cases above)
        if matches!(
            self.imports_policy,
            crate::worker::state::ImportsPolicy::Callback
        ) {
            return Ok(self.encode_resolve_url(specifier, referrer));
        }

        // Non-callback: disk resolution (node then deno)
        if let Some(u) = self.try_node_resolve_disk(specifier, referrer) {
            return Ok(u);
        }

        if let Ok(u) = deno_core::resolve_import(specifier, referrer) {
            return Ok(u);
        }

        Err(JsErrorBox::generic(format!(
            "Unable to resolve import: {specifier} (referrer: {referrer})"
        )))
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

        // Best-effort referrer string for callback
        let referrer_from_runtime = maybe_referrer
            .map(|r| r.specifier.as_str().to_string())
            .unwrap_or_default();

        dbg_imports(format!("load() checking registry spec={}", spec));

        // 1) Serve in-memory modules first (ephemeral eval modules and persistent virtual modules)
        if let Some(code) = self.reg.get_for_load(&spec) {
            let source = ModuleSource::new(
                ModuleType::JavaScript,
                deno_core::ModuleSourceCode::String(code.into()),
                module_specifier,
                None,
            );
            return deno_core::ModuleLoadResponse::Sync(Ok(source));
        }

        // 2) Decode synthetic resolve URL (callback path for otherwise-unresolvable specifiers)
        let decoded = Self::decode_resolve_url(module_specifier);
        let (orig_spec, orig_referrer) = decoded
            .clone()
            .unwrap_or_else(|| (spec.clone(), referrer_from_runtime.clone()));

        // 3) Enforce imports policy for real module loads (in-memory already allowed)
        match self.imports_policy {
            crate::worker::state::ImportsPolicy::DenyAll => {
                return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(format!(
                    "Import blocked (imports disabled): {orig_spec}"
                ))));
            }
            crate::worker::state::ImportsPolicy::AllowDisk => {
                // continue
            }
            crate::worker::state::ImportsPolicy::Callback => {
                // continue
            }
        }

        // 4) Callback path (async): if configured, consult Node before resolving further.
        if matches!(
            self.imports_policy,
            crate::worker::state::ImportsPolicy::Callback
        ) {
            let node_tx = self.node_tx.clone();
            let fs_loader = self.fs_loader.clone();
            let this_loader = self.clone_for_async();

            let requested_specifier = module_specifier.clone();
            let maybe_referrer_owned: Option<deno_core::ModuleLoadReferrer> = maybe_referrer.cloned();
            let options = options;

            return deno_core::ModuleLoadResponse::Async(Box::pin(async move {
                use crate::worker::messages::ImportDecision;

                let (tx, rx) = tokio::sync::oneshot::channel::<ImportDecision>();

                dbg_imports(format!(
                    "load() CALLBACK sending ImportRequest specifier={} referrer={}",
                    orig_spec, orig_referrer
                ));

                if node_tx
                    .send(NodeMsg::ImportRequest {
                        specifier: orig_spec.clone(),
                        referrer: orig_referrer.clone(),
                        reply: tx,
                    })
                    .await
                    .is_err()
                {
                    return Err(JsErrorBox::generic("Imports callback unavailable"));
                }

                let decision = rx.await.unwrap_or(ImportDecision::Block);

                let out: Result<ModuleSource, JsErrorBox> = match decision {
                    ImportDecision::Block => Err(JsErrorBox::generic(format!(
                        "Import blocked: {}",
                        orig_spec
                    ))),

                    ImportDecision::AllowDisk => {
                        let resolved = this_loader
                            .try_node_resolve_disk(&orig_spec, &orig_referrer)
                            .or_else(|| this_loader.try_deno_resolve(&orig_spec, &orig_referrer).ok())
                            .ok_or_else(|| {
                                JsErrorBox::generic(format!(
                                    "Unable to resolve import: {}",
                                    orig_spec
                                ))
                            })?;

                        if resolved.scheme() == "file" && !this_loader.within_sandbox(&resolved) {
                            return Err(JsErrorBox::generic("Import blocked: outside sandbox"));
                        }

                        let loaded = match fs_loader.load(&resolved, maybe_referrer_owned.as_ref(), options) {
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

                        let loaded = match fs_loader.load(&resolved, maybe_referrer_owned.as_ref(), options) {
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
                        // Create an internal virtual module URL whose path ends with .js/.ts/.tsx/.jsx
                        // so Deno's media type detection can parse it correctly.
                        let virt = this_loader.reg.next_virtual_specifier(&ext);
                        this_loader.reg.put_persistent(&virt, &code);

                        // Return a tiny wrapper module for the requested specifier.
                        let wrapper = format!(
                            "export * from {v};\nexport {{ default }} from {v};\n",
                            v = serde_json::to_string(&virt).unwrap_or_else(|_| {
                                "\"denojs-worker://virtual/__vm_bad.js\"".into()
                            })
                        );

                        dbg_imports(format!(
                            "load() CALLBACK SourceTyped ext={} creating virt={}",
                            ext, virt
                        ));

                        Ok(ModuleSource::new(
                            ModuleType::JavaScript,
                            deno_core::ModuleSourceCode::String(wrapper.into()),
                            &requested_specifier,
                            None,
                        ))
                    }
                };

                dbg_imports(format!(
                    "load() CALLBACK decision={:?} specifier={}",
                    out, orig_spec
                ));

                out
            }));
        }

        // 5) Non-callback: allow disk loads directly (resolved URL should already be usable)
        if module_specifier.scheme() == "file" && !self.within_sandbox(module_specifier) {
            return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(
                "Import blocked: outside sandbox",
            )));
        }

        self.fs_loader
            .load(module_specifier, maybe_referrer, options)
    }
}
