use deno_core::{
    ModuleLoader, ModuleSource, ModuleType,
};
use deno_error::JsErrorBox;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::bridge::types::JsValueBridge;

#[allow(dead_code)]
pub enum ScriptType {
    Classic,
    Module,
}

#[allow(dead_code)]
pub enum DenoThreadMsg {
    Eval {
        source: String,
        script_type: ScriptType,
        resp_tx: oneshot::Sender<Result<(JsValueBridge, f64, f64), JsValueBridge>>,
    },
    Close,
}

#[allow(dead_code)]
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
