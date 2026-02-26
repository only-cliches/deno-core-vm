use deno_core::{
    FastString, JsRuntime, ModuleLoader, ModuleSource, ModuleType, RuntimeOptions, resolve_url,
};
use deno_error::JsErrorBox;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};

use crate::bridge::types::{JsValueBridge};

pub enum ScriptType {
    Classic,
    Module,
}

pub enum DenoThreadMsg {
    Eval {
        source: String,
        script_type: ScriptType,
        resp_tx: oneshot::Sender<Result<(JsValueBridge, f64, f64), JsValueBridge>>,
    },
    Close,
}

pub struct DynamicModuleLoader {
    modules: Arc<Mutex<HashMap<String, String>>>,
}

// Updated trait bound signatures to comply with deno_core 0.385+
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
        let specifier = module_specifier.clone();
        let code = self
            .modules
            .lock()
            .unwrap()
            .get(module_specifier.as_str())
            .cloned()
            .unwrap_or_default();

        let source = ModuleSource::new(
            ModuleType::JavaScript,
            deno_core::ModuleSourceCode::String(code.into()),
            &specifier,
            None,
        );

        deno_core::ModuleLoadResponse::Sync(Ok(source))
    }
}

pub fn spawn_deno_runtime(
    mut rx: mpsc::Receiver<DenoThreadMsg>,
    node_tx: tokio::sync::mpsc::UnboundedSender<DenoThreadMsg>,
    max_eval_ms: u64,
) {
    std::thread::spawn(move || {
        let tokio_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to create Tokio Runtime");

        tokio_rt.block_on(async move {
            let modules = Arc::new(Mutex::new(HashMap::new()));
            let loader = std::rc::Rc::new(DynamicModuleLoader {
                modules: modules.clone(),
            });

            let mut runtime = JsRuntime::new(RuntimeOptions {
                module_loader: Some(loader),
                ..Default::default()
            });

            runtime.op_state().borrow_mut().put(node_tx);

            let _ = runtime.execute_script(
                "<init>",
                FastString::from(
                    "globalThis.postMessage = (msg) => Deno.core.ops.op_post_message(msg);"
                        .to_string(),
                ),
            );

            let mut mod_counter = 0;

            while let Some(msg) = rx.recv().await {
                match msg {
                    DenoThreadMsg::Eval {
                        source,
                        script_type,
                        resp_tx,
                    } => {
                        let start = Instant::now();
                        let start_cpu = cpu_time::ProcessTime::now();

                        let isolate_handle = runtime.v8_isolate().thread_safe_handle();
                        let timeout_task = tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(max_eval_ms)).await;
                            isolate_handle.terminate_execution();
                        });

                        let outcome = match script_type {
                            ScriptType::Classic => evaluate_classic(&mut runtime, source).await,
                            ScriptType::Module => {
                                mod_counter += 1;
                                let specifier_str =
                                    format!("file:///virtual_module_{}.js", mod_counter);
                                modules
                                    .lock()
                                    .unwrap()
                                    .insert(specifier_str.clone(), source);
                                evaluate_module(&mut runtime, specifier_str).await
                            }
                        };

                        timeout_task.abort();

                        let eval_time = start.elapsed().as_secs_f64() * 1000.0;
                        let cpu_time = start_cpu.elapsed().as_nanos() as f64 / 1_000_000.0;

                        let payload = match outcome {
                            Ok(data) => Ok((data, eval_time, cpu_time)),
                            Err(err) => Err(err),
                        };

                        let _ = resp_tx.send(payload);
                    }
                    DenoThreadMsg::Close => break,
                }
            }
        });
    });
}

async fn evaluate_classic(
    runtime: &mut JsRuntime,
    source: String,
) -> Result<JsValueBridge, JsValueBridge> {
    let res = runtime
        .execute_script("<anon>", FastString::from(source))
        .map_err(|e| e.to_string());
    resolve_and_map(runtime, res).await
}

async fn evaluate_module(
    runtime: &mut JsRuntime,
    specifier_str: String,
) -> Result<JsValueBridge, JsValueBridge> {
    let specifier = resolve_url(&specifier_str).unwrap();

    let mod_id = match runtime.load_side_es_module(&specifier).await {
        Ok(id) => id,
        Err(e) => {
            return Err(JsValueBridge::Error {
                name: "ModuleError".into(),
                message: e.to_string(),
                stack: None,
                code: None,
            });
        }
    };

    let receiver = runtime.mod_evaluate(mod_id);
    let _ = runtime.run_event_loop(Default::default()).await;

    match receiver.await {
        Ok(_) => Ok(JsValueBridge::Undefined),
        Err(e) => Err(JsValueBridge::Error {
            name: "EvalError".into(),
            message: e.to_string(),
            stack: None,
            code: None,
        }),
    }
}

async fn resolve_and_map<E: ToString>(
    runtime: &mut JsRuntime,
    res: Result<deno_core::v8::Global<deno_core::v8::Value>, E>,
) -> Result<JsValueBridge, JsValueBridge> {
    let global_val = match res {
        Ok(v) => v,
        Err(e) => {
            return Err(JsValueBridge::Error {
                name: "Error".into(),
                message: e.to_string(),
                stack: None,
                code: None,
            });
        }
    };

    let promise_val = {
        deno_core::scope!(scope, runtime);
        let local = deno_core::v8::Local::new(scope, global_val.clone());
        if local.is_promise() {
            Some(deno_core::v8::Global::new(scope, local))
        } else {
            return match crate::bridge::v8_codec::from_v8(scope, local) {
                Ok(data) => Ok(data),
                Err(e) => Err(JsValueBridge::Error {
                    name: "SerializeError".into(),
                    message: e,
                    stack: None,
                    code: None,
                }),
            };
        }
    };

    if let Some(promise) = promise_val {
        let resolved_global = match runtime.resolve(promise).await {
            Ok(v) => v,
            Err(e) => {
                return Err(JsValueBridge::Error {
                    name: "PromiseRejection".into(),
                    message: e.to_string(),
                    stack: None,
                    code: None,
                });
            }
        };

        deno_core::scope!(scope, runtime);
        let resolved_local = deno_core::v8::Local::new(scope, resolved_global);

        match crate::bridge::v8_codec::from_v8(scope, resolved_local) {
            Ok(data) => Ok(data),
            Err(e) => Err(JsValueBridge::Error {
                name: "SerializeError".into(),
                message: e,
                stack: None,
                code: None,
            }),
        }
    } else {
        Ok(JsValueBridge::Undefined)
    }
}