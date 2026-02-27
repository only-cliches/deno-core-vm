use cpu_time::ProcessTime;
use deno_runtime::deno_core::v8;
use deno_runtime::deno_core::{self, JsRuntime, RuntimeOptions, extension};
use neon::prelude::*;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::bridge::neon_codec::from_neon_value;
use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::bridge::v8_codec;
use crate::worker::dispatch::{dispatch_node_msg, handle_deno_msg};
use crate::worker::messages::{DenoMsg, EvalReply, ExecStats, NodeMsg, ResolvePayload};
use crate::worker::ops::{op_host_call_async, op_host_call_sync, op_post_message};
use crate::worker::state::RuntimeLimits;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use deno_core::{ModuleLoader, ModuleSource, ModuleType, resolve_url};
use deno_error::JsErrorBox;
use std::collections::HashMap;
use std::sync::Mutex;
use deno_core::url::Url;

#[derive(Clone)]
pub struct WorkerOpContext {
    #[allow(dead_code)]
    pub worker_id: usize,
    pub node_tx: mpsc::Sender<NodeMsg>,
}


const BARE_VIRTUAL_SCHEME: &str = "denojs-worker";
const BARE_VIRTUAL_HOST: &str = "bare";

fn bare_virtual_url_for(specifier: &str) -> Url {
    // Stable, valid absolute URL for "bare" specifiers like "virtual-mod".
    // Example: denojs-worker://bare/?specifier=virtual-mod
    let mut u = Url::parse(&format!("{BARE_VIRTUAL_SCHEME}://{BARE_VIRTUAL_HOST}/"))
        .expect("bare virtual base url");
    u.query_pairs_mut().append_pair("specifier", specifier);
    u
}

fn decode_bare_virtual_specifier(u: &Url) -> Option<String> {
    if u.scheme() != BARE_VIRTUAL_SCHEME {
        return None;
    }
    if u.host_str() != Some(BARE_VIRTUAL_HOST) {
        return None;
    }
    u.query_pairs()
        .find(|(k, _)| k == "specifier")
        .map(|(_, v)| v.to_string())
}

fn is_bare_virtual_url(u: &Url) -> bool {
    decode_bare_virtual_specifier(u).is_some()
}

fn maybe_decode_bare_virtual_referrer(referrer: &str) -> String {
    Url::parse(referrer)
        .ok()
        .and_then(|u| decode_bare_virtual_specifier(&u))
        .unwrap_or_else(|| referrer.to_string())
}

fn cwd_dir_url_string() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let u = deno_core::url::Url::from_directory_path(cwd).ok()?;
    Some(u.as_str().to_string())
}

fn normalize_module_base_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    // If user already provided a file URL, normalize to a directory URL ending with '/'
    if raw.starts_with("file://") {
        if let Ok(u) = Url::parse(raw) {
            let s = u.as_str().to_string();
            return Some(if s.ends_with('/') {
                s
            } else {
                format!("{}/", s)
            });
        }
        return None;
    }

    // Treat as filesystem path; allow relative paths (resolve against current_dir)
    let p = std::path::Path::new(raw);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(p)
    };

    let u = Url::from_directory_path(&abs).ok()?;
    let s = u.as_str().to_string();
    Some(if s.ends_with('/') {
        s
    } else {
        format!("{}/", s)
    })
}

fn join_module_base(base: &str, name: &str) -> String {
    // base is expected to end with '/'
    format!("{}{}", base, name)
}

extension!(
    deno_worker_extension,
    ops = [op_post_message, op_host_call_sync, op_host_call_async]
);

#[derive(Clone)]
struct ModuleRegistry {
    modules: Arc<Mutex<HashMap<String, String>>>,
    counter: Arc<AtomicUsize>,
    base_url: Option<String>,
}

impl ModuleRegistry {
    fn new(base_url: Option<String>) -> Self {
        Self {
            modules: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(AtomicUsize::new(0)),
            base_url,
        }
    }

    fn next_specifier(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let name = format!("__denojs_worker_module_{}.js", n);

        if let Some(base) = &self.base_url {
            join_module_base(base, &name)
        } else {
            format!("file:///{}", name)
        }
    }

    fn put(&self, specifier: &str, code: &str) {
        self.modules
            .lock()
            .expect("modules lock")
            .insert(specifier.to_string(), code.to_string());
    }

    // fn get(&self, specifier: &str) -> String {
    //     self.modules
    //         .lock()
    //         .expect("modules lock")
    //         .get(specifier)
    //         .cloned()
    //         .unwrap_or_default()
    // }

    // fn take(&self, specifier: &str) -> String {
    //     self.modules
    //         .lock()
    //         .expect("modules lock")
    //         .remove(specifier)
    //         .unwrap_or_default()
    // }
}

use crate::worker::messages::ImportDecision;
use deno_core::FsModuleLoader;

struct DynamicModuleLoader {
    reg: ModuleRegistry,
    node_tx: mpsc::Sender<NodeMsg>,
    imports_policy: crate::worker::state::ImportsPolicy,
    fs: Arc<FsModuleLoader>,
}

impl ModuleLoader for DynamicModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: deno_core::ResolutionKind,
    ) -> Result<deno_core::url::Url, JsErrorBox> {
        match deno_core::resolve_import(specifier, referrer) {
            Ok(u) => Ok(u),
            Err(e) => {
                // Allow bare specifiers only when imports is in Callback mode,
                // so the Node callback can provide a virtual module source.
                match self.imports_policy {
                    crate::worker::state::ImportsPolicy::Callback => Ok(bare_virtual_url_for(specifier)),
                    _ => Err(JsErrorBox::generic(e.to_string())),
                }
            }
        }
    }

    fn load(
        &self,
        module_specifier: &deno_core::url::Url,
        maybe_referrer: Option<&deno_core::ModuleLoadReferrer>,
        options: deno_core::ModuleLoadOptions,
    ) -> deno_core::ModuleLoadResponse {
        let spec_url = module_specifier.as_str().to_string();

        // Best-effort referrer string for callback
        let referrer_url = maybe_referrer
            .map(|r| r.specifier.as_str().to_string())
            .unwrap_or_default();

        // If this was a synthetic "bare virtual" URL, pass the original bare specifier
        // to the Node callback (and decode the referrer too if it was synthetic).
        let cb_specifier = decode_bare_virtual_specifier(module_specifier).unwrap_or_else(|| spec_url.clone());
        let cb_referrer = maybe_decode_bare_virtual_referrer(&referrer_url);

        // 1) Serve in-memory eval modules first (one-shot)
        let maybe_code = {
            let mut guard = self.reg.modules.lock().expect("modules lock");
            guard.remove(&spec_url)
        };

        if let Some(code) = maybe_code {
            let source = ModuleSource::new(
                ModuleType::JavaScript,
                deno_core::ModuleSourceCode::String(code.into()),
                module_specifier,
                None,
            );
            return deno_core::ModuleLoadResponse::Sync(Ok(source));
        }

        // 2) Enforce imports policy
        match self.imports_policy {
            crate::worker::state::ImportsPolicy::DenyAll => {
                return deno_core::ModuleLoadResponse::Sync(Err(JsErrorBox::generic(format!(
                    "Import blocked (imports disabled): {cb_specifier}"
                ))));
            }

            crate::worker::state::ImportsPolicy::AllowDisk => {
                return self.fs.load(module_specifier, maybe_referrer, options);
            }

            crate::worker::state::ImportsPolicy::Callback => {
                // continue to async callback path
            }
        }

        // 3) Callback path: ask Node, async
        let node_tx = self.node_tx.clone();
        let fs = self.fs.clone();
        let module_specifier = module_specifier.clone();
        let maybe_referrer_owned: Option<deno_core::ModuleLoadReferrer> = maybe_referrer.cloned();

        deno_core::ModuleLoadResponse::Async(Box::pin(async move {
            let (tx, rx) = tokio::sync::oneshot::channel::<ImportDecision>();

            if node_tx
                .send(NodeMsg::ImportRequest {
                    specifier: cb_specifier.clone(),
                    referrer: cb_referrer.clone(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Err(JsErrorBox::generic("Imports callback unavailable"));
            }

            match rx.await.unwrap_or(ImportDecision::Block) {
                ImportDecision::Block => Err(JsErrorBox::generic(format!("Import blocked: {}", cb_specifier))),

                ImportDecision::AllowDisk => {
                    // FsModuleLoader cannot load our synthetic bare URLs.
                    if is_bare_virtual_url(&module_specifier) {
                        return Err(JsErrorBox::generic(format!(
                            "Import allowed for disk, but bare specifier has no disk resolution: {}",
                            cb_specifier
                        )));
                    }

                    match fs.load(&module_specifier, maybe_referrer_owned.as_ref(), options) {
                        deno_core::ModuleLoadResponse::Sync(r) => r,
                        deno_core::ModuleLoadResponse::Async(fut) => fut.await,
                    }
                }

                ImportDecision::Source(code) => {
                    let source = ModuleSource::new(
                        ModuleType::JavaScript,
                        deno_core::ModuleSourceCode::String(code.into()),
                        &module_specifier,
                        None,
                    );
                    Ok(source)
                }
            }
        }))
    }
}

pub fn spawn_worker_thread(
    worker_id: usize,
    limits: RuntimeLimits,
    mut deno_rx: mpsc::Receiver<DenoMsg>,
    mut node_rx: mpsc::Receiver<NodeMsg>,
) {
    thread::spawn(move || {
        // Must be current-thread for deno_unsync
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async move {
            let node_tx = match crate::WORKERS.lock() {
                Ok(map) => map.get(&worker_id).map(|w| w.node_tx.clone()),
                Err(_) => None,
            };
            let Some(node_tx) = node_tx else {
                return;
            };

            let base_url = limits
                .module_base_url
                .as_deref()
                .and_then(normalize_module_base_url)
                .or_else(cwd_dir_url_string);

            let module_reg = ModuleRegistry::new(base_url);
            let loader = std::rc::Rc::new(DynamicModuleLoader {
                reg: module_reg.clone(),
                node_tx: node_tx.clone(),
                imports_policy: limits.imports.clone(),
                fs: Arc::new(FsModuleLoader),
            });

            apply_v8_flags_once(&limits);

            let mut runtime = JsRuntime::new(RuntimeOptions {
                extensions: vec![deno_worker_extension::init()],
                module_loader: Some(loader),
                ..Default::default()
            });

            {
                let state = runtime.op_state();
                let mut s = state.borrow_mut();
                s.put(WorkerOpContext {
                    worker_id,
                    node_tx: node_tx.clone(),
                });
                s.put(module_reg.clone());
            }

            let _ = runtime.execute_script("<bootstrap>", bootstrap_js());

            // Node pump runs on a dedicated OS thread
            let stop = Arc::new(AtomicBool::new(false));
            let stop2 = stop.clone();
            let wid_for_node = worker_id;

            let node_pump = std::thread::spawn(move || {
                // blocking_recv keeps working even while the current-thread runtime is blocked
                while !stop2.load(Ordering::SeqCst) {
                    match node_rx.blocking_recv() {
                        Some(nmsg) => dispatch_node_msg(wid_for_node, nmsg),
                        None => break, // sender dropped
                    }
                }

                // Drain any remaining messages best-effort
                while let Ok(nmsg) = node_rx.try_recv() {
                    dispatch_node_msg(wid_for_node, nmsg);
                }
            });

            // Deno message loop stays async on current-thread runtime
            while let Some(dmsg) = deno_rx.recv().await {
                let should_close = handle_deno_msg(&mut runtime, worker_id, &limits, dmsg).await;
                if should_close {
                    break;
                }
            }

            stop.store(true, Ordering::SeqCst);
            let _ = node_pump.join();
        });
    });
}

fn bootstrap_js() -> &'static str {
    include_str!("runtime.js")
}


pub async fn eval_in_runtime(
    runtime: &mut JsRuntime,
    limits: &RuntimeLimits,
    source: &str,
    options: EvalOptions,
) -> EvalReply {
    let start_wall = Instant::now();
    let start_cpu = ProcessTime::now();

    let isolate_handle = runtime.v8_isolate().thread_safe_handle();

    let cancel = Arc::new(AtomicBool::new(false));

    let effective_max_eval_ms = options.max_eval_ms.or(limits.max_eval_ms);

    let timeout_thread = effective_max_eval_ms.map(|ms| {
        let cancel = cancel.clone();
        let isolate_handle = isolate_handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            if !cancel.load(Ordering::SeqCst) {
                isolate_handle.terminate_execution();
            }
        })
    });

    let result = if options.is_module {
        eval_module(runtime, source, &options.filename).await
    } else {
        eval_script_or_callable(runtime, limits, source, &options).await
    };

    cancel.store(true, Ordering::SeqCst);
    if let Some(t) = timeout_thread {
        let _ = t.join();
    }

    // IMPORTANT: terminate_execution is sticky. Clear it for subsequent calls.
    runtime.v8_isolate().cancel_terminate_execution();

    let stats = ExecStats {
        cpu_time_ms: start_cpu.elapsed().as_nanos() as f64 / 1_000_000.0,
        eval_time_ms: start_wall.elapsed().as_nanos() as f64 / 1_000_000.0,
    };

    match result {
        Ok(value) => EvalReply::Ok { value, stats },
        Err(error) => EvalReply::Err { error, stats },
    }
}

async fn eval_script_or_callable(
    runtime: &mut JsRuntime,
    limits: &RuntimeLimits,
    source: &str,
    options: &EvalOptions,
) -> Result<JsValueBridge, JsValueBridge> {
    let filename = if options.filename.is_empty() {
        if let Some(base) = limits
            .module_base_url
            .as_deref()
            .and_then(normalize_module_base_url)
        {
            join_module_base(&base, "eval.js")
        } else {
            "eval.js".to_string()
        }
    } else if options.filename.starts_with("file://") {
        options.filename.clone()
    } else if let Some(base) = limits
        .module_base_url
        .as_deref()
        .and_then(normalize_module_base_url)
    {
        join_module_base(&base, &options.filename)
    } else {
        options.filename.clone()
    };

    let global = runtime
        .execute_script(filename, source.to_string())
        .map_err(js_error_to_bridge)?;

    if options.args_provided {
        let called = try_call_if_function(runtime, global, &options.args)?;
        return settle_if_promise(runtime, called).await;
    }

    settle_if_promise(runtime, global).await
}

async fn eval_module(
    runtime: &mut JsRuntime,
    source: &str,
    _filename: &str,
) -> Result<JsValueBridge, JsValueBridge> {
    let reg = {
        let state = runtime.op_state();
        state.borrow().borrow::<ModuleRegistry>().clone()
    };

    let spec = reg.next_specifier();
    reg.put(&spec, source);

    let url = resolve_url(&spec).map_err(|e| JsValueBridge::Error {
        name: "ModuleError".into(),
        message: e.to_string(),
        stack: None,
        code: None,
    })?;

    let mod_id = runtime
        .load_side_es_module(&url)
        .await
        .map_err(|e| JsValueBridge::Error {
            name: "ModuleError".into(),
            message: e.to_string(),
            stack: None,
            code: None,
        })?;

    let receiver = runtime.mod_evaluate(mod_id);

    runtime
        .run_event_loop(Default::default())
        .await
        .map_err(|e| JsValueBridge::Error {
            name: "ModuleError".into(),
            message: e.to_string(),
            stack: None,
            code: None,
        })?;

    receiver.await.map_err(|e| JsValueBridge::Error {
        name: "ModuleError".into(),
        message: e.to_string(),
        stack: None,
        code: None,
    })?;

    let out = runtime
        .execute_script("<moduleReturn>", "globalThis.__moduleReturn".to_string())
        .map_err(js_error_to_bridge)?;

    settle_if_promise(runtime, out).await
}

fn try_call_if_function(
    runtime: &mut JsRuntime,
    value: deno_runtime::deno_core::v8::Global<v8::Value>,
    args: &[JsValueBridge],
) -> Result<deno_runtime::deno_core::v8::Global<v8::Value>, JsValueBridge> {
    deno_core::scope!(scope, runtime);
    let local = v8::Local::new(scope, value);

    if !local.is_function() {
        return Ok(v8::Global::new(scope, local));
    }

    let func = v8::Local::<v8::Function>::try_from(local).map_err(|e| JsValueBridge::Error {
        name: "TypeError".into(),
        message: e.to_string(),
        stack: None,
        code: None,
    })?;

    let recv = v8::undefined(scope).into();
    let mut argv = Vec::with_capacity(args.len());
    for a in args {
        argv.push(v8_codec::to_v8(scope, a).map_err(simple_err)?);
    }

    let out = func
        .call(scope, recv, &argv)
        .ok_or_else(|| JsValueBridge::Error {
            name: "Error".into(),
            message: "Failed to call evaluated function".into(),
            stack: None,
            code: None,
        })?;

    Ok(v8::Global::new(scope, out))
}

async fn settle_if_promise(
    runtime: &mut JsRuntime,
    value: deno_runtime::deno_core::v8::Global<v8::Value>,
) -> Result<JsValueBridge, JsValueBridge> {
    loop {
        let (is_pending_promise, opt_res) = {
            deno_core::scope!(scope, runtime);
            let local = v8::Local::new(scope, value.clone());

            if let Ok(p) = v8::Local::<v8::Promise>::try_from(local) {
                match p.state() {
                    v8::PromiseState::Pending => (true, None),
                    v8::PromiseState::Fulfilled => {
                        let res = p.result(scope);
                        (
                            false,
                            Some(v8_codec::from_v8(scope, res).map_err(simple_err)),
                        )
                    }
                    v8::PromiseState::Rejected => {
                        let res = p.result(scope);

                        let rejected_value = v8_codec::from_v8(scope, res).unwrap_or_else(|_| {
                            JsValueBridge::Error {
                                name: "Error".into(),
                                message: "Promise rejected".into(),
                                stack: None,
                                code: None,
                            }
                        });

                        (false, Some(Err(rejected_value)))
                    }
                }
            } else {
                (
                    false,
                    Some(v8_codec::from_v8(scope, local).map_err(simple_err)),
                )
            }
        };

        if let Some(res) = opt_res {
            return res;
        }

        if is_pending_promise {
            runtime
                .run_event_loop(Default::default())
                .await
                .map_err(|e| JsValueBridge::Error {
                    name: "Error".into(),
                    message: e.to_string(),
                    stack: None,
                    code: None,
                })?;
        }
    }
}

fn js_error_to_bridge(e: Box<deno_core::error::JsError>) -> JsValueBridge {
    JsValueBridge::Error {
        name: "Error".into(),
        message: e.to_string(),
        stack: None,
        code: None,
    }
}

fn simple_err(msg: String) -> JsValueBridge {
    JsValueBridge::Error {
        name: "Error".into(),
        message: msg,
        stack: None,
        code: None,
    }
}

use std::sync::Once;

static V8_FLAGS_ONCE: Once = Once::new();

fn apply_v8_flags_once(limits: &RuntimeLimits) {
    V8_FLAGS_ONCE.call_once(|| {
        let mut flags: Vec<String> = Vec::new();

        if let Some(bytes) = limits.max_stack_size_bytes {
            // V8 flag is KB
            let kb = (bytes / 1024).max(64);
            flags.push(format!("--stack_size={}", kb));
        }

        if let Some(bytes) = limits.max_memory_bytes {
            // V8 flag is MB, affects old space sizing
            let mb = (bytes / (1024 * 1024)).max(16);
            flags.push(format!("--max_old_space_size={}", mb));
        }

        if !flags.is_empty() {
            // Applies process-wide. Must be called before isolates are created.
            deno_core::v8_set_flags(flags);
        }
    });
}
