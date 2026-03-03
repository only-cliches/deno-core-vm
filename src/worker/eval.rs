// src/worker/eval.rs
use cpu_time::ProcessTime;
use deno_core::url::Url;
use deno_runtime::deno_core::{self, v8};
use deno_runtime::worker::MainWorker;

use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::bridge::v8_codec;
use crate::worker::messages::{EvalReply, ExecStats};
use crate::worker::state::RuntimeLimits;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::sync::{OnceLock, mpsc};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    path::PathBuf,
};
use std::time::{Duration, Instant};
use std::{sync::atomic::AtomicU64, thread};

enum EvalTimerCmd {
    Arm {
        timer_id: u64,
        deadline: Instant,
        cancel: Arc<AtomicBool>,
        isolate_handle: v8::IsolateHandle,
    },
    Disarm {
        timer_id: u64,
    },
}

#[derive(Clone)]
struct EvalTimerService {
    tx: mpsc::Sender<EvalTimerCmd>,
    next_timer_id: Arc<AtomicU64>,
}

impl EvalTimerService {
    // Global.
    fn global() -> &'static EvalTimerService {
        static TIMER: OnceLock<EvalTimerService> = OnceLock::new();
        TIMER.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<EvalTimerCmd>();
            let service = EvalTimerService {
                tx,
                next_timer_id: Arc::new(AtomicU64::new(1)),
            };

            thread::spawn(move || {
                let mut timers: HashMap<u64, (Instant, Arc<AtomicBool>, v8::IsolateHandle)> =
                    HashMap::new();

                loop {
                    let now = Instant::now();
                    let due_ids: Vec<u64> = timers
                        .iter()
                        .filter_map(|(id, (deadline, _, _))| if *deadline <= now { Some(*id) } else { None })
                        .collect();

                    for id in due_ids {
                        if let Some((_deadline, cancel, isolate_handle)) = timers.remove(&id) {
                            if !cancel.load(Ordering::SeqCst) {
                                isolate_handle.terminate_execution();
                            }
                        }
                    }

                    let wait = timers
                        .values()
                        .map(|(deadline, _, _)| {
                            if *deadline > now {
                                *deadline - now
                            } else {
                                Duration::from_millis(0)
                            }
                        })
                        .min()
                        .unwrap_or(Duration::from_secs(3600));

                    match rx.recv_timeout(wait) {
                        Ok(EvalTimerCmd::Arm {
                            timer_id,
                            deadline,
                            cancel,
                            isolate_handle,
                        }) => {
                            timers.insert(timer_id, (deadline, cancel, isolate_handle));
                        }
                        Ok(EvalTimerCmd::Disarm { timer_id }) => {
                            timers.remove(&timer_id);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            });

            service
        })
    }

    // Arm.
    fn arm(&self, timeout_ms: u64, cancel: Arc<AtomicBool>, isolate_handle: v8::IsolateHandle) -> u64 {
        let timer_id = self.next_timer_id.fetch_add(1, Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let _ = self.tx.send(EvalTimerCmd::Arm {
            timer_id,
            deadline,
            cancel,
            isolate_handle,
        });
        timer_id
    }

    // Disarm.
    fn disarm(&self, timer_id: u64) {
        let _ = self.tx.send(EvalTimerCmd::Disarm { timer_id });
    }
}

// Transpiles ts enabled as part of runtime eval, module execution, and timeout handling.
fn transpile_ts_enabled(limits: &RuntimeLimits) -> bool {
    limits
        .module_loader
        .as_ref()
        .map(|m| m.transpile_ts)
        .unwrap_or(false)
}

// Transpiles options from limits as part of runtime eval, module execution, and timeout handling.
fn transpile_options_from_limits(limits: &RuntimeLimits) -> deno_ast::TranspileOptions {
    let mut out = deno_ast::TranspileOptions::default();
    let Some(cfg) = limits.module_loader.as_ref() else {
        return out;
    };
    let Some(tc) = cfg.ts_compiler.as_ref() else {
        return out;
    };

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

    out
}

// Media type for eval filename.
fn media_type_for_eval_filename(filename: &str) -> deno_ast::MediaType {
    let ext = filename
        .rsplit('.')
        .next()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "tsx" => deno_ast::MediaType::Tsx,
        "jsx" => deno_ast::MediaType::Jsx,
        "ts" | "mts" | "cts" => deno_ast::MediaType::TypeScript,
        _ => deno_ast::MediaType::TypeScript,
    }
}

// Specifier for eval filename.
fn specifier_for_eval_filename(filename: &str, media: deno_ast::MediaType) -> Url {
    if let Ok(u) = Url::parse(filename) {
        return u;
    }

    let ext = match media {
        deno_ast::MediaType::Tsx => "tsx",
        deno_ast::MediaType::Jsx => "jsx",
        _ => "ts",
    };

    Url::parse(&format!("denojs-worker://eval/virtual.{ext}"))
        .expect("internal eval transpile specifier should parse")
}

// Maybe transpile eval source.
fn maybe_transpile_eval_source(
    limits: &RuntimeLimits,
    filename: &str,
    source: &str,
) -> Result<String, JsValueBridge> {
    if !transpile_ts_enabled(limits) {
        return Ok(source.to_string());
    }

    let media = media_type_for_eval_filename(filename);
    let maybe_cache_path = transpile_cache_path_from_limits(limits, filename, source, media);

    let reload = limits
        .module_loader
        .as_ref()
        .map(|ml| ml.reload)
        .unwrap_or(false);
    if !reload {
        if let Some(cache_path) = maybe_cache_path.as_ref() {
            if let Ok(hit) = std::fs::read_to_string(cache_path) {
                return Ok(hit);
            }
        }
    }

    let parsed = deno_ast::parse_module(deno_ast::ParseParams {
        specifier: specifier_for_eval_filename(filename, media),
        text: source.to_string().into(),
        media_type: media,
        capture_tokens: false,
        scope_analysis: false,
        maybe_syntax: None,
    })
    .map_err(|e| mk_err("TranspileError", e.to_string()))?;

    let transpiled = parsed
        .transpile(
            &transpile_options_from_limits(limits),
            &deno_ast::TranspileModuleOptions::default(),
            &deno_ast::EmitOptions {
                source_map: deno_ast::SourceMapOption::None,
                ..Default::default()
            },
        )
        .map(|v| v.into_source().text)
        .map_err(|e| mk_err("TranspileError", e.to_string()))?;

    if let Some(cache_path) = maybe_cache_path.as_ref() {
        if let Some(parent) = cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(cache_path, transpiled.as_bytes());
    }

    Ok(transpiled)
}

// Transpiles cache path from limits as part of runtime eval, module execution, and timeout handling.
fn transpile_cache_path_from_limits(
    limits: &RuntimeLimits,
    filename: &str,
    source: &str,
    media: deno_ast::MediaType,
) -> Option<PathBuf> {
    let cache_dir = limits
        .module_loader
        .as_ref()
        .and_then(|ml| ml.ts_compiler.as_ref())
        .and_then(|tc| tc.cache_dir.as_ref())?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    filename.hash(&mut hasher);
    source.hash(&mut hasher);
    format!("{media:?}").hash(&mut hasher);
    if let Some(tc) = limits
        .module_loader
        .as_ref()
        .and_then(|ml| ml.ts_compiler.as_ref())
    {
        tc.jsx.hash(&mut hasher);
        tc.jsx_factory.hash(&mut hasher);
        tc.jsx_fragment_factory.hash(&mut hasher);
    }
    let h = hasher.finish();
    Some(PathBuf::from(cache_dir).join(format!("{h:016x}.js")))
}

// Mk err.
fn mk_err(name: &str, message: String) -> JsValueBridge {
    JsValueBridge::Error {
        name: name.to_string(),
        message,
        stack: None,
        code: None,
        cause: None,
    }
}

// Rejection to bridge fallback.
fn rejection_to_bridge_fallback<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    v: v8::Local<'s, v8::Value>,
) -> JsValueBridge {
    let mut name: Option<String> = None;
    let mut message: Option<String> = None;
    let mut stack: Option<String> = None;
    let mut code: Option<String> = None;

    if v.is_object() {
        if let Some(obj) = v.to_object(ps) {
            let k_name = v8::String::new(ps, "name");
            let k_msg = v8::String::new(ps, "message");
            let k_stack = v8::String::new(ps, "stack");
            let k_code = v8::String::new(ps, "code");

            if let Some(k) = k_name {
                name = obj
                    .get(ps, k.into())
                    .and_then(|x| x.to_string(ps))
                    .map(|s| s.to_rust_string_lossy(ps));
            }
            if let Some(k) = k_msg {
                message = obj
                    .get(ps, k.into())
                    .and_then(|x| x.to_string(ps))
                    .map(|s| s.to_rust_string_lossy(ps));
            }
            if let Some(k) = k_stack {
                stack = obj
                    .get(ps, k.into())
                    .and_then(|x| x.to_string(ps))
                    .map(|s| s.to_rust_string_lossy(ps));
            }
            if let Some(k) = k_code {
                code = obj
                    .get(ps, k.into())
                    .and_then(|x| x.to_string(ps))
                    .map(|s| s.to_rust_string_lossy(ps));
            }
        }
    }

    let msg = match message {
        Some(m) if !m.is_empty() => m,
        _ => v
            .to_string(ps)
            .map(|s| s.to_rust_string_lossy(ps))
            .unwrap_or_else(|| "Promise rejected".to_string()),
    };

    JsValueBridge::Error {
        name: name.unwrap_or_else(|| "Error".into()),
        message: msg,
        stack,
        code,
        cause: None,
    }
}

/// Execute user-provided script source via (0, eval)(...) inside a try/catch wrapper,
/// so we can preserve the actual thrown value.
fn execute_script_catching(
    worker: &mut MainWorker,
    filename: &str,
    source: &str,
) -> Result<deno_core::v8::Global<v8::Value>, deno_core::v8::Global<v8::Value>> {
    let src_json = serde_json::to_string(source).unwrap_or_else(|_| "\"\"".to_string());

    let wrapper = format!(
        r#"(function(){{
  try {{
    const v = (0, eval)({src_json});
    return {{ __denojs_worker_threw: false, v }};
  }} catch (e) {{
    return {{ __denojs_worker_threw: true, e }};
  }}
}})()"#
    );

    let out = match worker
        .js_runtime
        .execute_script(filename.to_string(), wrapper)
    {
        Ok(v) => v,
        Err(e) => {
            deno_core::scope!(scope, &mut worker.js_runtime);
            let msg = format!("Script execution failed: {}", e.to_string());
            let msg_v = v8::String::new(scope, &msg)
                .or_else(|| v8::String::new(scope, "Script execution failed"))
                .expect("v8 string alloc failed");
            let err = v8::Exception::error(scope, msg_v);
            return Err(deno_core::v8::Global::new(scope, err));
        }
    };

    deno_core::scope!(scope, &mut worker.js_runtime);
    let local = v8::Local::new(scope, out);

    if !local.is_object() {
        return Ok(v8::Global::new(scope, local));
    }

    let obj = local.to_object(scope).unwrap();

    let threw_key = v8::String::new(scope, "__denojs_worker_threw").unwrap();
    let threw_val = obj.get(scope, threw_key.into());
    let threw = threw_val.map(|v| v.is_true()).unwrap_or(false);

    if threw {
        let e_key = v8::String::new(scope, "e").unwrap();
        let e_val = obj
            .get(scope, e_key.into())
            .unwrap_or_else(|| v8::undefined(scope).into());
        return Err(deno_core::v8::Global::new(scope, e_val));
    }

    let v_key = v8::String::new(scope, "v").unwrap();
    let v_val = obj
        .get(scope, v_key.into())
        .unwrap_or_else(|| v8::undefined(scope).into());
    Ok(v8::Global::new(scope, v_val))
}

// Ensure runtime env bridge.
fn ensure_runtime_env_bridge(worker: &mut MainWorker) {
    let _ = worker.js_runtime.execute_script(
        "<runtime_env_bridge>",
        r#"(function(){
  try {
    const f = globalThis.__denojs_worker_install_runtime_env_bridge;
    if (typeof f === "function") f();
  } catch {}
})()"#,
    );
}

/// Evaluates in runtime within the execution flow for runtime eval, module execution, and timeout handling.
pub async fn eval_in_runtime(
    worker: &mut MainWorker,
    limits: &RuntimeLimits,
    source: &str,
    options: EvalOptions,
) -> EvalReply {
    // Defensive pre-clear:
    // timeout-driven termination can race with request boundaries; clear any
    // stale terminate flag before starting a fresh eval request.
    worker.js_runtime.v8_isolate().cancel_terminate_execution();
    worker.js_runtime.v8_isolate().cancel_terminate_execution();

    let start_wall = Instant::now();
    let start_cpu = ProcessTime::now();
    let filename = if options.filename.is_empty() {
        if options.is_module {
            "<evalModule>".to_string()
        } else {
            "<eval>".to_string()
        }
    } else {
        options.filename.clone()
    };

    let transpiled_source = match maybe_transpile_eval_source(limits, &filename, source) {
        Ok(s) => s,
        Err(error) => {
            let stats = ExecStats {
                cpu_time_ms: start_cpu.elapsed().as_nanos() as f64 / 1_000_000.0,
                eval_time_ms: start_wall.elapsed().as_nanos() as f64 / 1_000_000.0,
            };
            return EvalReply::Err { error, stats };
        }
    };

    let isolate_handle = worker.js_runtime.v8_isolate().thread_safe_handle();
    let cancel = Arc::new(AtomicBool::new(false));
    let effective_max_eval_ms = options.max_eval_ms.or(limits.max_eval_ms);

    let timeout_id = effective_max_eval_ms.map(|ms| {
        EvalTimerService::global().arm(ms, cancel.clone(), isolate_handle.clone())
    });

    let result = if options.is_module {
        eval_module(worker, &transpiled_source).await
    } else {
        eval_script_or_callable(worker, &transpiled_source, &options).await
    };

    cancel.store(true, Ordering::SeqCst);
    if let Some(id) = timeout_id {
        EvalTimerService::global().disarm(id);
    }

    // Defensive double-cancel:
    // we occasionally observe one pending termination flag survive the first
    // clear across nested eval/module flows, so clear twice before returning.
    worker.js_runtime.v8_isolate().cancel_terminate_execution();
    worker.js_runtime.v8_isolate().cancel_terminate_execution();

    let stats = ExecStats {
        cpu_time_ms: start_cpu.elapsed().as_nanos() as f64 / 1_000_000.0,
        eval_time_ms: start_wall.elapsed().as_nanos() as f64 / 1_000_000.0,
    };

    match result {
        Ok(value) => EvalReply::Ok { value, stats },
        Err(error) => EvalReply::Err { error, stats },
    }
}

// Evaluates script or callable within the execution flow for runtime eval, module execution, and timeout handling.
async fn eval_script_or_callable(
    worker: &mut MainWorker,
    source: &str,
    options: &EvalOptions,
) -> Result<JsValueBridge, JsValueBridge> {
    ensure_runtime_env_bridge(worker);

    let filename = if options.filename.is_empty() {
        "<eval>".to_string()
    } else {
        options.filename.clone()
    };

    let global = match execute_script_catching(worker, &filename, source) {
        Ok(v) => v,
        Err(thrown) => {
            let bridged = {
                deno_core::scope!(scope, &mut worker.js_runtime);
                let local = v8::Local::new(scope, thrown);

                crate::bridge::v8_codec::from_v8(scope, local)
                    .unwrap_or_else(|_| rejection_to_bridge_fallback(scope, local))
            };
            return Err(bridged);
        }
    };

    if options.args_provided {
        let called = try_call_if_function(worker, global, &options.args)?;
        return settle_until_non_promise(worker, called).await;
    }

    settle_until_non_promise(worker, global).await
}

// Evaluates module within the execution flow for runtime eval, module execution, and timeout handling.
async fn eval_module(
    worker: &mut MainWorker,
    source: &str,
) -> Result<JsValueBridge, JsValueBridge> {
    ensure_runtime_env_bridge(worker);

    let reg = {
        let state = worker.js_runtime.op_state();
        state
            .borrow()
            .borrow::<crate::worker::modules::ModuleRegistry>()
            .clone()
    };

    // Use internal virtual scheme so the loader serves it from memory.
    let spec = reg.next_virtual_specifier("js");

    let spec_json = serde_json::to_string(&spec).unwrap_or_else(|_| "\"\"".into());
    reg.put_ephemeral(&spec, source, deno_core::ModuleType::JavaScript);

    let url =
        deno_core::url::Url::parse(&spec).map_err(|e| mk_err("ModuleError", e.to_string()))?;

    worker
        .execute_side_module(&url)
        .await
        .map_err(|e| {
            reg.remove(&spec);
            JsValueBridge::any_error_to_bridge(e.into())
        })?;

    worker
        .run_event_loop(false)
        .await
        .map_err(|e| {
            reg.remove(&spec);
            JsValueBridge::any_error_to_bridge(e.into())
        })?;

    let decide_script = format!(
        r#"(async () => {{
  const spec = {spec_json};
  const m = await import(spec);
  const o = Object.create(null);
  const moduleFnKeys = [];
  const moduleAsyncFnKeys = [];
  o.__denojs_worker_module_spec = spec;

  for (const k of Object.keys(m)) {{
    const v = m[k];
    if (typeof v === "function") {{
      const isAsync = Object.prototype.toString.call(v) === "[object AsyncFunction]";
      o[k] = {{ __denojs_worker_type: "module_fn", spec, name: k, async: isAsync }};
      moduleFnKeys.push(k);
      if (isAsync) moduleAsyncFnKeys.push(k);
    }} else {{
      // Keep raw values here; Rust bridge dehydration happens once on the full
      // result object. Pre-dehydrating each export here can double-wrap graph
      // tags and break identity/references.
      o[k] = v;
    }}
  }}

  if ("default" in m) {{
    const isDefaultAsync =
      typeof m.default === "function" &&
      Object.prototype.toString.call(m.default) === "[object AsyncFunction]";
    o.default = {{ __denojs_worker_type: "module_fn", spec, name: "default", async: isDefaultAsync }};
    if (!moduleFnKeys.includes("default")) moduleFnKeys.push("default");
    if (isDefaultAsync && !moduleAsyncFnKeys.includes("default")) moduleAsyncFnKeys.push("default");
  }}

  if (moduleFnKeys.length) {{
    o.__denojs_worker_module_fns = moduleFnKeys;
  }}
  if (moduleAsyncFnKeys.length) {{
    o.__denojs_worker_module_async_fns = moduleAsyncFnKeys;
  }}

  return o;
}})()"#,
        spec_json = spec_json
    );

    let out = worker
        .js_runtime
        .execute_script("<evalModule>", decide_script)
        .map_err(JsValueBridge::js_error_to_bridge)?;

    settle_until_non_promise(worker, out).await
}

// Attempts to call if function and returns a fallible result for runtime eval, module execution, and timeout handling.
fn try_call_if_function(
    worker: &mut MainWorker,
    value: deno_core::v8::Global<v8::Value>,
    args: &[JsValueBridge],
) -> Result<deno_core::v8::Global<v8::Value>, JsValueBridge> {
    deno_core::scope!(scope, &mut worker.js_runtime);
    let local = v8::Local::new(scope, value);

    if !local.is_function() {
        return Ok(v8::Global::new(scope, local));
    }

    let func = v8::Local::<v8::Function>::try_from(local)
        .map_err(|e| mk_err("TypeError", e.to_string()))?;

    let recv = v8::undefined(scope).into();
    let mut argv = Vec::with_capacity(args.len());
    for a in args {
        let vv = v8_codec::to_v8(scope, a).map_err(|e| mk_err("BridgeError", e))?;
        argv.push(vv);
    }

    let out = func
        .call(scope, recv, &argv)
        .ok_or_else(|| mk_err("Error", "Failed to call evaluated function".into()))?;

    Ok(v8::Global::new(scope, out))
}

// Settle until non promise.
async fn settle_until_non_promise(
    worker: &mut MainWorker,
    mut value: deno_core::v8::Global<v8::Value>,
) -> Result<JsValueBridge, JsValueBridge> {
    loop {
        let (pending, next_value, done_result) = {
            deno_core::scope!(scope, &mut worker.js_runtime);
            let local = v8::Local::new(scope, value.clone());

            if let Ok(p) = v8::Local::<v8::Promise>::try_from(local) {
                match p.state() {
                    v8::PromiseState::Pending => (true, None, None),

                    v8::PromiseState::Fulfilled => {
                        let res = p.result(scope);
                        if res.is_promise() {
                            (false, Some(v8::Global::new(scope, res)), None)
                        } else {
                            let bridged =
                                v8_codec::from_v8(scope, res).map_err(|e| mk_err("BridgeError", e));
                            (false, None, Some(bridged))
                        }
                    }

                    v8::PromiseState::Rejected => {
                        let res = p.result(scope);
                        let bridged = v8_codec::from_v8(scope, res)
                            .map_err(|_| mk_err("Error", "Promise rejected".into()))
                            .unwrap_or_else(|_| rejection_to_bridge_fallback(scope, res));
                        (false, None, Some(Err(bridged)))
                    }
                }
            } else {
                let bridged = v8_codec::from_v8(scope, local).map_err(|e| mk_err("BridgeError", e));
                (false, None, Some(bridged))
            }
        };

        if let Some(next) = next_value {
            value = next;
            continue;
        }

        if let Some(res) = done_result {
            return res;
        }

        if pending {
            worker
                .run_event_loop(false)
                .await
                .map_err(|e| JsValueBridge::any_error_to_bridge(e.into()))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{media_type_for_eval_filename, transpile_cache_path_from_limits};
    use crate::worker::state::{ModuleLoaderConfig, RuntimeLimits, TsCompilerConfig};

    // Limits with cache.
    fn limits_with_cache(
        cache_dir: Option<&str>,
        jsx: Option<&str>,
        jsx_factory: Option<&str>,
    ) -> RuntimeLimits {
        RuntimeLimits {
            module_loader: Some(ModuleLoaderConfig {
                transpile_ts: true,
                ts_compiler: Some(TsCompilerConfig {
                    jsx: jsx.map(str::to_string),
                    jsx_factory: jsx_factory.map(str::to_string),
                    jsx_fragment_factory: None,
                    cache_dir: cache_dir.map(str::to_string),
                }),
                ..ModuleLoaderConfig::default()
            }),
            ..RuntimeLimits::default()
        }
    }

    #[test]
    // Transpiles cache path is none without cache dir as part of runtime eval, module execution, and timeout handling.
    fn transpile_cache_path_is_none_without_cache_dir() {
        let limits = limits_with_cache(None, Some("react"), None);
        let media = media_type_for_eval_filename("x.ts");
        let out = transpile_cache_path_from_limits(&limits, "x.ts", "const a: number = 1;", media);
        assert!(out.is_none());
    }

    #[test]
    // Transpiles cache path is stable for same inputs as part of runtime eval, module execution, and timeout handling.
    fn transpile_cache_path_is_stable_for_same_inputs() {
        let limits = limits_with_cache(Some("/tmp/cache"), Some("react-jsx"), Some("h"));
        let media = media_type_for_eval_filename("x.tsx");

        let a =
            transpile_cache_path_from_limits(&limits, "x.tsx", "const a: number = 1;", media)
                .expect("cache path");
        let b =
            transpile_cache_path_from_limits(&limits, "x.tsx", "const a: number = 1;", media)
                .expect("cache path");
        assert_eq!(a, b);
    }

    #[test]
    // Transpiles cache path changes with source or compiler flags as part of runtime eval, module execution, and timeout handling.
    fn transpile_cache_path_changes_with_source_or_compiler_flags() {
        let base = limits_with_cache(Some("/tmp/cache"), Some("react"), None);
        let changed_source = limits_with_cache(Some("/tmp/cache"), Some("react"), None);
        let changed_jsx = limits_with_cache(Some("/tmp/cache"), Some("react-jsx"), None);
        let media = media_type_for_eval_filename("x.ts");

        let a = transpile_cache_path_from_limits(&base, "x.ts", "const a = 1;", media)
            .expect("cache path");
        let b = transpile_cache_path_from_limits(&changed_source, "x.ts", "const a = 2;", media)
            .expect("cache path");
        let c = transpile_cache_path_from_limits(&changed_jsx, "x.ts", "const a = 1;", media)
            .expect("cache path");

        assert_ne!(a, b);
        assert_ne!(a, c);
    }
}
