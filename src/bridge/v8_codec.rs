use super::types::JsValueBridge;
use deno_core::v8::ValueDeserializerHelper;
use deno_core::v8::ValueSerializerHelper;
use deno_runtime::deno_core::{self, v8};

fn json_to_v8<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    v: &serde_json::Value,
) -> Result<v8::Local<'s, v8::Value>, &'static str> {
    use serde_json::Value;

    match v {
        Value::Null => Ok(v8::null(ps).into()),
        Value::Bool(b) => Ok(v8::Boolean::new(ps, *b).into()),
        Value::Number(n) => {
            // Force JS Number, never BigInt.
            let f = n
                .as_f64()
                .ok_or("json_to_v8: number not representable as f64")?;

            // Preserve -0 if it survived as f64 (rare, since serde_json can’t represent -0 distinctly),
            // but keep it anyway for completeness.
            if f == 0.0 && f.is_sign_negative() {
                return Ok(v8::Number::new(ps, -0.0).into());
            }

            Ok(v8::Number::new(ps, f).into())
        }
        Value::String(s) => Ok(v8::String::new(ps, s)
            .ok_or("json_to_v8: alloc string failed")?
            .into()),
        Value::Array(arr) => {
            let out = v8::Array::new(ps, arr.len() as i32);
            for (i, item) in arr.iter().enumerate() {
                let vv = json_to_v8(ps, item)?;
                out.set_index(ps, i as u32, vv);
            }
            Ok(out.into())
        }
        Value::Object(map) => {
            // Special-case your -0 marker: { "__denojs_worker_num": "-0" }
            if let Some(tag) = map.get("__denojs_worker_num") {
                if tag.as_str() == Some("-0") {
                    return Ok(v8::Number::new(ps, -0.0).into());
                }
            }

            let obj = v8::Object::new(ps);
            for (k, val) in map.iter() {
                let kk = v8::String::new(ps, k).ok_or("json_to_v8: alloc key failed")?;
                let vv = json_to_v8(ps, val)?;
                obj.set(ps, kk.into(), vv);
            }
            Ok(obj.into())
        }
    }
}

pub fn to_v8<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    value: &JsValueBridge,
) -> Result<v8::Local<'s, v8::Value>, String> {
    match value {
        JsValueBridge::Undefined => Ok(v8::undefined(ps).into()),
        JsValueBridge::Null => Ok(v8::null(ps).into()),
        JsValueBridge::Bool(v) => Ok(v8::Boolean::new(ps, *v).into()),
        JsValueBridge::Number(v) => Ok(v8::Number::new(ps, *v).into()),
        JsValueBridge::String(v) => Ok(v8::String::new(ps, v).ok_or("alloc string failed")?.into()),
        JsValueBridge::DateMs(ms) => Ok(v8::Date::new(ps, *ms).ok_or("date create failed")?.into()),
        JsValueBridge::Bytes(bytes) => {
            let bs = v8::ArrayBuffer::new_backing_store_from_boxed_slice(
                bytes.clone().into_boxed_slice(),
            )
            .make_shared();
            let ab = v8::ArrayBuffer::with_backing_store(ps, &bs);
            let arr = v8::Uint8Array::new(ps, ab, 0, bytes.len()).ok_or("uint8 create failed")?;
            Ok(arr.into())
        }
        JsValueBridge::Json(v) => json_to_v8(ps, v).map_err(|e| e.to_string()),
        JsValueBridge::V8Serialized(bytes) => {
            struct D;
            impl v8::ValueDeserializerImpl for D {}
            let d = v8::ValueDeserializer::new(ps, Box::new(D), bytes);
            let ctx = ps.get_current_context();
            let _ = d.read_header(ctx);
            d.read_value(ctx).ok_or("deserialize failed".into())
        }
        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
        } => {
            let msg = v8::String::new(ps, message).ok_or("err msg alloc failed")?;
            let ex = v8::Exception::error(ps, msg);
            let obj = ex.to_object(ps).ok_or("error object failed")?;
            set_opt_str(ps, obj, "name", Some(name.as_str()));
            set_opt_str(ps, obj, "stack", stack.as_deref());
            set_opt_str(ps, obj, "code", code.as_deref());
            Ok(obj.into())
        }
        JsValueBridge::HostFunction { id, is_async } => {
            let v = serde_json::json!({
                "__denojs_worker_type": "function",
                "id": id,
                "async": is_async,
            });
            deno_runtime::deno_core::serde_v8::to_v8(ps, v).map_err(|e| e.to_string())
        }
    }
}

fn v8_to_serde_json<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    value: v8::Local<'s, v8::Value>,
    depth: usize,
) -> Result<serde_json::Value, String> {
    // Prevent runaway recursion on pathological inputs.
    if depth > 200 {
        return Err("v8_to_serde_json: max depth exceeded".into());
    }

    if value.is_null() || value.is_undefined() {
        return Ok(serde_json::Value::Null);
    }

    if value.is_boolean() {
        return Ok(serde_json::Value::Bool(value.is_true()));
    }

    if value.is_number() {
        let n = value
            .to_number(ps)
            .ok_or("v8_to_serde_json: number conversion failed")?
            .value();

        // Preserve -0 using your existing marker convention.
        if n == 0.0 && n.is_sign_negative() {
            return Ok(serde_json::json!({ "__denojs_worker_num": "-0" }));
        }

        // Preserve JS number semantics (including unsafe integers) as JSON numbers.
        // serde_json rejects NaN/Infinity, but jsonValue() won't produce them.
        let num = serde_json::Number::from_f64(n).ok_or("v8_to_serde_json: non-finite number")?;
        return Ok(serde_json::Value::Number(num));
    }

    if value.is_string() {
        return Ok(serde_json::Value::String(value.to_rust_string_lossy(ps)));
    }

    if value.is_array() {
        let arr = value.cast::<v8::Array>();
        let len = arr.length();
        let mut out = Vec::with_capacity(len as usize);
        for i in 0..len {
            let v = arr
                .get_index(ps, i)
                .ok_or("v8_to_serde_json: array get_index failed")?;
            out.push(v8_to_serde_json(ps, v, depth + 1)?);
        }
        return Ok(serde_json::Value::Array(out));
    }

    // Treat any other object as a plain object with string keys.
    if value.is_object() {
        let obj = value
            .to_object(ps)
            .ok_or("v8_to_serde_json: to_object failed")?;

        let args = v8::GetPropertyNamesArgs::default();
        let keys = obj
            .get_own_property_names(ps, args)
            .ok_or("v8_to_serde_json: get_own_property_names failed")?;

        let klen = keys.length();
        let mut map = serde_json::Map::with_capacity(klen as usize);

        for i in 0..klen {
            let k = keys
                .get_index(ps, i)
                .ok_or("v8_to_serde_json: keys get_index failed")?;

            // JSON keys must be strings. Skip non-string keys.
            if !k.is_string() {
                continue;
            }

            let key = k.to_rust_string_lossy(ps);

            let v = obj.get(ps, k).ok_or("v8_to_serde_json: obj.get failed")?;

            map.insert(key, v8_to_serde_json(ps, v, depth + 1)?);
        }

        return Ok(serde_json::Value::Object(map));
    }

    // Anything else is not JSON-serializable (symbol, bigint, function, etc).
    Err("v8_to_serde_json: unsupported type".into())
}

fn set_opt_str<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    obj: v8::Local<'s, v8::Object>,
    key: &str,
    val: Option<&str>,
) {
    if let Some(v) = val {
        if let (Some(k), Some(s)) = (v8::String::new(ps, key), v8::String::new(ps, v)) {
            let _ = obj.set(ps, k.into(), s.into());
        }
    }
}

pub fn from_v8<'s, 'p>(
    ps: &mut v8::PinScope<'s, 'p>,
    value: v8::Local<'s, v8::Value>,
) -> Result<JsValueBridge, String> {
    if value.is_undefined() {
        return Ok(JsValueBridge::Undefined);
    }
    if value.is_null() {
        return Ok(JsValueBridge::Null);
    }
    if value.is_boolean() {
        return Ok(JsValueBridge::Bool(value.is_true()));
    }
    if value.is_big_int() {
        let bi = value.cast::<v8::BigInt>();
        let (i64_val, lossless) = bi.i64_value();
        if lossless {
            return Ok(JsValueBridge::Number(i64_val as f64));
        }
        // Best-effort: represent as f64 (may lose precision), but don’t silently become Undefined.
        let (u64_val, lossless_u) = bi.u64_value();
        if lossless_u {
            return Ok(JsValueBridge::Number(u64_val as f64));
        }
        return Err("bigint conversion failed".into());
    }

    if value.is_number() {
        return Ok(JsValueBridge::Number(
            value.to_number(ps).ok_or("num conv failed")?.value(),
        ));
    }
    if value.is_string() {
        return Ok(JsValueBridge::String(value.to_rust_string_lossy(ps)));
    }
    if value.is_date() {
        let d = value.cast::<v8::Date>();
        return Ok(JsValueBridge::DateMs(d.value_of()));
    }
    if value.is_uint8_array() {
        let a = value.cast::<v8::Uint8Array>();
        let mut buf = vec![0u8; a.byte_length()];
        a.copy_contents(&mut buf);
        return Ok(JsValueBridge::Bytes(buf));
    }

    if value.is_native_error() {
        let obj = value.to_object(ps).ok_or("error obj conv failed")?;
        let name = get_string_prop(ps, obj, "name").unwrap_or_else(|| "Error".into());
        let message = get_string_prop(ps, obj, "message").unwrap_or_default();
        let stack = get_string_prop(ps, obj, "stack");
        let code = get_string_prop(ps, obj, "code");
        return Ok(JsValueBridge::Error {
            name,
            message,
            stack,
            code,
        });
    }

    // Prefer plain JSON for objects/arrays
    // Prefer plain JSON for objects/arrays
    if value.is_object() {
        // 1) Fast path: serde_v8
        if let Ok(j) = deno_runtime::deno_core::serde_v8::from_v8::<serde_json::Value>(ps, value) {
            return Ok(JsValueBridge::Json(j));
        }

        // 2) Robust fallback: manual JSON conversion (handles unsafe integers as JS numbers)
        if let Ok(j) = v8_to_serde_json(ps, value, 0) {
            return Ok(JsValueBridge::Json(j));
        }

        // 3) Last resort: v8 structured clone (requires Node globalThis.__v8 to round-trip)
        struct S;
        impl v8::ValueSerializerImpl for S {
            fn throw_data_clone_error<'a>(
                &self,
                scope: &mut v8::PinnedRef<'a, v8::HandleScope<'_>>,
                msg: v8::Local<'a, v8::String>,
            ) {
                let ex = v8::Exception::error(scope, msg);
                scope.throw_exception(ex);
            }
        }
        let s = v8::ValueSerializer::new(ps, Box::new(S));
        s.write_header();
        let ctx = ps.get_current_context();
        if s.write_value(ctx, value).unwrap_or(false) {
            return Ok(JsValueBridge::V8Serialized(s.release()));
        }
    }

    Ok(JsValueBridge::Undefined)
}

fn get_string_prop<'s, 'p>(
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
