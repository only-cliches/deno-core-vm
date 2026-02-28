// src/worker/runtime.rs
use deno_core::extension;
use deno_runtime::BootstrapOptions;
use deno_runtime::deno_core::{self, resolve_url};
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::{MainWorker, WorkerOptions, WorkerServiceOptions};

use deno_permissions::PermissionDescriptorParser;
use deno_permissions::{Permissions, PermissionsContainer, PermissionsOptions};
use deno_resolver::npm::{DenoInNpmPackageChecker, NpmResolver};
use sys_traits::impls::RealSys;

use crate::worker::dispatch::{dispatch_node_msg, handle_deno_msg};
use crate::worker::filesystem::{SandboxFs, dir_url_from_path, normalize_cwd, sandboxed_path_list};
use crate::worker::messages::{DenoMsg, NodeMsg};
use crate::worker::ops::{
    op_denojs_worker_host_call_async,
    op_denojs_worker_host_call_sync,
    op_denojs_worker_post_message,
};
use crate::worker::state::RuntimeLimits;

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

use tokio::sync::mpsc;

#[derive(Clone)]
pub struct WorkerOpContext {
    #[allow(dead_code)]
    pub worker_id: usize,
    pub node_tx: mpsc::Sender<NodeMsg>,
}

// IMPORTANT: load bootstrap.js as an extension ESM entry point so it can access `core.ops`
// via `ext:core/mod.js`. Do not execute it via execute_script as "user code".
extension!(
    deno_worker_extension,
    ops = [
        op_denojs_worker_post_message,
        op_denojs_worker_host_call_sync,
        op_denojs_worker_host_call_async
    ],
    esm_entry_point = "ext:deno_worker_extension/src/worker/bootstrap.js",
    esm = ["src/worker/bootstrap.js"],
);

fn permissions_from_limits(limits: &RuntimeLimits, root: &Path) -> PermissionsContainer {
    let desc_parser: std::sync::Arc<dyn PermissionDescriptorParser> =
        std::sync::Arc::new(RuntimePermissionDescriptorParser::new(RealSys));

    let mut opts = PermissionsOptions::default();
    opts.prompt = false;

    if let Some(cfg) = &limits.permissions {
        // read
        if let Some(v) = cfg.get("read") {
            if v == true {
                opts.allow_read = Some(vec![
                    std::fs::canonicalize(root)
                        .unwrap_or_else(|_| root.to_path_buf())
                        .to_string_lossy()
                        .to_string(),
                ]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_read = Some(sandboxed_path_list(root, &items));
            } else if v == false {
                opts.allow_read = None;
            }
        }

        // write
        if let Some(v) = cfg.get("write") {
            if v == true {
                opts.allow_write = Some(vec![
                    std::fs::canonicalize(root)
                        .unwrap_or_else(|_| root.to_path_buf())
                        .to_string_lossy()
                        .to_string(),
                ]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_write = Some(sandboxed_path_list(root, &items));
            } else if v == false {
                opts.allow_write = None;
            }
        }

        // net
        if let Some(v) = cfg.get("net") {
            if v == true {
                opts.allow_net = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_net = Some(items);
            } else if v == false {
                opts.allow_net = None;
            }
        }

        // env
        if let Some(v) = cfg.get("env") {
            if v == true {
                opts.allow_env = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_env = Some(items);
            } else if v == false {
                opts.allow_env = None;
            }
        }

        // run
        if let Some(v) = cfg.get("run") {
            if v == true {
                opts.allow_run = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_run = Some(items);
            } else if v == false {
                opts.allow_run = None;
            }
        }

        // ffi
        if let Some(v) = cfg.get("ffi") {
            if v == true {
                opts.allow_ffi = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_ffi = Some(items);
            } else if v == false {
                opts.allow_ffi = None;
            }
        }

        // sys
        if let Some(v) = cfg.get("sys") {
            if v == true {
                opts.allow_sys = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_sys = Some(items);
            } else if v == false {
                opts.allow_sys = None;
            }
        }

        // import
        if let Some(v) = cfg.get("import") {
            if v == true {
                opts.allow_import = Some(vec![]);
            } else if let Some(arr) = v.as_array() {
                let items = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                opts.allow_import = Some(items);
            } else if v == false {
                opts.allow_import = None;
            }
        }
    }

    // If imports are enabled (AllowDisk or Callback) and the user did not explicitly
    // configure read permissions, allow filesystem reads so module loading works.
    if opts.allow_read.is_none() {
        if !matches!(limits.imports, crate::worker::state::ImportsPolicy::DenyAll) {
            // Empty list means "allow all" in Deno permissions.
            opts.allow_read = Some(vec![]);
        }
    }

    let perms = Permissions::from_options(desc_parser.as_ref(), &opts)
        .unwrap_or_else(|_| Permissions::none_without_prompt());

    PermissionsContainer::new(desc_parser, perms)
}

pub fn spawn_worker_thread(
    worker_id: usize,
    limits: RuntimeLimits,
    mut deno_rx: mpsc::Receiver<DenoMsg>,
    mut node_rx: mpsc::Receiver<NodeMsg>,
) {
    thread::spawn(move || {
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

            let cwd_path = normalize_cwd(limits.cwd.as_deref());
            let base_url = dir_url_from_path(&cwd_path);
            let module_reg = crate::worker::modules::ModuleRegistry::new(base_url.clone());

            let loader = Rc::new(crate::worker::modules::DynamicModuleLoader {
                reg: module_reg.clone(),
                node_tx: node_tx.clone(),
                imports_policy: limits.imports.clone(),
                node_compat: limits.node_compat,
                sandbox_root: cwd_path.clone(),
                fs_loader: Arc::new(deno_core::FsModuleLoader),
            });

            let permissions = permissions_from_limits(&limits, &cwd_path);

            let main_module = resolve_url(base_url.as_str())
                .unwrap_or_else(|_| resolve_url("file:///__denojs_worker_main__.js").expect("url"));

            let mut bootstrap = BootstrapOptions::default();
            bootstrap.has_node_modules_dir = limits.node_compat;

            let mut worker_opts = WorkerOptions::default();
            worker_opts.bootstrap = bootstrap;

            // IMPORTANT: load ops + extension ESM (bootstrap.js)
            worker_opts.extensions = vec![deno_worker_extension::init()];

            worker_opts.cache_storage_dir = Some(cwd_path.join(".deno_cache"));
            worker_opts.startup_snapshot = deno_snapshots::CLI_SNAPSHOT;

            let services =
                WorkerServiceOptions::<DenoInNpmPackageChecker, NpmResolver<RealSys>, RealSys> {
                    blob_store: Default::default(),
                    broadcast_channel: Default::default(),
                    compiled_wasm_module_store: Default::default(),
                    feature_checker: Default::default(),
                    fetch_dns_resolver: Default::default(),
                    fs: Arc::new(SandboxFs::new(cwd_path.clone())),
                    module_loader: loader,
                    node_services: Default::default(),
                    npm_process_state_provider: Default::default(),
                    permissions,
                    root_cert_store_provider: Default::default(),
                    shared_array_buffer_store: Default::default(),
                    v8_code_cache: Default::default(),
                    deno_rt_native_addon_loader: None,
                    bundle_provider: None,
                };

            let mut worker =
                MainWorker::bootstrap_from_options(&main_module, services, worker_opts);

            {
                let state = worker.js_runtime.op_state();
                let mut s = state.borrow_mut();
                s.put(WorkerOpContext {
                    worker_id,
                    node_tx: node_tx.clone(),
                });
                s.put(module_reg.clone());
            }

            if worker.run_event_loop(false).await.is_err() {
                if let Ok(map) = crate::WORKERS.lock() {
                    if let Some(w) = map.get(&worker_id) {
                        w.closed.store(true, Ordering::SeqCst);
                    }
                }
                return;
            }

            // Node pump runs on a dedicated OS thread
            let stop = Arc::new(AtomicBool::new(false));
            let stop2 = stop.clone();
            let wid_for_node = worker_id;

            let node_pump = std::thread::spawn(move || {
                while !stop2.load(Ordering::SeqCst) {
                    match node_rx.blocking_recv() {
                        Some(nmsg) => dispatch_node_msg(wid_for_node, nmsg),
                        None => break,
                    }
                }
                while let Ok(nmsg) = node_rx.try_recv() {
                    dispatch_node_msg(wid_for_node, nmsg);
                }
            });

            // Deno message loop stays async on current-thread runtime
            while let Some(dmsg) = deno_rx.recv().await {
                let should_close = handle_deno_msg(&mut worker, worker_id, &limits, dmsg).await;
                if should_close {
                    break;
                }
            }

            stop.store(true, Ordering::SeqCst);
            let _ = node_pump.join();
        });
    });
}