use neon::{prelude::*, result::Throw};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum JsValueBridge {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),

    BigInt(String), // decimal string
    DateMs(f64),

    RegExp {
        source: String,
        flags: String,
    },

    // Binary values
    BufferView {
        kind: String, // "ArrayBuffer" | "Uint8Array" | "Int32Array" | "DataView" | ...
        bytes: Vec<u8>,
        byte_offset: usize,
        length: usize, // for typed arrays: element length; for DataView: byteLength; for ArrayBuffer: byteLength
    },

    Map(Vec<(JsValueBridge, JsValueBridge)>), // primitive keys only
    Set(Vec<JsValueBridge>),

    Url {
        href: String,
    },
    UrlSearchParams {
        query: String,
    },

    Json(serde_json::Value),
    V8Serialized(Vec<u8>),

    Error {
        name: String,
        message: String,
        stack: Option<String>,
        code: Option<String>,
        cause: Option<Box<JsValueBridge>>,
    },

    HostFunction {
        id: usize,
        is_async: bool,
    },
}

#[derive(Debug, Clone)]
pub struct EvalOptions {
    pub filename: String,
    pub is_module: bool,
    pub args: Vec<JsValueBridge>,
    pub args_provided: bool,
    pub max_eval_ms: Option<u64>,
}

impl Default for EvalOptions {
    // Provides default default values used by bridge encoding/decoding between Rust, V8, and Neon.
    fn default() -> Self {
        Self {
            filename: "Unnamed Script".to_string(),
            is_module: false,
            args: vec![],
            args_provided: false,
            max_eval_ms: None,
        }
    }
}

impl EvalOptions {
    /// Constructs neon from source input for bridge encoding/decoding between Rust, V8, and Neon.
    pub fn from_neon<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> Result<Self, Throw> {
        let mut out = EvalOptions::default();

        if (idx as usize) >= cx.len() {
            return Ok(out);
        }

        let raw = cx.argument::<JsValue>(idx as usize)?;
        if raw.is_a::<JsNull, _>(cx) || raw.is_a::<JsUndefined, _>(cx) {
            return Ok(out);
        }

        let obj = match raw.downcast::<JsObject, _>(cx) {
            Ok(o) => o,
            Err(_) => return Ok(out),
        };

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "filename") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                out.filename = s.value(cx);
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "type") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                out.is_module = s.value(cx) == "module";
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "args") {
            out.args_provided = true;
            if let Ok(arr) = v.downcast::<JsArray, _>(cx) {
                for i in 0..arr.len(cx) {
                    let item = arr.get::<JsValue, _, _>(cx, i)?;
                    out.args
                        .push(crate::bridge::neon_codec::from_neon_value(cx, item)?);
                }
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxEvalMs") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let ms = n.value(cx);
                if ms.is_finite() && ms > 0.0 {
                    out.max_eval_ms = Some(ms as u64);
                }
            }
        }

        Ok(out)
    }
}

impl JsValueBridge {
    /// Js error to bridge.
    pub fn js_error_to_bridge(e: Box<deno_core::error::JsError>) -> Self {
        Self::Error {
            name: "Error".into(),
            message: e.to_string(),
            stack: None,
            code: None,
            cause: None,
        }
    }

    /// Any error to bridge.
    pub fn any_error_to_bridge(e: deno_core::error::AnyError) -> Self {
        Self::Error {
            name: "Error".into(),
            message: e.to_string(),
            stack: None,
            code: None,
            cause: None,
        }
    }

    /// Simple err.
    pub fn simple_err(msg: String) -> Self {
        Self::Error {
            name: "Error".into(),
            message: msg,
            stack: None,
            code: None,
            cause: None,
        }
    }
}
