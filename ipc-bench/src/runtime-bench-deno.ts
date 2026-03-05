type ScenarioKey = "deno+deno-postmessage" | "deno+deno-http";

type Config = {
    bytes: number;
    messages: number;
    warmup: number;
    iterations: number;
    transfer: "binary" | "json" | "string";
    restarts: number;
    json: boolean;
};

type Ack = { id?: number; size: number; checksum: number };
type JsonPayload = { blob: string; salt: number };
type TransferPayload = Uint8Array | JsonPayload | string;

function parseArgs(): Config {
    const args = Deno.args;
    const out: Config = {
        bytes: 1024 * 1024,
        messages: 128,
        warmup: 1,
        iterations: 3,
        transfer: "binary",
        restarts: 0,
        json: false,
    };

    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === "--bytes") out.bytes = Number(args[++i]);
        else if (a === "--messages") out.messages = Number(args[++i]);
        else if (a === "--warmup") out.warmup = Number(args[++i]);
        else if (a === "--iterations") out.iterations = Number(args[++i]);
        else if (a === "--transfer") {
            const mode = args[++i];
            out.transfer = mode === "json" || mode === "string" ? mode : "binary";
        }
        else if (a === "--restarts") out.restarts = Number(args[++i]);
        else if (a === "--json") out.json = true;
    }

    if (!Number.isFinite(out.bytes) || out.bytes <= 0) throw new Error("Invalid --bytes");
    if (!Number.isFinite(out.messages) || out.messages <= 0) throw new Error("Invalid --messages");
    if (!Number.isFinite(out.warmup) || out.warmup < 0) throw new Error("Invalid --warmup");
    if (!Number.isFinite(out.iterations) || out.iterations <= 0) throw new Error("Invalid --iterations");
    if (!Number.isFinite(out.restarts) || out.restarts < 0) throw new Error("Invalid --restarts");
    out.restarts = Math.trunc(out.restarts);
    return out;
}

function makePayload(size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let i = 0; i < out.length; i += 1) out[i] = (i * 131 + 17) & 0xff;
    return out;
}

function makeJsonPayload(size: number): JsonPayload {
    return { blob: "x".repeat(size), salt: ((size * 17) ^ 0x9e3779b1) >>> 0 };
}

function makeStringPayload(size: number): string {
    return "x".repeat(size);
}

function ackChecksum(payload: Uint8Array): number {
    const first = payload.length > 0 ? payload[0] : 0;
    const last = payload.length > 0 ? payload[payload.length - 1] : 0;
    return ((payload.length >>> 0) ^ first ^ (last << 8)) >>> 0;
}

function ackChecksumJson(payload: JsonPayload): number {
    const size = payload.blob.length >>> 0;
    const first = payload.blob.length > 0 ? payload.blob.charCodeAt(0) & 0xff : 0;
    const last = payload.blob.length > 0 ? payload.blob.charCodeAt(payload.blob.length - 1) & 0xff : 0;
    return ((size >>> 0) ^ first ^ (last << 8) ^ (payload.salt >>> 0)) >>> 0;
}

function ackChecksumString(payload: string): number {
    const size = new TextEncoder().encode(payload).length;
    const first = payload.length > 0 ? payload.charCodeAt(0) & 0xff : 0;
    const last = payload.length > 0 ? payload.charCodeAt(payload.length - 1) & 0xff : 0;
    return ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
}

function payloadBytes(payload: TransferPayload): number {
    if (payload instanceof Uint8Array) return payload.length;
    if (typeof payload === "string") return new TextEncoder().encode(payload).length;
    return new TextEncoder().encode(payload.blob).length;
}

function payloadChecksum(payload: TransferPayload): number {
    if (payload instanceof Uint8Array) return ackChecksum(payload);
    if (typeof payload === "string") return ackChecksumString(payload);
    return ackChecksumJson(payload);
}

function mergeChecksums(values: number[]): number {
    let acc = 0x811c9dc5;
    for (const v of values) {
        acc ^= v >>> 0;
        acc = Math.imul(acc, 16777619) >>> 0;
    }
    return acc >>> 0;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
}

function mbps(totalBytes: number, ms: number): number {
    return totalBytes / (ms / 1000) / (1024 * 1024);
}

function expectedFoldForCount(expectedAck: number, payloadBytes: number, count: number): number {
    const v = ((expectedAck ^ payloadBytes) >>> 0);
    let acc = 0x811c9dc5;
    for (let i = 0; i < count; i += 1) {
        acc ^= v;
        acc = Math.imul(acc, 16777619) >>> 0;
    }
    return acc >>> 0;
}

function splitCounts(total: number, parts: number): number[] {
    const out: number[] = [];
    const p = Math.max(1, parts | 0);
    const base = Math.floor(total / p);
    let rem = total % p;
    for (let i = 0; i < p; i += 1) {
        const n = base + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
        if (n > 0) out.push(n);
    }
    return out;
}

function createWorkerScript(): string {
    return `
self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "echo") return;
  const p = msg.payload;
  if (p instanceof Uint8Array) {
    const first = p.length > 0 ? p[0] : 0;
    const last = p.length > 0 ? p[p.length - 1] : 0;
    const checksum = ((p.length >>> 0) ^ first ^ (last << 8)) >>> 0;
    self.postMessage({ id: msg.id, size: p.length >>> 0, checksum });
    return;
  }
  if (typeof p === "string") {
    const size = new TextEncoder().encode(p).length;
    const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
    const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
    const checksum = ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
    self.postMessage({ id: msg.id, size: size >>> 0, checksum });
    return;
  }
  if (p && typeof p === "object" && typeof p.blob === "string") {
    const blob = p.blob;
    const size = blob.length >>> 0;
    const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
    const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
    const salt = Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
    const checksum = ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0;
    self.postMessage({ id: msg.id, size: size >>> 0, checksum });
  }
};
`;
}

async function runPostMessage(
    payload: TransferPayload,
    messages: number,
    warmup: number,
    iterations: number,
    expectedFold: number,
    restarts: number,
): Promise<number> {
    const counts = splitCounts(messages, restarts + 1);
    const unitBytes = payloadBytes(payload);
    const expectedAck = payloadChecksum(payload);
    const workerUrl = URL.createObjectURL(new Blob([createWorkerScript()], { type: "application/javascript" }));
    const worker = new Worker(workerUrl, { type: "module" });
    const pending = new Map<number, { resolve: (ack: Ack) => void; reject: (err: unknown) => void }>();
    let nextId = 1;

    worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as Ack;
        const id = msg.id || 0;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.resolve(msg);
    };

    const oneSegment = async (count: number): Promise<number> => {
        const oneRun = async (): Promise<number> => {
            const promises = Array.from({ length: count }, () => {
                const id = nextId++;
                return new Promise<Ack>((resolve, reject) => {
                    pending.set(id, { resolve, reject });
                    worker.postMessage({ type: "echo", id, payload });
                });
            });
            const out = await Promise.all(promises);
            return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
        };
        return await oneRun();
    };

    const oneRun = async (): Promise<number> => {
        if (restarts <= 0) return await oneSegment(messages);
        for (const c of counts) {
            const sum = await oneSegment(c);
            const expectedSegment = expectedFoldForCount(expectedAck, unitBytes, c);
            if (sum !== expectedSegment) {
                throw new Error(`Checksum mismatch in deno postMessage segment(count=${c}): expected ${expectedSegment}, got ${sum}`);
            }
        }
        return expectedFold;
    };
    try {
        for (let i = 0; i < warmup; i += 1) await oneRun();
        const dts: number[] = [];
        for (let i = 0; i < iterations; i += 1) {
            const t0 = performance.now();
            const checksum = await oneRun();
            const dt = performance.now() - t0;
            if (checksum !== expectedFold) throw new Error(`Checksum mismatch in deno postMessage: expected ${expectedFold}, got ${checksum}`);
            dts.push(dt);
        }
        return median(dts);
    } finally {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
    }
}

async function runHttp(
    payload: TransferPayload,
    messages: number,
    warmup: number,
    iterations: number,
    expectedFold: number,
    restarts: number,
): Promise<number> {
    const counts = splitCounts(messages, restarts + 1);
    const unitBytes = payloadBytes(payload);
    const expectedAck = payloadChecksum(payload);
    const ac = new AbortController();
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal }, async (req) => {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/echo") return new Response("not found", { status: 404 });
        const ct = req.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
            const p = (await req.json()) as JsonPayload;
            const blob = p && typeof p.blob === "string" ? p.blob : "";
            const size = blob.length >>> 0;
            const first = blob.length > 0 ? blob.charCodeAt(0) & 0xff : 0;
            const last = blob.length > 0 ? blob.charCodeAt(blob.length - 1) & 0xff : 0;
            const checksum = ((size >>> 0) ^ first ^ (last << 8) ^ ((p.salt || 0) >>> 0)) >>> 0;
            return Response.json({ size: size >>> 0, checksum });
        }
        if (ct.includes("text/plain")) {
            const text = await req.text();
            const size = new TextEncoder().encode(text).length;
            const first = text.length > 0 ? text.charCodeAt(0) & 0xff : 0;
            const last = text.length > 0 ? text.charCodeAt(text.length - 1) & 0xff : 0;
            const checksum = ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
            return Response.json({ size: size >>> 0, checksum });
        }
        const body = new Uint8Array(await req.arrayBuffer());
        const first = body.length > 0 ? body[0] : 0;
        const last = body.length > 0 ? body[body.length - 1] : 0;
        const checksum = ((body.length >>> 0) ^ first ^ (last << 8)) >>> 0;
        return Response.json({ size: body.length >>> 0, checksum });
    });
    const addr = server.addr as Deno.NetAddr;
    const port = addr.port;

    const oneSegment = async (count: number): Promise<number> => {
        const oneRun = async (): Promise<number> => {
            const isJson = !(payload instanceof Uint8Array) && typeof payload !== "string";
            const isString = typeof payload === "string";
            const promises = Array.from({ length: count }, async () => {
                const resp = await fetch(`http://127.0.0.1:${port}/echo`, {
                    method: "POST",
                    headers: { "content-type": isJson ? "application/json" : isString ? "text/plain" : "application/octet-stream" },
                    body: isJson ? JSON.stringify(payload) : payload,
                });
                if (!resp.ok) throw new Error(`HTTP echo failed (${resp.status})`);
                return (await resp.json()) as Ack;
            });
            const out = await Promise.all(promises);
            return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
        };
        return await oneRun();
    };

    const oneRun = async (): Promise<number> => {
        if (restarts <= 0) return await oneSegment(messages);
        for (const c of counts) {
            const sum = await oneSegment(c);
            const expectedSegment = expectedFoldForCount(expectedAck, unitBytes, c);
            if (sum !== expectedSegment) {
                throw new Error(`Checksum mismatch in deno HTTP segment(count=${c}): expected ${expectedSegment}, got ${sum}`);
            }
        }
        return expectedFold;
    };

    try {
        for (let i = 0; i < warmup; i += 1) await oneRun();
        const dts: number[] = [];
        for (let i = 0; i < iterations; i += 1) {
            const t0 = performance.now();
            const checksum = await oneRun();
            const dt = performance.now() - t0;
            if (checksum !== expectedFold) throw new Error(`Checksum mismatch in deno HTTP: expected ${expectedFold}, got ${checksum}`);
            dts.push(dt);
        }
        return median(dts);
    } finally {
        ac.abort();
        try {
            await server.finished;
        } catch {
            // expected on abort
        }
    }
}

async function main(): Promise<void> {
    const config = parseArgs();
    const payload =
        config.transfer === "json" ? makeJsonPayload(config.bytes) : config.transfer === "string" ? makeStringPayload(config.bytes) : makePayload(config.bytes);
    const expectedAck = payloadChecksum(payload);
    const expectedFold = mergeChecksums(Array.from({ length: config.messages }, () => expectedAck ^ config.bytes));
    const totalBytes = config.bytes * config.messages;

    const postMs = await runPostMessage(payload, config.messages, config.warmup, config.iterations, expectedFold, config.restarts);
    const httpMs = await runHttp(payload, config.messages, config.warmup, config.iterations, expectedFold, config.restarts);

    const results: Record<ScenarioKey, number> = {
        "deno+deno-postmessage": mbps(totalBytes, postMs),
        "deno+deno-http": mbps(totalBytes, httpMs),
    };

    if (config.json) {
        console.log(JSON.stringify({ runtime: "deno", results }));
    } else {
        console.log(results);
    }
}

main().catch((err) => {
    console.error(err);
    Deno.exit(1);
});
