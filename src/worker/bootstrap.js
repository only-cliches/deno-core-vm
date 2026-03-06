// src/worker/bootstrap.js
// Extension ESM entrypoint.

import * as coreMod from "ext:core/mod.js";
import {
  STREAM_BRIDGE_TAG,
  STREAM_TYPED_CHUNK_PREFIX,
  STREAM_TYPED_CONTROL_PREFIX,
  decodeStreamFrameEnvelope,
  decodeTypedStreamChunkMessage,
  decodeTypedStreamControlMessage,
  encodeStreamFrameEnvelope,
} from "../shared/stream-envelope.ts";

// Resolve the core API across Deno core versions and export shapes.
function getCoreApi() {
  try {
    if (globalThis.Deno && globalThis.Deno.core) return globalThis.Deno.core;
  } catch {
    // ignore
  }

  const imported = coreMod && typeof coreMod === "object" ? coreMod : null;
  if (imported && imported.core && typeof imported.core === "object") return imported.core;
  return imported;
}

const coreApi = getCoreApi();
const opsTable = coreApi && typeof coreApi === "object" ? coreApi.ops ?? null : null;

const coreOpSync =
  coreApi && typeof coreApi.opSync === "function" ? coreApi.opSync.bind(coreApi) : null;

const coreOpAsync =
  coreApi && typeof coreApi.opAsync === "function" ? coreApi.opAsync.bind(coreApi) : null;

function isThenable(x) {
  return x != null && (typeof x === "object" || typeof x === "function") && typeof x.then === "function";
}

function getOpEntry(name) {
  if (!opsTable) return { kind: "missing_ops_table", entry: undefined };
  try {
    if (!(name in opsTable)) return { kind: "missing", entry: undefined };
    const v = opsTable[name];
    const t = typeof v;
    if (t === "function") return { kind: "function", entry: v };
    if (t === "number") return { kind: "number", entry: v };
    return { kind: t, entry: v };
  } catch {
    return { kind: "error", entry: undefined };
  }
}

function callCapturedRaw(captured, name, ...args) {
  if (captured && captured.kind === "function" && typeof captured.entry === "function") {
    return captured.entry(...args);
  }

  if (captured && captured.kind === "number" && typeof captured.entry === "number") {
    if (typeof coreOpSync === "function") return coreOpSync(captured.entry, ...args);
  }

  const kind = captured ? captured.kind : "missing_capture";
  throw new Error(`${name} is unavailable (captured kind=${kind})`);
}

async function callCapturedAwait(captured, name, ...args) {
  if (
    (name === OP_STREAM_ACCEPT_ASYNC || name === OP_STREAM_READ_ASYNC || name === OP_STREAM_READ_ASYNC_RAW) &&
    typeof coreOpAsync === "function"
  ) {
    return await coreOpAsync(name, ...args);
  }
  if (captured && captured.kind === "function" && typeof captured.entry === "function") {
    const out = captured.entry(...args);
    if (isThenable(out)) return await out;
    // Some runtimes expose async ops as callable IDs/functions without thenables.
    if (
      (name === OP_STREAM_ACCEPT_ASYNC || name === OP_STREAM_READ_ASYNC || name === OP_STREAM_READ_ASYNC_RAW) &&
      typeof coreOpAsync === "function"
    ) {
      return await coreOpAsync(name, ...args);
    }
    return out;
  }

  if (captured && captured.kind === "number" && typeof captured.entry === "number") {
    if (typeof coreOpAsync === "function") return await coreOpAsync(captured.entry, ...args);
    if (typeof coreOpSync === "function") {
      const out = coreOpSync(captured.entry, ...args);
      return isThenable(out) ? await out : out;
    }
  }

  const kind = captured ? captured.kind : "missing_capture";
  throw new Error(`${name} is unavailable (captured kind=${kind})`);
}

// Unique op names to avoid collisions with built-in ops.
const OP_HOST_CALL_SYNC = "op_denojs_worker_host_call_sync";
const OP_HOST_CALL_ASYNC = "op_denojs_worker_host_call_async";
const OP_HOST_CALL_SYNC_BIN = "op_denojs_worker_host_call_sync_bin";
const OP_HOST_CALL_ASYNC_BIN = "op_denojs_worker_host_call_async_bin";
const OP_HOST_CALL_SYNC_BIN_MIXED = "op_denojs_worker_host_call_sync_bin_mixed";
const OP_HOST_CALL_ASYNC_BIN_MIXED = "op_denojs_worker_host_call_async_bin_mixed";
const OP_POST_MESSAGE = "op_denojs_worker_post_message";
const OP_POST_MESSAGE_BIN = "op_denojs_worker_post_message_bin";
const OP_ENV_GET = "op_denojs_worker_env_get";
const OP_ENV_SET = "op_denojs_worker_env_set";
const OP_ENV_DELETE = "op_denojs_worker_env_delete";
const OP_ENV_TO_OBJECT = "op_denojs_worker_env_to_object";
const OP_STREAM_ACCEPT = "op_denojs_worker_stream_accept";
const OP_STREAM_ACCEPT_ASYNC = "op_denojs_worker_stream_accept_async";
const OP_STREAM_READ = "op_denojs_worker_stream_read";
const OP_STREAM_READ_ASYNC = "op_denojs_worker_stream_read_async";
const OP_STREAM_READ_ASYNC_RAW = "op_denojs_worker_stream_read_async_raw";
const OP_STREAM_READ_RAW = "op_denojs_worker_stream_read_raw";
const OP_STREAM_TAKE_CHUNK = "op_denojs_worker_stream_take_chunk";
const OP_STREAM_DISCARD = "op_denojs_worker_stream_discard";

// Capture stable references at bootstrap time.
const CAP_HOST_CALL_SYNC = getOpEntry(OP_HOST_CALL_SYNC);
const CAP_HOST_CALL_ASYNC = getOpEntry(OP_HOST_CALL_ASYNC);
const CAP_HOST_CALL_SYNC_BIN = getOpEntry(OP_HOST_CALL_SYNC_BIN);
const CAP_HOST_CALL_ASYNC_BIN = getOpEntry(OP_HOST_CALL_ASYNC_BIN);
const CAP_HOST_CALL_SYNC_BIN_MIXED = getOpEntry(OP_HOST_CALL_SYNC_BIN_MIXED);
const CAP_HOST_CALL_ASYNC_BIN_MIXED = getOpEntry(OP_HOST_CALL_ASYNC_BIN_MIXED);
const CAP_POST_MESSAGE = getOpEntry(OP_POST_MESSAGE);
const CAP_POST_MESSAGE_BIN = getOpEntry(OP_POST_MESSAGE_BIN);
const CAP_ENV_GET = getOpEntry(OP_ENV_GET);
const CAP_ENV_SET = getOpEntry(OP_ENV_SET);
const CAP_ENV_DELETE = getOpEntry(OP_ENV_DELETE);
const CAP_ENV_TO_OBJECT = getOpEntry(OP_ENV_TO_OBJECT);
const CAP_STREAM_ACCEPT = getOpEntry(OP_STREAM_ACCEPT);
const CAP_STREAM_ACCEPT_ASYNC = getOpEntry(OP_STREAM_ACCEPT_ASYNC);
const CAP_STREAM_READ = getOpEntry(OP_STREAM_READ);
const CAP_STREAM_READ_ASYNC = getOpEntry(OP_STREAM_READ_ASYNC);
const CAP_STREAM_READ_ASYNC_RAW = getOpEntry(OP_STREAM_READ_ASYNC_RAW);
const CAP_STREAM_READ_RAW = getOpEntry(OP_STREAM_READ_RAW);
const CAP_STREAM_TAKE_CHUNK = getOpEntry(OP_STREAM_TAKE_CHUNK);
const CAP_STREAM_DISCARD = getOpEntry(OP_STREAM_DISCARD);

// --------------------
// Wire helpers
// --------------------

function safeObjSet(obj, key, val) {
  try {
    Object.defineProperty(obj, key, { value: val, writable: true, configurable: true, enumerable: true });
  } catch {
    try {
      obj[key] = val;
    } catch {
      // ignore
    }
  }
}

function wireUndef() {
  return { __undef: true };
}

function wireNum(tag) {
  return { __num: tag };
}

function isPlainJsonFast(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value);
  if (t !== "object") return false;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const v = value[i];
      if (v === null) continue;
      const vt = typeof v;
      if (vt === "string" || vt === "boolean") continue;
      if (vt === "number" && Number.isFinite(v)) continue;
      return false;
    }
    return true;
  }

  const proto = Object.getPrototypeOf(value);
  if (!(proto === Object.prototype || proto === null)) return false;
  const entries = Object.entries(value);
  if (entries.length > 32) return false;
  for (const [k, v] of entries) {
    if (k === "__proto__") return false;
    if (v === null) continue;
    const vt = typeof v;
    if (vt === "string" || vt === "boolean") continue;
    if (vt === "number" && Number.isFinite(v)) continue;
    return false;
  }
  return true;
}

function dehydrateAny(v) {
  if (isPlainJsonFast(v)) return v;
  const seen = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  let nextGraphId = 1;
  const GRAPH_ID_KEY = "__denojs_worker_graph_id";
  const GRAPH_REF_KEY = "__denojs_worker_graph_ref";
  const GRAPH_KIND_KEY = "__denojs_worker_graph_kind";
  const GRAPH_VALUE_KEY = "__denojs_worker_graph_value";

  function inner(x, depth) {
    if (x === undefined) return wireUndef();
    if (x === null) return null;
    if (depth > 200) return wireUndef();

    const t = typeof x;

    if (t === "number") {
      if (Object.is(x, -0)) return { __denojs_worker_num: "-0" };
      if (Number.isNaN(x)) return wireNum("NaN");
      if (x === Number.POSITIVE_INFINITY) return wireNum("Infinity");
      if (x === Number.NEGATIVE_INFINITY) return wireNum("-Infinity");
      if (!Number.isFinite(x)) return wireUndef();
      return x;
    }

    if (t === "string" || t === "boolean") return x;

    if (t === "bigint") {
      return { __bigint: x.toString() };
    }

    if (t === "function" || t === "symbol") return wireUndef();

    if (typeof Date !== "undefined" && x instanceof Date) {
      return { __date: x.getTime() };
    }

    if (typeof RegExp !== "undefined" && x instanceof RegExp) {
      return { __regexp: { source: x.source, flags: x.flags } };
    }

    // URL / URLSearchParams
    if (typeof URL !== "undefined" && x instanceof URL) {
      return { __url: x.href };
    }
    if (typeof URLSearchParams !== "undefined" && x instanceof URLSearchParams) {
      return { __urlSearchParams: x.toString() };
    }

    // ArrayBuffer + TypedArrays + DataView
    if (typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer) {
      const bytes = Array.from(new Uint8Array(x));
      return { __buffer: { kind: "ArrayBuffer", bytes, byteOffset: 0, length: bytes.length } };
    }

    if (typeof SharedArrayBuffer !== "undefined" && x instanceof SharedArrayBuffer) {
      const bytes = Array.from(new Uint8Array(x));
      return { __buffer: { kind: "SharedArrayBuffer", bytes, byteOffset: 0, length: bytes.length } };
    }

    if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(x)) {
      const kind = x && x.constructor && typeof x.constructor.name === "string" ? x.constructor.name : "Uint8Array";
      const byteOffset = typeof x.byteOffset === "number" ? x.byteOffset : 0;
      const byteLength = typeof x.byteLength === "number" ? x.byteLength : 0;
      const length = typeof x.length === "number" ? x.length : byteLength;

      let u8;
      try {
        u8 = new Uint8Array(x.buffer, byteOffset, byteLength);
      } catch {
        return wireUndef();
      }

      const bytes = Array.from(u8);
      return { __buffer: { kind, bytes, byteOffset, length } };
    }

    // Map/Set (primitive keys only)
    if (typeof Map !== "undefined" && x instanceof Map) {
      const out = [];
      for (const [k, v2] of x.entries()) {
        const kt = typeof k;
        const kOk =
          k === null ||
          kt === "string" ||
          kt === "number" ||
          kt === "boolean" ||
          kt === "bigint";
        if (!kOk) continue;

        const kk = inner(k, depth + 1);
        const vv = inner(v2, depth + 1);
        out.push([kk, vv]);
      }
      return { __map: out };
    }

    if (typeof Set !== "undefined" && x instanceof Set) {
      const out = [];
      for (const v2 of x.values()) {
        out.push(inner(v2, depth + 1));
      }
      return { __set: out };
    }

    // Error (best-effort)
    if (typeof Error !== "undefined" && x instanceof Error) {
      const out = {
        __denojs_worker_type: "error",
        name: typeof x.name === "string" ? x.name : "Error",
        message: typeof x.message === "string" ? x.message : String(x.message ?? ""),
      };
      if (typeof x.stack === "string") out.stack = x.stack;
      if ("code" in x && x.code != null) out.code = String(x.code);

      if ("cause" in x && x.cause != null) {
        out.cause = inner(x.cause, depth + 1);
      }

      return out;
    }

    if (t === "object") {
      if (!seen) return wireUndef();
      if (seen.has(x)) return { [GRAPH_REF_KEY]: seen.get(x) };

      const id = nextGraphId++;
      seen.set(x, id);

      if (Array.isArray(x)) {
        return {
          [GRAPH_ID_KEY]: id,
          [GRAPH_KIND_KEY]: "array",
          [GRAPH_VALUE_KEY]: x.map((it) => inner(it, depth + 1)),
        };
      }

      const out = {};
      for (const [k, val] of Object.entries(x)) out[k] = inner(val, depth + 1);
      return {
        [GRAPH_ID_KEY]: id,
        [GRAPH_KIND_KEY]: "object",
        [GRAPH_VALUE_KEY]: out,
      };
    }

    return wireUndef();
  }

  return inner(v, 0);
}

function dehydrateArgs(args) {
  try {
    return Array.isArray(args) ? args.map((a) => dehydrateAny(a)) : [];
  } catch {
    return [];
  }
}

function asUint8ArrayForOp(x) {
  try {
    if (typeof Uint8Array === "undefined") return null;
    if (x instanceof Uint8Array) return x;

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) {
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }

    if (typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer) {
      return new Uint8Array(x);
    }

    if (
      typeof ArrayBuffer !== "undefined" &&
      typeof ArrayBuffer.isView === "function" &&
      ArrayBuffer.isView(x)
    ) {
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
  } catch {
    // ignore
  }
  return null;
}


function dehydrateConsoleAny(v) {
  const seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;

  function inner(x, depth) {
    if (x === undefined || x === null) return null;
    if (depth > 200) return null;

    const t = typeof x;

    if (t === "number") {
      if (Object.is(x, -0)) return { __denojs_worker_num: "-0" };
      if (Number.isNaN(x)) return { __num: "NaN" };
      if (x === Number.POSITIVE_INFINITY) return { __num: "Infinity" };
      if (x === Number.NEGATIVE_INFINITY) return { __num: "-Infinity" };
      if (!Number.isFinite(x)) return null;
      return x;
    }

    if (t === "string" || t === "boolean") return x;

    // Console rule: BigInt becomes string (no trailing n)
    if (t === "bigint") return x.toString();

    // Console rule: symbol/function become null
    if (t === "function" || t === "symbol") return null;

    if (Array.isArray(x)) return x.map((it) => inner(it, depth + 1));

    // Console rule: top-level Date arg should round-trip to a Date in Node callback;
    // nested Date values stay as plain marker objects.
    if (typeof Date !== "undefined" && x instanceof Date) {
      return depth === 0
        ? { __denojs_worker_console_date: x.getTime() }
        : { __denojs_worker_console_nested_date: x.getTime() };
    }

    // Console rule: turn ArrayBuffer views into a marker that Rust will convert to Buffer
    if (typeof ArrayBuffer !== "undefined") {
      if (x instanceof ArrayBuffer) {
        const bytes = Array.from(new Uint8Array(x));
        return { __denojs_worker_console_buffer: bytes };
      }

      if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(x)) {
        try {
          const bo = typeof x.byteOffset === "number" ? x.byteOffset : 0;
          const bl = typeof x.byteLength === "number" ? x.byteLength : 0;
          const u8 = new Uint8Array(x.buffer, bo, bl);
          const bytes = Array.from(u8);
          return { __denojs_worker_console_buffer: bytes };
        } catch {
          return null;
        }
      }
    }

    if (t === "object") {
      if (seen) {
        if (seen.has(x)) return null;
        seen.add(x);
      }
      const out = {};
      for (const [k, val] of Object.entries(x)) {
        out[k] = inner(val, depth + 1);
      }
      return out;
    }

    return null;
  }

  return inner(v, 0);
}

function dehydrateConsoleArgs(args) {
  try {
    return Array.isArray(args) ? args.map((a) => dehydrateConsoleAny(a)) : [];
  } catch {
    return [];
  }
}

function isHostFnWrapper(fn) {
  return (
    typeof fn === "function" &&
    fn &&
    typeof fn.__denojs_worker_host_id === "number"
  );
}

function callHostFromConsole(fn, args) {
  const id = fn.__denojs_worker_host_id;
  const payloadArgs = dehydrateConsoleArgs(args);

  try {
    return hostCallSync(id, payloadArgs);
  } catch (e) {
    // Keep console routing low-latency by preferring sync dispatch.
    // If the callback returns a Promise, treat it as fire-and-forget.
    try {
      const msg = e && typeof e.message === "string" ? e.message : String(e);
      if (msg.includes("Sync host function returned a Promise")) {
        return undefined;
      }
    } catch {
      // ignore
    }
    throw e;
  }
}

function makeConsoleHostWrapper(fn) {
  return function (...args) {
    try {
      const out = callHostFromConsole(fn, args);
      if (isThenable(out)) {
        out.then(
          () => { },
          () => { }
        );
      }
    } catch {
      // ignore
    }
  };
}

// --------------------
// Worker -> Node (via Deno op)
// --------------------

function hostPostMessageImpl(msg) {
  try {
    const bin = asUint8ArrayForOp(msg);
    if (bin && CAP_POST_MESSAGE_BIN && CAP_POST_MESSAGE_BIN.kind !== "missing") {
      callCapturedRaw(CAP_POST_MESSAGE_BIN, OP_POST_MESSAGE_BIN, bin);
      return undefined;
    }

    const payload = dehydrateAny(msg);
    callCapturedRaw(CAP_POST_MESSAGE, OP_POST_MESSAGE, payload);
  } catch {
    // ignore
  }
  return undefined;
}

try {
  Object.defineProperty(globalThis, "hostPostMessage", {
    value: hostPostMessageImpl,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch {
  try {
    globalThis.hostPostMessage = hostPostMessageImpl;
  } catch {
    // ignore
  }
}

function tryAliasPostMessageToHost() {
  const d = Object.getOwnPropertyDescriptor(globalThis, "postMessage");
  const canSet = !d || d.writable === true || d.configurable === true;
  if (!canSet) return false;

  try {
    Object.defineProperty(globalThis, "postMessage", {
      value: hostPostMessageImpl,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return true;
  } catch {
    try {
      globalThis.postMessage = hostPostMessageImpl;
      return true;
    } catch {
      return false;
    }
  }
}

tryAliasPostMessageToHost();
// --------------------
// Node -> Worker dispatch (used by Rust DenoMsg::PostMessage)
// --------------------

try {
  Object.defineProperty(globalThis, "__dehydrate", {
    value: dehydrateAny,
    writable: true,
    configurable: true,
    enumerable: false,
  });
} catch {
  try {
    globalThis.__dehydrate = dehydrateAny;
  } catch {
    // ignore
  }
}

globalThis.__nodeOnMessageHandlers = [];
globalThis.__nodeMessageEventListeners = [];
const STREAM_DEFAULT_WINDOW_BYTES = 256 * 1024 * 1024;
const STREAM_CREDIT_FLUSH_THRESHOLD = 256 * 1024;
const STREAM_READER_DEFAULT_HIGH_WATER_MARK_BYTES = STREAM_DEFAULT_WINDOW_BYTES;
const STREAM_CONNECT_HOST_TO_WORKER_SUFFIX = "::h2w";
const STREAM_CONNECT_WORKER_TO_HOST_SUFFIX = "::w2h";
let nextWorkerStreamId = 1;
globalThis.__nodeIncomingStreams = new Map();
globalThis.__nodePendingStreamAccepts = new Map();
globalThis.__nodeStreamBacklog = new Map();
globalThis.__nodePendingIncomingStreamFrames = new Map();
globalThis.__nodeStreamById = new Map();
globalThis.__nodeStreamNameToId = new Map();
globalThis.__nodeStreamNumericIdToId = new Map();
globalThis.__nodeIncomingStreamsByNumeric = new Map();
globalThis.__nodeStreamWriterCredits = new Map();
globalThis.__nodeStreamWriterWaiters = new Map();
globalThis.__nodePendingStreamCredits = new Map();
globalThis.__nodeNativeStreamReadWaiters = new Map();

function streamBridgeConfig() {
  const raw = globalThis.__denojs_worker_bridge;
  const parsedWindow = raw && Number(raw.streamWindowBytes);
  const parsedFlush = raw && Number(raw.streamCreditFlushBytes);
  const parsedHighWater = raw && Number(raw.streamHighWaterMarkBytes);
  const streamWindowBytes =
    Number.isFinite(parsedWindow) && parsedWindow >= 1
      ? Math.trunc(parsedWindow)
      : STREAM_DEFAULT_WINDOW_BYTES;
  const streamCreditFlushBytes =
    Number.isFinite(parsedFlush) && parsedFlush >= 1
      ? Math.trunc(parsedFlush)
      : STREAM_CREDIT_FLUSH_THRESHOLD;
  const streamHighWaterMarkBytes =
    Number.isFinite(parsedHighWater) && parsedHighWater >= 1
      ? Math.trunc(parsedHighWater)
      : streamWindowBytes;
  return { streamWindowBytes, streamCreditFlushBytes, streamHighWaterMarkBytes };
}
const STREAM_BRIDGE_CFG = streamBridgeConfig();
const STREAM_CREDIT_FLUSH_EFFECTIVE_BYTES = Math.max(
  1,
  Math.min(STREAM_BRIDGE_CFG.streamCreditFlushBytes, STREAM_BRIDGE_CFG.streamWindowBytes),
);

function isStreamFrame(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    payload[STREAM_BRIDGE_TAG] === true &&
    typeof payload.t === "string" &&
    typeof payload.id === "string"
  );
}

function decodeTypedStreamChunkMessageWithHydrate(payload) {
  const hydrate =
    globalThis && typeof globalThis.__hydrate === "function" ? globalThis.__hydrate : undefined;
  return decodeTypedStreamChunkMessage(payload, hydrate);
}

function toStreamChunk(x) {
  try {
    if (typeof Uint8Array === "undefined") return null;
    if (x instanceof Uint8Array) return x;
    if (typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer) return new Uint8Array(x);
    if (
      typeof ArrayBuffer !== "undefined" &&
      typeof ArrayBuffer.isView === "function" &&
      ArrayBuffer.isView(x)
    ) {
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
  } catch {
    // ignore
  }
  return null;
}

function generateSecureRandomStreamKey() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // ignore
  }
  throw new Error("Secure random stream key generation is unavailable (crypto API missing)");
}

function registerStream(name, id) {
  if (globalThis.__nodeStreamById.has(id)) {
    throw new Error(`Duplicate stream id: ${id}`);
  }
  if (globalThis.__nodeStreamNameToId.has(name)) {
    throw new Error(`Stream key already in use: ${name}`);
  }
  globalThis.__nodeStreamById.set(id, { name, localDiscarded: false, remoteDiscarded: false });
  globalThis.__nodeStreamNameToId.set(name, id);
  const idNum = Number(id);
  if (Number.isFinite(idNum) && idNum >= 1 && idNum <= 0xffffffff) {
    globalThis.__nodeStreamNumericIdToId.set(Math.trunc(idNum), id);
  }
}

function resolveStreamId(streamId) {
  if (typeof streamId === "string") return streamId;
  if (typeof streamId === "number" && Number.isFinite(streamId)) {
    const n = Math.trunc(streamId) >>> 0;
    return globalThis.__nodeStreamNumericIdToId.get(n) || String(n);
  }
  const s = String(streamId || "");
  return s;
}

function connectDirectionalKeys(baseKey, role) {
  const base = String(baseKey || "").trim();
  if (!base) throw new Error("hostStreams.connect(key) requires a non-empty key");
  if (role === "host") {
    return {
      writeKey: `${base}${STREAM_CONNECT_HOST_TO_WORKER_SUFFIX}`,
      readKey: `${base}${STREAM_CONNECT_WORKER_TO_HOST_SUFFIX}`,
    };
  }
  return {
    writeKey: `${base}${STREAM_CONNECT_WORKER_TO_HOST_SUFFIX}`,
    readKey: `${base}${STREAM_CONNECT_HOST_TO_WORKER_SUFFIX}`,
  };
}

function addWriterCredit(id, credit) {
  if (!Number.isFinite(credit) || credit <= 0) return;
  const next = (globalThis.__nodeStreamWriterCredits.get(id) || 0) + Math.trunc(credit);
  globalThis.__nodeStreamWriterCredits.set(id, next);
  const waiters = globalThis.__nodeStreamWriterWaiters.get(id);
  if (!Array.isArray(waiters) || waiters.length === 0) return;
  const remain = [];
  for (const w of waiters) {
    if (next >= w.minBytes) {
      try {
        w.resolve();
      } catch {
        // ignore
      }
    } else {
      remain.push(w);
    }
  }
  if (remain.length > 0) globalThis.__nodeStreamWriterWaiters.set(id, remain);
  else globalThis.__nodeStreamWriterWaiters.delete(id);
}

function consumeWriterCredit(id, bytes) {
  const have = globalThis.__nodeStreamWriterCredits.get(id) || 0;
  const next = have - bytes;
  globalThis.__nodeStreamWriterCredits.set(id, next > 0 ? next : 0);
}

function waitForWriterCredit(id, minBytes) {
  if ((globalThis.__nodeStreamWriterCredits.get(id) || 0) >= minBytes) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const arr = globalThis.__nodeStreamWriterWaiters.get(id) || [];
    arr.push({ minBytes, resolve, reject });
    globalThis.__nodeStreamWriterWaiters.set(id, arr);
  });
}

function flushStreamCredits() {
  if (globalThis.__nodePendingStreamCredits.size === 0) return;
  for (const [id, credit] of globalThis.__nodePendingStreamCredits.entries()) {
    if (!(credit > 0)) continue;
    hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "credit", id, credit }));
  }
  globalThis.__nodePendingStreamCredits.clear();
}

function queueStreamCredit(id, bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const next = (globalThis.__nodePendingStreamCredits.get(id) || 0) + Math.trunc(bytes);
  globalThis.__nodePendingStreamCredits.set(id, next);
  if (next >= STREAM_CREDIT_FLUSH_EFFECTIVE_BYTES) {
    flushStreamCredits();
  }
}

function tryReleaseStream(id) {
  const meta = globalThis.__nodeStreamById.get(id);
  if (!meta) return;
  if (!meta.localDiscarded || !meta.remoteDiscarded) return;
  globalThis.__nodeStreamById.delete(id);
  globalThis.__nodeIncomingStreams.delete(id);
  const idNumIncoming = Number(id);
  if (Number.isFinite(idNumIncoming) && idNumIncoming >= 1 && idNumIncoming <= 0xffffffff) {
    globalThis.__nodeIncomingStreamsByNumeric.delete(Math.trunc(idNumIncoming) >>> 0);
  }
  globalThis.__nodePendingIncomingStreamFrames.delete(id);
  const activeId = globalThis.__nodeStreamNameToId.get(meta.name);
  if (activeId === id) globalThis.__nodeStreamNameToId.delete(meta.name);
  const idNum = Number(id);
  if (Number.isFinite(idNum) && idNum >= 1 && idNum <= 0xffffffff) {
    const n = Math.trunc(idNum) >>> 0;
    const mapped = globalThis.__nodeStreamNumericIdToId.get(n);
    if (mapped === id) globalThis.__nodeStreamNumericIdToId.delete(n);
  }
  globalThis.__nodeStreamWriterCredits.delete(id);
  globalThis.__nodePendingStreamCredits.delete(id);
  const waiters = globalThis.__nodeStreamWriterWaiters.get(id);
  if (Array.isArray(waiters) && waiters.length > 0) {
    for (const waiter of waiters) {
      try {
        waiter.reject(new Error("stream released"));
      } catch {
        // ignore
      }
    }
  }
  globalThis.__nodeStreamWriterWaiters.delete(id);
}

function markLocalDiscard(id) {
  const meta = globalThis.__nodeStreamById.get(id);
  if (!meta || meta.localDiscarded) return;
  meta.localDiscarded = true;
  const sendDiscard = () => {
    hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "discard", id }));
  };
  try {
    sendDiscard();
  } catch {
    try {
      setTimeout(() => {
        try {
          sendDiscard();
        } catch {
          // ignore
        }
      }, 0);
    } catch {
      // ignore
    }
  }
  tryReleaseStream(id);
}

function markRemoteDiscard(id) {
  const meta = globalThis.__nodeStreamById.get(id);
  if (!meta || meta.remoteDiscarded) return;
  meta.remoteDiscarded = true;
  tryReleaseStream(id);
}

function rejectIncomingOpen(id, reason) {
  globalThis.__nodePendingIncomingStreamFrames.delete(id);
  hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "error", id, error: reason }));
  hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "discard", id }));
}

function queuePendingIncomingStreamFrame(frame) {
  const queued = globalThis.__nodePendingIncomingStreamFrames.get(frame.id) || [];
  if (queued.length >= 256) queued.shift();
  queued.push(frame);
  globalThis.__nodePendingIncomingStreamFrames.set(frame.id, queued);
}

function makeStreamReader(id) {
  const queue = [];
  const waiting = [];
  let bufferedBytes = 0;
  let pendingCreditBytes = 0;
  const highWaterMarkBytes = STREAM_BRIDGE_CFG.streamHighWaterMarkBytes;
  let closed = false;
  let done = false;
  let discarded = false;
  let onLocalDiscard = null;
  let onChunkConsumed = null;

  function markLocalDiscarded() {
    if (discarded) return;
    discarded = true;
    try {
      if (typeof onLocalDiscard === "function") onLocalDiscard();
    } catch {
      // ignore
    }
  }

  function push(ev) {
    if (waiting.length > 0) {
      const w = waiting.shift();
      if (ev.kind === "chunk") {
        w.resolve({ done: false, value: ev.chunk });
        bufferedBytes = Math.max(0, bufferedBytes - ev.chunk.byteLength);
        pendingCreditBytes += ev.chunk.byteLength;
        if (bufferedBytes <= highWaterMarkBytes && pendingCreditBytes > 0) {
          try {
            if (onChunkConsumed) onChunkConsumed(pendingCreditBytes);
          } catch {
            // ignore
          }
          pendingCreditBytes = 0;
        }
      }
      else if (ev.kind === "close") w.resolve({ done: true, value: undefined });
      else w.reject(ev.error);
      return;
    }
    queue.push(ev);
  }

  const reader = {
    pushChunk(chunk) {
      if (closed || done) return;
      bufferedBytes += chunk.byteLength;
      push({ kind: "chunk", chunk });
    },
    closeRemote() {
      if (closed) return;
      closed = true;
      markLocalDiscarded();
      push({ kind: "close" });
    },
    errorRemote(error) {
      if (closed) return;
      closed = true;
      markLocalDiscarded();
      push({ kind: "error", error });
    },
    setOnLocalDiscard(fn) {
      onLocalDiscard = typeof fn === "function" ? fn : null;
    },
    setOnChunkConsumed(fn) {
      onChunkConsumed = typeof fn === "function" ? fn : null;
    },
    async read() {
      if (done) return { done: true, value: undefined };
      if (queue.length > 0) {
        const ev = queue.shift();
        if (ev.kind === "chunk") {
          bufferedBytes = Math.max(0, bufferedBytes - ev.chunk.byteLength);
          pendingCreditBytes += ev.chunk.byteLength;
          if (bufferedBytes <= highWaterMarkBytes && pendingCreditBytes > 0) {
            try {
              if (onChunkConsumed) onChunkConsumed(pendingCreditBytes);
            } catch {
              // ignore
            }
            pendingCreditBytes = 0;
          }
          return { done: false, value: ev.chunk };
        }
        done = true;
        if (ev.kind === "close") return { done: true, value: undefined };
        throw ev.error;
      }
      return await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    async cancel(reason) {
      if (done) return;
      done = true;
      closed = true;
      queue.length = 0;
      while (waiting.length > 0) {
        const w = waiting.shift();
        w.resolve({ done: true, value: undefined });
      }
      try {
        hostPostMessageImpl(
          encodeStreamFrameEnvelope({
            t: "cancel",
            id,
            reason: reason == null ? undefined : String(reason),
          })
        );
      } catch {
        // ignore
      }
      markLocalDiscarded();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => reader.read(),
        return: async () => {
          await reader.cancel("iterator return");
          return { done: true, value: undefined };
        },
        throw: async (err) => {
          await reader.cancel("iterator throw");
          throw err;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };

  return reader;
}

function makeNativeAcceptedStreamReader(idNum) {
  const id = String(idNum >>> 0);
  let done = false;
  let pendingRaw = null;
  const canUseAsyncRawRead =
    CAP_STREAM_READ_ASYNC_RAW &&
    (CAP_STREAM_READ_ASYNC_RAW.kind === "function" || CAP_STREAM_READ_ASYNC_RAW.kind === "number");
  const clearWaiter = () => {
    const waiter = globalThis.__nodeNativeStreamReadWaiters.get(id);
    if (waiter) {
      globalThis.__nodeNativeStreamReadWaiters.delete(id);
      try {
        waiter();
      } catch {
        // ignore
      }
    }
  };
  const wrapper = {
    async read() {
      if (done) return { done: true, value: undefined };
      while (true) {
        let raw = pendingRaw;
        pendingRaw = null;
        if (!raw) {
          if (canUseAsyncRawRead) {
            raw = await callCapturedAwait(CAP_STREAM_READ_ASYNC_RAW, OP_STREAM_READ_ASYNC_RAW, idNum >>> 0);
          } else {
            raw = callCapturedRaw(CAP_STREAM_READ_RAW, OP_STREAM_READ_RAW, idNum >>> 0);
          }
        }
        if (!(raw instanceof Uint8Array)) {
          raw = toStreamChunk(raw);
        }
        if (!raw || raw.length === 0) {
          done = true;
          return { done: true, value: undefined };
        }
        const tag = raw[0] >>> 0;
        if (tag === 0) {
          if (canUseAsyncRawRead) {
            continue;
          }
          await new Promise((resolve) => {
            globalThis.__nodeNativeStreamReadWaiters.set(id, resolve);
            let immediate = callCapturedRaw(CAP_STREAM_READ_RAW, OP_STREAM_READ_RAW, idNum >>> 0);
            if (!(immediate instanceof Uint8Array)) {
              immediate = toStreamChunk(immediate);
            }
            if (immediate && immediate.length > 0 && (immediate[0] >>> 0) !== 0) {
              pendingRaw = immediate;
              globalThis.__nodeNativeStreamReadWaiters.delete(id);
              resolve();
            }
          });
          continue;
        }
        if (tag === 1) {
          const chunk = raw.subarray(1);
          if (chunk.byteLength > 0) {
            queueStreamCredit(id, chunk.byteLength);
          }
          return { done: false, value: chunk };
        }
        done = true;
        clearWaiter();
        try {
          callCapturedRaw(CAP_STREAM_DISCARD, OP_STREAM_DISCARD, idNum >>> 0);
        } catch {
          // ignore
        }
        if (tag === 2) return { done: true, value: undefined };
        if (tag === 3) {
          let msg = "Remote stream error";
          try {
            msg = new TextDecoder().decode(raw.subarray(1)) || msg;
          } catch {
            // ignore
          }
          throw new Error(msg);
        }
        return { done: true, value: undefined };
      }
    },
    async cancel(reason) {
      if (done) return;
      done = true;
      clearWaiter();
      try {
        hostPostMessageImpl(
          encodeStreamFrameEnvelope({
            t: "cancel",
            id,
            reason: reason == null ? undefined : String(reason),
          })
        );
      } catch {
        // ignore
      }
      try {
        hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "discard", id }));
      } catch {
        // ignore
      }
      try {
        callCapturedRaw(CAP_STREAM_DISCARD, OP_STREAM_DISCARD, idNum >>> 0);
      } catch {
        // ignore
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => wrapper.read(),
        return: async () => {
          await wrapper.cancel("iterator return");
          return { done: true, value: undefined };
        },
        throw: async (err) => {
          await wrapper.cancel("iterator throw");
          throw err;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
  return wrapper;
}

function queueAcceptedStream(name, reader) {
  const pending = globalThis.__nodePendingStreamAccepts.get(name);
  if (pending) {
    globalThis.__nodePendingStreamAccepts.delete(name);
    pending(reader);
    return;
  }

  globalThis.__nodeStreamBacklog.set(name, reader);
}

function handleIncomingStreamFrame(frame) {
  switch (frame.t) {
    case "open": {
      const key = typeof frame.key === "string" && frame.key ? frame.key : frame.id;
      if (globalThis.__nodeStreamNameToId.has(key) || globalThis.__nodeStreamBacklog.has(key)) {
        rejectIncomingOpen(frame.id, `Stream key already in use: ${key}`);
        return true;
      }
      registerStream(key, frame.id);
      const reader = makeStreamReader(frame.id);
      reader.setOnLocalDiscard(() => markLocalDiscard(frame.id));
      reader.setOnChunkConsumed((bytes) => queueStreamCredit(frame.id, bytes));
      globalThis.__nodeIncomingStreams.set(frame.id, reader);
      const idNum = Number(frame.id);
      if (Number.isFinite(idNum) && idNum >= 1 && idNum <= 0xffffffff) {
        globalThis.__nodeIncomingStreamsByNumeric.set(Math.trunc(idNum) >>> 0, reader);
      }
      queueAcceptedStream(key, reader);
      const pending = globalThis.__nodePendingIncomingStreamFrames.get(frame.id);
      if (Array.isArray(pending) && pending.length > 0) {
        globalThis.__nodePendingIncomingStreamFrames.delete(frame.id);
        for (const queued of pending) {
          handleIncomingStreamFrame(queued);
        }
      }
      return true;
    }
    case "chunk": {
      const stream = globalThis.__nodeIncomingStreams.get(frame.id);
      if (!stream) {
        if (!globalThis.__nodeStreamById.has(frame.id)) queuePendingIncomingStreamFrame(frame);
        return true;
      }
      const chunk = frame.chunk ? toStreamChunk(frame.chunk) : null;
      if (!chunk) {
        stream.errorRemote(new Error("Invalid stream chunk"));
        return true;
      }
      stream.pushChunk(chunk);
      return true;
    }
    case "close": {
      const stream = globalThis.__nodeIncomingStreams.get(frame.id);
      if (!stream) {
        if (!globalThis.__nodeStreamById.has(frame.id)) queuePendingIncomingStreamFrame(frame);
        return true;
      }
      stream.closeRemote();
      return true;
    }
    case "error": {
      const stream = globalThis.__nodeIncomingStreams.get(frame.id);
      if (!stream) {
        if (!globalThis.__nodeStreamById.has(frame.id)) queuePendingIncomingStreamFrame(frame);
        return true;
      }
      stream.errorRemote(new Error(frame.error || "Remote stream error"));
      return true;
    }
    case "cancel": {
      const stream = globalThis.__nodeIncomingStreams.get(frame.id);
      if (!stream) {
        if (!globalThis.__nodeStreamById.has(frame.id)) queuePendingIncomingStreamFrame(frame);
        return true;
      }
      stream.errorRemote(new Error(frame.reason || "Remote stream cancelled"));
      return true;
    }
    case "discard": {
      const waiter = globalThis.__nodeNativeStreamReadWaiters.get(frame.id);
      if (waiter) {
        globalThis.__nodeNativeStreamReadWaiters.delete(frame.id);
        try {
          waiter();
        } catch {
          // ignore
        }
      }
      markRemoteDiscard(frame.id);
      return true;
    }
    case "credit": {
      addWriterCredit(frame.id, Number(frame.credit || 0));
      return true;
    }
    case "native-poke": {
      const waiter = globalThis.__nodeNativeStreamReadWaiters.get(frame.id);
      if (waiter) {
        globalThis.__nodeNativeStreamReadWaiters.delete(frame.id);
        try {
          waiter();
        } catch {
          // ignore
        }
      }
      return true;
    }
    default:
      return true;
  }
}

function routeIncomingStreamChunkFast(streamId, chunk) {
  let id = streamId;
  if (typeof streamId === "number" && Number.isFinite(streamId)) {
    const n = Math.trunc(streamId) >>> 0;
    const direct = globalThis.__nodeIncomingStreamsByNumeric.get(n);
    if (direct) {
      direct.pushChunk(chunk);
      return true;
    }
    id = globalThis.__nodeStreamNumericIdToId.get(n) || String(n);
  } else if (typeof streamId !== "string") {
    id = String(streamId || "");
  }
  const stream = globalThis.__nodeIncomingStreams.get(id);
  if (stream) {
    stream.pushChunk(chunk);
    return true;
  }
  if (!globalThis.__nodeStreamById.has(id)) {
    queuePendingIncomingStreamFrame({
      [STREAM_BRIDGE_TAG]: true,
      t: "chunk",
      id,
      chunk,
    });
  }
  return true;
}

const hostStreams = {
  create(key) {
    const provided = key != null;
    const streamKey = provided ? String(key || "").trim() : "";
    if (provided && !streamKey) throw new Error("hostStreams.create(key) requires a non-empty key when provided");

    let finalKey = streamKey;
    if (!finalKey) {
      for (let i = 0; i < 16; i += 1) {
        const candidate = generateSecureRandomStreamKey();
        if (
          !globalThis.__nodeStreamNameToId.has(candidate) &&
          !globalThis.__nodePendingStreamAccepts.has(candidate) &&
          !globalThis.__nodeStreamBacklog.has(candidate)
        ) {
          finalKey = candidate;
          break;
        }
      }
      if (!finalKey) throw new Error("Failed to generate a unique random stream key");
    }

    if (
      globalThis.__nodeStreamNameToId.has(finalKey) ||
      globalThis.__nodePendingStreamAccepts.has(finalKey) ||
      globalThis.__nodeStreamBacklog.has(finalKey)
    ) {
      throw new Error(`Stream key already in use: ${finalKey}`);
    }

    const id = String(nextWorkerStreamId++);
    registerStream(finalKey, id);
    globalThis.__nodeStreamWriterCredits.set(id, STREAM_BRIDGE_CFG.streamWindowBytes);
    let done = false;
    const rejectWriterWaiters = (reason) => {
      const waiters = globalThis.__nodeStreamWriterWaiters.get(id);
      if (Array.isArray(waiters) && waiters.length > 0) {
        for (const waiter of waiters) {
          try {
            waiter.reject(new Error(String(reason || "stream closed")));
          } catch {
            // ignore
          }
        }
      }
      globalThis.__nodeStreamWriterWaiters.delete(id);
      globalThis.__nodeStreamWriterCredits.delete(id);
    };

    hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "open", id, key: finalKey }));

    const ensureOpen = () => {
      if (done) throw new Error(`Stream already closed: ${finalKey}`);
    };

    return {
      getKey() {
        return finalKey;
      },
      async ready(minBytes) {
        ensureOpen();
        const need = Math.max(1, Math.trunc(minBytes || 1));
        await waitForWriterCredit(id, need);
      },
      async write(chunk) {
        ensureOpen();
        const u8 = toStreamChunk(chunk);
        if (!u8) throw new Error("stream.write requires Uint8Array or ArrayBuffer");
        await waitForWriterCredit(id, u8.byteLength);
        hostPostMessageImpl(encodeStreamFrameEnvelope({
          t: "chunk",
          id,
          chunk: u8,
        }));
        consumeWriterCredit(id, u8.byteLength);
      },
      async writeMany(chunks) {
        ensureOpen();
        if (!Array.isArray(chunks) || chunks.length === 0) return 0;
        let sent = 0;
        let batch = [];
        let batchBytes = 0;
        for (const chunk of chunks) {
          const u8 = toStreamChunk(chunk);
          if (!u8) throw new Error("stream.writeMany requires Uint8Array or ArrayBuffer chunks");
          await waitForWriterCredit(id, u8.byteLength);
          batch.push(encodeStreamFrameEnvelope({ t: "chunk", id, chunk: u8 }));
          batchBytes += u8.byteLength;
          sent += 1;
          if (batch.length >= 64) {
            for (const payload of batch) hostPostMessageImpl(payload);
            consumeWriterCredit(id, batchBytes);
            batch = [];
            batchBytes = 0;
          }
        }
        if (batch.length > 0) {
          for (const payload of batch) hostPostMessageImpl(payload);
          consumeWriterCredit(id, batchBytes);
        }
        return sent;
      },
      async close() {
        if (done) return;
        done = true;
        hostPostMessageImpl(encodeStreamFrameEnvelope({ t: "close", id }));
        markRemoteDiscard(id);
        markLocalDiscard(id);
        rejectWriterWaiters(`Stream closed: ${finalKey}`);
      },
      async error(message) {
        if (done) return;
        done = true;
        hostPostMessageImpl(encodeStreamFrameEnvelope({
          t: "error",
          id,
          error: String(message || "stream error"),
        }));
        markRemoteDiscard(id);
        markLocalDiscard(id);
        rejectWriterWaiters(`Stream errored: ${finalKey}`);
      },
      async cancel(reason) {
        if (done) return;
        done = true;
        hostPostMessageImpl(encodeStreamFrameEnvelope({
          t: "cancel",
          id,
          reason: reason == null ? undefined : String(reason),
        }));
        markRemoteDiscard(id);
        markLocalDiscard(id);
        rejectWriterWaiters(`Stream cancelled: ${finalKey}`);
      },
    };
  },

  async connect(key, options) {
    const roleRaw = options && options.role;
    const role = roleRaw === "host" ? "host" : "worker";
    const keys = connectDirectionalKeys(key, role);
    const writer = hostStreams.create(keys.writeKey);
    const reader = await hostStreams.accept(keys.readKey);

    const readable = new ReadableStream({
      async pull(controller) {
        const out = await reader.read();
        if (out.done) {
          controller.close();
          return;
        }
        controller.enqueue(out.value);
      },
      async cancel(reason) {
        await reader.cancel(reason == null ? undefined : String(reason));
      },
    });

    const writable = new WritableStream({
      async write(chunk) {
        const u8 = toStreamChunk(chunk);
        if (!u8) throw new Error("hostStreams.connect(...).writable expects Uint8Array or ArrayBuffer");
        await writer.write(u8);
      },
      async close() {
        await writer.close();
      },
      async abort(reason) {
        await writer.cancel(reason == null ? undefined : String(reason));
      },
    });

    return { readable, writable };
  },

  async accept(key) {
    const streamName = String(key || "").trim();
    if (!streamName) throw new Error("hostStreams.accept(key) requires a non-empty key");
    if (globalThis.__denojs_worker_bridge && globalThis.__denojs_worker_bridge.nativeStreamPlane === true) {
      await Promise.resolve();
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        const accepted = callCapturedRaw(CAP_STREAM_ACCEPT, OP_STREAM_ACCEPT, streamName);
        const idNum = Number(accepted);
        if (Number.isFinite(idNum) && idNum > 0) {
          return makeNativeAcceptedStreamReader(Math.trunc(idNum) >>> 0);
        }
        if (idNum < 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`hostStreams.accept timeout for stream key: ${streamName}`);
    }

    if (globalThis.__nodePendingStreamAccepts.has(streamName)) {
      throw new Error(`hostStreams.accept already pending for stream key: ${streamName}`);
    }
    const activeId = globalThis.__nodeStreamNameToId.get(streamName);
    if (activeId && !globalThis.__nodeStreamBacklog.has(streamName)) {
      throw new Error(`Stream key already in use: ${streamName}`);
    }

    const queued = globalThis.__nodeStreamBacklog.get(streamName);
    if (queued) {
      globalThis.__nodeStreamBacklog.delete(streamName);
      return queued;
    }
    return await new Promise((resolve) => {
      globalThis.__nodePendingStreamAccepts.set(streamName, resolve);
    });
  },
};

safeObjSet(globalThis, "hostStreams", hostStreams);
safeObjSet(globalThis, "__denojs_core_debug", {
  hasCoreOpAsync: typeof coreOpAsync === "function",
  hasCoreOpSync: typeof coreOpSync === "function",
  hasOpresolve: !!(coreApi && typeof coreApi.opresolve === "function"),
  capReadAsyncKind: CAP_STREAM_READ_ASYNC && CAP_STREAM_READ_ASYNC.kind,
  capAcceptAsyncKind: CAP_STREAM_ACCEPT_ASYNC && CAP_STREAM_ACCEPT_ASYNC.kind,
  capReadKind: CAP_STREAM_READ && CAP_STREAM_READ.kind,
  capAcceptKind: CAP_STREAM_ACCEPT && CAP_STREAM_ACCEPT.kind,
});

const onImpl = (name, fn) => {
  if (name === "message" && typeof fn === "function") {
    // Node-style: fn(payload)
    globalThis.__nodeOnMessageHandlers.push(fn);
  }
};

const addEventListenerImpl = (name, fn) => {
  if (name === "message" && typeof fn === "function") {
    // DOM-style: fn({ data: payload })
    globalThis.__nodeMessageEventListeners.push(fn);
  }
};

function dispatchNodeMessagePayload(payload) {
  const onHandlers = globalThis.__nodeOnMessageHandlers;
  if (onHandlers.length === 1) {
    try {
      onHandlers[0](payload);
    } catch {
      // ignore
    }
  } else {
    for (const fn of onHandlers) {
      try {
        fn(payload);
      } catch {
        // ignore
      }
    }
  }

  const evtHandlers = globalThis.__nodeMessageEventListeners;
  if (evtHandlers.length === 1) {
    try {
      evtHandlers[0](payload);
    } catch {
      // ignore
    }
  } else {
    for (const fn of evtHandlers) {
      try {
        fn(payload);
      } catch {
        // ignore
      }
    }
  }
}

try {
  Object.defineProperty(globalThis, "on", {
    value: onImpl,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch {
  try {
    globalThis.on = onImpl;
  } catch {
    // ignore
  }
}

try {
  Object.defineProperty(globalThis, "addEventListener", {
    value: addEventListenerImpl,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch {
  try {
    globalThis.addEventListener = addEventListenerImpl;
  } catch {
    // ignore
  }
}

globalThis.__dispatchNodeMessage = (payload) => {
  const frame = decodeStreamFrameEnvelope(payload);
  if (frame) {
    handleIncomingStreamFrame(frame);
    return;
  }
  const typedStreamFrame = decodeTypedStreamChunkMessageWithHydrate(payload);
  if (typedStreamFrame) {
    handleIncomingStreamFrame(typedStreamFrame);
    return;
  }
  const typedControlFrame = decodeTypedStreamControlMessage(payload);
  if (typedControlFrame) {
    handleIncomingStreamFrame(typedControlFrame);
    return;
  }
  if (isStreamFrame(payload)) {
    handleIncomingStreamFrame(payload);
    return;
  }

  // addEventListener('message'): payload (test expects payload, not { data })
  dispatchNodeMessagePayload(payload);
};

globalThis.__dispatchNodeTypedMessage = (type, id, payload) => {
  dispatchNodeMessagePayload({ type, id, payload });
};

globalThis.__dispatchNodeStreamChunk = (streamId, payload) => {
  const id = resolveStreamId(streamId);
  if (!id) return;
  const chunk = toStreamChunk(payload);
  if (!chunk) return;
  routeIncomingStreamChunkFast(id, chunk);
};

globalThis.__dispatchNodeStreamChunkRaw = (streamId, payload, credit) => {
  const id = resolveStreamId(streamId);
  if (!id) return;
  const c = Number(credit || 0);
  if (Number.isFinite(c) && c > 0) {
    const creditId =
      typeof streamId === "number" && Number.isFinite(streamId)
        ? (globalThis.__nodeStreamNumericIdToId.get(Math.trunc(streamId) >>> 0) || id)
        : id;
    handleIncomingStreamFrame({
      [STREAM_BRIDGE_TAG]: true,
      t: "credit",
      id: creditId,
      credit: c,
    });
  }
  const chunk = toStreamChunk(payload);
  if (!chunk) return;
  routeIncomingStreamChunkFast(streamId, chunk);
};

globalThis.__dispatchNodeStreamChunks = (streamId, payloads) => {
  const id = resolveStreamId(streamId);
  if (!id) return;
  if (!Array.isArray(payloads) || payloads.length === 0) return;
  for (const payload of payloads) {
    const chunk = toStreamChunk(payload);
    if (!chunk) continue;
    routeIncomingStreamChunkFast(id, chunk);
  }
};

globalThis.__dispatchNodeStreamChunkVectorized = (streamId, payload) => {
  const id = resolveStreamId(streamId);
  if (!id) return;
  const u8 = toStreamChunk(payload);
  if (!u8 || u8.byteLength < 4) return;
  let off = 0;
  while (off + 4 <= u8.byteLength) {
    const len =
      ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
    off += 4;
    if (off + len > u8.byteLength) break;
    routeIncomingStreamChunkFast(id, u8.subarray(off, off + len));
    off += len;
  }
};

globalThis.__dispatchNodeStreamControl = (kind, streamId, aux) => {
  const t = typeof kind === "string" ? kind : String(kind || "");
  const id = typeof streamId === "string" ? streamId : String(streamId || "");
  if (!t || !id) return;
  const frame = {
    [STREAM_BRIDGE_TAG]: true,
    t,
    id,
  };
  if (t === "open") frame.key = aux == null ? "" : String(aux);
  else if (t === "error") frame.error = aux == null ? "" : String(aux);
  else if (t === "cancel") frame.reason = aux == null ? "" : String(aux);
  else if (t === "credit") frame.credit = Number(aux || "0");
  else if (t !== "close" && t !== "discard" && t !== "native-poke") return;
  handleIncomingStreamFrame(frame);
};

globalThis.__dispatchNativeStreamPoke = (streamId) => {
  const id = resolveStreamId(streamId);
  if (!id) return;
  const waiter = globalThis.__nodeNativeStreamReadWaiters.get(id);
  if (!waiter) return;
  globalThis.__nodeNativeStreamReadWaiters.delete(id);
  try {
    waiter();
  } catch {
    // ignore
  }
};

// --------------------
// HostFunction hydration using captured ops
// --------------------

function assertHostReplyShape(res) {
  if (!res || typeof res !== "object") {
    throw new Error(`Host call returned non-object: ${String(res)}`);
  }
  if (!("ok" in res)) {
    throw new Error(`Host call returned missing 'ok': ${JSON.stringify(res)}`);
  }
  return res;
}

function handleHostReply(res) {
  const r = assertHostReplyShape(res);
  if (r.ok) return globalThis.__hydrate(r.value);
  throw globalThis.__hydrate(r.error);
}

async function hostCallAsync(funcId, payloadArgs, rawArgs) {
  if (Array.isArray(rawArgs) && rawArgs.length >= 1) {
    const maybeBin = asUint8ArrayForOp(rawArgs[0]);
    if (maybeBin) {
      if (rawArgs.length === 1 && CAP_HOST_CALL_ASYNC_BIN && CAP_HOST_CALL_ASYNC_BIN.kind !== "missing") {
        const res = await callCapturedAwait(
          CAP_HOST_CALL_ASYNC_BIN,
          OP_HOST_CALL_ASYNC_BIN,
          funcId,
          maybeBin
        );
        return handleHostReply(res);
      }

      if (rawArgs.length > 1 && CAP_HOST_CALL_ASYNC_BIN_MIXED && CAP_HOST_CALL_ASYNC_BIN_MIXED.kind !== "missing") {
        const rest = dehydrateArgs(rawArgs.slice(1));
        const res = await callCapturedAwait(
          CAP_HOST_CALL_ASYNC_BIN_MIXED,
          OP_HOST_CALL_ASYNC_BIN_MIXED,
          funcId,
          maybeBin,
          rest
        );
        return handleHostReply(res);
      }
    }
  }

  const res = await callCapturedAwait(
    CAP_HOST_CALL_ASYNC,
    OP_HOST_CALL_ASYNC,
    funcId,
    payloadArgs
  );
  return handleHostReply(res);
}

function hostCallSync(funcId, payloadArgs, rawArgs) {
  if (Array.isArray(rawArgs) && rawArgs.length >= 1) {
    const maybeBin = asUint8ArrayForOp(rawArgs[0]);
    if (maybeBin) {
      if (rawArgs.length === 1 && CAP_HOST_CALL_SYNC_BIN && CAP_HOST_CALL_SYNC_BIN.kind !== "missing") {
        const out = callCapturedRaw(
          CAP_HOST_CALL_SYNC_BIN,
          OP_HOST_CALL_SYNC_BIN,
          funcId,
          maybeBin
        );
        if (isThenable(out)) {
          return out.then((res) => handleHostReply(res));
        }
        return handleHostReply(out);
      }

      if (rawArgs.length > 1 && CAP_HOST_CALL_SYNC_BIN_MIXED && CAP_HOST_CALL_SYNC_BIN_MIXED.kind !== "missing") {
        const rest = dehydrateArgs(rawArgs.slice(1));
        const out = callCapturedRaw(
          CAP_HOST_CALL_SYNC_BIN_MIXED,
          OP_HOST_CALL_SYNC_BIN_MIXED,
          funcId,
          maybeBin,
          rest
        );
        if (isThenable(out)) {
          return out.then((res) => handleHostReply(res));
        }
        return handleHostReply(out);
      }
    }
  }

  const out = callCapturedRaw(CAP_HOST_CALL_SYNC, OP_HOST_CALL_SYNC, funcId, payloadArgs);
  if (isThenable(out)) {
    return out.then((res) => handleHostReply(res));
  }
  return handleHostReply(out);
}

function envCallSync(captured, name, ...args) {
  const out = callCapturedRaw(captured, name, ...args);
  if (isThenable(out)) {
    throw new Error(`${name} returned a Promise unexpectedly`);
  }
  return handleHostReply(out);
}

function installRuntimeEnvBridge() {
  const denoObj = globalThis && globalThis.Deno;
  const envObj = denoObj && denoObj.env;
  if (!envObj || typeof envObj !== "object") return false;

  safeObjSet(envObj, "get", (key) => {
    const k = String(key);
    return envCallSync(CAP_ENV_GET, OP_ENV_GET, k);
  });

  safeObjSet(envObj, "set", (key, value) => {
    const k = String(key);
    const v = String(value);
    envCallSync(CAP_ENV_SET, OP_ENV_SET, k, v);
  });

  safeObjSet(envObj, "delete", (key) => {
    const k = String(key);
    const out = envCallSync(CAP_ENV_DELETE, OP_ENV_DELETE, k);
    return !!out;
  });

  safeObjSet(envObj, "toObject", () => {
    const out = envCallSync(CAP_ENV_TO_OBJECT, OP_ENV_TO_OBJECT);
    return out && typeof out === "object" ? out : {};
  });

  return true;
}

function installRuntimeEnvBridgeEventually(attemptsLeft) {
  if (installRuntimeEnvBridge()) return;
  if (attemptsLeft <= 0) return;
  try {
    queueMicrotask(() => installRuntimeEnvBridgeEventually(attemptsLeft - 1));
  } catch {
    // ignore
  }
}

try {
  Object.defineProperty(globalThis, "__denojs_worker_install_runtime_env_bridge", {
    value: installRuntimeEnvBridge,
    writable: true,
    configurable: true,
    enumerable: false,
  });
} catch {
  try {
    globalThis.__denojs_worker_install_runtime_env_bridge = installRuntimeEnvBridge;
  } catch {
    // ignore
  }
}

installRuntimeEnvBridgeEventually(32);

function bufferViewFromWire(obj) {
  const b = obj && obj.__buffer ? obj.__buffer : null;
  if (!b || typeof b !== "object") return null;

  const kind = typeof b.kind === "string" ? b.kind : "Uint8Array";
  const bytes = Array.isArray(b.bytes) ? b.bytes : [];
  const byteOffset = typeof b.byteOffset === "number" ? b.byteOffset : 0;
  const length = typeof b.length === "number" ? b.length : bytes.length;

  const u8 = new Uint8Array(bytes);

  if (kind === "ArrayBuffer") {
    return u8.buffer;
  }
  if (kind === "SharedArrayBuffer") {
    return u8.buffer;
  }

  const ab = u8.buffer;

  function safeTyped(TypedCtor, bytesPerElem) {
    try {
      const elemOffset = Math.floor(byteOffset / bytesPerElem);
      return new TypedCtor(ab, elemOffset * bytesPerElem, length);
    } catch {
      return null;
    }
  }

  switch (kind) {
    case "Uint8Array": return safeTyped(Uint8Array, 1);
    case "Uint8ClampedArray": return safeTyped(Uint8ClampedArray, 1);
    case "Int8Array": return safeTyped(Int8Array, 1);
    case "Uint16Array": return safeTyped(Uint16Array, 2);
    case "Int16Array": return safeTyped(Int16Array, 2);
    case "Uint32Array": return safeTyped(Uint32Array, 4);
    case "Int32Array": return safeTyped(Int32Array, 4);
    case "Float32Array": return safeTyped(Float32Array, 4);
    case "Float64Array": return safeTyped(Float64Array, 8);
    case "BigInt64Array": return typeof BigInt64Array !== "undefined" ? safeTyped(BigInt64Array, 8) : null;
    case "BigUint64Array": return typeof BigUint64Array !== "undefined" ? safeTyped(BigUint64Array, 8) : null;
    case "DataView":
      try { return new DataView(ab, byteOffset, length); } catch { return null; }
    default:
      return safeTyped(Uint8Array, 1);
  }
}

{
  const GRAPH_ID_KEY = "__denojs_worker_graph_id";
  const GRAPH_REF_KEY = "__denojs_worker_graph_ref";
  const GRAPH_KIND_KEY = "__denojs_worker_graph_kind";
  const GRAPH_VALUE_KEY = "__denojs_worker_graph_value";
  const FORBIDDEN_PROTO_KEYS = new Set(["__proto__"]);

  globalThis.__hydrate = function (v) {
    const graphMap = new Map();

    function hydrateInner(vv) {
      if (vv == null) return vv;
      if (Array.isArray(vv)) return vv.map(hydrateInner);
      if (typeof vv !== "object") return vv;

      if (
        typeof vv[GRAPH_REF_KEY] === "number" &&
        Object.keys(vv).length === 1
      ) {
        return graphMap.get(vv[GRAPH_REF_KEY]);
      }

      if (
        typeof vv[GRAPH_ID_KEY] === "number" &&
        typeof vv[GRAPH_KIND_KEY] === "string" &&
        GRAPH_VALUE_KEY in vv
      ) {
        const id = vv[GRAPH_ID_KEY];
        const kind = vv[GRAPH_KIND_KEY];
        const raw = vv[GRAPH_VALUE_KEY];
        if (graphMap.has(id)) return graphMap.get(id);

        if (kind === "array") {
          const out = [];
          graphMap.set(id, out);
          if (Array.isArray(raw)) {
            for (const item of raw) out.push(hydrateInner(item));
          }
          return out;
        }

        const out = {};
        graphMap.set(id, out);
        if (raw && typeof raw === "object") {
          for (const [k, val] of Object.entries(raw)) {
            if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
            out[k] = hydrateInner(val);
          }
        }
        return out;
      }

      if (vv.__undef === true) return undefined;

      if (vv.__denojs_worker_num === "-0") return -0;

      if (vv.__num === "NaN") return NaN;
      if (vv.__num === "Infinity") return Infinity;
      if (vv.__num === "-Infinity") return -Infinity;

      if (vv.__date !== undefined) return new Date(vv.__date);

      if (vv.__bigint !== undefined) {
        try {
          return BigInt(String(vv.__bigint));
        } catch {
          return undefined;
        }
      }

      if (vv.__regexp && typeof vv.__regexp === "object") {
        try {
          const src = String(vv.__regexp.source ?? "");
          const flags = String(vv.__regexp.flags ?? "");
          return new RegExp(src, flags);
        } catch {
          return undefined;
        }
      }

      if (vv.__url !== undefined) {
        try {
          return new URL(String(vv.__url));
        } catch {
          return String(vv.__url);
        }
      }

      if (vv.__urlSearchParams !== undefined) {
        try {
          return new URLSearchParams(String(vv.__urlSearchParams));
        } catch {
          return String(vv.__urlSearchParams);
        }
      }

      if (vv.__buffer !== undefined) {
        const bv = bufferViewFromWire(vv);
        if (bv != null) return bv;
        return undefined;
      }

      if (vv.__map !== undefined && Array.isArray(vv.__map)) {
        const m = new Map();
        for (const pair of vv.__map) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const kk = hydrateInner(pair[0]);
          const vv2 = hydrateInner(pair[1]);
          m.set(kk, vv2);
        }
        return m;
      }

      if (vv.__set !== undefined && Array.isArray(vv.__set)) {
        const s = new Set();
        for (const item of vv.__set) s.add(hydrateInner(item));
        return s;
      }

      if (vv.__denojs_worker_type === "error") {
        const msg = String(vv.message ?? "");
        const e = new Error(msg);

        if (typeof vv.name === "string") e.name = vv.name;

        safeObjSet(e, "name", typeof vv.name === "string" ? vv.name : e.name);
        safeObjSet(e, "message", msg);

        if (typeof vv.stack === "string") safeObjSet(e, "stack", vv.stack);
        if ("code" in vv && vv.code != null) safeObjSet(e, "code", vv.code);

        if ("cause" in vv && vv.cause != null) {
          try {
            e.cause = hydrateInner(vv.cause);
            safeObjSet(e, "cause", e.cause);
          } catch {
            // ignore
          }
        }

        return e;
      }

      if (vv.__denojs_worker_type === "function" && typeof vv.id === "number") {
        const id = vv.id;
        const isAsync = !!vv.async;

    function isSyncReturnedPromiseError(err) {
      try {
        const msg = err && typeof err.message === "string" ? err.message : String(err);
        return msg.includes("Sync host function returned a Promise");
      } catch {
        return false;
      }
    }

        let fn;
        if (isAsync) {
          fn = async (...args) => {
            const payloadArgs = dehydrateArgs(args);
            return await hostCallAsync(id, payloadArgs, args);
          };
        } else {
          fn = (...args) => {
            const payloadArgs = dehydrateArgs(args);
            try {
              return hostCallSync(id, payloadArgs, args);
            } catch (e) {
              if (isSyncReturnedPromiseError(e)) {
                return hostCallAsync(id, payloadArgs, args);
              }
              throw e;
            }
          };
        }

        safeObjSet(fn, "__denojs_worker_host_id", id);
        safeObjSet(fn, "__denojs_worker_host_async", isAsync);
        return fn;
      }

      const out = {};
      for (const [k, val] of Object.entries(vv)) {
        if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
        out[k] = hydrateInner(val);
      }
      return out;
    }

    return hydrateInner(v);
  };
}

// --------------------
// Console routing
// --------------------

function ensureConsoleObj() {
  const c = globalThis.console;
  if (c && typeof c === "object") return c;
  const out = {};
  try {
    Object.defineProperty(globalThis, "console", {
      value: out,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    try {
      globalThis.console = out;
    } catch {
      // ignore
    }
  }
  return out;
}

function captureConsoleOriginals() {
  const c = ensureConsoleObj();
  if (!globalThis.__denojs_worker_console_originals) {
    globalThis.__denojs_worker_console_originals = { methods: Object.create(null) };
  }
  const orig = globalThis.__denojs_worker_console_originals;
  if (!orig.methods) orig.methods = Object.create(null);

  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  for (const m of methods) {
    if (!(m in orig.methods) && typeof c[m] === "function") {
      orig.methods[m] = c[m];
    }
  }
}

function restoreConsoleMethod(method) {
  const c = ensureConsoleObj();
  const orig = globalThis.__denojs_worker_console_originals;
  const fn = orig && orig.methods ? orig.methods[method] : undefined;
  if (typeof fn === "function") {
    safeObjSet(c, method, fn);
  }
}

function makeNoop() {
  return function () { };
}

function makeConsoleWrapper(fn) {
  return function (...args) {
    try {
      const out = fn(...args);
      if (isThenable(out)) {
        out.then(
          () => { },
          () => { }
        );
      }
    } catch {
      // ignore
    }
  };
}

globalThis.__applyConsoleConfig = () => {
  captureConsoleOriginals();

  const c = ensureConsoleObj();
  const cfg = globalThis.__denojs_worker_console;

  const methods = ["log", "info", "warn", "error", "debug", "trace"];

  if (cfg === false) {
    const noop = makeNoop();
    for (const m of methods) safeObjSet(c, m, noop);
    return;
  }

  if (!cfg || typeof cfg !== "object") {
    for (const m of methods) restoreConsoleMethod(m);
    return;
  }

  for (const m of methods) {
    if (!(m in cfg) || cfg[m] == null) {
      restoreConsoleMethod(m);
      continue;
    }

    const v = cfg[m];

    if (v === false) {
      safeObjSet(c, m, makeNoop());
      continue;
    }

    if (typeof v === "function") {
      // If this is a host function wrapper, use console-specific dehydration rules.
      if (isHostFnWrapper(v)) safeObjSet(c, m, makeConsoleHostWrapper(v));
      else safeObjSet(c, m, makeConsoleWrapper(v));
      continue;
    }

    restoreConsoleMethod(m);
  }
};

// --------------------
// Globals application support
// --------------------

globalThis.__globals = Object.create(null);
globalThis.__applyGlobals = () => {
  for (const [k, v] of Object.entries(globalThis.__globals)) {
    globalThis[k] = globalThis.__hydrate(v);
  }

  try {
    if (typeof globalThis.__applyConsoleConfig === "function") {
      globalThis.__applyConsoleConfig();
    }
  } catch {
    // ignore
  }
};

export { };
