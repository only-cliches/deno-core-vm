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

function isThenable(x) {
  return (
    x != null &&
    (typeof x === "object" || typeof x === "function") &&
    typeof x.then === "function"
  );
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

// Unique op names to avoid collisions with built-in ops.
const OP_HOST_CALL_SYNC = "op_denojs_worker_host_call_sync";
const OP_HOST_CALL_ASYNC = "op_denojs_worker_host_call_async";
const OP_POST_MESSAGE = "op_denojs_worker_post_message";

// Capture stable references at bootstrap time.
const CAP_HOST_CALL_SYNC = getOpEntry(OP_HOST_CALL_SYNC);
const CAP_HOST_CALL_ASYNC = getOpEntry(OP_HOST_CALL_ASYNC);
const CAP_POST_MESSAGE = getOpEntry(OP_POST_MESSAGE);

function callCapturedRaw(captured, name, ...args) {
  if (captured && captured.kind === "function" && typeof captured.entry === "function") {
    return captured.entry(...args);
  }

  const kind = captured ? captured.kind : "missing_capture";
  throw new Error(`${name} is unavailable (captured kind=${kind})`);
}

async function callCapturedAwait(captured, name, ...args) {
  if (captured && captured.kind === "function" && typeof captured.entry === "function") {
    const out = captured.entry(...args);
    return isThenable(out) ? await out : out;
  }

  const kind = captured ? captured.kind : "missing_capture";
  throw new Error(`${name} is unavailable (captured kind=${kind})`);
}

// --------------------
// Wire helpers
// --------------------

function dehydrateAny(v) {
  const seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;

  function inner(x, depth) {
    if (x === undefined || x === null) return null;
    if (depth > 200) return null;

    const t = typeof x;

    if (t === "number") {
      if (Object.is(x, -0)) return { __denojs_worker_num: "-0" };
      if (!Number.isFinite(x)) return null;
      return x;
    }
    if (t === "string" || t === "boolean") return x;
    if (t === "bigint") return x.toString();
    if (t === "function" || t === "symbol") return null;

    if (Array.isArray(x)) return x.map((it) => inner(it, depth + 1));

    if (typeof Date !== "undefined" && x instanceof Date) {
      return { __date: x.getTime() };
    }

    if (typeof Uint8Array !== "undefined" && x instanceof Uint8Array) {
      return { __bytes: Array.from(x) };
    }

    if (typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer) {
      return { __bytes: Array.from(new Uint8Array(x)) };
    }

    if (typeof SharedArrayBuffer !== "undefined" && x instanceof SharedArrayBuffer) {
      return { __bytes: Array.from(new Uint8Array(x)) };
    }

    if (typeof Error !== "undefined" && x instanceof Error) {
      const out = {
        __denojs_worker_type: "error",
        name: typeof x.name === "string" ? x.name : "Error",
        message: typeof x.message === "string" ? x.message : String(x.message ?? ""),
      };
      if (typeof x.stack === "string") out.stack = x.stack;
      if ("code" in x && x.code != null) out.code = String(x.code);
      return out;
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

function dehydrateArgs(args) {
  try {
    return Array.isArray(args) ? args.map((a) => dehydrateAny(a)) : [];
  } catch {
    return [];
  }
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

globalThis.__nodeMessageListeners = [];

const onImpl = (name, fn) => {
  if (name === "message" && typeof fn === "function") globalThis.__nodeMessageListeners.push(fn);
};

const addEventListenerImpl = (name, fn) => {
  if (name === "message" && typeof fn === "function") {
    globalThis.__nodeMessageListeners.push((e) => fn(e));
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
  for (const fn of globalThis.__nodeMessageListeners) {
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
  const res = await callCapturedAwait(
    CAP_HOST_CALL_ASYNC,
    OP_HOST_CALL_ASYNC,
    funcId,
    payloadArgs
  );
  return handleHostReply(res);
}

function hostCallSync(funcId, payloadArgs) {
  const out = callCapturedRaw(CAP_HOST_CALL_SYNC, OP_HOST_CALL_SYNC, funcId, payloadArgs);
  if (isThenable(out)) {
    return out.then((res) => handleHostReply(res));
  }
  return handleHostReply(out);
}

globalThis.__hydrate = function (v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(globalThis.__hydrate);
  if (typeof v !== "object") return v;

  if (v.__date !== undefined) return new Date(v.__date);
  if (v.__bytes !== undefined) return new Uint8Array(v.__bytes);
  if (v.__denojs_worker_num === "-0") return -0;

  if (v.__denojs_worker_type === "error") {
    const e = new Error(String(v.message ?? ""));
    if (typeof v.name === "string") e.name = v.name;
    if (typeof v.stack === "string") e.stack = v.stack;
    if ("code" in v) e.code = v.code;
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

    if (isAsync) {
      return async (...args) => {
        const payloadArgs = dehydrateArgs(args);
        return await hostCallAsync(id, payloadArgs);
      };
    }

    return (...args) => {
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

  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = globalThis.__hydrate(val);
  return out;
};

// --------------------
// Console routing
// --------------------

function safeDefine(obj, key, val) {
  try {
    Object.defineProperty(obj, key, {
      value: val,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    try {
      obj[key] = val;
    } catch {
      // ignore
    }
  }
}

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
    safeDefine(c, method, fn);
  }
}

function makeNoop() {
  return function () {};
}

function makeConsoleWrapper(fn) {
  return function (...args) {
    try {
      const out = fn(...args);
      if (isThenable(out)) {
        out.then(
          () => {},
          () => {}
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

  // cfg === false => dev/null everything
  if (cfg === false) {
    const noop = makeNoop();
    for (const m of methods) safeDefine(c, m, noop);
    return;
  }

  // cfg missing or non-object => restore defaults
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
      safeDefine(c, m, makeNoop());
      continue;
    }

    if (typeof v === "function") {
      safeDefine(c, m, makeConsoleWrapper(v));
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

globalThis.moduleReturn = (v) => {
  globalThis.__moduleReturn = v;
};

export { };