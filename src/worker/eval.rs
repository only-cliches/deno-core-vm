// src/worker/eval.rs
use cpu_time::ProcessTime;
use deno_runtime::deno_core::{self, resolve_url, v8};
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

fn v8_get_string_prop<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    obj: v8::Local<'s, v8::Object>,
    key: &str,
) -> Option<String> {
    let k = v8::String::new(ps, key)?;
    let v = obj.get(ps, k.into())?;
    if v.is_string() {
        Some(v.to_rust_string_lossy(ps))
    } else {
        None
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
            name = v8_get_string_prop(ps, obj, "name");
            message = v8_get_string_prop(ps, obj, "message");
            stack = v8_get_string_prop(ps, obj, "stack");
            code = v8_get_string_prop(ps, obj, "code");
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
    }
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
            std::thread::sleep(Duration::from_millis(ms));
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
    if let Some(t) = timeout_thread {
        let _ = t.join();
    }

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

    let global = worker
        .js_runtime
        .execute_script(filename.to_string(), source.to_string())
        .map_err(JsValueBridge::js_error_to_bridge)?;

    if options.args_provided {
        let called = try_call_if_function(worker, global, &options.args)?;
        return settle_if_promise(worker, called).await;
    }

    settle_if_promise(worker, global).await
}

async fn eval_module(worker: &mut MainWorker, source: &str) -> Result<JsValueBridge, JsValueBridge> {
    let reg = {
        let state = worker.js_runtime.op_state();
        state.borrow().borrow::<super::modules::ModuleRegistry>().clone()
    };

    let spec = reg.next_specifier();
    reg.put(&spec, source);

    let url = resolve_url(&spec).map_err(|e| JsValueBridge::Error {
        name: "ModuleError".into(),
        message: e.to_string(),
        stack: None,
        code: None,
    })?;

    worker
        .execute_side_module(&url)
        .await
        .map_err(|e| JsValueBridge::any_error_to_bridge(e.into()))?;

    worker
        .run_event_loop(false)
        .await
        .map_err(|e| JsValueBridge::any_error_to_bridge(e.into()))?;

    let out = worker
        .js_runtime
        .execute_script("<moduleReturn>", "globalThis.__moduleReturn".to_string())
        .map_err(JsValueBridge::js_error_to_bridge)?;

    settle_if_promise(worker, out).await
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

    let func = v8::Local::<v8::Function>::try_from(local).map_err(|e| JsValueBridge::Error {
        name: "TypeError".into(),
        message: e.to_string(),
        stack: None,
        code: None,
    })?;

    let recv = v8::undefined(scope).into();
    let mut argv = Vec::with_capacity(args.len());
    for a in args {
        argv.push(v8_codec::to_v8(scope, a).map_err(JsValueBridge::simple_err)?);
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
    worker: &mut MainWorker,
    value: deno_core::v8::Global<v8::Value>,
) -> Result<JsValueBridge, JsValueBridge> {
    loop {
        let (is_pending_promise, opt_res) = {
            deno_core::scope!(scope, &mut worker.js_runtime);
            let local = v8::Local::new(scope, value.clone());

            if let Ok(p) = v8::Local::<v8::Promise>::try_from(local) {
                match p.state() {
                    v8::PromiseState::Pending => (true, None),
                    v8::PromiseState::Fulfilled => {
                        let res = p.result(scope);
                        (
                            false,
                            Some(v8_codec::from_v8(scope, res).map_err(JsValueBridge::simple_err)),
                        )
                    }
                    v8::PromiseState::Rejected => {
                        let res = p.result(scope);

                        let bridged = v8_codec::from_v8(scope, res);
                        let rejected_value = match bridged {
                            Ok(v) => v,
                            Err(_) => rejection_to_bridge_fallback(scope, res),
                        };

                        (false, Some(Err(rejected_value)))
                    }
                }
            } else {
                (
                    false,
                    Some(v8_codec::from_v8(scope, local).map_err(JsValueBridge::simple_err)),
                )
            }
        };

        if let Some(res) = opt_res {
            return res;
        }

        if is_pending_promise {
            worker
                .run_event_loop(false)
                .await
                .map_err(|e| JsValueBridge::any_error_to_bridge(e.into()))?;
        }
    }
}