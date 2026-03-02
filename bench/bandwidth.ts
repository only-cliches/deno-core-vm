// bench/bandwidth.ts
//
// Bandwidth benchmark between Node and the embedded Deno runtime.
// Instrumented with verbose logging to pinpoint hangs.
//
// Usage:
//   npx tsx bench/bandwidth.ts
//   npx tsx bench/bandwidth.ts --duration-ms 3000 --size 4192 --messages 200 --ack-every 25
//   npx tsx bench/bandwidth.ts --log-queue
//
// Notes:
// - End-to-end throughput includes serialization and dispatch overhead.
// - Avoids message races by installing exactly one dw.on("message") handler for the entire run.
// - If it hangs, the logs should show the last completed step.

import { DenoWorker } from "../src/index";

type Args = {
  size: number;
  messages: number;
  graphMessages: number;
  graphDepth: number;
  graphFanout: number;
  graphShare: number;
  evalIter: number;
  durationMs: number;
  ackEvery: number;
  warmup: number;
  json: boolean;
  timeoutMs: number;
  logQueue: boolean;
  logEverySend: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    size: 1 * 1024 * 1024,
    messages: 200,
    graphMessages: 200,
    graphDepth: 5,
    graphFanout: 3,
    graphShare: 0.35,
    evalIter: 50,
    durationMs: 2500,
    ackEvery: 25,
    warmup: 5,
    json: false,
    timeoutMs: 20_000,
    logQueue: false,
    logEverySend: 0,
  };

  const take = (k: string) => {
    const i = argv.indexOf(k);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };

  const toInt = (s: string | undefined, fallback: number) => {
    if (!s) return fallback;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const toFloat = (s: string | undefined, fallback: number) => {
    if (!s) return fallback;
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  };

  out.size = toInt(take("--size"), out.size);
  out.messages = toInt(take("--messages"), out.messages);
  out.graphMessages = toInt(take("--graph-messages"), out.graphMessages);
  out.graphDepth = Math.max(1, toInt(take("--graph-depth"), out.graphDepth));
  out.graphFanout = Math.max(1, toInt(take("--graph-fanout"), out.graphFanout));
  out.graphShare = Math.min(0.95, Math.max(0, toFloat(take("--graph-share"), out.graphShare)));
  out.evalIter = toInt(take("--eval-iter"), out.evalIter);
  out.durationMs = toInt(take("--duration-ms"), out.durationMs);
  out.ackEvery = toInt(take("--ack-every"), out.ackEvery);
  out.warmup = toInt(take("--warmup"), out.warmup);
  out.timeoutMs = toInt(take("--timeout-ms"), out.timeoutMs);
  out.logEverySend = toInt(take("--log-every-send"), out.logEverySend);

  out.json = argv.includes("--json");
  out.logQueue = argv.includes("--log-queue");

  return out;
}

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function nsToSec(ns: bigint): number {
  return Number(ns) / 1_000_000_000;
}

function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function mibPerSec(bytes: number, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return bytesToMiB(bytes) / seconds;
}

function makeBytes(size: number): Buffer {
  // Use Node Buffer so Neon reliably sees it as JsBuffer and bridges as Bytes -> {__bytes} -> Uint8Array in the worker.
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
  return b;
}

function makeRecursiveGraphPayload(depth: number, fanout: number, share: number): Record<string, unknown> {
  let seq = 0;
  const pool: Array<Record<string, unknown>> = [];

  function shouldReuse(id: number, edge: number): boolean {
    if (pool.length === 0) return false;
    const bucket = ((id * 31 + edge * 17 + 13) % 10_000) / 10_000;
    return bucket < share;
  }

  function build(level: number): Record<string, unknown> {
    const id = seq++;
    const node: Record<string, unknown> = {
      id,
      level,
      label: `n-${id}`,
      even: (id & 1) === 0,
      scalar: (id * 2654435761) >>> 0,
    };
    pool.push(node);

    if (level <= 0) return node;

    for (let i = 0; i < fanout; i++) {
      if (shouldReuse(id, i)) {
        const ref = pool[(id + i * 7) % pool.length];
        node[`c${i}`] = ref;
      } else {
        node[`c${i}`] = build(level - 1);
      }
    }

    if (id % 5 === 0) node.self = node;
    if (pool.length > 2 && id % 7 === 0) node.peer = pool[(id * 11) % pool.length];
    return node;
  }

  const root = build(depth);
  root.root = root;
  root.meta = {
    depth,
    fanout,
    share,
    nodes: pool.length,
  };
  return root;
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "NaN";
  return n.toFixed(digits);
}

type BenchResult = {
  name: string;
  bytes: number;
  seconds: number;
  mibPerSec: number;
  extra?: Record<string, unknown>;
};

function printResults(results: BenchResult[]) {
  const rows = results.map((r) => ({
    Path: r.name,
    "Total MiB": fmt(bytesToMiB(r.bytes), 2),
    Seconds: fmt(r.seconds, 3),
    "MiB/s": fmt(r.mibPerSec, 2),
  }));

  const widths = {
    Path: Math.max("Path".length, ...rows.map((r) => r.Path.length)),
    "Total MiB": Math.max("Total MiB".length, ...rows.map((r) => r["Total MiB"].length)),
    Seconds: Math.max("Seconds".length, ...rows.map((r) => r.Seconds.length)),
    "MiB/s": Math.max("MiB/s".length, ...rows.map((r) => r["MiB/s"].length)),
  };

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  const header =
    pad("Path", widths.Path) +
    "  " +
    pad("Total MiB", widths["Total MiB"]) +
    "  " +
    pad("Seconds", widths.Seconds) +
    "  " +
    pad("MiB/s", widths["MiB/s"]);

  const sep =
    "-".repeat(widths.Path) +
    "  " +
    "-".repeat(widths["Total MiB"]) +
    "  " +
    "-".repeat(widths.Seconds) +
    "  " +
    "-".repeat(widths["MiB/s"]);

  // eslint-disable-next-line no-console
  console.log(header);
  // eslint-disable-next-line no-console
  console.log(sep);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(
      pad(r.Path, widths.Path) +
        "  " +
        pad(r["Total MiB"], widths["Total MiB"]) +
        "  " +
        pad(r.Seconds, widths.Seconds) +
        "  " +
        pad(r["MiB/s"], widths["MiB/s"])
    );
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Single-listener buffered message bus to avoid missing fast messages.
 * DenoWorker does not expose an "off" API, so this installs one handler for the run.
 */
class MessageBus {
  private queue: any[] = [];
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void; label: string }> =
    [];
  private recvCount = 0;
  private lastRecvAt = Date.now();

  constructor(
    private readonly dw: DenoWorker,
    private readonly opts: { logQueue: boolean }
  ) {
    dw.on("message", (msg: any) => this.onMessage(msg));
  }

  stats() {
    return {
      recvCount: this.recvCount,
      queueLen: this.queue.length,
      waiters: this.waiters.length,
      lastRecvAgoMs: Date.now() - this.lastRecvAt,
    };
  }

  private onMessage(msg: any) {
    this.recvCount++;
    this.lastRecvAt = Date.now();

    if (this.opts.logQueue) {
      const kind =
        msg && typeof msg === "object"
          ? msg.kind ?? (msg.__bench_done ? "__bench_done" : msg.__bench_ack ? "__bench_ack" : "obj")
          : typeof msg;
     
    }

    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      let ok = false;
      try {
        ok = w.pred(msg);
      } catch {
        ok = false;
      }
      if (ok) {
        this.waiters.splice(i, 1);
        if (this.opts.logQueue) {
         
        }
        w.resolve(msg);
        return;
      }
    }

    this.queue.push(msg);
    if (this.opts.logQueue) {
     
    }
  }

  dumpHead(n = 5) {
    return this.queue.slice(0, n);
  }

  async waitFor(pred: (m: any) => boolean, timeoutMs: number, label: string): Promise<any> {

    for (let i = 0; i < this.queue.length; i++) {
      const m = this.queue[i];
      let ok = false;
      try {
        ok = pred(m);
      } catch {
        ok = false;
      }
      if (ok) {
        this.queue.splice(i, 1);
        return m;
      }
    }

    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const head = this.dumpHead(5);
        const st = this.stats();
        reject(
          new Error(
            `Timeout waiting for message: ${label}. Stats=${safeJson(st)} queueHead=${safeJson(head)}`
          )
        );
      }, Math.max(1, timeoutMs));

      this.waiters.push({
        pred,
        label,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
}
function buildWorkerBenchModuleSource(): string {
  return `
    globalThis.__bench = {
      _nodeToWorkerBytes: 0,
      _nodeToWorkerMsgs: 0,
      _nodeToWorkerTargetMsgs: 0,
      _nodeToWorkerAckEvery: 25,
      _nodeToWorkerGraphWeight: 0,
      _nodeToWorkerGraphMsgs: 0,
      _nodeToWorkerGraphTargetMsgs: 0,
      _nodeToWorkerMode: "bytes",

      _nodeToWorkerReset(targetMsgs, ackEvery) {
        this._nodeToWorkerBytes = 0;
        this._nodeToWorkerMsgs = 0;
        this._nodeToWorkerTargetMsgs = targetMsgs >>> 0;
        this._nodeToWorkerAckEvery = ackEvery >>> 0;
        this._nodeToWorkerMode = "bytes";
      },

      _nodeToWorkerGraphReset(targetMsgs, ackEvery) {
        this._nodeToWorkerGraphWeight = 0;
        this._nodeToWorkerGraphMsgs = 0;
        this._nodeToWorkerGraphTargetMsgs = targetMsgs >>> 0;
        this._nodeToWorkerAckEvery = ackEvery >>> 0;
        this._nodeToWorkerMode = "graph";
      },

      async workerToNodePostMessage(size, messages, durationMs) {
        const payload = new Uint8Array(size >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

        const count = messages >>> 0;
        const dur = durationMs >>> 0;

        const start = Date.now();
        let sent = 0;
        let bytes = 0;

        if (dur > 0) {
          while ((Date.now() - start) < dur) {
            postMessage(payload);
            sent++;
            bytes += payload.byteLength;
          }
        } else {
          for (let i = 0; i < count; i++) {
            postMessage(payload);
            sent++;
            bytes += payload.byteLength;
          }
        }

        postMessage({ __bench_done: true, kind: "workerToNodePostMessage", sent, bytes });
        return { sent, bytes };
      },

      async hostCallSyncSink(size, calls, durationMs) {
        const payload = new Uint8Array(size >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

        const n = calls >>> 0;
        const dur = durationMs >>> 0;

        const start = Date.now();
        let sent = 0;
        let bytes = 0;

        if (dur > 0) {
          while ((Date.now() - start) < dur) {
            globalThis.__bench_sink_sync(payload);
            sent++;
            bytes += payload.byteLength;
          }
        } else {
          for (let i = 0; i < n; i++) {
            globalThis.__bench_sink_sync(payload);
            sent++;
            bytes += payload.byteLength;
          }
        }

        postMessage({ __bench_done: true, kind: "hostCallSyncSink", sent, bytes });
        return { sent, bytes };
      },

      async hostCallAsyncSink(size, calls, durationMs) {
        const payload = new Uint8Array(size >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

        const n = calls >>> 0;
        const dur = durationMs >>> 0;

        const start = Date.now();
        let sent = 0;
        let bytes = 0;

        if (dur > 0) {
          while ((Date.now() - start) < dur) {
            await globalThis.__bench_sink_async(payload);
            sent++;
            bytes += payload.byteLength;
          }
        } else {
          for (let i = 0; i < n; i++) {
            await globalThis.__bench_sink_async(payload);
            sent++;
            bytes += payload.byteLength;
          }
        }

        postMessage({ __bench_done: true, kind: "hostCallAsyncSink", sent, bytes });
        return { sent, bytes };
      },

      async evalReturnBytes(size) {
        const payload = new Uint8Array(size >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        return payload;
      },

      async evalReturnJsonBytes(size) {
        const payload = new Uint8Array(size >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        return Array.from(payload);
      },
    };

    function __benchByteLength(msg) {
      try {
        if (msg instanceof Uint8Array) return msg.byteLength;

        // If Rust bridges Bytes through wire format, __hydrate turns {__bytes:[...]} into Uint8Array.
        if (msg && typeof msg === "object") {
          if (msg.payload instanceof Uint8Array) return msg.payload.byteLength;

          // Defensive: if something bypasses __hydrate and we still see wire JSON.
          if (Array.isArray(msg.__bytes)) return msg.__bytes.length;
          if (Array.isArray(msg.payload && msg.payload.__bytes)) return msg.payload.__bytes.length;

          // Defensive: some conversions might produce a numeric array directly.
          if (Array.isArray(msg) && (msg.length === 0 || typeof msg[0] === "number")) return msg.length;
        }
      } catch {
        // ignore
      }
      return 0;
    }

    function __benchGraphWeight(msg) {
      const seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;
      const stack = [msg];
      let total = 0;

      while (stack.length > 0) {
        const v = stack.pop();
        if (v == null) {
          total += 4;
          continue;
        }

        const t = typeof v;
        if (t === "boolean") {
          total += 4;
          continue;
        }
        if (t === "number") {
          total += 8;
          continue;
        }
        if (t === "bigint") {
          total += String(v).length;
          continue;
        }
        if (t === "string") {
          total += v.length * 2;
          continue;
        }
        if (t === "function" || t === "symbol") {
          total += 0;
          continue;
        }

        if (seen) {
          if (seen.has(v)) continue;
          seen.add(v);
        }

        if (v instanceof Uint8Array) {
          total += v.byteLength;
          continue;
        }
        if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) {
          total += v.byteLength;
          continue;
        }
        if (Array.isArray(v)) {
          total += 16 + v.length * 4;
          for (let i = 0; i < v.length; i++) stack.push(v[i]);
          continue;
        }
        if (v instanceof Map) {
          total += 24;
          for (const [k, vv] of v.entries()) {
            stack.push(k);
            stack.push(vv);
          }
          continue;
        }
        if (v instanceof Set) {
          total += 24;
          for (const vv of v.values()) stack.push(vv);
          continue;
        }
        if (typeof v === "object") {
          total += 24;
          for (const [k, vv] of Object.entries(v)) {
            total += k.length * 2;
            stack.push(vv);
          }
        }
      }

      return total >>> 0;
    }

    globalThis.on("message", (msg) => {
      try {
        if (msg && typeof msg === "object" && msg.__bench_cmd === "nodeToWorkerReset") {
          globalThis.__bench._nodeToWorkerReset(msg.targetMsgs, msg.ackEvery);
          postMessage({ __bench_ack: true, kind: "nodeToWorkerReset" });
          return;
        }
        if (msg && typeof msg === "object" && msg.__bench_cmd === "nodeToWorkerGraphReset") {
          globalThis.__bench._nodeToWorkerGraphReset(msg.targetMsgs, msg.ackEvery);
          postMessage({ __bench_ack: true, kind: "nodeToWorkerGraphReset" });
          return;
        }

        const bytes = __benchByteLength(msg);
        if (globalThis.__bench._nodeToWorkerMode === "bytes" && bytes > 0) {
          globalThis.__bench._nodeToWorkerMsgs++;
          globalThis.__bench._nodeToWorkerBytes += bytes;

          const every = globalThis.__bench._nodeToWorkerAckEvery || 0;
          if (every > 0 && (globalThis.__bench._nodeToWorkerMsgs % every) === 0) {
            postMessage({ __bench_ack: true, kind: "nodeToWorkerProgress", msgs: globalThis.__bench._nodeToWorkerMsgs });
          }

          if (globalThis.__bench._nodeToWorkerTargetMsgs > 0 &&
              globalThis.__bench._nodeToWorkerMsgs >= globalThis.__bench._nodeToWorkerTargetMsgs) {
            postMessage({
              __bench_done: true,
              kind: "nodeToWorkerPostMessage",
              receivedMsgs: globalThis.__bench._nodeToWorkerMsgs,
              receivedBytes: globalThis.__bench._nodeToWorkerBytes,
            });
          }
        }

        if (globalThis.__bench._nodeToWorkerMode === "graph" && msg && typeof msg === "object") {
          globalThis.__bench._nodeToWorkerGraphMsgs++;
          globalThis.__bench._nodeToWorkerGraphWeight += __benchGraphWeight(msg);

          const every = globalThis.__bench._nodeToWorkerAckEvery || 0;
          if (every > 0 && (globalThis.__bench._nodeToWorkerGraphMsgs % every) === 0) {
            postMessage({
              __bench_ack: true,
              kind: "nodeToWorkerGraphProgress",
              msgs: globalThis.__bench._nodeToWorkerGraphMsgs,
            });
          }

          if (globalThis.__bench._nodeToWorkerGraphTargetMsgs > 0 &&
              globalThis.__bench._nodeToWorkerGraphMsgs >= globalThis.__bench._nodeToWorkerGraphTargetMsgs) {
            postMessage({
              __bench_done: true,
              kind: "nodeToWorkerRecursiveGraph",
              receivedMsgs: globalThis.__bench._nodeToWorkerGraphMsgs,
              receivedBytes: globalThis.__bench._nodeToWorkerGraphWeight,
            });
          }
        }
      } catch {
        // ignore
      }
    });

    export const __benchReady = true;
  `;
}

async function benchWorkerToNodePostMessage(
  dw: DenoWorker,
  bus: MessageBus,
  args: Args
): Promise<BenchResult> {
  const { size, messages, durationMs, warmup, timeoutMs } = args;
 

  for (let i = 0; i < warmup; i++) {
    // eslint-disable-next-line no-await-in-loop
    await dw.evalModule(
      `await globalThis.__bench.workerToNodePostMessage(${Math.max(
        1024,
        Math.min(16_384, size)
      )}, 5, 0);`
    );
    // eslint-disable-next-line no-await-in-loop
    await bus.waitFor(
      (m) => m && m.__bench_done === true && m.kind === "workerToNodePostMessage",
      timeoutMs,
      "workerToNodePostMessage warmup done"
    );
  }

 

  const start = nowNs();

 
  void dw.evalModule(`await globalThis.__bench.workerToNodePostMessage(${size}, ${messages}, ${durationMs});`);

 
  const done = await bus.waitFor(
    (m) => m && m.__bench_done === true && m.kind === "workerToNodePostMessage",
    timeoutMs,
    "workerToNodePostMessage done"
  );

  const end = nowNs();

 

  const bytes = typeof done.bytes === "number" ? done.bytes : 0;
  const seconds = nsToSec(end - start);

  return {
    name: "Worker -> Node postMessage (Uint8Array)",
    bytes,
    seconds,
    mibPerSec: mibPerSec(bytes, seconds),
    extra: { sent: done.sent },
  };
}

async function benchHostCallSync(dw: DenoWorker, bus: MessageBus, args: Args): Promise<BenchResult> {
  const { size, durationMs, warmup, timeoutMs } = args;
 

 
  await dw.setGlobal("__bench_sink_sync", (buf: any) => {
    if (buf && typeof buf === "object" && typeof buf.byteLength === "number") return buf.byteLength;
    if (Array.isArray(buf)) return buf.length;
    return 0;
  });

  for (let i = 0; i < warmup; i++) {
    // eslint-disable-next-line no-await-in-loop
    await dw.evalModule(
      `await globalThis.__bench.hostCallSyncSink(${Math.max(
        1024,
        Math.min(16_384, size)
      )}, 50, 0);`
    );
    // eslint-disable-next-line no-await-in-loop
    await bus.waitFor(
      (m) => m && m.__bench_done === true && m.kind === "hostCallSyncSink",
      timeoutMs,
      "hostCallSyncSink warmup done"
    );
  }

 
  const start = nowNs();

  void dw.evalModule(`await globalThis.__bench.hostCallSyncSink(${size}, 0, ${durationMs});`);

 
  const done = await bus.waitFor(
    (m) => m && m.__bench_done === true && m.kind === "hostCallSyncSink",
    timeoutMs,
    "hostCallSyncSink done"
  );

  const end = nowNs();

 

  const bytes = typeof done.bytes === "number" ? done.bytes : 0;
  const seconds = nsToSec(end - start);

  return {
    name: "Worker -> Node host call (sync) with Uint8Array arg",
    bytes,
    seconds,
    mibPerSec: mibPerSec(bytes, seconds),
    extra: { calls: done.sent },
  };
}

async function benchHostCallAsync(dw: DenoWorker, bus: MessageBus, args: Args): Promise<BenchResult> {
  const { size, durationMs, warmup, timeoutMs } = args;
 

 
  await dw.setGlobal("__bench_sink_async", async (buf: any) => {
    if (buf && typeof buf === "object" && typeof buf.byteLength === "number") return buf.byteLength;
    if (Array.isArray(buf)) return buf.length;
    return 0;
  });

  for (let i = 0; i < warmup; i++) {
    // eslint-disable-next-line no-await-in-loop
    await dw.evalModule(
      `await globalThis.__bench.hostCallAsyncSink(${Math.max(
        1024,
        Math.min(16_384, size)
      )}, 20, 0);`
    );
    // eslint-disable-next-line no-await-in-loop
    await bus.waitFor(
      (m) => m && m.__bench_done === true && m.kind === "hostCallAsyncSink",
      timeoutMs,
      "hostCallAsyncSink warmup done"
    );
  }

 
  const start = nowNs();

  void dw.evalModule(`await globalThis.__bench.hostCallAsyncSink(${size}, 0, ${durationMs});`);

 
  const done = await bus.waitFor(
    (m) => m && m.__bench_done === true && m.kind === "hostCallAsyncSink",
    timeoutMs,
    "hostCallAsyncSink done"
  );

  const end = nowNs();

 

  const bytes = typeof done.bytes === "number" ? done.bytes : 0;
  const seconds = nsToSec(end - start);

  return {
    name: "Worker -> Node host call (async) with Uint8Array arg (sequential await)",
    bytes,
    seconds,
    mibPerSec: mibPerSec(bytes, seconds),
    extra: { calls: done.sent },
  };
}

async function benchNodeToWorkerPostMessage(
  dw: DenoWorker,
  bus: MessageBus,
  args: Args
): Promise<BenchResult> {
  const { size, messages, ackEvery, warmup, timeoutMs, logEverySend } = args;

 

  // Buffer (not Uint8Array) to ensure Neon bridges it as JsBuffer -> Bytes -> {__bytes} -> Uint8Array.
  const payload = makeBytes(size);

 
  for (let i = 0; i < warmup; i++) dw.postMessage(payload);
 

 
  dw.postMessage({ __bench_cmd: "nodeToWorkerReset", targetMsgs: messages, ackEvery });

 
  await bus.waitFor(
    (m) => m && m.__bench_ack === true && m.kind === "nodeToWorkerReset",
    timeoutMs,
    "nodeToWorkerReset ack"
  );

 

  const start = nowNs();

  if (logEverySend > 0) {
    for (let i = 0; i < messages; i++) {
      dw.postMessage(payload);
    }
  } else {
    for (let i = 0; i < messages; i++) dw.postMessage(payload);
  }

 

  const done = await bus.waitFor(
    (m) => m && m.__bench_done === true && m.kind === "nodeToWorkerPostMessage",
    timeoutMs,
    "nodeToWorkerPostMessage done"
  );

  const end = nowNs();

 

  const receivedBytes =
    typeof done.receivedBytes === "number" ? done.receivedBytes : messages * payload.byteLength;

  const seconds = nsToSec(end - start);

  return {
    name: "Node -> Worker postMessage (Buffer -> Uint8Array)",
    bytes: receivedBytes,
    seconds,
    mibPerSec: mibPerSec(receivedBytes, seconds),
    extra: { receivedMsgs: done.receivedMsgs },
  };
}

async function benchNodeToWorkerPostMessagesBatch(
  dw: DenoWorker,
  bus: MessageBus,
  args: Args
): Promise<BenchResult> {
  const { size, messages, ackEvery, warmup, timeoutMs } = args;
  const chunkSize = Math.max(1, Math.min(64, Math.floor(messages / 4) || 8));
  const payload = makeBytes(size);

  if (typeof (dw as any).postMessages !== "function") {
    return {
      name: "Node -> Worker postMessages batch (Buffer[])",
      bytes: 0,
      seconds: 0,
      mibPerSec: 0,
      extra: { skipped: true, reason: "native postMessages API unavailable" },
    };
  }

  for (let i = 0; i < warmup; i++) {
    dw.postMessage({ __bench_cmd: "nodeToWorkerReset", targetMsgs: 4, ackEvery: 0 });
    await bus.waitFor(
      (m) => m && m.__bench_ack === true && m.kind === "nodeToWorkerReset",
      timeoutMs,
      "nodeToWorkerReset (batch warmup ack)"
    );
    const arr = [payload, payload, payload, payload];
    const sent = (dw as any).postMessages(arr);
    if (sent !== arr.length) throw new Error("postMessages warmup dropped");
    await bus.waitFor(
      (m) => m && m.__bench_done === true && m.kind === "nodeToWorkerPostMessage",
      timeoutMs,
      "nodeToWorkerPostMessages warmup done"
    );
  }

  dw.postMessage({ __bench_cmd: "nodeToWorkerReset", targetMsgs: messages, ackEvery });
  await bus.waitFor(
    (m) => m && m.__bench_ack === true && m.kind === "nodeToWorkerReset",
    timeoutMs,
    "nodeToWorkerReset (batch ack)"
  );

  const start = nowNs();
  let sentMsgs = 0;
  while (sentMsgs < messages) {
    const n = Math.min(chunkSize, messages - sentMsgs);
    const arr = new Array(n).fill(payload);
    const sent = (dw as any).postMessages(arr);
    if (sent !== n) throw new Error(`postMessages dropped at ${sentMsgs}/${messages}`);
    sentMsgs += sent;
  }

  const done = await bus.waitFor(
    (m) => m && m.__bench_done === true && m.kind === "nodeToWorkerPostMessage",
    timeoutMs,
    "nodeToWorkerPostMessages done"
  );

  const end = nowNs();
  const receivedBytes =
    typeof done.receivedBytes === "number" ? done.receivedBytes : messages * payload.byteLength;
  const seconds = nsToSec(end - start);

  return {
    name: "Node -> Worker postMessages batch (Buffer[])",
    bytes: receivedBytes,
    seconds,
    mibPerSec: mibPerSec(receivedBytes, seconds),
    extra: { receivedMsgs: done.receivedMsgs, chunkSize },
  };
}

async function benchNodeToWorkerRecursiveGraph(
  dw: DenoWorker,
  bus: MessageBus,
  args: Args
): Promise<BenchResult> {
  const { graphDepth, graphFanout, graphShare, graphMessages, ackEvery, warmup, timeoutMs } = args;
  const payload = makeRecursiveGraphPayload(graphDepth, graphFanout, graphShare);

  for (let i = 0; i < warmup; i++) {
    dw.postMessage({ __bench_cmd: "nodeToWorkerGraphReset", targetMsgs: 2, ackEvery: 0 });
    await bus.waitFor(
      (m) => m && m.__bench_ack === true && m.kind === "nodeToWorkerGraphReset",
      timeoutMs,
      "nodeToWorkerGraphReset (warmup ack)"
    );
    dw.postMessage(payload);
    dw.postMessage(payload);
    await bus.waitFor(
      (m) => m && m.__bench_done === true && m.kind === "nodeToWorkerRecursiveGraph",
      timeoutMs,
      "nodeToWorkerRecursiveGraph warmup done"
    );
  }

  dw.postMessage({ __bench_cmd: "nodeToWorkerGraphReset", targetMsgs: graphMessages, ackEvery });
  await bus.waitFor(
    (m) => m && m.__bench_ack === true && m.kind === "nodeToWorkerGraphReset",
    timeoutMs,
    "nodeToWorkerGraphReset ack"
  );

  const start = nowNs();
  for (let i = 0; i < graphMessages; i++) dw.postMessage(payload);

  const done = await bus.waitFor(
    (m) => m && m.__bench_done === true && m.kind === "nodeToWorkerRecursiveGraph",
    timeoutMs,
    "nodeToWorkerRecursiveGraph done"
  );
  const end = nowNs();

  const receivedBytes = typeof done.receivedBytes === "number" ? done.receivedBytes : 0;
  const seconds = nsToSec(end - start);

  return {
    name: "Node -> Worker postMessage (recursive object graph)",
    bytes: receivedBytes,
    seconds,
    mibPerSec: mibPerSec(receivedBytes, seconds),
    extra: {
      receivedMsgs: done.receivedMsgs,
      depth: graphDepth,
      fanout: graphFanout,
      share: graphShare,
    },
  };
}

async function benchEvalReturnBytes(
  dw: DenoWorker,
  args: Args,
  jsonMode: boolean
): Promise<BenchResult> {
  const { size, evalIter, warmup } = args;
  const fnName = jsonMode ? "evalReturnJsonBytes" : "evalReturnBytes";
 

  for (let i = 0; i < warmup; i++) {
    // eslint-disable-next-line no-await-in-loop
    await dw.evalModule(`export const out = await globalThis.__bench.${fnName}(${size});`);
  }

  const start = nowNs();
  let totalBytes = 0;

  for (let i = 0; i < evalIter; i++) {
    // eslint-disable-next-line no-await-in-loop
    const mod = await dw.evalModule(`export const out = await globalThis.__bench.${fnName}(${size});`);
    const v = (mod as any).out;
    if (jsonMode) {
      if (Array.isArray(v)) totalBytes += v.length;
    } else {
      if (v instanceof Uint8Array) totalBytes += v.byteLength;
    }
    if (i === 0 || (i + 1) === evalIter || (i + 1) % 10 === 0) {
     
    }
  }

  const end = nowNs();
  const seconds = nsToSec(end - start);

  return {
    name: jsonMode ? "Eval return number[] (JSON)" : "Eval return Uint8Array",
    bytes: totalBytes,
    seconds,
    mibPerSec: mibPerSec(totalBytes, seconds),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

 

  const dw = new DenoWorker({ imports: false, channelSize: 4096 });
  const bus = new MessageBus(dw, { logQueue: args.logQueue });

  try {
   
    await dw.evalModule(buildWorkerBenchModuleSource());
   

    const results: BenchResult[] = [];

   
    results.push(await benchNodeToWorkerPostMessage(dw, bus, args));
    results.push(await benchNodeToWorkerPostMessagesBatch(dw, bus, args));
    results.push(await benchNodeToWorkerRecursiveGraph(dw, bus, args));
   

   
    results.push(await benchWorkerToNodePostMessage(dw, bus, args));
   

   
    results.push(await benchHostCallSync(dw, bus, args));
   

   
    results.push(await benchHostCallAsync(dw, bus, args));
   

   
    results.push(await benchEvalReturnBytes(dw, args, false));
   

    if (args.json) {
     
      results.push(await benchEvalReturnBytes(dw, args, true));
     
    }

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "Config:",
        `  size: ${args.size} bytes (${fmt(bytesToMiB(args.size), 4)} MiB)`,
        `  node->worker messages: ${args.messages} (ackEvery=${args.ackEvery})`,
        `  recursive graph messages: ${args.graphMessages} (depth=${args.graphDepth}, fanout=${args.graphFanout}, share=${fmt(args.graphShare, 2)})`,
        `  worker->node duration: ${args.durationMs} ms`,
        `  eval iters: ${args.evalIter}`,
        `  timeout: ${args.timeoutMs} ms`,
        "",
      ].join("\n")
    );

    printResults(results);
  } catch (e) {

    throw e;
  } finally {
   
    try {
      if (!dw.isClosed()) await dw.close();
    } catch (e) {

    }
   
  }
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});
