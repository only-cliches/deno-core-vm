// src/worker/bootstrap.js
// Extension ESM entrypoint.

import * as coreMod from "ext:core/mod.js";

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
  if (captured && captured.kind === "function" && typeof captured.entry === "function") {
    const out = captured.entry(...args);
    return isThenable(out) ? await out : out;
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
const OP_POST_MESSAGE = "op_denojs_worker_post_message";

// Capture stable references at bootstrap time.
const CAP_HOST_CALL_SYNC = getOpEntry(OP_HOST_CALL_SYNC);
const CAP_HOST_CALL_ASYNC = getOpEntry(OP_HOST_CALL_ASYNC);
const CAP_POST_MESSAGE = getOpEntry(OP_POST_MESSAGE);

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

function dehydrateAny(v) {
  const seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;

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

    if (Array.isArray(x)) return x.map((it) => inner(it, depth + 1));

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
      if (seen) {
        if (seen.has(x)) return wireUndef();
        seen.add(x);
      }

      const out = {};
      for (const [k, val] of Object.entries(x)) {
        out[k] = inner(val, depth + 1);
      }
      return out;
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
  const isAsync = !!fn.__denojs_worker_host_async;
  const payloadArgs = dehydrateConsoleArgs(args);

  if (isAsync) return hostCallAsync(id, payloadArgs);

  // Sync wrapper: keep the same Promise fallback behavior as __hydrate\u2019s sync wrapper
  try {
    return hostCallSync(id, payloadArgs);
  } catch (e) {
    // If sync op indicates Promise, use async
    try {
      const msg = e && typeof e.message === "string" ? e.message : String(e);
      if (msg.includes("Sync host function returned a Promise")) {
        return hostCallAsync(id, payloadArgs);
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
  // on('message'): payload
  for (const fn of globalThis.__nodeOnMessageHandlers) {
    try {
      fn(payload);
    } catch {
      // ignore
    }
  }

  // addEventListener('message'): payload (test expects payload, not { data })
  for (const fn of globalThis.__nodeMessageEventListeners) {
    try {
      fn(payload);
    } catch {
      // ignore
    }
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

async function hostCallAsync(funcId, payloadArgs) {
  const res = await callCapturedAwait(CAP_HOST_CALL_ASYNC, OP_HOST_CALL_ASYNC, funcId, payloadArgs);
  return handleHostReply(res);
}

function hostCallSync(funcId, payloadArgs) {
  const out = callCapturedRaw(CAP_HOST_CALL_SYNC, OP_HOST_CALL_SYNC, funcId, payloadArgs);
  if (isThenable(out)) {
    return out.then((res) => handleHostReply(res));
  }
  return handleHostReply(out);
}

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

globalThis.__hydrate = function (v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(globalThis.__hydrate);
  if (typeof v !== "object") return v;

  if (v.__undef === true) return undefined;

  if (v.__denojs_worker_num === "-0") return -0;

  if (v.__num === "NaN") return NaN;
  if (v.__num === "Infinity") return Infinity;
  if (v.__num === "-Infinity") return -Infinity;

  if (v.__date !== undefined) return new Date(v.__date);

  if (v.__bigint !== undefined) {
    try {
      return BigInt(String(v.__bigint));
    } catch {
      return undefined;
    }
  }

  if (v.__regexp && typeof v.__regexp === "object") {
    try {
      const src = String(v.__regexp.source ?? "");
      const flags = String(v.__regexp.flags ?? "");
      return new RegExp(src, flags);
    } catch {
      return undefined;
    }
  }

  if (v.__url !== undefined) {
    try {
      return new URL(String(v.__url));
    } catch {
      return String(v.__url);
    }
  }

  if (v.__urlSearchParams !== undefined) {
    try {
      return new URLSearchParams(String(v.__urlSearchParams));
    } catch {
      return String(v.__urlSearchParams);
    }
  }

  if (v.__buffer !== undefined) {
    const bv = bufferViewFromWire(v);
    if (bv != null) return bv;
    return undefined;
  }

  if (v.__map !== undefined && Array.isArray(v.__map)) {
    const m = new Map();
    for (const pair of v.__map) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const kk = globalThis.__hydrate(pair[0]);
      const vv = globalThis.__hydrate(pair[1]);
      m.set(kk, vv);
    }
    return m;
  }

  if (v.__set !== undefined && Array.isArray(v.__set)) {
    const s = new Set();
    for (const item of v.__set) s.add(globalThis.__hydrate(item));
    return s;
  }

  if (v.__denojs_worker_type === "error") {
    const msg = String(v.message ?? "");
    const e = new Error(msg);

    if (typeof v.name === "string") e.name = v.name;

    safeObjSet(e, "name", typeof v.name === "string" ? v.name : e.name);
    safeObjSet(e, "message", msg);

    if (typeof v.stack === "string") safeObjSet(e, "stack", v.stack);
    if ("code" in v && v.code != null) safeObjSet(e, "code", v.code);

    if ("cause" in v && v.cause != null) {
      try {
        e.cause = globalThis.__hydrate(v.cause);
        safeObjSet(e, "cause", e.cause);
      } catch {
        // ignore
      }
    }

    return e;
  }

  if (v.__denojs_worker_type === "function" && typeof v.id === "number") {
    const id = v.id;
    const isAsync = !!v.async;

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
        return await hostCallAsync(id, payloadArgs);
      };
    } else {
      fn = (...args) => {
        const payloadArgs = dehydrateArgs(args);
        try {
          return hostCallSync(id, payloadArgs);
        } catch (e) {
          if (isSyncReturnedPromiseError(e)) {
            return hostCallAsync(id, payloadArgs);
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
  for (const [k, val] of Object.entries(v)) out[k] = globalThis.__hydrate(val);
  return out;
};

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
