type ScenarioKey = "bun+bun-postmessage" | "bun+bun-http";

type Config = {
  scenario: ScenarioKey;
  width: number;
  height: number;
  samples: number;
  maxDepth: number;
  warmup: number;
  iterations: number;
  workers: number;
  json: boolean;
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

type TileResult = { id?: number; checksum: number; pixels: number };
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

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
  const unit = (a) => { const l = len(a); return l > 0 ? scale(a, 1 / l) : vec3(0, 0, 0); };
  const mixHash = (s) => { s = (s ^ 61) ^ (s >>> 16); s = (s + (s << 3)) >>> 0; s ^= s >>> 4; s = Math.imul(s, 0x27d4eb2d) >>> 0; s ^= s >>> 15; return s >>> 0; };
  const rand01 = (state) => { state.v = (Math.imul(state.v, 1664525) + 1013904223) >>> 0; return state.v / 0x100000000; };
  const randomInUnitSphere = (state) => { for (let i = 0; i < 16; i += 1) { const p = vec3(rand01(state) * 2 - 1, rand01(state) * 2 - 1, rand01(state) * 2 - 1); if (dot(p, p) < 1) return p; } return vec3(0, 0, 0); };
  const hitSphere = (center, radius, rayOrigin, rayDir, tMin, tMax) => {
    const oc = sub(rayOrigin, center);
    const a = dot(rayDir, rayDir);
    const halfB = dot(oc, rayDir);
    const c = dot(oc, oc) - radius * radius;
    const disc = halfB * halfB - a * c;
    if (disc < 0) return null;
    const sqrtd = Math.sqrt(disc);
    let root = (-halfB - sqrtd) / a;
    if (root < tMin || root > tMax) { root = (-halfB + sqrtd) / a; if (root < tMin || root > tMax) return null; }
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
    let attenuation = vec3(1, 1, 1); let o = rayOrigin; let d = rayDir;
    for (let depth = 0; depth < maxDepth; depth += 1) {
      let closest = Infinity; let rec = null; let mat = null;
      for (const s of scene) { const h = hitSphere(s.c, s.r, o, d, 0.001, closest); if (h && h.t < closest) { closest = h.t; rec = h; mat = s; } }
      if (!rec || !mat) { const ud = unit(d); const t = 0.5 * (ud.y + 1.0); const sky = add(scale(vec3(1, 1, 1), 1 - t), scale(vec3(0.5, 0.7, 1.0), t)); return mul(attenuation, sky); }
      const target = add(add(rec.p, rec.normal), randomInUnitSphere(state)); d = unit(sub(target, rec.p)); o = rec.p; attenuation = mul(attenuation, mat.albedo);
    }
    return vec3(0, 0, 0);
  };
  globalThis.__raytraceTile = (job) => {
    const width = job.width | 0; const height = job.height | 0; const yStart = job.yStart | 0; const yEnd = job.yEnd | 0;
    const samples = Math.max(1, job.samples | 0); const maxDepth = Math.max(1, job.maxDepth | 0); const aspect = width / Math.max(1, height);
    const viewportHeight = 2.0; const viewportWidth = aspect * viewportHeight; const focalLength = 1.0;
    const origin = vec3(0, 0, 0); const horizontal = vec3(viewportWidth, 0, 0); const vertical = vec3(0, viewportHeight, 0);
    const lowerLeftCorner = sub(sub(sub(origin, scale(horizontal, 0.5)), scale(vertical, 0.5)), vec3(0, 0, focalLength));
    let checksum = 0 >>> 0; let pixels = 0;
    for (let y = yStart; y < yEnd; y += 1) for (let x = 0; x < width; x += 1) {
      const state = { v: mixHash((job.seed ^ (y * 73856093) ^ (x * 19349663)) >>> 0) }; let col = vec3(0, 0, 0);
      for (let s = 0; s < samples; s += 1) { const u = (x + rand01(state)) / Math.max(1, width - 1); const v = ((height - 1 - y) + rand01(state)) / Math.max(1, height - 1); const dir = unit(sub(add(add(lowerLeftCorner, scale(horizontal, u)), scale(vertical, v)), origin)); col = add(col, rayColor(origin, dir, maxDepth, state)); }
      col = scale(col, 1 / samples); col = vec3(Math.sqrt(clamp01(col.x)), Math.sqrt(clamp01(col.y)), Math.sqrt(clamp01(col.z)));
      const ir = Math.max(0, Math.min(255, (255.999 * col.x) | 0)); const ig = Math.max(0, Math.min(255, (255.999 * col.y) | 0)); const ib = Math.max(0, Math.min(255, (255.999 * col.z) | 0));
      checksum = (checksum + (((ir << 16) ^ (ig << 8) ^ ib) >>> 0)) >>> 0; pixels += 1;
    }
    return { checksum: checksum >>> 0, pixels };
  };
  true;
})();
`;

function parseArgs(): Config {
  const args = Bun.argv.slice(2);
  const out: Config = {
    scenario: "bun+bun-postmessage",
    width: 640,
    height: 360,
    samples: 8,
    maxDepth: 6,
    warmup: 1,
    iterations: 3,
    workers: 1,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--scenario") out.scenario = args[++i] as ScenarioKey;
    else if (a === "--width") out.width = Number(args[++i]);
    else if (a === "--height") out.height = Number(args[++i]);
    else if (a === "--samples") out.samples = Number(args[++i]);
    else if (a === "--max-depth") out.maxDepth = Number(args[++i]);
    else if (a === "--workers") out.workers = Number(args[++i]);
    else if (a === "--warmup") out.warmup = Number(args[++i]);
    else if (a === "--iterations") out.iterations = Number(args[++i]);
    else if (a === "--json") out.json = true;
  }
  return out;
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

function jobsFor(cfg: Config): TileJob[] {
  const rows = splitRows(cfg.height, cfg.workers);
  const seed = (0x9e3779b1 ^ (cfg.width * 17) ^ (cfg.height * 131) ^ (cfg.samples * 8191) ^ (cfg.maxDepth * 65537)) >>> 0;
  return rows.map((r, i) => ({
    id: i + 1,
    width: cfg.width,
    height: cfg.height,
    yStart: r.yStart,
    yEnd: r.yEnd,
    samples: cfg.samples,
    maxDepth: cfg.maxDepth,
    seed,
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

async function runMeasured(fn: () => Promise<{ checksum: number; pixels: number }>, warmup: number, iterations: number) {
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
    else if ((out.checksum >>> 0) !== checksum) throw new Error("Non-deterministic checksum");
    pixels = out.pixels;
  }
  return { medianMs: median(times), checksum, pixels };
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function workerOnceMessage(worker: Worker, timeoutMs: number, label: string): Promise<any> {
  return withTimeout(
    new Promise<any>((resolve) => {
      worker.onmessage = (ev: MessageEvent) => resolve(ev.data);
    }),
    timeoutMs,
    label,
  );
}

function pmWorkerScript(): string {
  return `${RAYTRACE_SOURCE}\nself.onmessage=(ev)=>{const m=ev.data;if(!m||m.type!==\"render\")return;const out=globalThis.__raytraceTile(m.job);self.postMessage({id:m.id,checksum:out.checksum>>>0,pixels:out.pixels>>>0});};`;
}

async function runPostMessage(cfg: Config) {
  const workerUrl = URL.createObjectURL(new Blob([pmWorkerScript()], { type: "application/javascript" }));
  const workers = Array.from({ length: cfg.workers }, () => new Worker(workerUrl, { type: "module" }));
  const pending = new Map<number, { resolve: (x: TileResult) => void; reject: (e: unknown) => void }>();
  let nextId = 1;

  for (const w of workers) {
    w.onmessage = (ev: MessageEvent) => {
      const m: any = ev.data;
      const entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      entry.resolve({ checksum: m.checksum >>> 0, pixels: m.pixels >>> 0 });
    };
  }

  try {
    const runOne = async () => {
      const jobs = jobsFor(cfg);
      const parts = await Promise.all(
        jobs.map((job, i) =>
          new Promise<TileResult>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            workers[i % workers.length].postMessage({ type: "render", id, job });
          }),
        ),
      );
      return aggregate(parts);
    };
    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    for (const w of workers) w.terminate();
  }
}

function httpWorkerScript(): string {
  return `${RAYTRACE_SOURCE}\nlet server;\nself.onmessage=(ev)=>{const m=ev.data;if(m&&m.type===\"stop\"&&server){server.stop();}};\nserver=Bun.serve({port:0,hostname:\"127.0.0.1\",fetch:async(req)=>{if(req.method!==\"POST\")return new Response(\"not found\",{status:404});const job=await req.json();const out=globalThis.__raytraceTile(job);return Response.json({checksum:out.checksum>>>0,pixels:out.pixels>>>0});}});self.postMessage({type:\"ready\",port:server.port});`;
}

async function runHttp(cfg: Config) {
  const workerUrl = URL.createObjectURL(new Blob([httpWorkerScript()], { type: "application/javascript" }));
  const workers = Array.from({ length: cfg.workers }, () => new Worker(workerUrl, { type: "module" }));
  const ready = await Promise.all(workers.map((w, i) => workerOnceMessage(w, READY_TIMEOUT_MS, `bun worker ready (${i})`)));
  const ports: number[] = ready.map((msg, i) => {
    const port = msg?.port | 0;
    if (!Number.isFinite(port) || port <= 0) throw new Error(`bun worker ${i} returned invalid port: ${msg?.port}`);
    return port;
  });

  try {
    const runOne = async () => {
      const jobs = jobsFor(cfg);
      const parts = await Promise.all(
        jobs.map(async (job, i) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          const res = await fetch(`http://127.0.0.1:${ports[i % ports.length]}/render`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(job),
            signal: controller.signal,
          }).finally(() => clearTimeout(timer));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const out: any = await res.json();
          return { checksum: out.checksum >>> 0, pixels: out.pixels >>> 0 } as TileResult;
        }),
      );
      return aggregate(parts);
    };
    return await runMeasured(runOne, cfg.warmup, cfg.iterations);
  } finally {
    await Promise.all(
      workers.map(async (w) => {
        try {
          w.postMessage({ type: "stop" });
        } catch {
          // ignore best-effort stop message failures
        }
        try {
          await Promise.resolve(w.terminate());
        } catch {
          // ignore terminate failures on shutdown path
        }
      }),
    );
    URL.revokeObjectURL(workerUrl);
  }
}

async function main() {
  const cfg = parseArgs();
  const out = cfg.scenario === "bun+bun-http" ? await runHttp(cfg) : await runPostMessage(cfg);
  if (cfg.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const mpixPerSec = (out.pixels / 1_000_000) / (out.medianMs / 1000);
  console.log(`# bun runtime ray bench`);
  console.log(`${cfg.scenario}: workers=${cfg.workers} median=${out.medianMs.toFixed(1)}ms throughput=${mpixPerSec.toFixed(2)} MPix/s checksum=0x${(out.checksum >>> 0).toString(16)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
