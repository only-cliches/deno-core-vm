// src/worker/eval.rs
use cpu_time::ProcessTime;
use deno_runtime::deno_core::{self, v8};
use deno_runtime::worker::MainWorker;

use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::bridge::v8_codec;
use crate::worker::messages::{EvalReply, ExecStats};
use crate::worker::state::RuntimeLimits;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

fn mk_err(name: &str, message: String) -> JsValueBridge {
    JsValueBridge::Error {
        name: name.to_string(),
        message,
        stack: None,
        code: None,
        cause: None,
    }
}

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

    let out = match worker.js_runtime.execute_script(filename.to_string(), wrapper) {
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

pub async fn eval_in_runtime(
    worker: &mut MainWorker,
    limits: &RuntimeLimits,
    source: &str,
    options: EvalOptions,
) -> EvalReply {
    let start_wall = Instant::now();
    let start_cpu = ProcessTime::now();

    let isolate_handle = worker.js_runtime.v8_isolate().thread_safe_handle();
    let cancel = Arc::new(AtomicBool::new(false));
    let effective_max_eval_ms = options.max_eval_ms.or(limits.max_eval_ms);

    let timeout_thread = effective_max_eval_ms.map(|ms| {
        let cancel = cancel.clone();
        let isolate_handle = isolate_handle.clone();
        std::thread::spawn(move || {
            std::thread::park_timeout(Duration::from_millis(ms));
            if !cancel.load(Ordering::SeqCst) {
                isolate_handle.terminate_execution();
            }
        })
    });

    let result = if options.is_module {
        eval_module(worker, source).await
    } else {
        eval_script_or_callable(worker, source, &options).await
    };

    cancel.store(true, Ordering::SeqCst);
    if let Some(h) = timeout_thread {
        h.thread().unpark();
        let _ = h.join();
    }

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

async fn eval_script_or_callable(
    worker: &mut MainWorker,
    source: &str,
    options: &EvalOptions,
) -> Result<JsValueBridge, JsValueBridge> {
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

async fn eval_module(worker: &mut MainWorker, source: &str) -> Result<JsValueBridge, JsValueBridge> {
    let reg = {
        let state = worker.js_runtime.op_state();
        state
            .borrow()
            .borrow::<crate::worker::modules::ModuleRegistry>()
            .clone()
    };

    // Use internal virtual scheme so the loader serves it from memory.
    let spec = reg.next_virtual_specifier("js");

    // Inject moduleReturn into module scope and also register per-module state on globalThis.
    // If moduleReturn is called, evalModule resolves to that value.
    // Otherwise, it resolves to a namespace-like object (plain object copy of exports).
    let spec_json = serde_json::to_string(&spec).unwrap_or_else(|_| "\"\"".into());

    let wrapped = format!(
        r#"
const __spec = {spec_json};
const __g = globalThis;
if (!__g.__denojs_worker_module_returns) {{
  Object.defineProperty(__g, "__denojs_worker_module_returns", {{
    value: Object.create(null),
    writable: true,
    configurable: true,
    enumerable: false
  }});
}}
if (!__g.__denojs_worker_module_returns[__spec]) {{
  let __resolve, __reject;
  const __p = new Promise((res, rej) => {{ __resolve = res; __reject = rej; }});
  __g.__denojs_worker_module_returns[__spec] = {{
    called: false,
    promise: __p,
    resolve: __resolve,
    reject: __reject,
  }};
}}
const __st = __g.__denojs_worker_module_returns[__spec];

function moduleReturn(v) {{
  if (__st.called) return;
  __st.called = true;
  try {{ __st.resolve(v); }} catch (e) {{ try {{ __st.reject(e); }} catch {{}} }}
}}

{user}
"#,
        spec_json = spec_json,
        user = source
    );

    reg.put_ephemeral(&spec, &wrapped);

    let url = deno_core::url::Url::parse(&spec).map_err(|e| mk_err("ModuleError", e.to_string()))?;

    worker
        .execute_side_module(&url)
        .await
        .map_err(|e| JsValueBridge::any_error_to_bridge(e.into()))?;

    worker
        .run_event_loop(false)
        .await
        .map_err(|e| JsValueBridge::any_error_to_bridge(e.into()))?;

            let decide_script = format!(
        r#"(async () => {{
  const spec = {spec_json};
  const st = globalThis.__denojs_worker_module_returns && globalThis.__denojs_worker_module_returns[spec];
  if (st && st.called) {{
    return await st.promise;
  }}
  const m = await import(spec);
  const o = Object.create(null);
  const moduleFnKeys = [];
  o.__denojs_worker_module_spec = spec;
  const dehydrate = typeof globalThis.__dehydrate === "function" ? globalThis.__dehydrate : (x) => x;

  for (const k of Object.keys(m)) {{
    const v = m[k];
    if (typeof v === "function") {{
      o[k] = {{ __denojs_worker_type: "module_fn", spec, name: k }};
      moduleFnKeys.push(k);
    }} else {{
      o[k] = dehydrate(v);
    }}
  }}

  if ("default" in m) {{
    o.default = {{ __denojs_worker_type: "module_fn", spec, name: "default" }};
    if (!moduleFnKeys.includes("default")) moduleFnKeys.push("default");
  }}

  if (moduleFnKeys.length) {{
    o.__denojs_worker_module_fns = moduleFnKeys;
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
                            let bridged = v8_codec::from_v8(scope, res)
                                .map_err(|e| mk_err("BridgeError", e));
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
