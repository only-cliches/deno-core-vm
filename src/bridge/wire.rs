use crate::bridge::types::JsValueBridge;

/// Canonical "wire" JSON format used between Rust and the Deno runtime.js hydration layer.
/// This must stay stable, because runtime.js depends on these tags.
pub fn to_wire_json(v: &JsValueBridge) -> serde_json::Value {
    match v {
        JsValueBridge::Undefined => serde_json::Value::Null,
        JsValueBridge::Null => serde_json::Value::Null,
        JsValueBridge::Bool(b) => serde_json::json!(b),
        JsValueBridge::Number(n) => serde_json::json!(n),
        JsValueBridge::String(s) => serde_json::json!(s),
        JsValueBridge::DateMs(ms) => serde_json::json!({ "__date": ms }),
        JsValueBridge::Bytes(b) => serde_json::json!({ "__bytes": b }),
        JsValueBridge::Json(v) => v.clone(),
        JsValueBridge::V8Serialized(b) => serde_json::json!({ "__v8": b }),
        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
        } => serde_json::json!({
            "__denojs_worker_type": "error",
            "name": name,
            "message": message,
            "stack": stack,
            "code": code
        }),
        JsValueBridge::HostFunction { id, is_async } => serde_json::json!({
            "__denojs_worker_type": "function",
            "id": id,
            "async": is_async
        }),
    }
}

/// Best effort parse from the wire JSON format into a bridge value.
/// This is intentionally permissive because callers may give us plain JSON.
#[allow(dead_code)]
pub fn from_wire_json(v: serde_json::Value) -> JsValueBridge {
    match v {
        serde_json::Value::Null => JsValueBridge::Null,
        serde_json::Value::Bool(b) => JsValueBridge::Bool(b),
        serde_json::Value::Number(n) => JsValueBridge::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => JsValueBridge::String(s),
        serde_json::Value::Array(a) => JsValueBridge::Json(serde_json::Value::Array(a)),
        serde_json::Value::Object(map) => {
            // Date
            if let Some(ms) = map.get("__date").and_then(|v| v.as_f64()) {
                return JsValueBridge::DateMs(ms);
            }
            // Bytes
            if let Some(bytes) = map.get("__bytes").and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(bytes.len());
                for b in bytes {
                    if let Some(n) = b.as_u64() {
                        out.push((n & 0xFF) as u8);
                    } else {
                        return JsValueBridge::Json(serde_json::Value::Object(map));
                    }
                }
                return JsValueBridge::Bytes(out);
            }
            // V8 structured clone bytes
            if let Some(bytes) = map.get("__v8").and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(bytes.len());
                for b in bytes {
                    if let Some(n) = b.as_u64() {
                        out.push((n & 0xFF) as u8);
                    } else {
                        return JsValueBridge::Json(serde_json::Value::Object(map));
                    }
                }
                return JsValueBridge::V8Serialized(out);
            }

            // Tagged error
            if map.get("__denojs_worker_type").and_then(|v| v.as_str()) == Some("error") {
                let name = map
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Error")
                    .to_string();
                let message = map
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let stack = map
                    .get("stack")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let code = map
                    .get("code")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                return JsValueBridge::Error {
                    name,
                    message,
                    stack,
                    code,
                };
            }

            // Tagged function
            if map.get("__denojs_worker_type").and_then(|v| v.as_str()) == Some("function") {
                if let Some(id) = map.get("id").and_then(|v| v.as_u64()) {
                    let is_async = map.get("async").and_then(|v| v.as_bool()).unwrap_or(false);
                    return JsValueBridge::HostFunction {
                        id: id as usize,
                        is_async,
                    };
                }
            }

            JsValueBridge::Json(serde_json::Value::Object(map))
        }
    }
}
