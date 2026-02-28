use neon::result::Throw;
use neon::types::buffer::TypedArray;
use neon::{prelude::*, types::JsDate};

use super::types::JsValueBridge;
use crate::worker::messages::EvalReply;

fn get_string_prop<'a, C: Context<'a>>(
    cx: &mut C,
    obj: Handle<'a, JsObject>,
    key: &str,
) -> Option<String> {
    let v = obj.get_value(cx, key).ok()?;
    let s = v.downcast::<JsString, _>(cx).ok()?;
    Some(s.value(cx))
}

pub fn from_neon_value<'a, C: Context<'a>>(
    cx: &mut C,
    value: Handle<'a, JsValue>,
) -> Result<JsValueBridge, Throw> {
    if value.is_a::<JsUndefined, _>(cx) {
        return Ok(JsValueBridge::Undefined);
    }
    if value.is_a::<JsNull, _>(cx) {
        return Ok(JsValueBridge::Null);
    }

    if let Ok(v) = value.downcast::<JsBoolean, _>(cx) {
        return Ok(JsValueBridge::Bool(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsNumber, _>(cx) {
        return Ok(JsValueBridge::Number(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsString, _>(cx) {
        return Ok(JsValueBridge::String(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsDate, _>(cx) {
        return Ok(JsValueBridge::DateMs(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsBuffer, _>(cx) {
        return Ok(JsValueBridge::Bytes(v.as_slice(cx).to_vec()));
    }

    if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
        // Robust Error duck-typing to catch JSDOM / VM Context Errors from Jest
        let is_native_err = value.is_a::<neon::types::JsError, _>(cx);
        let name_opt = get_string_prop(cx, obj, "name");
        let is_error_name = name_opt.as_deref().unwrap_or("").ends_with("Error");
        let has_message = obj
            .get_value(cx, "message")
            .map(|v| v.is_a::<JsString, _>(cx))
            .unwrap_or(false);
        let has_stack = obj
            .get_value(cx, "stack")
            .map(|v| v.is_a::<JsString, _>(cx))
            .unwrap_or(false);

        if is_native_err || (is_error_name && (has_message || has_stack)) {
            return Ok(JsValueBridge::Error {
                name: name_opt.unwrap_or_else(|| "Error".into()),
                message: get_string_prop(cx, obj, "message").unwrap_or_default(),
                stack: get_string_prop(cx, obj, "stack"),
                code: get_string_prop(cx, obj, "code"),
            });
        }
    }

    if value.is_a::<JsArray, _>(cx) || value.is_a::<JsObject, _>(cx) {
        let json = cx.global::<JsObject>("JSON")?;
        let stringify = json.get::<JsFunction, _, _>(cx, "stringify")?;
        let replacer = JsFunction::new(cx, |mut cx| {
            let v = cx.argument::<JsValue>(1)?;
            if let Ok(n) = v.downcast::<JsNumber, _>(&mut cx) {
                let f = n.value(&mut cx);
                if f == 0.0 && f.is_sign_negative() {
                    let marker = cx.empty_object();
                    let neg = cx.string("-0");
                    marker.set(&mut cx, "__denojs_worker_num", neg)?;
                    return Ok(marker.upcast());
                }
            }
            Ok(v)
        })?;

        if let Ok(s) = stringify
            .call_with(cx)
            .this(json)
            .arg(value)
            .arg(replacer)
            .apply::<JsString, _>(cx)
        {
            let parsed = serde_json::from_str::<serde_json::Value>(&s.value(cx))
                .unwrap_or(serde_json::Value::Null);
            return Ok(JsValueBridge::Json(parsed));
        }

        if let Ok(v8obj) = cx.global::<JsObject>("__v8") {
            if let Ok(ser) = v8obj.get::<JsFunction, _, _>(cx, "serialize") {
                if let Ok(buf_any) = ser.call_with(cx).arg(value).apply::<JsValue, _>(cx) {
                    if let Ok(buf) = buf_any.downcast::<JsBuffer, _>(cx) {
                        return Ok(JsValueBridge::V8Serialized(buf.as_slice(cx).to_vec()));
                    }
                }
            }
        }
        return Ok(JsValueBridge::Undefined);
    }
    Ok(JsValueBridge::Undefined)
}

pub fn to_neon_value<'a, C: Context<'a>>(
    cx: &mut C,
    value: &JsValueBridge,
) -> Result<Handle<'a, JsValue>, Throw> {
    match value {
        JsValueBridge::Undefined => Ok(cx.undefined().upcast()),
        JsValueBridge::Null => Ok(cx.null().upcast()),
        JsValueBridge::Bool(v) => Ok(cx.boolean(*v).upcast()),
        JsValueBridge::Number(v) => Ok(cx.number(*v).upcast()),
        JsValueBridge::String(v) => Ok(cx.string(v).upcast()),
        JsValueBridge::DateMs(ms) => {
            // Do not call cx.throw_* here. If Date construction fails, fall back to undefined.
            match cx.date(*ms) {
                Ok(d) => Ok(d.upcast()),
                Err(_) => Ok(cx.undefined().upcast()),
            }
        }
        JsValueBridge::Bytes(bytes) => {
            let mut b = JsBuffer::new(cx, bytes.len())?;
            b.as_mut_slice(cx).copy_from_slice(bytes);
            Ok(b.upcast())
        }
        JsValueBridge::Json(v) => {
            // Never let JSON.parse throw out of a Channel callback.
            let json_text = serde_json::to_string(v).unwrap_or_else(|_| "null".into());
            let s = cx.string(json_text);

            // Reviver: turn {"__denojs_worker_num":"-0"} back into -0.
            let reviver = JsFunction::new(cx, |mut cx| {
                let val = cx.argument::<JsValue>(1)?;

                if val.is_a::<JsObject, _>(&mut cx) {
                    let obj = val.downcast::<JsObject, _>(&mut cx).unwrap();
                    if let Ok(tag) = obj.get::<JsValue, _, _>(&mut cx, "__denojs_worker_num") {
                        if let Ok(tag_s) = tag.downcast::<JsString, _>(&mut cx) {
                            if tag_s.value(&mut cx) == "-0" {
                                return Ok(cx.number(-0.0).upcast());
                            }
                        }
                    }
                }

                Ok(val)
            })?;

            let parsed = cx
                .try_catch(|cx| {
                    let json = cx.global::<JsObject>("JSON")?;
                    let parse = json.get::<JsFunction, _, _>(cx, "parse")?;
                    parse
                        .call_with(cx)
                        .this(json)
                        .arg(s)
                        .arg(reviver)
                        .apply::<JsValue, _>(cx)
                })
                .ok();

            Ok(parsed.unwrap_or_else(|| cx.undefined().upcast()))
        }
        JsValueBridge::V8Serialized(bytes) => {
            let global = cx.global::<JsObject>("globalThis")?;
            let v8_any: Handle<JsValue> = match global.get_value(cx, "__v8") {
                Ok(v) => v,
                Err(_) => return Ok(cx.undefined().upcast()),
            };

            if !v8_any.is_a::<JsObject, _>(cx) {
                return Ok(cx.undefined().upcast());
            }
            let v8obj = v8_any.downcast::<JsObject, _>(cx).unwrap();

            let deser_any: Handle<JsValue> = match v8obj.get_value(cx, "deserialize") {
                Ok(v) => v,
                Err(_) => return Ok(cx.undefined().upcast()),
            };
            if !deser_any.is_a::<JsFunction, _>(cx) {
                return Ok(cx.undefined().upcast());
            }
            let deser = deser_any.downcast::<JsFunction, _>(cx).unwrap();

            let mut b = JsBuffer::new(cx, bytes.len())?;
            b.as_mut_slice(cx).copy_from_slice(bytes);

            deser
                .call_with(cx)
                .this(v8obj)
                .arg(b)
                .apply::<JsValue, _>(cx)
        }
        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
        } => {
            // Never assume the global Error constructor is sane (Jest can patch it).
            let obj: Handle<JsObject> = cx
                .try_catch(|cx| {
                    let err = cx.error(message)?;
                    Ok(err.upcast::<JsObject>())
                })
                .unwrap_or_else(|_| cx.empty_object());

            // Force message/name to be enumerable so Jest matchers see them.
            if let (Ok(object_ctor), Ok(define_prop)) = (
                cx.global::<JsFunction>("Object"),
                cx.global::<JsObject>("Object")
                    .and_then(|o| o.get::<JsFunction, _, _>(cx, "defineProperty")),
            ) {
                let define = define_prop;

                let define_enum = |cx: &mut C, key: &str, val: Handle<JsValue>| {
                    let desc = cx.empty_object();
                    let true_bool = cx.boolean(true);
                    let key = cx.string(key).upcast();
                    let _ = desc.set(cx, "value", val);
                    let _ = desc.set(cx, "enumerable", true_bool);
                    let _ = desc.set(cx, "configurable", true_bool);
                    let _ = desc.set(cx, "writable", true_bool);
                    let _ = define.call(cx, object_ctor, &[obj.upcast(), key, desc.upcast()]);
                };

                let msg = cx.string(message).upcast();
                let name = cx.string(name).upcast();
                
                define_enum(cx, "message", msg);
                define_enum(cx, "name", name);

                if let Some(stack) = stack {
                    let stack = cx.string(stack).upcast();
                    define_enum(cx, "stack", stack);
                }
                if let Some(code) = code {
                    let code = cx.string(code).upcast();
                    define_enum(cx, "code", code);
                }
            } else {
                let msg = cx.string(message);
                let name = cx.string(name);
                let _ = obj.set(cx, "message", msg);
                let _ = obj.set(cx, "name", name);
                if let Some(stack) = stack {
                    let stack = cx.string(stack);
                    let _ = obj.set(cx, "stack", stack);
                }
                if let Some(code) = code {
                    let code = cx.string(code);
                    let _ = obj.set(cx, "code", code);
                }
            }

            Ok(obj.upcast())
        }
        JsValueBridge::HostFunction { .. } => Ok(cx.undefined().upcast()),
    }
}

pub fn eval_result_to_neon<'a>(
    cx: &mut FunctionContext<'a>,
    reply: EvalReply,
) -> JsResult<'a, JsValue> {
    match reply {
        EvalReply::Ok { value, .. } => to_neon_value(cx, &value),
        EvalReply::Err { error, .. } => {
            let err_val = to_neon_value(cx, &error)?;
            cx.throw(err_val)
        }
    }
}
