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

#[derive(Clone)]
pub struct WorkerOpContext {
    #[allow(dead_code)]
    pub worker_id: usize,
    pub node_tx: mpsc::Sender<NodeMsg>,
}

extension!(
    deno_worker_extension,
    ops = [op_post_message, op_host_call_sync, op_host_call_async]
);

#[derive(Clone)]
struct ModuleRegistry {
    modules: Arc<Mutex<HashMap<String, String>>>,
    counter: Arc<AtomicUsize>,
}

impl ModuleRegistry {
    fn new() -> Self {
        Self {
            modules: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn next_specifier(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("file:///__denojs_worker_module_{}.js", n)
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
    fn take(&self, specifier: &str) -> String {
        self.modules
            .lock()
            .expect("modules lock")
            .remove(specifier)
            .unwrap_or_default()
    }
}

struct DynamicModuleLoader {
    reg: ModuleRegistry,
}

impl ModuleLoader for DynamicModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: deno_core::ResolutionKind,
    ) -> Result<deno_core::url::Url, JsErrorBox> {
        deno_core::resolve_import(specifier, referrer)
            .map_err(|e| JsErrorBox::generic(e.to_string()))
    }

    fn load(
        &self,
        module_specifier: &deno_core::url::Url,
        _maybe_referrer: Option<&deno_core::ModuleLoadReferrer>,
        _options: deno_core::ModuleLoadOptions,
    ) -> deno_core::ModuleLoadResponse {
        let spec = module_specifier.as_str().to_string();
        let code = self.reg.take(&spec);

        let source = ModuleSource::new(
            ModuleType::JavaScript,
            deno_core::ModuleSourceCode::String(code.into()),
            module_specifier,
            None,
        );

        deno_core::ModuleLoadResponse::Sync(Ok(source))
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

            let module_reg = ModuleRegistry::new();
            let loader = std::rc::Rc::new(DynamicModuleLoader {
                reg: module_reg.clone(),
            });

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

async fn handle_deno_msg(
    runtime: &mut JsRuntime,
    worker_id: usize,
    limits: &RuntimeLimits,
    msg: DenoMsg,
) -> bool {
    match msg {
        DenoMsg::Close { deferred } => {
            deferred.resolve_with_value_via_channel(JsValueBridge::Undefined);

            if let Ok(map) = crate::WORKERS.lock() {
                if let Some(w) = map.get(&worker_id) {
                    w.closed.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }

            let mut try_direct_cleanup = false;

            if let Some(tx) = get_node_tx(worker_id) {
                if tx.try_send(NodeMsg::EmitClose).is_err() {
                    try_direct_cleanup = true;
                }
            } else {
                try_direct_cleanup = true;
            }

            if try_direct_cleanup {
                let (channel, on_close_cb_opt) = match crate::WORKERS.lock() {
                    Ok(map) => {
                        if let Some(w) = map.get(&worker_id) {
                            (w.channel.clone(), w.callbacks.on_close.clone())
                        } else {
                            return true;
                        }
                    }
                    Err(_) => {
                        return true;
                    }
                };

                let wid = worker_id;
                let _ = channel.try_send(move |mut cx| {
                    if let Some(cb_arc) = on_close_cb_opt.as_ref() {
                        let cb = cb_arc.to_inner(&mut cx);
                        let this = cx.undefined();
                        let _ = cb.call(&mut cx, this, &[]);
                    }

                    if let Ok(mut map) = crate::WORKERS.lock() {
                        let _ = map.remove(&wid);
                    }

                    Ok(())
                });
            }

            true
        }

        DenoMsg::Memory { deferred } => {
            let mem = serde_json::json!({
                "ok": true,
                "heapStatistics": "not_implemented_yet"
            });

            if let Some(tx) = get_node_tx(worker_id) {
                send_node_msg_or_reject(
                    &tx,
                    NodeMsg::Resolve {
                        settler: deferred,
                        payload: ResolvePayload::Json(mem),
                    },
                )
                .await;
            } else {
                deferred.reject_with_error("Node thread is unavailable");
            }

            false
        }

        DenoMsg::PostMessage { value } => {
            let payload = serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
                .unwrap_or_else(|_| "null".into());
            let script =
                format!("globalThis.__dispatchNodeMessage(globalThis.__hydrate({payload}))");

            let _ = runtime.execute_script("<postMessage>", script);
            false
        }

        DenoMsg::SetGlobal {
            key,
            value,
            deferred,
        } => {
            let json = serde_json::to_string(&crate::bridge::wire::to_wire_json(&value))
                .unwrap_or_else(|_| "null".into());
            let key_json = serde_json::to_string(&key).unwrap_or_else(|_| "\"\"".into());
            let script =
                format!("globalThis.__globals[{key_json}] = {json}; globalThis.__applyGlobals();");

            let res = runtime.execute_script("<setGlobal>", script);

            if let Some(tx) = get_node_tx(worker_id) {
                match res {
                    Ok(_) => {
                        send_node_msg_or_reject(
                            &tx,
                            NodeMsg::Resolve {
                                settler: deferred,
                                payload: ResolvePayload::Void,
                            },
                        )
                        .await;
                    }
                    Err(e) => {
                        let err = JsValueBridge::Error {
                            name: "Error".into(),
                            message: e.to_string(),
                            stack: None,
                            code: None,
                        };
                        send_node_msg_or_reject(
                            &tx,
                            NodeMsg::Resolve {
                                settler: deferred,
                                payload: ResolvePayload::Result {
                                    result: Err(err),
                                    stats: ExecStats {
                                        cpu_time_ms: 0.0,
                                        eval_time_ms: 0.0,
                                    },
                                },
                            },
                        )
                        .await;
                    }
                }
            } else {
                deferred.reject_with_error("Node thread is unavailable");
            }

            false
        }

        DenoMsg::Eval {
            source,
            options,
            deferred,
            sync_reply,
        } => {
            let reply = eval_in_runtime(runtime, limits, &source, options).await;

            if let Some(tx) = sync_reply {
                let _ = tx.send(reply);
                return false;
            }

            let Some(deferred) = deferred else {
                return false;
            };

            if let Some(node_tx) = get_node_tx(worker_id) {
                let payload = match &reply {
                    EvalReply::Ok { value, stats } => ResolvePayload::Result {
                        result: Ok(value.clone()),
                        stats: stats.clone(),
                    },
                    EvalReply::Err { error, stats } => ResolvePayload::Result {
                        result: Err(error.clone()),
                        stats: stats.clone(),
                    },
                };

                send_node_msg_or_reject(
                    &node_tx,
                    NodeMsg::Resolve {
                        settler: deferred,
                        payload,
                    },
                )
                .await;
            } else {
                deferred.reject_with_error("Node thread is unavailable");
            }

            false
        }
    }
}

async fn send_node_msg_or_reject(node_tx: &mpsc::Sender<NodeMsg>, msg: NodeMsg) {
    if let Err(send_err) = node_tx.send(msg).await {
        match send_err.0 {
            NodeMsg::Resolve { settler, .. } => {
                settler.reject_with_error("Node thread is unavailable");
            }
            _ => {}
        }
    }
}

fn get_node_tx(worker_id: usize) -> Option<mpsc::Sender<NodeMsg>> {
    crate::WORKERS
        .lock()
        .ok()?
        .get(&worker_id)
        .map(|w| w.node_tx.clone())
}

async fn eval_in_runtime(
    runtime: &mut JsRuntime,
    limits: &RuntimeLimits,
    source: &str,
    options: EvalOptions,
) -> EvalReply {
    let start_wall = Instant::now();
    let start_cpu = ProcessTime::now();

    let isolate_handle = runtime.v8_isolate().thread_safe_handle();

    let cancel = Arc::new(AtomicBool::new(false));

    let timeout_thread = limits.max_eval_ms.map(|ms| {
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
        eval_script_or_callable(runtime, source, &options).await
    };

    cancel.store(true, Ordering::SeqCst);
    if let Some(t) = timeout_thread {
        let _ = t.join();
    }

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
    source: &str,
    options: &EvalOptions,
) -> Result<JsValueBridge, JsValueBridge> {
    let filename = if options.filename.is_empty() {
        "eval.js"
    } else {
        &options.filename
    };

    let global = runtime
        .execute_script(filename.to_string(), source.to_string())
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

fn dispatch_node_msg(worker_id: usize, msg: NodeMsg) {
    let (channel, handle_snapshot) = match crate::WORKERS.lock() {
        Ok(map) => {
            if let Some(w) = map.get(&worker_id) {
                (
                    w.channel.clone(),
                    Some((
                        w.callbacks.clone(),
                        w.host_functions.clone(),
                        w.last_stats.clone(),
                    )),
                )
            } else {
                return;
            }
        }
        Err(_) => return,
    };

    let Some((callbacks, host_functions, last_stats)) = handle_snapshot else {
        return;
    };

    let _ = channel.send(move |mut cx| {
        // let mk_err = |name: &str, message: String| JsValueBridge::Error {
        //     name: name.into(),
        //     message,
        //     stack: None,
        //     code: None,
        // };

        fn swallow_js_exn<'a, F, T>(
            cx: &mut TaskContext<'a>,
            _label: &'static str,
            f: F,
        ) -> Option<T>
        where
            F: FnOnce(&mut TaskContext<'a>) -> NeonResult<T>,
        {
            cx.try_catch(f).ok()
        }

        // fn send_once(
        //     slot: &std::sync::Arc<
        //         std::sync::Mutex<
        //             Option<tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>>,
        //         >,
        //     >,
        //     value: Result<JsValueBridge, JsValueBridge>,
        // ) {
        //     let tx_opt = slot.lock().ok().and_then(|mut g| g.take());
        //     if let Some(tx) = tx_opt {
        //         let _ = tx.send(value);
        //     }
        // }

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let outer = cx.try_catch(|cx| match msg {
                NodeMsg::Resolve { settler, payload } => {
                    if let ResolvePayload::Result { stats, .. } = &payload {
                        if let Ok(mut g) = last_stats.lock() {
                            *g = Some(stats.clone());
                        }
                    }

                    match payload {
                        ResolvePayload::Void => {
                            settler.resolve_with_value_in_cx(cx, &JsValueBridge::Null)
                        }
                        ResolvePayload::Json(json) => {
                            let s = serde_json::to_string(&json).unwrap_or_else(|_| "null".into());
                            settler.resolve_with_json_in_cx(cx, &s);
                        }
                        ResolvePayload::Result { result, .. } => match result {
                            Ok(v) => settler.resolve_with_value_in_cx(cx, &v),
                            Err(e) => settler.reject_with_value_in_cx(cx, &e),
                        },
                    }
                    Ok(())
                }

                NodeMsg::EmitMessage { value } => {
                    let Some(cb_root) = callbacks.on_message.as_ref() else {
                        return Ok(());
                    };

                    let cb = cb_root.to_inner(cx);
                    let arg = crate::bridge::neon_codec::to_neon_value(cx, &value)
                        .unwrap_or_else(|_| cx.undefined().upcast());

                    let this = cx.undefined();
                    let _ = swallow_js_exn(cx, "EmitMessage:cb.call", |cx| {
                        cb.call(cx, this, &[arg])?;
                        Ok(())
                    });

                    Ok(())
                }

                NodeMsg::EmitClose => {
                    if let Some(cb_root) = callbacks.on_close.as_ref() {
                        let cb = cb_root.to_inner(cx);
                        let this = cx.undefined();
                        let _ = swallow_js_exn(cx, "EmitClose:cb.call", |cx| {
                            cb.call(cx, this, &[])?;
                            Ok(())
                        });
                    }

                    if let Ok(mut map) = crate::WORKERS.lock() {
                        let _ = map.remove(&worker_id);
                    }

                    Ok(())
                }

                NodeMsg::InvokeHostFunctionSync {
                    func_id,
                    args,
                    reply,
                } => {
                    let send = |v: Result<JsValueBridge, JsValueBridge>| {
                        let _ = reply.send(v);
                    };

                    let func_root = match host_functions.get(func_id) {
                        Some(f) => f.clone(),
                        None => {
                            send(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: format!("Unknown host function id {func_id}"),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let func = func_root.to_inner(cx);

                    let mut js_argv: Vec<Handle<JsValue>> = Vec::with_capacity(args.len());
                    for a in &args {
                        let v = crate::bridge::neon_codec::to_neon_value(cx, a)
                            .unwrap_or_else(|_| cx.undefined().upcast());
                        js_argv.push(v);
                    }

                    let this = cx.undefined();
                    let called = cx.try_catch(|cx| func.call(cx, this, js_argv.as_slice()));

                    let v = match called {
                        Ok(v) => v,
                        Err(e) => {
                            let msg = if let Ok(JsValueBridge::String(str)) = from_neon_value(cx, e)
                            {
                                str
                            } else {
                                String::from("")
                            };
                            send(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: msg,
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    if v.is_a::<neon::types::JsPromise, _>(cx) {
                        // Suppress unhandled rejection warnings.
                        // This sync path intentionally refuses to await Promises, but we still need to
                        // attach a rejection handler so Node/Jest does not treat it as unhandled.
                        if let Ok(promise_obj) = v.downcast::<JsObject, _>(cx) {
                            // Create a no-op rejection handler and root it so V8 cannot GC it
                            // before the microtask queue runs.
                            let noop_reject = JsFunction::new(cx, |mut cx| Ok(cx.undefined()))?;
                            let rooted = noop_reject.root(cx);
                            std::mem::forget(rooted);

                            // Prefer .catch(noop) if available, else .then(undefined, noop)
                            if let Ok(catch_fn) = promise_obj.get::<JsFunction, _, _>(cx, "catch") {
                                let _ = cx.try_catch(|cx| {
                                    let _ = catch_fn.call(
                                        cx,
                                        promise_obj,
                                        &[noop_reject.upcast::<JsValue>()],
                                    )?;
                                    Ok(())
                                });
                            } else if let Ok(then_fn) = promise_obj.get::<JsFunction, _, _>(cx, "then") {
                                let undef = cx.undefined().upcast::<JsValue>();
                                let _ = cx.try_catch(|cx| {
                                    let _ = then_fn.call(cx, promise_obj, &[undef, noop_reject.upcast()])?;
                                    Ok(())
                                });
                            }
                        }

                        send(Err(JsValueBridge::Error {
                            name: "HostFunctionError".into(),
                            message: "Sync host function returned a Promise; use async host function instead".into(),
                            stack: None,
                            code: None,
                        }));
                        return Ok(());
                    }

                    match crate::bridge::neon_codec::from_neon_value(cx, v) {
                        Ok(b) => send(Ok(b)),
                        Err(e) => send(Err(JsValueBridge::Error {
                            name: "HostFunctionError".into(),
                            message: e.to_string(),
                            stack: None,
                            code: None,
                        })),
                    }

                    Ok(())
                }
                NodeMsg::InvokeHostFunctionAsync { func_id, args, reply } => {
                    struct AsyncState {
                        reply: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<JsValueBridge, JsValueBridge>>>>,
                        hooks: std::sync::Mutex<Option<(Root<JsFunction>, Root<JsFunction>)>>,
                    }

                    impl AsyncState {
                        fn send_once(&self, value: Result<JsValueBridge, JsValueBridge>) {
                            let tx_opt = self.reply.lock().ok().and_then(|mut g| g.take());
                            if let Some(tx) = tx_opt {
                                let _ = tx.send(value);
                            }
                        }

                        fn clear_hooks(&self) {
                            let _ = self.hooks.lock().ok().and_then(|mut g| g.take());
                            // Dropping Roots here (on the Node thread) releases the GC roots.
                        }
                    }

                    let state = std::sync::Arc::new(AsyncState {
                        reply: std::sync::Mutex::new(Some(reply)),
                        hooks: std::sync::Mutex::new(None),
                    });

                    let func_root = match host_functions.get(func_id) {
                        Some(f) => f.clone(),
                        None => {
                            state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: format!("Unknown host function id {func_id}"),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let func = func_root.to_inner(cx);

                    let mut js_argv: Vec<Handle<JsValue>> = Vec::with_capacity(args.len());
                    for a in &args {
                        let v = crate::bridge::neon_codec::to_neon_value(cx, a)
                            .unwrap_or_else(|_| cx.undefined().upcast());
                        js_argv.push(v);
                    }

                    let this = cx.undefined();

                    let returned = match cx.try_catch(|cx| func.call(cx, this, js_argv.as_slice())) {
                        Ok(v) => v,
                        Err(_) => {
                            state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: "Host function threw".into(),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let is_promise = returned.is_a::<neon::types::JsPromise, _>(cx);

                    if !is_promise {
                        match crate::bridge::neon_codec::from_neon_value(cx, returned) {
                            Ok(b) => state.send_once(Ok(b)),
                            Err(e) => state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: e.to_string(),
                                stack: None,
                                code: None,
                            })),
                        }
                        return Ok(());
                    }

                    let promise_obj: Handle<JsObject> = match returned.downcast::<JsObject, _>(cx) {
                        Ok(o) => o,
                        Err(_) => {
                            state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: "Async host function returned a non-object promise".into(),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let then_fn: Handle<JsFunction> = match cx.try_catch(|cx| promise_obj.get::<JsFunction, _, _>(cx, "then")) {
                        Ok(f) => f,
                        Err(_) => {
                            state.send_once(Err(JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: "Promise.then lookup failed".into(),
                                stack: None,
                                code: None,
                            }));
                            return Ok(());
                        }
                    };

                    let state_ok = state.clone();
                    let on_fulfilled = JsFunction::new(cx, move |mut cx| {
                        let v = cx.argument::<JsValue>(0)?;
                        let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, v).unwrap_or_else(|e| {
                            JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: e.to_string(),
                                stack: None,
                                code: None,
                            }
                        });

                        state_ok.send_once(Ok(bridged));
                        state_ok.clear_hooks();
                        Ok(cx.undefined())
                    })?;

                    let state_err = state.clone();
                    let on_rejected = JsFunction::new(cx, move |mut cx| {
                        let v = cx.argument::<JsValue>(0)?;
                        let bridged = crate::bridge::neon_codec::from_neon_value(&mut cx, v).unwrap_or_else(|e| {
                            JsValueBridge::Error {
                                name: "HostFunctionError".into(),
                                message: e.to_string(),
                                stack: None,
                                code: None,
                            }
                        });

                        state_err.send_once(Err(bridged));
                        state_err.clear_hooks();
                        Ok(cx.undefined())
                    })?;

                    // Root the callbacks so V8 cannot GC them before the Promise settles.
                    {
                        let f_root = on_fulfilled.root(cx);
                        let r_root = on_rejected.root(cx);
                        if let Ok(mut g) = state.hooks.lock() {
                            *g = Some((f_root, r_root));
                        }
                    }

                    let (on_fulfilled_handle, on_rejected_handle) = {
                        let g = state.hooks.lock().ok().and_then(|g| g.as_ref().map(|(f, r)| (f.clone(cx), r.clone(cx))));
                        match g {
                            Some((f, r)) => (f.to_inner(cx), r.to_inner(cx)),
                            None => (on_fulfilled, on_rejected),
                        }
                    };

                    let attached = cx.try_catch(|cx| {
                        let args: Vec<Handle<JsValue>> = vec![
                            on_fulfilled_handle.upcast::<JsValue>(),
                            on_rejected_handle.upcast::<JsValue>(),
                        ];

                        let _ = then_fn.call(cx, promise_obj, args.as_slice())?;
                        Ok(())
                    });

                    if attached.is_err() {
                        state.send_once(Err(JsValueBridge::Error {
                            name: "HostFunctionError".into(),
                            message: "Promise.then invocation failed".into(),
                            stack: None,
                            code: None,
                        }));
                        state.clear_hooks();
                    }

                    Ok(())
                }
            });

            let _ = outer;
        }));

        Ok(())
    });
}
