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
use crate::worker::env::{EnvRuntimeState, env_access_from_permissions, merge_env_snapshot};
use crate::worker::env_flags::{native_stream_debug_enabled, native_stream_plane_enabled};
use crate::worker::filesystem::{
    SandboxFs, dir_url_from_path, normalize_cwd, normalize_startup_url, sandboxed_path_list,
};
use crate::worker::messages::{DenoMsg, NodeMsg};
use crate::worker::ops::{
    NativeReadScratch,
    op_denojs_worker_env_delete, op_denojs_worker_env_get, op_denojs_worker_env_set,
    op_denojs_worker_env_to_object, op_denojs_worker_host_call_async,
    op_denojs_worker_host_call_async_bin_mixed,
    op_denojs_worker_host_call_async_bin, op_denojs_worker_host_call_sync,
    op_denojs_worker_host_call_sync_bin_mixed,
    op_denojs_worker_host_call_sync_bin, op_denojs_worker_post_message,
    op_denojs_worker_post_message_bin, op_denojs_worker_stream_accept,
    op_denojs_worker_stream_accept_async, op_denojs_worker_stream_discard,
    op_denojs_worker_stream_read, op_denojs_worker_stream_read_async,
    op_denojs_worker_stream_read_raw, op_denojs_worker_stream_take_chunk,
};
use crate::worker::stream_plane::NativeIncomingPlane;
use crate::worker::state::RuntimeLimits;

use std::path::Path;
use std::rc::Rc;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::sync::mpsc as std_mpsc;
use std::thread;

use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;

#[derive(Clone)]
pub struct WorkerOpContext {
    #[allow(dead_code)]
    pub worker_id: usize,
    pub node_tx: mpsc::Sender<NodeMsg>,
    pub sync_node_dispatch_tx: std_mpsc::Sender<SyncNodeDispatchRequest>,
    pub eval_sync_active: Arc<AtomicBool>,
}

pub enum SyncNodeDispatchAck {
    Sent,
    Closed,
}

pub struct SyncNodeDispatchRequest {
    pub msg: NodeMsg,
    pub ack: std_mpsc::Sender<SyncNodeDispatchAck>,
}

extension!(
    deno_worker_extension,
    ops = [
        op_denojs_worker_post_message,
        op_denojs_worker_post_message_bin,
        op_denojs_worker_host_call_sync,
        op_denojs_worker_host_call_sync_bin,
        op_denojs_worker_host_call_sync_bin_mixed,
        op_denojs_worker_host_call_async,
        op_denojs_worker_host_call_async_bin,
        op_denojs_worker_host_call_async_bin_mixed,
        op_denojs_worker_stream_accept,
        op_denojs_worker_stream_accept_async,
        op_denojs_worker_stream_read,
        op_denojs_worker_stream_read_async,
        op_denojs_worker_stream_read_raw,
        op_denojs_worker_stream_take_chunk,
        op_denojs_worker_stream_discard,
        op_denojs_worker_env_get,
        op_denojs_worker_env_set,
        op_denojs_worker_env_delete,
        op_denojs_worker_env_to_object
    ],
    esm_entry_point = "ext:deno_worker_extension/src/worker/bootstrap.js",
    esm = [
        "src/worker/bootstrap.js",
        "src/shared/stream-envelope.ts",
    ],
);

// Cfg items.
fn cfg_items(v: &serde_json::Value) -> Option<Vec<String>> {
    v.as_array().map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    })
}

// Applies perm field updates used by worker runtime lifecycle and thread orchestration.
fn apply_perm_field(
    cfg: &serde_json::Value,
    key: &str,
    dst: &mut Option<Vec<String>>,
    map_paths: Option<&dyn Fn(Vec<String>) -> Vec<String>>,
) {
    let Some(v) = cfg.get(key) else {
        return;
    };

    if *v == serde_json::Value::Bool(true) {
        *dst = Some(vec![]);
        return;
    }
    if *v == serde_json::Value::Bool(false) {
        *dst = None;
        return;
    }

    let Some(items) = cfg_items(v) else {
        return;
    };
    *dst = Some(match map_paths {
        Some(f) => f(items),
        None => items,
    });
}

// Permissions from limits.
fn permissions_from_limits(limits: &RuntimeLimits, root: &Path) -> PermissionsContainer {
    let desc_parser: std::sync::Arc<dyn PermissionDescriptorParser> =
        std::sync::Arc::new(RuntimePermissionDescriptorParser::new(RealSys));

    let mut opts = PermissionsOptions::default();
    opts.prompt = false;

    if let Some(cfg) = &limits.permissions {
        // Permission arrays are interpreted relative to the worker cwd sandbox.
        // Boolean true means "sandbox root", not unrestricted host filesystem.
        let canon_root = std::fs::canonicalize(root)
            .unwrap_or_else(|_| root.to_path_buf())
            .to_string_lossy()
            .to_string();

        if *cfg == serde_json::Value::Bool(true) {
            opts.allow_read = Some(vec![canon_root.clone()]);
            opts.allow_write = Some(vec![canon_root.clone()]);
            opts.allow_net = Some(vec![]);
            opts.allow_env = Some(vec![]);
            opts.allow_run = Some(vec![]);
            opts.allow_ffi = Some(vec![]);
            opts.allow_sys = Some(vec![]);
            opts.allow_import = Some(vec![]);
        } else if *cfg != serde_json::Value::Bool(false) {
            apply_perm_field(
                cfg,
                "read",
                &mut opts.allow_read,
                Some(&|items| sandboxed_path_list(root, &items)),
            );
            if cfg.get("read") == Some(&serde_json::Value::Bool(true)) {
                opts.allow_read = Some(vec![canon_root.clone()]);
            }

            apply_perm_field(
                cfg,
                "write",
                &mut opts.allow_write,
                Some(&|items| sandboxed_path_list(root, &items)),
            );
            if cfg.get("write") == Some(&serde_json::Value::Bool(true)) {
                opts.allow_write = Some(vec![canon_root]);
            }

            apply_perm_field(cfg, "net", &mut opts.allow_net, None);
            apply_perm_field(cfg, "env", &mut opts.allow_env, None);
            apply_perm_field(cfg, "run", &mut opts.allow_run, None);
            apply_perm_field(cfg, "ffi", &mut opts.allow_ffi, None);
            apply_perm_field(cfg, "sys", &mut opts.allow_sys, None);
            apply_perm_field(cfg, "import", &mut opts.allow_import, None);
        }
    }

    let perms = Permissions::from_options(desc_parser.as_ref(), &opts)
        .unwrap_or_else(|_| Permissions::none_without_prompt());

    PermissionsContainer::new(desc_parser, perms)
}

// Inspector addr.
fn inspector_addr(host: &str, port: u16) -> std::net::SocketAddr {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    let h = host.trim();
    if let Ok(ip) = h.parse::<IpAddr>() {
        return SocketAddr::new(ip, port);
    }

    if h.eq_ignore_ascii_case("localhost") {
        return SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port);
    }

    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port)
}

// Inspector http response.
fn inspector_http_response(method: &str, path: &str, port: u16) -> (&'static str, String) {
    if method == "GET" && path == "/json/version" {
        return (
            "200 OK",
            r#"{"Browser":"denojs-worker","Protocol-Version":"1.3"}"#.to_string(),
        );
    }
    if method == "GET" && (path == "/json/list" || path == "/json") {
        return (
            "200 OK",
            format!(
                r#"[{{"id":"denojs-worker","title":"denojs-worker","type":"node","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/ws"}}]"#
            ),
        );
    }
    ("404 Not Found", r#"{"error":"not found"}"#.to_string())
}

// Parses http method path from input data and validates it for worker runtime lifecycle and thread orchestration.
fn parse_http_method_path(req: &str) -> (String, String) {
    let first_line = req.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    (method, path)
}

// Creates params from limits used by worker runtime lifecycle and thread orchestration.
fn create_params_from_limits(limits: &RuntimeLimits) -> Option<deno_core::v8::CreateParams> {
    let max_mem = limits.max_memory_bytes?;
    let max_heap = usize::try_from(max_mem).unwrap_or(usize::MAX);
    Some(deno_core::v8::Isolate::create_params().heap_limits(0, max_heap))
}

// Emit startup warning.
fn emit_startup_warning(worker: &mut MainWorker, message: &str) {
    let msg_json = serde_json::to_string(message).unwrap_or_else(|_| "\"startup warning\"".into());
    let script = format!(
        "(function(){{ try {{ console.warn(\"[deno-director] \" + {msg_json}); }} catch {{}} }})()"
    );
    let _ = worker.js_runtime.execute_script("<startupWarning>", script);
    eprintln!("[deno-director] {message}");
}

// Mark worker closed.
fn mark_worker_closed(worker_id: usize) {
    if let Ok(map) = crate::WORKERS.read() {
        if let Some(w) = map.get(&worker_id) {
            w.closed.store(true, Ordering::SeqCst);
        }
    }
}

/// Spawns worker thread as part of worker runtime lifecycle and thread orchestration.
pub fn spawn_worker_thread(
    worker_id: usize,
    limits: RuntimeLimits,
    mut deno_control_rx: mpsc::Receiver<DenoMsg>,
    mut deno_data_rx: mpsc::Receiver<DenoMsg>,
    mut node_rx: mpsc::Receiver<NodeMsg>,
) {
    thread::spawn(move || {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        use std::time::Duration;

        let inspect_cfg = limits.inspect.clone();

        // Minimal inspector endpoints for tests/tooling that only need liveness
        // and target discovery; this is intentionally not a full DevTools proxy.
        let mut inspect_stop: Option<Arc<AtomicBool>> = None;
        let mut inspect_thread: Option<std::thread::JoinHandle<()>> = None;

        if let Some(ins) = inspect_cfg.as_ref() {
            let addr = inspector_addr(&ins.host, ins.port);
            if let Ok(listener) = TcpListener::bind(addr) {
                let _ = listener.set_nonblocking(true);

                let stop = Arc::new(AtomicBool::new(false));
                let stop2 = stop.clone();

                let port = listener.local_addr().map(|a| a.port()).unwrap_or(ins.port);
                if let Ok(map) = crate::WORKERS.read() {
                    if let Some(w) = map.get(&worker_id) {
                        w.inspect_bound_port.store(port, Ordering::SeqCst);
                    }
                }

                let handle = std::thread::spawn(move || {
                    // Writes http for worker runtime lifecycle and thread orchestration.
                    fn write_http(mut stream: &std::net::TcpStream, status: &str, body: &str) {
                        let hdr = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.as_bytes().len()
                        );
                        let _ = stream.write_all(hdr.as_bytes());
                        let _ = stream.write_all(body.as_bytes());
                        let _ = stream.flush();
                    }

                    while !stop2.load(Ordering::SeqCst) {
                        match listener.accept() {
                            Ok((mut stream, _peer)) => {
                                let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                                let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));

                                let mut buf = [0u8; 2048];
                                let n = stream.read(&mut buf).unwrap_or(0);
                                let req = String::from_utf8_lossy(&buf[..n]);

                                let (method, path) = parse_http_method_path(&req);
                                let (status, body) =
                                    inspector_http_response(method.as_str(), path.as_str(), port);
                                write_http(&stream, status, &body);

                                let _ = stream.shutdown(Shutdown::Both);
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(25));
                            }
                            Err(_) => {
                                std::thread::sleep(Duration::from_millis(50));
                            }
                        }
                    }
                });

                inspect_stop = Some(stop);
                inspect_thread = Some(handle);
            }
        }

        // Single-thread runtime keeps worker semantics deterministic and avoids
        // cross-thread access to non-Send JS runtime internals.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async move {
            let Some((node_tx, eval_sync_active)) = (match crate::WORKERS.read() {
                Ok(map) => map
                    .get(&worker_id)
                    .map(|w| (w.node_tx.clone(), w.eval_sync_active.clone())),
                Err(_) => None,
            }) else {
                return;
            };

            let (sync_node_dispatch_tx, sync_node_dispatch_rx) =
                std_mpsc::channel::<SyncNodeDispatchRequest>();
            let node_tx_for_sync_dispatch = node_tx.clone();
            let sync_node_dispatch_thread = std::thread::spawn(move || {
                while let Ok(req) = sync_node_dispatch_rx.recv() {
                    let ack = if node_tx_for_sync_dispatch.blocking_send(req.msg).is_ok() {
                        SyncNodeDispatchAck::Sent
                    } else {
                        SyncNodeDispatchAck::Closed
                    };
                    let _ = req.ack.send(ack);
                }
            });

            let cwd_path = normalize_cwd(limits.cwd.as_deref());

            let env_snapshot = merge_env_snapshot(std::env::vars().collect(), limits.env.as_ref());
            let env_access = env_access_from_permissions(limits.permissions.as_ref());

            let startup_url = normalize_startup_url(&cwd_path, limits.startup.as_deref());
            let base_url = dir_url_from_path(&cwd_path);
            let module_reg = crate::worker::modules::ModuleRegistry::new(base_url.clone());

            let loader = Rc::new(crate::worker::modules::DynamicModuleLoader {
                reg: module_reg.clone(),
                node_tx: node_tx.clone(),
                imports_policy: limits.imports.clone(),
                wasm: limits.wasm,
                node_resolve: limits.node_resolve,
                node_compat: limits.node_compat,
                sandbox_root: cwd_path.clone(),
                fs_loader: Arc::new(deno_core::FsModuleLoader),
                module_loader: limits.module_loader.clone(),
                permissions: limits.permissions.clone(),
                eval_sync_active: Some(eval_sync_active.clone()),
            });

            let permissions = permissions_from_limits(&limits, &cwd_path);

            let main_module = resolve_url(base_url.as_str())
                .unwrap_or_else(|_| resolve_url("file:///__denojs_worker_main__.js").expect("url"));

            let mut bootstrap = BootstrapOptions::default();
            bootstrap.has_node_modules_dir = limits.node_resolve || limits.node_compat;

            let mut worker_opts = WorkerOptions::default();
            worker_opts.bootstrap = bootstrap;
            if let Some(create_params) = create_params_from_limits(&limits) {
                worker_opts.create_params = Some(create_params);
            }

            if let Some(ins) = inspect_cfg.as_ref() {
                worker_opts.should_break_on_first_statement = ins.break_on_first_statement;
                worker_opts.should_wait_for_inspector_session = false;
            }

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

            let mut worker = MainWorker::bootstrap_from_options(&main_module, services, worker_opts);
            let stream_credit_flush_bytes = limits
                .bridge
                .as_ref()
                .and_then(|cfg| cfg.stream_credit_flush_bytes)
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0);
            let native_stream_plane = std::sync::Arc::new(NativeIncomingPlane::new(stream_credit_flush_bytes));
            if native_stream_debug_enabled() {
                eprintln!(
                    "[native-stream] runtime-created plane={:p} worker={}",
                    std::sync::Arc::as_ptr(&native_stream_plane),
                    worker_id
                );
            }
            if let Ok(map) = crate::WORKERS.read()
                && let Some(handle) = map.get(&worker_id)
                && let Ok(mut slot) = handle.native_stream_plane.lock()
            {
                *slot = Some(native_stream_plane.clone());
                if native_stream_debug_enabled() {
                    eprintln!(
                        "[native-stream] runtime-shared plane={:p} worker={}",
                        std::sync::Arc::as_ptr(&native_stream_plane),
                        worker_id
                    );
                }
            }

            {
                let state = worker.js_runtime.op_state();
                let mut s = state.borrow_mut();
                s.put(WorkerOpContext {
                    worker_id,
                    node_tx: node_tx.clone(),
                    sync_node_dispatch_tx: sync_node_dispatch_tx.clone(),
                    eval_sync_active: eval_sync_active.clone(),
                });
                s.put(module_reg.clone());
                s.put(EnvRuntimeState {
                    vars: std::sync::Mutex::new(env_snapshot),
                    access: env_access,
                });
                s.put(native_stream_plane.clone());
                s.put(NativeReadScratch::default());
            }

            if worker.run_event_loop(false).await.is_err() {
                mark_worker_closed(worker_id);
                return;
            }

            if let Some(cfg) = limits.console.as_ref() {
                let cfg_json = serde_json::to_string(cfg).unwrap_or_else(|_| "null".into());
                let script = format!(
                    "globalThis.__globals[\"__denojs_worker_console\"] = {cfg_json}; globalThis.__applyGlobals();"
                );
                let _ = worker.js_runtime.execute_script("<consoleConfig>", script);
            }

            let native_stream_plane_enabled = native_stream_plane_enabled();
            if let Some(cfg) = limits.bridge.as_ref() {
                let mut bridge_cfg = serde_json::to_value(cfg).unwrap_or_else(|_| serde_json::json!({}));
                if native_stream_plane_enabled && let serde_json::Value::Object(obj) = &mut bridge_cfg {
                    obj.insert("nativeStreamPlane".to_string(), serde_json::Value::Bool(true));
                }
                let cfg_json = serde_json::to_string(&bridge_cfg).unwrap_or_else(|_| "{}".into());
                let script = format!(
                    "globalThis.__globals[\"__denojs_worker_bridge\"] = {cfg_json}; globalThis.__applyGlobals();"
                );
                let _ = worker.js_runtime.execute_script("<bridgeConfig>", script);
            } else if native_stream_plane_enabled {
                let script = "globalThis.__globals[\"__denojs_worker_bridge\"] = { nativeStreamPlane: true }; globalThis.__applyGlobals();";
                let _ = worker.js_runtime.execute_script("<bridgeConfigNativeStream>", script);
            }

            for warning in limits.startup_warnings.iter() {
                emit_startup_warning(&mut worker, warning);
            }

            if let Some(url) = startup_url.as_ref() {
                if worker.execute_side_module(url).await.is_err() {
                    mark_worker_closed(worker_id);
                    return;
                }

                if worker.run_event_loop(false).await.is_err() {
                    mark_worker_closed(worker_id);
                    return;
                }
            }

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

            let mut control_open = true;
            let mut data_open = true;
            while control_open || data_open {
                tokio::select! {
                    biased;
                    dmsg = deno_control_rx.recv(), if control_open => {
                        match dmsg {
                            Some(dmsg) => {
                                let mut close_requested = false;
                                // Drain already-queued data frames before running the next
                                // control message. This avoids deadlock when eval waits on
                                // stream/postMessage data that is already queued.
                                for _ in 0..1024 {
                                    match deno_data_rx.try_recv() {
                                        Ok(data_msg) => {
                                            let should_close = handle_deno_msg(&mut worker, worker_id, &limits, data_msg).await;
                                            if should_close {
                                                close_requested = true;
                                                break;
                                            }
                                        }
                                        Err(TryRecvError::Empty) => break,
                                        Err(TryRecvError::Disconnected) => {
                                            data_open = false;
                                            break;
                                        }
                                    }
                                }
                                if close_requested {
                                    break;
                                }
                                let should_close = handle_deno_msg(&mut worker, worker_id, &limits, dmsg).await;
                                if should_close { break; }
                            }
                            None => control_open = false,
                        }
                    }
                    dmsg = deno_data_rx.recv(), if data_open => {
                        match dmsg {
                            Some(dmsg) => {
                                let should_close = handle_deno_msg(&mut worker, worker_id, &limits, dmsg).await;
                                if should_close { break; }
                            }
                            None => data_open = false,
                        }
                    }
                }
            }

            stop.store(true, Ordering::SeqCst);
            let _ = node_pump.join();
            drop(sync_node_dispatch_tx);
            let _ = sync_node_dispatch_thread.join();
        });

        if let Some(s) = inspect_stop.as_ref() {
            s.store(true, Ordering::SeqCst);
        }
        if let Some(h) = inspect_thread.take() {
            let _ = h.join();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        apply_perm_field, cfg_items, create_params_from_limits, env_access_from_permissions, inspector_addr,
        inspector_http_response, mark_worker_closed, parse_http_method_path,
        merge_env_snapshot,
    };
    use crate::worker::env::EnvAccess;
    use crate::worker::state::{EnvConfig, RuntimeLimits};
    use std::collections::{HashMap, HashSet};

    #[test]
    // Env access defaults to deny.
    fn env_access_defaults_to_deny() {
        let limits = RuntimeLimits::default();
        assert!(matches!(
            env_access_from_permissions(limits.permissions.as_ref()),
            EnvAccess::Deny
        ));
    }

    #[test]
    // Env access honors true and false.
    fn env_access_honors_true_and_false() {
        let mut allow = RuntimeLimits::default();
        allow.permissions = Some(serde_json::json!({ "env": true }));
        assert!(matches!(
            env_access_from_permissions(allow.permissions.as_ref()),
            EnvAccess::AllowAll
        ));

        let mut deny = RuntimeLimits::default();
        deny.permissions = Some(serde_json::json!({ "env": false }));
        assert!(matches!(
            env_access_from_permissions(deny.permissions.as_ref()),
            EnvAccess::Deny
        ));
    }

    #[test]
    // Env access honors allow list.
    fn env_access_honors_allow_list() {
        let mut limits = RuntimeLimits::default();
        limits.permissions = Some(serde_json::json!({ "env": ["A", "B"] }));
        let out = env_access_from_permissions(limits.permissions.as_ref());
        match out {
            EnvAccess::AllowKeys(keys) => {
                let expected: HashSet<String> =
                    ["A".to_string(), "B".to_string()].into_iter().collect();
                assert_eq!(keys, expected);
            }
            other => panic!("expected allow list, got {:?}", other),
        }
    }

    #[test]
    // Merges env snapshot overlays and filters invalid keys while preserving invariants required by worker runtime lifecycle and thread orchestration.
    fn merge_env_snapshot_overlays_and_filters_invalid_keys() {
        let mut base = HashMap::new();
        base.insert("A".to_string(), "1".to_string());
        base.insert("B".to_string(), "2".to_string());

        let mut overlay = HashMap::new();
        overlay.insert("B".to_string(), "22".to_string());
        overlay.insert("C".to_string(), "3".to_string());
        overlay.insert("".to_string(), "bad".to_string());
        overlay.insert("HAS\0NUL".to_string(), "bad".to_string());
        overlay.insert("X".repeat(4097), "bad".to_string());

        let out = merge_env_snapshot(base, Some(&EnvConfig::Map(overlay)));
        assert_eq!(out.get("A").map(String::as_str), Some("1"));
        assert_eq!(out.get("B").map(String::as_str), Some("22"));
        assert_eq!(out.get("C").map(String::as_str), Some("3"));
        assert!(!out.contains_key(""));
        assert!(!out.contains_key("HAS\0NUL"));
    }

    #[test]
    // Cfg items keeps only string entries.
    fn cfg_items_keeps_only_string_entries() {
        let v = serde_json::json!(["a", 1, true, "b", null, {"x":1}]);
        let out = cfg_items(&v).expect("array");
        assert_eq!(out, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    // Applies perm field honors bool and list forms updates used by worker runtime lifecycle and thread orchestration.
    fn apply_perm_field_honors_bool_and_list_forms() {
        let cfg = serde_json::json!({
            "read": true,
            "write": false,
            "net": ["a:1", 1, "b:2"]
        });

        let mut read: Option<Vec<String>> = None;
        let mut write: Option<Vec<String>> = Some(vec!["existing".to_string()]);
        let mut net: Option<Vec<String>> = None;

        apply_perm_field(&cfg, "read", &mut read, None);
        apply_perm_field(&cfg, "write", &mut write, None);
        apply_perm_field(
            &cfg,
            "net",
            &mut net,
            Some(&|items| items.into_iter().map(|x| format!("mapped:{x}")).collect()),
        );

        assert_eq!(read, Some(vec![]));
        assert_eq!(write, None);
        assert_eq!(
            net,
            Some(vec!["mapped:a:1".to_string(), "mapped:b:2".to_string()])
        );
    }

    #[test]
    // Applies perm field ignores missing or non array non bool updates used by worker runtime lifecycle and thread orchestration.
    fn apply_perm_field_ignores_missing_or_non_array_non_bool() {
        let cfg = serde_json::json!({
            "env": "invalid",
            "sys": 123
        });

        let mut env_dst: Option<Vec<String>> = Some(vec!["keep".to_string()]);
        let mut run_dst: Option<Vec<String>> = Some(vec!["keep2".to_string()]);

        apply_perm_field(&cfg, "env", &mut env_dst, None);
        apply_perm_field(&cfg, "run", &mut run_dst, None);

        assert_eq!(env_dst, Some(vec!["keep".to_string()]));
        assert_eq!(run_dst, Some(vec!["keep2".to_string()]));
    }

    #[test]
    // Inspector addr accepts ip and normalizes localhost.
    fn inspector_addr_accepts_ip_and_normalizes_localhost() {
        let ipv4 = inspector_addr("127.0.0.1", 9229);
        assert_eq!(ipv4.ip().to_string(), "127.0.0.1");
        assert_eq!(ipv4.port(), 9229);

        let ipv6 = inspector_addr("::1", 9333);
        assert_eq!(ipv6.ip().to_string(), "::1");
        assert_eq!(ipv6.port(), 9333);

        let localhost = inspector_addr(" localhost ", 9444);
        assert_eq!(localhost.ip().to_string(), "127.0.0.1");
        assert_eq!(localhost.port(), 9444);
    }

    #[test]
    // Inspector addr falls back to loopback for invalid host.
    fn inspector_addr_falls_back_to_loopback_for_invalid_host() {
        let out = inspector_addr("not-a-valid-hostname", 9222);
        assert_eq!(out.ip().to_string(), "127.0.0.1");
        assert_eq!(out.port(), 9222);
    }

    #[test]
    // Inspector http response serves version endpoint.
    fn inspector_http_response_serves_version_endpoint() {
        let (status, body) = inspector_http_response("GET", "/json/version", 9229);
        assert_eq!(status, "200 OK");
        assert!(body.contains("\"Browser\":\"denojs-worker\""));
        assert!(body.contains("\"Protocol-Version\":\"1.3\""));
    }

    #[test]
    // Inspector http response serves list endpoint with port.
    fn inspector_http_response_serves_list_endpoint_with_port() {
        let (status, body) = inspector_http_response("GET", "/json/list", 9333);
        assert_eq!(status, "200 OK");
        assert!(body.contains("\"id\":\"denojs-worker\""));
        assert!(body.contains("ws://127.0.0.1:9333/ws"));

        let (_status_json, body_json) = inspector_http_response("GET", "/json", 9444);
        assert!(body_json.contains("ws://127.0.0.1:9444/ws"));
    }

    #[test]
    // Inspector http response returns 404 for unknown paths or methods.
    fn inspector_http_response_returns_404_for_unknown_paths_or_methods() {
        let (status_path, body_path) = inspector_http_response("GET", "/unknown", 9229);
        assert_eq!(status_path, "404 Not Found");
        assert_eq!(body_path, r#"{"error":"not found"}"#);

        let (status_method, body_method) = inspector_http_response("POST", "/json/list", 9229);
        assert_eq!(status_method, "404 Not Found");
        assert_eq!(body_method, r#"{"error":"not found"}"#);
    }

    #[test]
    // Parses http method path extracts method and path from input data and validates it for worker runtime lifecycle and thread orchestration.
    fn parse_http_method_path_extracts_method_and_path() {
        let req = "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let (method, path) = parse_http_method_path(req);
        assert_eq!(method, "GET");
        assert_eq!(path, "/json/list");
    }

    #[test]
    // Parses http method path handles invalid or empty requests from input data and validates it for worker runtime lifecycle and thread orchestration.
    fn parse_http_method_path_handles_invalid_or_empty_requests() {
        let (m1, p1) = parse_http_method_path("");
        assert_eq!(m1, "");
        assert_eq!(p1, "");

        let (m2, p2) = parse_http_method_path("MALFORMED");
        assert_eq!(m2, "MALFORMED");
        assert_eq!(p2, "");
    }

    #[test]
    // Mark worker closed is noop for unknown worker id.
    fn mark_worker_closed_is_noop_for_unknown_worker_id() {
        mark_worker_closed(usize::MAX);
    }

    #[test]
    // Creates params from limits only when max memory is set used by worker runtime lifecycle and thread orchestration.
    fn create_params_from_limits_only_when_max_memory_is_set() {
        let none = RuntimeLimits::default();
        assert!(create_params_from_limits(&none).is_none());

        let with_mem = RuntimeLimits {
            max_memory_bytes: Some(8 * 1024 * 1024),
            ..RuntimeLimits::default()
        };
        assert!(create_params_from_limits(&with_mem).is_some());
    }
}
