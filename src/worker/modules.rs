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

#[derive(Clone)]
pub struct ModuleRegistry {
    modules: Arc<Mutex<HashMap<String, String>>>,
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

    pub fn next_specifier(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let name = format!("__denojs_worker_module_{}.js", n);
        let mut u = self.base_url.clone();
        u.set_path(&format!("{}{}", u.path(), name));
        u.to_string()
    }

    pub fn put(&self, specifier: &str, code: &str) {
        self.modules
            .lock()
            .expect("modules lock")
            .insert(specifier.to_string(), code.to_string());
    }

    pub fn take(&self, specifier: &str) -> Option<String> {
        self.modules.lock().ok()?.remove(specifier)
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
        // Normal Deno resolution first.
        if let Ok(u) = deno_core::resolve_import(specifier, referrer) {
            return Ok(u);
        }

        // If in callback mode, preserve unresolved specifiers so the callback can supply source.
        if matches!(
            self.imports_policy,
            crate::worker::state::ImportsPolicy::Callback
        ) {
            return Ok(self.encode_resolve_url(specifier, referrer));
        }

        // Node-style resolution when enabled.
        if let Some(u) = self.try_node_resolve_disk(specifier, referrer) {
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
        let spec = module_specifier.as_str().to_string();

        // Best-effort referrer string for callback
        let referrer_from_runtime = maybe_referrer
            .map(|r| r.specifier.as_str().to_string())
            .unwrap_or_default();

        // 1) Serve in-memory eval modules first (one-shot)
        if let Some(code) = self.reg.take(&spec) {
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
                // continue, callback below
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

            let module_specifier = module_specifier.clone();
            let maybe_referrer_owned: Option<deno_core::ModuleLoadReferrer> =
                maybe_referrer.cloned();

            return deno_core::ModuleLoadResponse::Async(Box::pin(async move {
                use crate::worker::messages::ImportDecision;

                let (tx, rx) = tokio::sync::oneshot::channel::<ImportDecision>();

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

                match rx.await.unwrap_or(ImportDecision::Block) {
                    ImportDecision::Block => Err(JsErrorBox::generic(format!(
                        "Import blocked: {}",
                        orig_spec
                    ))),
                    ImportDecision::Source(code) => Ok(ModuleSource::new(
                        ModuleType::JavaScript,
                        deno_core::ModuleSourceCode::String(code.into()),
                        &module_specifier,
                        None,
                    )),
                    ImportDecision::AllowDisk => {
                        // Now do: node-style resolution -> deno-style resolution.
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

                        if !this_loader.within_sandbox(&resolved) {
                            return Err(JsErrorBox::generic("Import blocked: outside sandbox"));
                        }

                        match fs_loader.load(&resolved, maybe_referrer_owned.as_ref(), options) {
                            deno_core::ModuleLoadResponse::Sync(r) => r,
                            deno_core::ModuleLoadResponse::Async(fut) => fut.await,
                        }
                    }
                }
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
