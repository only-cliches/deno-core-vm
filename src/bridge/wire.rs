use crate::bridge::tags::{
    BIGINT_KEY, BUFFER_KEY, DATE_KEY, MAP_KEY, NUMBER_KEY, NUMBER_NEG_ZERO_KEY, REGEXP_KEY,
    SET_KEY, TYPE_ERROR, TYPE_FUNCTION, TYPE_KEY, UNDEFINED_KEY, URL_KEY, URL_SEARCH_PARAMS_KEY,
    V8_KEY,
};
use crate::bridge::types::JsValueBridge;
use bytes::Bytes;

// Decodes special number tag from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_special_number_tag(tag: &str) -> Option<f64> {
    match tag {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

// Parses u8 array from input data and validates it for bridge encoding/decoding between Rust, V8, and Neon.
fn parse_u8_array(items: &[serde_json::Value]) -> Option<Bytes> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let n = item.as_u64()?;
        out.push((n & 0xFF) as u8);
    }
    Some(Bytes::from(out))
}

// Decodes error object from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_error_object(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Option<JsValueBridge> {
    if map.get(TYPE_KEY).and_then(|v| v.as_str()) != Some(TYPE_ERROR) {
        return None;
    }

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
    let cause = map.get("cause").cloned().and_then(|v| {
        if v.is_null() {
            None
        } else {
            Some(Box::new(from_wire_json(v)))
        }
    });

    Some(JsValueBridge::Error {
        name,
        message,
        stack,
        code,
        cause,
    })
}

// Decodes host function object from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_host_function_object(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Option<JsValueBridge> {
    if map.get(TYPE_KEY).and_then(|v| v.as_str()) != Some(TYPE_FUNCTION) {
        return None;
    }
    let id = map.get("id").and_then(|v| v.as_u64())?;
    let is_async = map.get("async").and_then(|v| v.as_bool()).unwrap_or(false);
    Some(JsValueBridge::HostFunction {
        id: id as usize,
        is_async,
    })
}

// Decodes buffer view object from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_buffer_view_object(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Option<Result<JsValueBridge, ()>> {
    let obj = map.get(BUFFER_KEY)?.as_object()?;
    let kind = obj
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("Uint8Array")
        .to_string();
    let byte_offset = obj.get("byteOffset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let requested_length = obj.get("length").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let bytes_arr = obj.get("bytes").and_then(|v| v.as_array())?;
    let Some(bytes) = parse_u8_array(bytes_arr) else {
        return Some(Err(()));
    };
    // Never trust caller-supplied offset/length blindly; clamp to actual byte payload.
    let safe_byte_offset = byte_offset.min(bytes.len());
    let max_len = bytes.len().saturating_sub(safe_byte_offset);
    let safe_length = requested_length.min(max_len);

    Some(Ok(JsValueBridge::BufferView {
        kind,
        bytes,
        byte_offset: safe_byte_offset,
        length: safe_length,
    }))
}

// Decodes v8 serialized object from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_v8_serialized_object(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Option<Result<JsValueBridge, ()>> {
    let bytes_arr = map.get(V8_KEY)?.as_array()?;
    let Some(bytes) = parse_u8_array(bytes_arr) else {
        return Some(Err(()));
    };
    Some(Ok(JsValueBridge::V8Serialized(bytes.to_vec())))
}

// Decodes map entries from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_map_entries(items: &[serde_json::Value]) -> JsValueBridge {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(pair) = item.as_array() else {
            continue;
        };
        if pair.len() != 2 {
            continue;
        }
        out.push((from_wire_json(pair[0].clone()), from_wire_json(pair[1].clone())));
    }
    JsValueBridge::Map(out)
}

// Decodes set items from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
fn decode_set_items(items: &[serde_json::Value]) -> JsValueBridge {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(from_wire_json(item.clone()));
    }
    JsValueBridge::Set(out)
}

/// Canonical "wire" JSON format used between Rust and the Deno runtime bootstrap hydration layer.
/// This must stay stable, because bootstrap.js depends on these tags.
pub fn to_wire_json(v: &JsValueBridge) -> serde_json::Value {
    match v {
        JsValueBridge::Undefined => serde_json::json!({ UNDEFINED_KEY: true }),
        JsValueBridge::Null => serde_json::Value::Null,
        JsValueBridge::Bool(b) => serde_json::json!(b),

        JsValueBridge::Number(n) => {
            if n.is_nan() {
                serde_json::json!({ NUMBER_KEY: "NaN" })
            } else if *n == f64::INFINITY {
                serde_json::json!({ NUMBER_KEY: "Infinity" })
            } else if *n == f64::NEG_INFINITY {
                serde_json::json!({ NUMBER_KEY: "-Infinity" })
            } else if *n == 0.0 && n.is_sign_negative() {
                serde_json::json!({ NUMBER_NEG_ZERO_KEY: "-0" })
            } else if n.is_finite() {
                serde_json::json!(n)
            } else {
                // Fallback: should not happen, but never emit invalid JSON numbers.
                serde_json::json!({ UNDEFINED_KEY: true })
            }
        }

        JsValueBridge::String(s) => serde_json::json!(s),

        JsValueBridge::BigInt(s) => serde_json::json!({ BIGINT_KEY: s }),
        JsValueBridge::DateMs(ms) => serde_json::json!({ DATE_KEY: ms }),

        JsValueBridge::RegExp { source, flags } => serde_json::json!({
            REGEXP_KEY: { "source": source, "flags": flags }
        }),

        JsValueBridge::BufferView {
            kind,
            bytes,
            byte_offset,
            length,
        } => serde_json::json!({
            BUFFER_KEY: {
                "kind": kind,
                "bytes": bytes,
                "byteOffset": byte_offset,
                "length": length,
            }
        }),

        JsValueBridge::Map(entries) => serde_json::json!({
            MAP_KEY: entries
                .iter()
                .map(|(k, vv)| [to_wire_json(k), to_wire_json(vv)])
                .collect::<Vec<_>>()
        }),

        JsValueBridge::Set(items) => serde_json::json!({
            SET_KEY: items.iter().map(to_wire_json).collect::<Vec<_>>()
        }),

        JsValueBridge::Url { href } => serde_json::json!({ URL_KEY: href }),
        JsValueBridge::UrlSearchParams { query } => {
            serde_json::json!({ URL_SEARCH_PARAMS_KEY: query })
        }

        JsValueBridge::Json(j) => j.clone(),
        JsValueBridge::V8Serialized(b) => serde_json::json!({ V8_KEY: b }),

        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
            cause,
        } => serde_json::json!({
            TYPE_KEY: TYPE_ERROR,
            "name": name,
            "message": message,
            "stack": stack,
            "code": code,
            "cause": cause.as_ref().map(|c| to_wire_json(c)),
        }),

        JsValueBridge::HostFunction { id, is_async } => serde_json::json!({
            TYPE_KEY: TYPE_FUNCTION,
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

        serde_json::Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f == 0.0 && f.is_sign_negative() {
                JsValueBridge::Number(-0.0)
            } else {
                JsValueBridge::Number(f)
            }
        }

        serde_json::Value::String(s) => JsValueBridge::String(s),

        serde_json::Value::Array(a) => JsValueBridge::Json(serde_json::Value::Array(a)),

        serde_json::Value::Object(map) => {
            if map.get(UNDEFINED_KEY).and_then(|v| v.as_bool()) == Some(true) {
                return JsValueBridge::Undefined;
            }

            if map.get(NUMBER_NEG_ZERO_KEY).and_then(|x| x.as_str()) == Some("-0") {
                return JsValueBridge::Number(-0.0);
            }

            if let Some(tag) = map.get(NUMBER_KEY).and_then(|v| v.as_str()) {
                return decode_special_number_tag(tag)
                    .map(JsValueBridge::Number)
                    .unwrap_or(JsValueBridge::Undefined);
            }

            if let Some(ms) = map.get(DATE_KEY).and_then(|v| v.as_f64()) {
                return JsValueBridge::DateMs(ms);
            }

            if let Some(s) = map.get(BIGINT_KEY).and_then(|v| v.as_str()) {
                return JsValueBridge::BigInt(s.to_string());
            }

            if let Some(obj) = map.get(REGEXP_KEY).and_then(|v| v.as_object()) {
                let source = obj
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let flags = obj
                    .get("flags")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                return JsValueBridge::RegExp { source, flags };
            }

            if let Some(decoded) = decode_buffer_view_object(&map) {
                match decoded {
                    Ok(val) => return val,
                    Err(()) => return JsValueBridge::Json(serde_json::Value::Object(map)),
                }
            }

            if let Some(arr) = map.get(MAP_KEY).and_then(|v| v.as_array()) {
                return decode_map_entries(arr);
            }

            if let Some(arr) = map.get(SET_KEY).and_then(|v| v.as_array()) {
                return decode_set_items(arr);
            }

            if let Some(href) = map.get(URL_KEY).and_then(|v| v.as_str()) {
                return JsValueBridge::Url {
                    href: href.to_string(),
                };
            }

            if let Some(q) = map.get(URL_SEARCH_PARAMS_KEY).and_then(|v| v.as_str()) {
                return JsValueBridge::UrlSearchParams {
                    query: q.to_string(),
                };
            }

            if let Some(decoded) = decode_v8_serialized_object(&map) {
                match decoded {
                    Ok(val) => return val,
                    Err(()) => return JsValueBridge::Json(serde_json::Value::Object(map)),
                }
            }

            if let Some(err) = decode_error_object(&map) {
                return err;
            }

            if let Some(host_fn) = decode_host_function_object(&map) {
                return host_fn;
            }

            JsValueBridge::Json(serde_json::Value::Object(map))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_buffer_view_object, decode_error_object, decode_host_function_object,
        decode_map_entries, decode_set_items, decode_special_number_tag,
        decode_v8_serialized_object, from_wire_json, parse_u8_array, to_wire_json,
    };
    use crate::bridge::tags::{
        BUFFER_KEY, MAP_KEY, NUMBER_KEY, REGEXP_KEY, SET_KEY, TYPE_ERROR, TYPE_FUNCTION,
        TYPE_KEY, V8_KEY,
    };
    use crate::bridge::types::JsValueBridge;

    // Assert number eq.
    fn assert_number_eq(actual: f64, expected: f64) {
        if expected.is_nan() {
            assert!(actual.is_nan(), "expected NaN, got {}", actual);
            return;
        }
        if expected == 0.0 && expected.is_sign_negative() {
            assert!(
                actual == 0.0 && actual.is_sign_negative(),
                "expected -0, got {}",
                actual
            );
            return;
        }
        assert_eq!(actual, expected);
    }

    // Assert bridge eq.
    fn assert_bridge_eq(actual: JsValueBridge, expected: JsValueBridge) {
        match (actual, expected) {
            (JsValueBridge::Undefined, JsValueBridge::Undefined)
            | (JsValueBridge::Null, JsValueBridge::Null) => {}

            (JsValueBridge::Bool(a), JsValueBridge::Bool(b)) => assert_eq!(a, b),
            (JsValueBridge::String(a), JsValueBridge::String(b)) => assert_eq!(a, b),
            (JsValueBridge::Number(a), JsValueBridge::Number(b)) => assert_number_eq(a, b),
            (JsValueBridge::BigInt(a), JsValueBridge::BigInt(b)) => assert_eq!(a, b),
            (JsValueBridge::DateMs(a), JsValueBridge::DateMs(b)) => assert_eq!(a, b),
            (
                JsValueBridge::RegExp {
                    source: asrc,
                    flags: aflags,
                },
                JsValueBridge::RegExp {
                    source: bsrc,
                    flags: bflags,
                },
            ) => {
                assert_eq!(asrc, bsrc);
                assert_eq!(aflags, bflags);
            }
            (
                JsValueBridge::BufferView {
                    kind: ak,
                    bytes: ab,
                    byte_offset: abo,
                    length: al,
                },
                JsValueBridge::BufferView {
                    kind: bk,
                    bytes: bb,
                    byte_offset: bbo,
                    length: bl,
                },
            ) => {
                assert_eq!(ak, bk);
                assert_eq!(ab, bb);
                assert_eq!(abo, bbo);
                assert_eq!(al, bl);
            }
            (JsValueBridge::Map(a), JsValueBridge::Map(b)) => {
                assert_eq!(a.len(), b.len());
                for (ap, bp) in a.into_iter().zip(b.into_iter()) {
                    assert_bridge_eq(ap.0, bp.0);
                    assert_bridge_eq(ap.1, bp.1);
                }
            }
            (JsValueBridge::Set(a), JsValueBridge::Set(b)) => {
                assert_eq!(a.len(), b.len());
                for (av, bv) in a.into_iter().zip(b.into_iter()) {
                    assert_bridge_eq(av, bv);
                }
            }
            (JsValueBridge::Url { href: a }, JsValueBridge::Url { href: b }) => {
                assert_eq!(a, b);
            }
            (
                JsValueBridge::UrlSearchParams { query: a },
                JsValueBridge::UrlSearchParams { query: b },
            ) => {
                assert_eq!(a, b);
            }
            (JsValueBridge::Json(a), JsValueBridge::Json(b)) => assert_eq!(a, b),
            (JsValueBridge::V8Serialized(a), JsValueBridge::V8Serialized(b)) => assert_eq!(a, b),
            (
                JsValueBridge::HostFunction {
                    id: aid,
                    is_async: aa,
                },
                JsValueBridge::HostFunction {
                    id: bid,
                    is_async: ba,
                },
            ) => {
                assert_eq!(aid, bid);
                assert_eq!(aa, ba);
            }
            (
                JsValueBridge::Error {
                    name: an,
                    message: am,
                    stack: ast,
                    code: ac,
                    cause: acause,
                },
                JsValueBridge::Error {
                    name: bn,
                    message: bm,
                    stack: bst,
                    code: bc,
                    cause: bcause,
                },
            ) => {
                assert_eq!(an, bn);
                assert_eq!(am, bm);
                assert_eq!(ast, bst);
                assert_eq!(ac, bc);
                match (acause, bcause) {
                    (Some(a), Some(b)) => assert_bridge_eq(*a, *b),
                    (None, None) => {}
                    (a, b) => panic!("cause mismatch: {:?} vs {:?}", a, b),
                }
            }
            (a, b) => panic!("bridge mismatch: {:?} vs {:?}", a, b),
        }
    }

    #[test]
    // Round trips special numbers and undefined.
    fn round_trips_special_numbers_and_undefined() {
        for val in [
            JsValueBridge::Undefined,
            JsValueBridge::Number(-0.0),
            JsValueBridge::Number(f64::NAN),
            JsValueBridge::Number(f64::INFINITY),
            JsValueBridge::Number(f64::NEG_INFINITY),
            JsValueBridge::Number(42.5),
        ] {
            let out = from_wire_json(to_wire_json(&val));
            assert_bridge_eq(out, val);
        }
    }

    #[test]
    // Round trips structured values.
    fn round_trips_structured_values() {
        let val = JsValueBridge::Map(vec![
            (
                JsValueBridge::String("k".into()),
                JsValueBridge::Set(vec![
                    JsValueBridge::DateMs(1700000000000.0),
                    JsValueBridge::BigInt("9007199254740993".into()),
                    JsValueBridge::BufferView {
                        kind: "Uint8Array".into(),
                        bytes: bytes::Bytes::from(vec![1, 2, 3, 255]).into(),
                        byte_offset: 0,
                        length: 4,
                    },
                ]),
            ),
            (
                JsValueBridge::Bool(true),
                JsValueBridge::RegExp {
                    source: "ab+".into(),
                    flags: "gi".into(),
                },
            ),
        ]);

        let out = from_wire_json(to_wire_json(&val));
        assert_bridge_eq(out, val);
    }

    #[test]
    // Round trips error and host fn.
    fn round_trips_error_and_host_fn() {
        let val = JsValueBridge::Error {
            name: "TypeError".into(),
            message: "boom".into(),
            stack: Some("stack".into()),
            code: Some("E_BANG".into()),
            cause: Some(Box::new(JsValueBridge::HostFunction {
                id: 12,
                is_async: true,
            })),
        };
        let out = from_wire_json(to_wire_json(&val));
        assert_bridge_eq(out, val);
    }

    #[test]
    // Preserves plain json objects as json variant.
    fn preserves_plain_json_objects_as_json_variant() {
        let j = serde_json::json!({
            "a": 1,
            "b": [true, null, "x"],
            "nested": { "k": "v" }
        });
        let out = from_wire_json(j.clone());
        assert_bridge_eq(out, JsValueBridge::Json(j));
    }

    #[test]
    // Invalid number tag decodes to undefined.
    fn invalid_number_tag_decodes_to_undefined() {
        let out = from_wire_json(serde_json::json!({ NUMBER_KEY: "not-supported" }));
        assert_bridge_eq(out, JsValueBridge::Undefined);
    }

    #[test]
    // Malformed buffer falls back to json.
    fn malformed_buffer_falls_back_to_json() {
        let raw = serde_json::json!({
            BUFFER_KEY: {
                "kind": "Uint8Array",
                "bytes": [1, "bad", 3],
                "byteOffset": 0,
                "length": 3
            }
        });
        let out = from_wire_json(raw.clone());
        assert_bridge_eq(out, JsValueBridge::Json(raw));
    }

    #[test]
    // Malformed host function falls back to json.
    fn malformed_host_function_falls_back_to_json() {
        let raw = serde_json::json!({
            TYPE_KEY: TYPE_FUNCTION,
            "async": true
        });
        let out = from_wire_json(raw.clone());
        assert_bridge_eq(out, JsValueBridge::Json(raw));
    }

    #[test]
    // Map decoder ignores non pair entries.
    fn map_decoder_ignores_non_pair_entries() {
        let raw = serde_json::json!({
            MAP_KEY: [
                ["k1", 1],
                ["missing_value_only"],
                "not-an-array",
                [true, false, "extra"]
            ]
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(
            out,
            JsValueBridge::Map(vec![(
                JsValueBridge::String("k1".into()),
                JsValueBridge::Number(1.0),
            )]),
        );
    }

    #[test]
    // Sets decoder preserves item order and types state used by bridge encoding/decoding between Rust, V8, and Neon.
    fn set_decoder_preserves_item_order_and_types() {
        let raw = serde_json::json!({
            SET_KEY: [null, true, "x", { NUMBER_KEY: "Infinity" }]
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(
            out,
            JsValueBridge::Set(vec![
                JsValueBridge::Null,
                JsValueBridge::Bool(true),
                JsValueBridge::String("x".into()),
                JsValueBridge::Number(f64::INFINITY),
            ]),
        );
    }

    #[test]
    // Error decoder applies defaults when optional fields missing.
    fn error_decoder_applies_defaults_when_optional_fields_missing() {
        let raw = serde_json::json!({
            TYPE_KEY: TYPE_ERROR
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(
            out,
            JsValueBridge::Error {
                name: "Error".into(),
                message: "".into(),
                stack: None,
                code: None,
                cause: None,
            },
        );
    }

    #[test]
    // Malformed v8 payload falls back to json.
    fn malformed_v8_payload_falls_back_to_json() {
        let raw = serde_json::json!({
            V8_KEY: [1, 2, "bad", 4]
        });
        let out = from_wire_json(raw.clone());
        assert_bridge_eq(out, JsValueBridge::Json(raw));
    }

    #[test]
    // Host function defaults async to false when omitted.
    fn host_function_defaults_async_to_false_when_omitted() {
        let raw = serde_json::json!({
            TYPE_KEY: TYPE_FUNCTION,
            "id": 7
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(
            out,
            JsValueBridge::HostFunction {
                id: 7,
                is_async: false,
            },
        );
    }

    #[test]
    // Error decoder treats null cause as none.
    fn error_decoder_treats_null_cause_as_none() {
        let raw = serde_json::json!({
            TYPE_KEY: TYPE_ERROR,
            "name": "TypeError",
            "message": "boom",
            "cause": null
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(
            out,
            JsValueBridge::Error {
                name: "TypeError".into(),
                message: "boom".into(),
                stack: None,
                code: None,
                cause: None,
            },
        );
    }

    #[test]
    // Regexp decoder defaults missing source and flags.
    fn regexp_decoder_defaults_missing_source_and_flags() {
        let raw = serde_json::json!({
            REGEXP_KEY: {}
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(
            out,
            JsValueBridge::RegExp {
                source: "".into(),
                flags: "".into(),
            },
        );
    }

    #[test]
    // V8 decoder masks values to u8.
    fn v8_decoder_masks_values_to_u8() {
        let raw = serde_json::json!({
            V8_KEY: [0, 255, 256, 511]
        });
        let out = from_wire_json(raw);
        assert_bridge_eq(out, JsValueBridge::V8Serialized(vec![0, 255, 0, 255]));
    }

    #[test]
    // Decodes special number tag handles supported and unknown tags from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_special_number_tag_handles_supported_and_unknown_tags() {
        assert!(decode_special_number_tag("NaN").expect("NaN").is_nan());
        assert_eq!(decode_special_number_tag("Infinity"), Some(f64::INFINITY));
        assert_eq!(decode_special_number_tag("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(decode_special_number_tag("nope"), None);
    }

    #[test]
    // Parses u8 array parses and masks values from input data and validates it for bridge encoding/decoding between Rust, V8, and Neon.
    fn parse_u8_array_parses_and_masks_values() {
        let arr = vec![
            serde_json::json!(0),
            serde_json::json!(255),
            serde_json::json!(256),
            serde_json::json!(511),
        ];
        assert_eq!(
            parse_u8_array(&arr),
            Some(bytes::Bytes::from(vec![0, 255, 0, 255]))
        );
    }

    #[test]
    // Parses u8 array rejects non numeric entries from input data and validates it for bridge encoding/decoding between Rust, V8, and Neon.
    fn parse_u8_array_rejects_non_numeric_entries() {
        let arr = vec![serde_json::json!(1), serde_json::json!("bad"), serde_json::json!(3)];
        assert_eq!(parse_u8_array(&arr), None);
    }

    #[test]
    // Decodes error object parses error payloads from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_error_object_parses_error_payloads() {
        let map = serde_json::json!({
            TYPE_KEY: TYPE_ERROR,
            "name": "TypeError",
            "message": "boom",
            "stack": "stack",
            "code": "E_BANG",
            "cause": { NUMBER_KEY: "Infinity" }
        })
        .as_object()
        .cloned()
        .expect("object");
        let out = decode_error_object(&map).expect("decoded");
        assert_bridge_eq(
            out,
            JsValueBridge::Error {
                name: "TypeError".into(),
                message: "boom".into(),
                stack: Some("stack".into()),
                code: Some("E_BANG".into()),
                cause: Some(Box::new(JsValueBridge::Number(f64::INFINITY))),
            },
        );
    }

    #[test]
    // Decodes host function object parses and defaults async from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_host_function_object_parses_and_defaults_async() {
        let a = serde_json::json!({
            TYPE_KEY: TYPE_FUNCTION,
            "id": 9
        })
        .as_object()
        .cloned()
        .expect("object");
        let out_a = decode_host_function_object(&a).expect("decoded");
        assert_bridge_eq(
            out_a,
            JsValueBridge::HostFunction {
                id: 9,
                is_async: false,
            },
        );

        let b = serde_json::json!({
            TYPE_KEY: TYPE_FUNCTION,
            "id": 10,
            "async": true
        })
        .as_object()
        .cloned()
        .expect("object");
        let out_b = decode_host_function_object(&b).expect("decoded");
        assert_bridge_eq(
            out_b,
            JsValueBridge::HostFunction {
                id: 10,
                is_async: true,
            },
        );
    }

    #[test]
    // Decodes buffer view object parses valid payload from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_buffer_view_object_parses_valid_payload() {
        let map = serde_json::json!({
            BUFFER_KEY: {
                "kind": "Uint8Array",
                "bytes": [1, 2, 255, 256],
                "byteOffset": 0,
                "length": 4
            }
        })
        .as_object()
        .cloned()
        .expect("object");
        let out = decode_buffer_view_object(&map)
            .expect("tag")
            .expect("decode");
        assert_bridge_eq(
            out,
            JsValueBridge::BufferView {
                kind: "Uint8Array".into(),
                bytes: bytes::Bytes::from(vec![1, 2, 255, 0]),
                byte_offset: 0,
                length: 4,
            },
        );
    }

    #[test]
    // Ensures buffer-view decoder clamps byte offset and length to actual payload bounds.
    fn decode_buffer_view_object_clamps_offset_and_length() {
        let map = serde_json::json!({
            BUFFER_KEY: {
                "kind": "Uint8Array",
                "bytes": [1, 2, 3],
                "byteOffset": 10,
                "length": 999999
            }
        })
        .as_object()
        .cloned()
        .expect("object");
        let out = decode_buffer_view_object(&map)
            .expect("tag")
            .expect("decode");
        assert_bridge_eq(
            out,
            JsValueBridge::BufferView {
                kind: "Uint8Array".into(),
                bytes: bytes::Bytes::from(vec![1, 2, 3]),
                byte_offset: 3,
                length: 0,
            },
        );
    }

    #[test]
    // Decodes v8 serialized object parses valid payload from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_v8_serialized_object_parses_valid_payload() {
        let map = serde_json::json!({
            V8_KEY: [0, 255, 256]
        })
        .as_object()
        .cloned()
        .expect("object");
        let out = decode_v8_serialized_object(&map)
            .expect("tag")
            .expect("decode");
        assert_bridge_eq(out, JsValueBridge::V8Serialized(vec![0, 255, 0]));
    }

    #[test]
    // Decodes buffer and v8 objects return error on invalid bytes from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_buffer_and_v8_objects_return_error_on_invalid_bytes() {
        let bad_buf = serde_json::json!({
            BUFFER_KEY: {
                "kind": "Uint8Array",
                "bytes": [1, "bad", 3],
                "byteOffset": 0,
                "length": 3
            }
        })
        .as_object()
        .cloned()
        .expect("object");
        assert!(matches!(
            decode_buffer_view_object(&bad_buf),
            Some(Err(()))
        ));

        let bad_v8 = serde_json::json!({
            V8_KEY: [1, "bad", 3]
        })
        .as_object()
        .cloned()
        .expect("object");
        assert!(matches!(
            decode_v8_serialized_object(&bad_v8),
            Some(Err(()))
        ));
    }

    #[test]
    // Decodes map entries skips invalid pairs from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_map_entries_skips_invalid_pairs() {
        let out = decode_map_entries(&[
            serde_json::json!(["k", 1]),
            serde_json::json!(["only-one"]),
            serde_json::json!("not-array"),
            serde_json::json!([true, false, "extra"]),
        ]);
        assert_bridge_eq(
            out,
            JsValueBridge::Map(vec![(
                JsValueBridge::String("k".into()),
                JsValueBridge::Number(1.0),
            )]),
        );
    }

    #[test]
    // Decodes set items preserves order and value decoding from wire/serialized form for bridge encoding/decoding between Rust, V8, and Neon.
    fn decode_set_items_preserves_order_and_value_decoding() {
        let out = decode_set_items(&[
            serde_json::json!(null),
            serde_json::json!(true),
            serde_json::json!({ NUMBER_KEY: "Infinity" }),
        ]);
        assert_bridge_eq(
            out,
            JsValueBridge::Set(vec![
                JsValueBridge::Null,
                JsValueBridge::Bool(true),
                JsValueBridge::Number(f64::INFINITY),
            ]),
        );
    }
}
