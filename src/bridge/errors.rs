use crate::bridge::types::JsValueBridge;

/// Error.
pub fn error(name: impl Into<String>, message: impl Into<String>) -> JsValueBridge {
    JsValueBridge::Error {
        name: name.into(),
        message: message.into(),
        stack: None,
        code: None,
        cause: None,
    }
}

/// Host function error.
pub fn host_function_error(message: impl Into<String>) -> JsValueBridge {
    error("HostFunctionError", message)
}
