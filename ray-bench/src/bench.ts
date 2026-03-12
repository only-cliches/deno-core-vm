import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { Agent as HttpAgent, createServer, IncomingMessage, request as httpRequest } from "node:http";
import { Worker as NodeWorker } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import { DenoWorker } from "../../src/index";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { QuickJSWorker } from "quickjs-vm";

type ScenarioKey =
  | "node-node-fn"
  | "node+node-postmessage"
  | "node+node-http"
  | "node+deno-postmessage"
  | "node+deno-eval"
  | "node+deno-handle"
  | "node+quickjs-eval"
  | "node+quickjs-handle"
  | "node+deno-stream"
  | "bun+bun-postmessage"
  | "bun+bun-http"
  | "deno+deno-postmessage"
  | "deno+deno-http";

type BenchConfig = {
  width: number;
  height: number;
  samples: number;
  maxDepth: number;
  tileSize: number;
  warmup: number;
  iterations: number;
  repeats: number;
  unsafeStreamMemory: boolean;
  workersList: number[];
  scenarios: ScenarioKey[];
};

type ScenarioMeta = {
  key: ScenarioKey;
  label: string;
  main: "Node" | "Bun" | "Deno";
  ipc: string;
  worker: "Node" | "Deno" | "Bun" | "QuickJS";
};

type TileJob = {
  id: number;
  width: number;
  height: number;
  yStart: number;
  yEnd: number;
  samples: number;
  maxDepth: number;
  seed: number;
};

type TileResult = {
  id?: number;
  checksum: number;
  pixels: number;
};

type IterationStats = {
  medianMs: number;
  pixels: number;
  checksum: number;
};

type ScenarioRunner = (cfg: BenchConfig, workers: number) => Promise<IterationStats>;

type Row = {
  scenario: ScenarioMeta;
  workers: number;
  medianMs?: number;
  reqPerSec?: number;
  mpixPerSec?: number;
  checksum?: number;
  status: "ok" | "skip" | "fail";
  detail?: string;
};

const scenarioOrder: ScenarioKey[] = [
  "node-node-fn",
  "node+node-postmessage",
  "node+node-http",
  "node+deno-postmessage",
  "node+deno-eval",
  "node+deno-handle",
  "node+quickjs-eval",
  "node+quickjs-handle",
  "node+deno-stream",
  "bun+bun-postmessage",
  "bun+bun-http",
  "deno+deno-postmessage",
  "deno+deno-http",
];

const scenarioCatalog: ScenarioMeta[] = [
  { key: "node-node-fn", label: "Node | direct.fn | Node", main: "Node", ipc: "direct.fn", worker: "Node" },
  { key: "node+node-postmessage", label: "Node | postMessage | Node", main: "Node", ipc: "postMessage", worker: "Node" },
  { key: "node+node-http", label: "Node | HTTP | Node", main: "Node", ipc: "HTTP", worker: "Node" },
  { key: "node+deno-postmessage", label: "Node | postMessage | Deno", main: "Node", ipc: "postMessage", worker: "Deno" },
  { key: "node+deno-eval", label: "Node | worker.eval | Deno", main: "Node", ipc: "worker.eval", worker: "Deno" },
  { key: "node+deno-handle", label: "Node | worker.handle | Deno", main: "Node", ipc: "worker.handle", worker: "Deno" },
  { key: "node+quickjs-eval", label: "Node | worker.eval | QuickJS", main: "Node", ipc: "worker.eval", worker: "QuickJS" },
  { key: "node+quickjs-handle", label: "Node | worker.handle | QuickJS", main: "Node", ipc: "worker.handle", worker: "QuickJS" },
  { key: "node+deno-stream", label: "Node | worker.stream.connect | Deno", main: "Node", ipc: "worker.stream.connect", worker: "Deno" },
  { key: "bun+bun-postmessage", label: "Bun | postMessage | Bun", main: "Bun", ipc: "postMessage", worker: "Bun" },
  { key: "bun+bun-http", label: "Bun | HTTP | Bun", main: "Bun", ipc: "HTTP", worker: "Bun" },
  { key: "deno+deno-postmessage", label: "Deno | postMessage | Deno", main: "Deno", ipc: "postMessage", worker: "Deno" },
  { key: "deno+deno-http", label: "Deno | HTTP | Deno", main: "Deno", ipc: "HTTP", worker: "Deno" },
];

const RAYTRACE_SOURCE = String.raw`
(() => {
  if (globalThis.__raytraceTile) return true;

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const vec3 = (x, y, z) => ({ x, y, z });
  const add = (a, b) => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub = (a, b) => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul = (a, b) => vec3(a.x * b.x, a.y * b.y, a.z * b.z);
  const scale = (a, s) => vec3(a.x * s, a.y * s, a.z * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const len = (a) => Math.sqrt(dot(a, a));
  const unit = (a) => {
    const l = len(a);
    return l > 0 ? scale(a, 1 / l) : vec3(0, 0, 0);
  };

  const mixHash = (s) => {
    s = (s ^ 61) ^ (s >>> 16);
    s = (s + (s << 3)) >>> 0;
    s ^= s >>> 4;
    s = Math.imul(s, 0x27d4eb2d) >>> 0;
    s ^= s >>> 15;
    return s >>> 0;
  };

  const rand01 = (state) => {
    state.v = (Math.imul(state.v, 1664525) + 1013904223) >>> 0;
    return state.v / 0x100000000;
  };

  const randomInUnitSphere = (state) => {
    for (let i = 0; i < 16; i += 1) {
      const p = vec3(rand01(state) * 2 - 1, rand01(state) * 2 - 1, rand01(state) * 2 - 1);
      if (dot(p, p) < 1) return p;
    }
    return vec3(0, 0, 0);
  };

  const hitSphere = (center, radius, rayOrigin, rayDir, tMin, tMax) => {
    const oc = sub(rayOrigin, center);
    const a = dot(rayDir, rayDir);
    const halfB = dot(oc, rayDir);
    const c = dot(oc, oc) - radius * radius;
    const disc = halfB * halfB - a * c;
    if (disc < 0) return null;
    const sqrtd = Math.sqrt(disc);

    let root = (-halfB - sqrtd) / a;
    if (root < tMin || root > tMax) {
      root = (-halfB + sqrtd) / a;
      if (root < tMin || root > tMax) return null;
    }

    const p = add(rayOrigin, scale(rayDir, root));
    const outward = scale(sub(p, center), 1 / radius);
    return { t: root, p, normal: outward };
  };

  const scene = [
    { c: vec3(0, -100.5, -1), r: 100, albedo: vec3(0.75, 0.75, 0.75) },
    { c: vec3(0, 0, -1.2), r: 0.5, albedo: vec3(0.7, 0.3, 0.3) },
    { c: vec3(-0.9, 0.05, -1.0), r: 0.45, albedo: vec3(0.3, 0.7, 0.3) },
    { c: vec3(0.9, 0.05, -1.0), r: 0.45, albedo: vec3(0.3, 0.3, 0.8) },
  ];

  const rayColor = (rayOrigin, rayDir, maxDepth, state) => {
    let attenuation = vec3(1, 1, 1);
    let o = rayOrigin;
    let d = rayDir;

    for (let depth = 0; depth < maxDepth; depth += 1) {
      let closest = Infinity;
      let rec = null;
      let mat = null;

      for (const s of scene) {
        const h = hitSphere(s.c, s.r, o, d, 0.001, closest);
        if (h && h.t < closest) {
          closest = h.t;
          rec = h;
          mat = s;
        }
      }

      if (!rec || !mat) {
        const ud = unit(d);
        const t = 0.5 * (ud.y + 1.0);
        const sky = add(scale(vec3(1, 1, 1), 1 - t), scale(vec3(0.5, 0.7, 1.0), t));
        return mul(attenuation, sky);
      }

      const target = add(add(rec.p, rec.normal), randomInUnitSphere(state));
      d = unit(sub(target, rec.p));
      o = rec.p;
      attenuation = mul(attenuation, mat.albedo);
    }

    return vec3(0, 0, 0);
  };

  globalThis.__raytraceTile = (job) => {
    const width = job.width | 0;
    const height = job.height | 0;
    const yStart = job.yStart | 0;
    const yEnd = job.yEnd | 0;
    const samples = Math.max(1, job.samples | 0);
    const maxDepth = Math.max(1, job.maxDepth | 0);
    const aspect = width / Math.max(1, height);

    const viewportHeight = 2.0;
    const viewportWidth = aspect * viewportHeight;
    const focalLength = 1.0;

    const origin = vec3(0, 0, 0);
    const horizontal = vec3(viewportWidth, 0, 0);
    const vertical = vec3(0, viewportHeight, 0);
    const lowerLeftCorner = sub(sub(sub(origin, scale(horizontal, 0.5)), scale(vertical, 0.5)), vec3(0, 0, focalLength));

    let checksum = 0 >>> 0;
    let pixels = 0;

    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const state = { v: mixHash((job.seed ^ (y * 73856093) ^ (x * 19349663)) >>> 0) };
        let col = vec3(0, 0, 0);

        for (let s = 0; s < samples; s += 1) {
          const u = (x + rand01(state)) / Math.max(1, width - 1);
          const v = ((height - 1 - y) + rand01(state)) / Math.max(1, height - 1);
          const dir = unit(sub(add(add(lowerLeftCorner, scale(horizontal, u)), scale(vertical, v)), origin));
          col = add(col, rayColor(origin, dir, maxDepth, state));
        }

        col = scale(col, 1 / samples);
        col = vec3(Math.sqrt(clamp01(col.x)), Math.sqrt(clamp01(col.y)), Math.sqrt(clamp01(col.z)));

        const ir = Math.max(0, Math.min(255, (255.999 * col.x) | 0));
        const ig = Math.max(0, Math.min(255, (255.999 * col.y) | 0));
        const ib = Math.max(0, Math.min(255, (255.999 * col.z) | 0));

        checksum = (checksum + (((ir << 16) ^ (ig << 8) ^ ib) >>> 0)) >>> 0;
        pixels += 1;
      }
    }

    return { checksum: checksum >>> 0, pixels };
  };

  true;
})();
`;

const NODE_PM_WORKER_SCRIPT = `${RAYTRACE_SOURCE}
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "render") return;
  const out = globalThis.__raytraceTile(msg.payload);
  parentPort.postMessage({ id: msg.id, checksum: out.checksum >>> 0, pixels: out.pixels >>> 0 });
});
`;

const NODE_HTTP_WORKER_SCRIPT = `${RAYTRACE_SOURCE}
const { parentPort } = require("node:worker_threads");
const { createServer } = require("node:http");
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/render") {
    res.statusCode = 404;
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on("end", () => {
    try {
      const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const out = globalThis.__raytraceTile(job);
      const body = Buffer.from(JSON.stringify({ checksum: out.checksum >>> 0, pixels: out.pixels >>> 0 }));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(body.length));
      res.end(body);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e && e.message || e));
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  parentPort.postMessage({ type: "ready", port: addr && addr.port });
});
`;

const DENO_POSTMESSAGE_SCRIPT = `${RAYTRACE_SOURCE}
on("message", (msg) => {
  if (!msg || typeof msg !== "object" || msg.type !== "render") return;
  const out = globalThis.__raytraceTile(msg.payload);
  hostPostMessage({ id: msg.id, checksum: out.checksum >>> 0, pixels: out.pixels >>> 0 });
});`;

const DENO_STREAM_SCRIPT = `${RAYTRACE_SOURCE}
(key) => {
  (async () => {
    const conn = await hostStreams.connect(String(key));
    const reader = conn.readable.getReader();
    const writer = conn.writable.getWriter();
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let buf = "";

    while (true) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      while (true) {
        const idx = buf.indexOf("\\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const out = globalThis.__raytraceTile(msg.job);
        await writer.write(enc.encode(JSON.stringify({ id: msg.id, checksum: out.checksum >>> 0, pixels: out.pixels >>> 0 }) + "\\n"));
      }
    }

    try { await writer.close(); } catch {}
  })();
  return true;
};`;

function parseArgs(): BenchConfig {
  const args = process.argv.slice(2);
  const out: BenchConfig = {
    width: 640,
    height: 360,
    samples: 8,
    maxDepth: 6,
    tileSize: 0,
    warmup: 1,
    iterations: 3,
    repeats: 1,
    unsafeStreamMemory: false,
    workersList: [1, 2, 4],
    scenarios: [...scenarioOrder],
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--width") out.width = Number(args[++i]);
    else if (a === "--height") out.height = Number(args[++i]);
    else if (a === "--samples") out.samples = Number(args[++i]);
    else if (a === "--max-depth") out.maxDepth = Number(args[++i]);
    else if (a === "--tile-size") out.tileSize = Number(args[++i]);
    else if (a === "--warmup") out.warmup = Number(args[++i]);
    else if (a === "--iterations") out.iterations = Number(args[++i]);
    else if (a === "--repeats") out.repeats = Number(args[++i]);
    else if (a === "--unsafe-stream-memory") out.unsafeStreamMemory = true;
    else if (a === "--workers") out.workersList = [Number(args[++i])];
    else if (a === "--workers-list") {
      out.workersList = args[++i].split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0).map((v) => Math.trunc(v));
    } else if (a === "--scenarios") {
      const wanted = new Set(args[++i].split(",").map((v) => v.trim()));
      out.scenarios = scenarioOrder.filter((k) => wanted.has(k));
    }
  }

  if (!Number.isFinite(out.width) || out.width <= 0) throw new Error("Invalid --width");
  if (!Number.isFinite(out.height) || out.height <= 0) throw new Error("Invalid --height");
  if (!Number.isFinite(out.samples) || out.samples <= 0) throw new Error("Invalid --samples");
  if (!Number.isFinite(out.maxDepth) || out.maxDepth <= 0) throw new Error("Invalid --max-depth");
  if (!Number.isFinite(out.tileSize) || out.tileSize < 0) throw new Error("Invalid --tile-size");
  out.tileSize = Math.trunc(out.tileSize);
  if (!Number.isFinite(out.warmup) || out.warmup < 0) throw new Error("Invalid --warmup");
  if (!Number.isFinite(out.iterations) || out.iterations <= 0) throw new Error("Invalid --iterations");
  if (!Number.isFinite(out.repeats) || out.repeats <= 0) throw new Error("Invalid --repeats");
  out.repeats = Math.trunc(out.repeats);
  out.workersList = Array.from(new Set(out.workersList.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.trunc(n))));
  if (out.workersList.length === 0) throw new Error("No valid workers configured");
  if (out.scenarios.length === 0) throw new Error("No scenarios selected");
  return out;
}

function createBenchDenoWorker(cfg: BenchConfig): DenoWorker {
  const opts = cfg.unsafeStreamMemory
    ? { console: false as const, bridge: { enableUnsafeStreamMemory: true } }
    : { console: false as const };
  return new DenoWorker(opts);
}

function createBenchQuickJSWorker(): QuickJSWorker {
  return new QuickJSWorker();
}

function isRuntimeOnPath(runtimeBin: string): boolean {
  try {
    const result = spawnSync(runtimeBin, ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function splitRows(height: number, workers: number): Array<{ yStart: number; yEnd: number }> {
  const out: Array<{ yStart: number; yEnd: number }> = [];
  const base = Math.floor(height / workers);
  let rem = height % workers;
  let cur = 0;
  for (let i = 0; i < workers; i += 1) {
    const rows = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
    const next = cur + rows;
    if (rows > 0) out.push({ yStart: cur, yEnd: next });
    cur = next;
  }
  return out;
}

function splitRowsByTile(height: number, tileSize: number): Array<{ yStart: number; yEnd: number }> {
  const out: Array<{ yStart: number; yEnd: number }> = [];
  for (let yStart = 0; yStart < height; yStart += tileSize) {
    out.push({ yStart, yEnd: Math.min(height, yStart + tileSize) });
  }
  return out;
}

function jobsFor(cfg: BenchConfig, workers: number): TileJob[] {
  const slices = cfg.tileSize > 0 ? splitRowsByTile(cfg.height, cfg.tileSize) : splitRows(cfg.height, workers);
  const globalSeed = (0x9e3779b1 ^ (cfg.width * 17) ^ (cfg.height * 131) ^ (cfg.samples * 8191) ^ (cfg.maxDepth * 65537)) >>> 0;
  return slices.map((s, i) => ({
    id: i + 1,
    width: cfg.width,
    height: cfg.height,
    yStart: s.yStart,
    yEnd: s.yEnd,
    samples: cfg.samples,
    maxDepth: cfg.maxDepth,
    seed: globalSeed,
  }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
}

function aggregate(parts: TileResult[]): { checksum: number; pixels: number } {
  let checksum = 0 >>> 0;
  let pixels = 0;
  for (const p of parts) {
    checksum = (checksum + (p.checksum >>> 0)) >>> 0;
    pixels += p.pixels | 0;
  }
  return { checksum, pixels };
}

function hashString32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function shuffledScenariosForWorkers(selected: ScenarioMeta[], workers: number): ScenarioMeta[] {
  return [...selected]
    .map((scenario) => ({ scenario, score: (hashString32(scenario.key) ^ Math.imul(workers, 0x9e3779b1)) >>> 0 }))
    .sort((a, b) => (a.score - b.score) || a.scenario.key.localeCompare(b.scenario.key))
    .map((x) => x.scenario);
}

async function runMeasured(fn: () => Promise<{ checksum: number; pixels: number }>, warmup: number, iterations: number): Promise<IterationStats> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const times: number[] = [];
  let checksum = 0;
  let pixels = 0;
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    const out = await fn();
    const t1 = performance.now();
    times.push(t1 - t0);
    if (i === 0) checksum = out.checksum >>> 0;
    else if ((out.checksum >>> 0) !== checksum) throw new Error(`Non-deterministic checksum across iterations: ${checksum} != ${out.checksum}`);
    pixels = out.pixels;
  }
  return { medianMs: median(times), pixels, checksum };
}

async function runNodeNodePostMessage(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const nodeWorkers = Array.from({ length: workers }, () => new NodeWorker(NODE_PM_WORKER_SCRIPT, { eval: true }));
  const pending = new Map<number, { resolve: (x: TileResult) => void }>();
  let nextId = 1;
  for (const w of nodeWorkers) {
    w.on("message", (msg: any) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      entry.resolve({ checksum: msg.checksum >>> 0, pixels: msg.pixels >>> 0 });
    });
  }

  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const results = await Promise.all(
        jobs.map((job, i) =>
          new Promise<TileResult>((resolve) => {
            const id = nextId++;
            pending.set(id, { resolve });
            nodeWorkers[i % workers].postMessage({ type: "render", id, payload: job });
          }),
        ),
      );
      return aggregate(results);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    await Promise.all(nodeWorkers.map((w) => w.terminate()));
  }
}

function parseReqBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function postRenderHttp(port: number, job: TileJob, agent: HttpAgent): Promise<TileResult> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(job));
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/render",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          connection: "keep-alive",
        },
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) return reject(new Error(`HTTP render failed (${status})`));
          try {
            const out = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({ checksum: out.checksum >>> 0, pixels: out.pixels >>> 0 });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function runNodeNodeHttp(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const nodeWorkers = Array.from({ length: workers }, () => new NodeWorker(NODE_HTTP_WORKER_SCRIPT, { eval: true }));
  const readyMessages = await Promise.all(nodeWorkers.map((w) => once(w, "message").then((m) => m[0])));
  const ports: number[] = readyMessages.map((msg, i) => {
    if (!msg || msg.type !== "ready" || !Number.isFinite(msg.port)) {
      throw new Error(`Node HTTP worker ${i} failed to start`);
    }
    return msg.port | 0;
  });
  const agents = ports.map(() => new HttpAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }));

  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const parts = await Promise.all(jobs.map((job, i) => postRenderHttp(ports[i % workers], job, agents[i % workers])));
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    for (const a of agents) a.destroy();
    await Promise.all(nodeWorkers.map((w) => w.terminate()));
  }
}

async function runNodeDenoPostMessage(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const denoWorkers = Array.from({ length: workers }, () => createBenchDenoWorker(cfg));
  await Promise.all(denoWorkers.map((w) => w.eval(DENO_POSTMESSAGE_SCRIPT)));
  const pending = new Map<number, { resolve: (x: TileResult) => void }>();
  let nextId = 1;
  for (const w of denoWorkers) {
    w.on("message", (msg: any) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      entry.resolve({ checksum: msg.checksum >>> 0, pixels: msg.pixels >>> 0 });
    });
  }

  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const parts = await Promise.all(
        jobs.map((job, i) =>
          new Promise<TileResult>((resolve) => {
            const id = nextId++;
            pending.set(id, { resolve });
            denoWorkers[i % workers].postMessage({ type: "render", id, payload: job });
          }),
        ),
      );
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    pending.clear();
    await Promise.all(denoWorkers.map((w) => w.close({ force: true })));
  }
}

async function runNodeDenoEval(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const denoWorkers = Array.from({ length: workers }, () => createBenchDenoWorker(cfg));
  await Promise.all(denoWorkers.map((w) => w.eval(RAYTRACE_SOURCE)));
  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const parts = await Promise.all(
        jobs.map((job, i) => denoWorkers[i % workers].eval<TileResult>("globalThis.__raytraceTile", { args: [job] })),
      );
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    await Promise.all(denoWorkers.map((w) => w.close({ force: true })));
  }
}

async function runNodeDenoHandle(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const denoWorkers = Array.from({ length: workers }, () => createBenchDenoWorker(cfg));
  await Promise.all(denoWorkers.map((w) => w.eval(RAYTRACE_SOURCE)));
  const handles = await Promise.all(denoWorkers.map((w) => w.handle.eval("globalThis.__raytraceTile")));

  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const parts = await Promise.all(jobs.map((job, i) => handles[i % workers].call<TileResult>([job])));
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    await Promise.all(handles.map((h) => h.dispose()));
    await Promise.all(denoWorkers.map((w) => w.close({ force: true })));
  }
}

async function runNodeQuickJSEval(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const quickjsWorkers = Array.from({ length: workers }, () => createBenchQuickJSWorker());
  await Promise.all(quickjsWorkers.map((w) => w.eval(RAYTRACE_SOURCE)));
  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const parts = await Promise.all(
        jobs.map((job, i) => quickjsWorkers[i % workers].eval<TileResult>("globalThis.__raytraceTile", { args: [job] })),
      );
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    await Promise.all(quickjsWorkers.map((w) => w.close()));
  }
}

async function runNodeQuickJSHandle(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const quickjsWorkers = Array.from({ length: workers }, () => createBenchQuickJSWorker());
  await Promise.all(quickjsWorkers.map((w) => w.eval(RAYTRACE_SOURCE)));
  const handles = await Promise.all(quickjsWorkers.map((w) => w.handle.eval("globalThis.__raytraceTile")));

  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const parts = await Promise.all(jobs.map((job, i) => handles[i % workers].call<TileResult>([job])));
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    await Promise.all(handles.map((h) => h.dispose()));
    await Promise.all(quickjsWorkers.map((w) => w.close()));
  }
}

async function writeLine(duplex: Duplex, line: string): Promise<void> {
  return await new Promise((resolve, reject) => {
    duplex.write(line, (err) => (err ? reject(err) : resolve()));
  });
}

async function endDuplex(duplex: Duplex): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    duplex.end((err) => (err ? reject(err) : resolve()));
  });
}

async function runNodeDenoStream(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const denoWorkers = Array.from({ length: workers }, () => createBenchDenoWorker(cfg));
  const keys = denoWorkers.map(() => `raybench:${randomUUID()}`);
  const duplexes = await Promise.all(denoWorkers.map((w, i) => w.stream.connect(keys[i], cfg.unsafeStreamMemory ? { unsafeSharedMemory: true } : undefined)));
  for (const d of duplexes) {
    // Force-close path can emit stream errors while tearing down workers.
    d.on("error", () => {});
  }
  await Promise.all(denoWorkers.map((w, i) => w.eval(DENO_STREAM_SCRIPT, { args: [keys[i]] })));

  type Pending = { resolve: (x: TileResult) => void; reject: (e: unknown) => void };
  const pendingByWorker = new Map<number, Map<number, Pending>>();
  const buffers = new Map<number, string>();
  let nextId = 1;

  for (let wi = 0; wi < duplexes.length; wi += 1) {
    pendingByWorker.set(wi, new Map());
    buffers.set(wi, "");
    duplexes[wi].setEncoding("utf8");
    duplexes[wi].on("data", (chunk: string) => {
      let buf = (buffers.get(wi) || "") + chunk;
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const map = pendingByWorker.get(wi);
          const entry = map?.get(msg.id);
          if (!entry) continue;
          map!.delete(msg.id);
          entry.resolve({ checksum: msg.checksum >>> 0, pixels: msg.pixels >>> 0 });
        } catch {
          // ignore malformed lines
        }
      }
      buffers.set(wi, buf);
    });
  }

  try {
    const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
      const jobs = jobsFor(cfg, workers);
      const pendingPromises = jobs.map((job, i) => {
        const wi = i % workers;
        const id = nextId++;
        const req = JSON.stringify({ id, job }) + "\n";
        const promise = new Promise<TileResult>((resolve, reject) => {
          const map = pendingByWorker.get(wi)!;
          map.set(id, { resolve, reject });
        });
        return { wi, req, id, promise };
      });
      const perWorkerReq = new Map<number, string[]>();
      const perWorkerIds = new Map<number, number[]>();
      for (const p of pendingPromises) {
        const arr = perWorkerReq.get(p.wi) || [];
        arr.push(p.req);
        perWorkerReq.set(p.wi, arr);
        const ids = perWorkerIds.get(p.wi) || [];
        ids.push(p.id);
        perWorkerIds.set(p.wi, ids);
      }
      await Promise.all(
        Array.from(perWorkerReq.entries()).map(async ([wi, reqs]) => {
          try {
            await writeLine(duplexes[wi], reqs.join(""));
          } catch (err) {
            const ids = perWorkerIds.get(wi) || [];
            const map = pendingByWorker.get(wi);
            for (const id of ids) {
              const pending = map?.get(id);
              if (!pending) continue;
              map!.delete(id);
              pending.reject(err);
            }
            throw err;
          }
        }),
      );
      const parts = await Promise.all(pendingPromises.map((p) => p.promise));
      return aggregate(parts);
    };

    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    for (const d of duplexes) {
      try {
        await endDuplex(d);
      } catch {
        // ignore
      }
    }
    await Promise.all(denoWorkers.map((w) => w.close({ force: true })));
  }
}

function createLocalRaytraceTile(): (job: TileJob) => TileResult {
  const fn = new Function(`${RAYTRACE_SOURCE}\nreturn globalThis.__raytraceTile;`)();
  if (typeof fn !== "function") {
    throw new Error("Failed to initialize local raytrace function");
  }
  return fn as (job: TileJob) => TileResult;
}

async function runNodeNodeFn(cfg: BenchConfig, workers: number): Promise<IterationStats> {
  const localRaytraceTile = createLocalRaytraceTile();
  const runOne = async (): Promise<{ checksum: number; pixels: number }> => {
    const jobs = jobsFor(cfg, workers);
    const parts = jobs.map((job) => localRaytraceTile(job));
    return aggregate(parts);
  };
  return await runMeasured(runOne, cfg.warmup, cfg.iterations);
}

const nodeScenarioRunners: Record<string, ScenarioRunner> = {
  "node-node-fn": runNodeNodeFn,
  "node+node-postmessage": runNodeNodePostMessage,
  "node+node-http": runNodeNodeHttp,
  "node+deno-postmessage": runNodeDenoPostMessage,
  "node+deno-eval": runNodeDenoEval,
  "node+deno-handle": runNodeDenoHandle,
  "node+quickjs-eval": runNodeQuickJSEval,
  "node+quickjs-handle": runNodeQuickJSHandle,
  "node+deno-stream": runNodeDenoStream,
};

function runJsonCommand(cmd: string, args: string[], timeoutMs = 180_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse ${cmd} output: ${String(e)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function runExternalBunScenario(cfg: BenchConfig, workers: number, scenario: ScenarioKey): Promise<IterationStats> {
  const script = path.resolve(process.cwd(), "src/runtime-bench-bun.ts");
  const out = await runJsonCommand("bun", [
    script,
    "--scenario",
    scenario,
    "--width",
    String(cfg.width),
    "--height",
    String(cfg.height),
    "--samples",
    String(cfg.samples),
    "--max-depth",
    String(cfg.maxDepth),
    "--tile-size",
    String(cfg.tileSize),
    "--workers",
    String(workers),
    "--warmup",
    String(cfg.warmup),
    "--iterations",
    String(cfg.iterations),
    "--json",
    ...(cfg.unsafeStreamMemory ? ["--unsafe-stream-memory"] : []),
  ]);
  return {
    medianMs: Number(out.medianMs),
    pixels: Number(out.pixels) | 0,
    checksum: Number(out.checksum) >>> 0,
  };
}

async function runExternalDenoScenario(cfg: BenchConfig, workers: number, scenario: ScenarioKey): Promise<IterationStats> {
  const script = path.resolve(process.cwd(), "src/runtime-bench-deno.ts");
  const out = await runJsonCommand("deno", [
    "run",
    "-A",
    script,
    "--scenario",
    scenario,
    "--width",
    String(cfg.width),
    "--height",
    String(cfg.height),
    "--samples",
    String(cfg.samples),
    "--max-depth",
    String(cfg.maxDepth),
    "--tile-size",
    String(cfg.tileSize),
    "--workers",
    String(workers),
    "--warmup",
    String(cfg.warmup),
    "--iterations",
    String(cfg.iterations),
    "--json",
    ...(cfg.unsafeStreamMemory ? ["--unsafe-stream-memory"] : []),
  ]);
  return {
    medianMs: Number(out.medianMs),
    pixels: Number(out.pixels) | 0,
    checksum: Number(out.checksum) >>> 0,
  };
}

async function runWithRepeats(cfg: BenchConfig, runner: () => Promise<IterationStats>): Promise<IterationStats> {
  if (cfg.repeats === 1) return await runner();
  const all: IterationStats[] = [];
  for (let i = 0; i < cfg.repeats; i += 1) {
    all.push(await runner());
  }
  const base = all[0];
  for (let i = 1; i < all.length; i += 1) {
    if ((all[i].checksum >>> 0) !== (base.checksum >>> 0) || (all[i].pixels | 0) !== (base.pixels | 0)) {
      throw new Error("Non-deterministic output across repeats");
    }
  }
  const medianMs = median(all.map((x) => x.medianMs));
  return { medianMs, pixels: base.pixels, checksum: base.checksum };
}

function printRows(title: string, rows: Row[], workersList: number[], scenarioOrderForTable: ScenarioMeta[]): void {
  const headers = [
    "Scenario",
    ...workersList.flatMap((w) => [`Req/s (${w}w)`, `Throughput (${w}w)`]),
  ];
  const rowsByScenario = new Map<ScenarioKey, Map<number, Row>>();
  for (const row of rows) {
    let perWorker = rowsByScenario.get(row.scenario.key);
    if (!perWorker) {
      perWorker = new Map<number, Row>();
      rowsByScenario.set(row.scenario.key, perWorker);
    }
    perWorker.set(row.workers, row);
  }

  const bestMedianMs = (scenario: ScenarioMeta): number => {
    const perWorker = rowsByScenario.get(scenario.key);
    if (!perWorker) return Number.POSITIVE_INFINITY;
    let best = Number.POSITIVE_INFINITY;
    for (const workers of workersList) {
      const row = perWorker.get(workers);
      if (row?.status === "ok" && row.medianMs != null && Number.isFinite(row.medianMs)) {
        best = Math.min(best, row.medianMs);
      }
    }
    return best;
  };

  const sortedScenarios = [...scenarioOrderForTable].sort((a, b) => {
    const aBest = bestMedianMs(a);
    const bBest = bestMedianMs(b);
    if (aBest !== bBest) return aBest - bBest;
    return a.key.localeCompare(b.key);
  });

  const bodyRaw = sortedScenarios.map((scenario) => {
    const perWorker = rowsByScenario.get(scenario.key);
    const cells = workersList.flatMap((workers) => {
      const row = perWorker?.get(workers);
      if (!row) return ["-", "-"];
      if (row.status === "skip") return ["skip", "skip"];
      if (row.status === "fail") return ["fail", "fail"];
      return [
        row.reqPerSec == null ? "-" : `${row.reqPerSec.toFixed(2)} req/s`,
        row.mpixPerSec == null ? "-" : `${row.mpixPerSec.toFixed(2)} MPix/s`,
      ];
    });
    return [scenario.key, ...cells];
  });

  const parseLeadingNumber = (cell: string): number | null => {
    const m = cell.match(/^([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
  };
  const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, "");
  const visibleLen = (s: string): number => stripAnsi(s).length;
  const padVisible = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - visibleLen(s)));

  const mins: Array<number | null> = headers.map(() => null);
  const maxs: Array<number | null> = headers.map(() => null);
  const highlightExcludedScenarios = new Set<ScenarioKey>(["node-node-fn"]);
  for (let col = 1; col < headers.length; col += 1) {
    const nums = bodyRaw
      .filter((row) => !highlightExcludedScenarios.has(row[0] as ScenarioKey))
      .map((row) => parseLeadingNumber(row[col]))
      .filter((n): n is number => n != null);
    if (nums.length > 0) {
      mins[col] = Math.min(...nums);
      maxs[col] = Math.max(...nums);
    }
  }

  const body = bodyRaw.map((row) => {
    if (highlightExcludedScenarios.has(row[0] as ScenarioKey)) return [...row];
    const out = [...row];
    for (let col = 1; col < out.length; col += 1) {
      const val = parseLeadingNumber(out[col]);
      if (val == null || mins[col] == null || maxs[col] == null) continue;
      if (val === maxs[col]) out[col] = chalk.bgGreen.black(out[col]);
      else if (val === mins[col]) out[col] = chalk.bgRed.white(out[col]);
    }
    return out;
  });

  const widths = headers.map((h, i) => Math.max(visibleLen(h), ...body.map((r) => visibleLen(r[i]))));
  const join = (cells: string[]) => `| ${cells.map((c, i) => padVisible(c, widths[i])).join(" | ")} |`;
  const sep = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;

  console.log(`\n${title}`);
  console.log(sep);
  console.log(join(headers));
  console.log(sep);
  for (const row of body) console.log(join(row));
  console.log(sep);

  const failures = rows.filter((r) => r.status === "fail");
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`- ${f.scenario.key} workers=${f.workers}: ${f.detail || "unknown error"}`);
    }
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  const hasBun = isRuntimeOnPath("bun");
  const hasDeno = isRuntimeOnPath("deno");

  console.log("# Ray Bench");
  console.log(
    `config: width=${cfg.width} height=${cfg.height} samples=${cfg.samples} maxDepth=${cfg.maxDepth} tileSize=${cfg.tileSize === 0 ? "auto" : cfg.tileSize} warmup=${cfg.warmup} iterations=${cfg.iterations} repeats=${cfg.repeats} unsafeStreamMemory=${cfg.unsafeStreamMemory} workers=${cfg.workersList.join(",")} scenarios=${cfg.scenarios.join(",")}`,
  );
  if (!hasBun) console.log("runtime: bun not found in PATH (bun+bun-* scenarios skipped)");
  if (!hasDeno) console.log("runtime: deno not found in PATH (deno+deno-* scenarios skipped)");

  const selected = scenarioCatalog.filter((s) => cfg.scenarios.includes(s.key));
  const rows: Row[] = [];
  let nodeFnBaseline: IterationStats | null = null;

  for (const workers of cfg.workersList) {
    const executionOrder = shuffledScenariosForWorkers(selected, workers);
    for (const scenario of executionOrder) {
      try {
        console.log(`running: ${scenario.key} workers=${workers}`);
        let out: IterationStats;

        if (scenario.main === "Node") {
          const runner = nodeScenarioRunners[scenario.key];
          if (scenario.key === "node-node-fn") {
            if (nodeFnBaseline == null) {
              nodeFnBaseline = await runWithRepeats(cfg, () => runner(cfg, 1));
            }
            out = nodeFnBaseline;
          } else {
            out = await runWithRepeats(cfg, () => runner(cfg, workers));
          }
        } else if (scenario.main === "Bun") {
          if (!hasBun) {
            rows.push({ scenario, workers, status: "skip", detail: "bun missing" });
            continue;
          }
          out = await runWithRepeats(cfg, () => runExternalBunScenario(cfg, workers, scenario.key));
        } else {
          if (!hasDeno) {
            rows.push({ scenario, workers, status: "skip", detail: "deno missing" });
            continue;
          }
          out = await runWithRepeats(cfg, () => runExternalDenoScenario(cfg, workers, scenario.key));
        }

        const reqPerSec = 1000 / out.medianMs;
        const mpixPerSec = (out.pixels / 1_000_000) / (out.medianMs / 1000);
        console.log(
          `done: ${scenario.key} workers=${workers} req/s=${reqPerSec.toFixed(2)} throughput=${mpixPerSec.toFixed(2)} MPix/s`,
        );
        rows.push({ scenario, workers, medianMs: out.medianMs, reqPerSec, mpixPerSec, checksum: out.checksum, status: "ok" });
      } catch (e: any) {
        rows.push({ scenario, workers, status: "fail", detail: String(e?.message || e) });
      }
    }
  }

  printRows("# Ray Bench Results", rows, cfg.workersList, selected);

  const failed = rows.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("ray bench failed:", err);
  process.exitCode = 1;
});
