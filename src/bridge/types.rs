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
    DateMs(f64),
    Bytes(Vec<u8>),

    Json(serde_json::Value),
    V8Serialized(Vec<u8>),

    // Replace BridgeError struct with inline fields
    Error {
        name: String,
        message: String,
        stack: Option<String>,
        code: Option<String>,
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
}

impl Default for EvalOptions {
    fn default() -> Self {
        Self {
            filename: "Unnamed Script".to_string(),
            is_module: false,
            args: vec![],
            args_provided: false,
        }
    }
}

impl EvalOptions {
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

        Ok(out)
    }
}
