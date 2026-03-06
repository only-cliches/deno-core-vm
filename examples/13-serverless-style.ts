import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DenoDirector } from "../src/index";

// Shape of the payload that Node forwards into a Deno runtime.
// This is intentionally simple; in a real app you can add auth/session/correlation IDs.
type RequestPayload = {
  userId: string;
  action: string;
  body?: Record<string, unknown>;
};

// Shape returned from the Deno runtime back to Node.
type HandlerResult = {
  ok: boolean;
  tenant: string;
  host: string;
  userId: string;
  action: string;
  method: string;
  path: string;
  receivedKeys: string[];
  now: string;
};

// Per-host runtime pool configuration.
// poolSize controls how many warm runtimes each host gets.
type TenantConfig = {
  id: string;
  poolSize: number;
};

// One slot in a pool: a runtime instance + current in-flight request count.
// We use inFlight as a very cheap load-balancing signal.
type PoolSlot = {
  runtime: Awaited<ReturnType<typeof director.start>>;
  inFlight: number;
};

// Hostname -> tenant mapping.
// Requests are routed by Host/x-forwarded-host header to one of these pools.
const TENANTS: Record<string, TenantConfig> = {
  "api.local.test": { id: "tenant-api", poolSize: 2 },
  "admin.local.test": { id: "tenant-admin", poolSize: 1 },
};

// Director provides lifecycle management for many warm Deno runtimes.
// The template applies to every runtime we start.
const director = new DenoDirector({
  template: {
    workerOptions: {
      // Lock down runtime permissions by default.
      permissions: {
        net: false,
        read: false,
        write: false,
        env: false,
      },
      // Keep request latency bounded and cap memory footprint.
      limits: {
        maxEvalMs: 1500,
        maxMemoryBytes: 128 * 1024 * 1024,
      },
    },
  },
});

// Hostname -> lazy-created pool promise.
// Promise caching prevents duplicate pool creation under concurrent first requests.
const tenantPools = new Map<string, Promise<PoolSlot[]>>();

// Small helper for consistent JSON responses.
function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(encoded.byteLength),
  });
  res.end(encoded);
}

// Extract hostname for routing.
// Priority:
// 1) x-forwarded-host (for reverse-proxy deployments)
// 2) host
// We strip any "," chain and port suffix, then normalize to lowercase.
function getHostname(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-host"];
  const hostHeader = Array.isArray(forwarded) ? forwarded[0] : forwarded ?? req.headers.host;
  const raw = String(hostHeader ?? "").split(",")[0]?.trim() ?? "";
  if (!raw) return "";

  try {
    // URL parsing handles IPv6 bracket forms and explicit ports robustly.
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    // Fallback for malformed host values.
    return raw.split(":")[0]?.toLowerCase() ?? "";
  }
}

// Pick the least busy runtime slot in a pool.
// This keeps hot hosts balanced without adding queueing complexity.
function pickLeastBusySlot(pool: PoolSlot[]): PoolSlot {
  let best = pool[0];
  for (let i = 1; i < pool.length; i += 1) {
    if (pool[i].inFlight < best.inFlight) best = pool[i];
  }
  return best;
}

// Lazy-create (or reuse) the warm runtime pool for a hostname.
// If pool creation fails, we remove the cached promise so future requests can retry.
async function getTenantPool(hostname: string): Promise<PoolSlot[]> {
  const cfg = TENANTS[hostname];
  if (!cfg) throw new Error(`Unknown tenant host: ${hostname}`);

  const existing = tenantPools.get(hostname);
  if (existing) return await existing;

  const created = (async () => {
    const runtimes = await Promise.all(
      Array.from({ length: cfg.poolSize }, (_, i) =>
        director.start({
          // Human-readable label/tags are useful for introspection/ops.
          label: `${cfg.id}-warm-${i}`,
          tags: ["serverless", "warm", `host:${hostname}`, `tenant:${cfg.id}`],
          // Inject tenant metadata into runtime globals so sandbox code can branch safely.
          globals: {
            TENANT_ID: cfg.id,
            TENANT_HOST: hostname,
          },
        }),
      ),
    );

    return runtimes.map((runtime) => ({ runtime, inFlight: 0 }));
  })();

  tenantPools.set(hostname, created);
  try {
    return await created;
  } catch (err) {
    tenantPools.delete(hostname);
    throw err;
  }
}

// Read and validate JSON request body.
// We cap size to avoid accidental memory blowups on malformed/bad clients.
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX_BYTES = 1024 * 1024;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_BYTES) throw new Error("Request body exceeds 1 MiB limit");
    chunks.push(buf);
  }

  if (chunks.length === 0) return undefined;

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;

  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }

  return parsed as Record<string, unknown>;
}

// Send one request payload into one runtime.
// We increment/decrement inFlight so concurrent requests spread naturally.
async function invokeTenantRuntime(hostname: string, payload: RequestPayload & { method: string; path: string }): Promise<HandlerResult> {
  const pool = await getTenantPool(hostname);
  const slot = pickLeastBusySlot(pool);

  slot.inFlight += 1;
  try {
    return await slot.runtime.eval<HandlerResult>(
      `
      (input) => {
        const body = input?.body && typeof input.body === "object" ? input.body : {};

        return {
          ok: true,
          tenant: String(globalThis.TENANT_ID ?? "unknown"),
          host: String(globalThis.TENANT_HOST ?? "unknown"),
          userId: String(input?.userId ?? "anonymous"),
          action: String(input?.action ?? "request"),
          method: String(input?.method ?? "GET"),
          path: String(input?.path ?? "/"),
          receivedKeys: Object.keys(body).sort(),
          now: new Date().toISOString(),
        };
      }
      `,
      { args: [payload] },
    );
  } finally {
    slot.inFlight -= 1;
  }
}

// Main HTTP handler.
// Flow:
// 1) resolve tenant via Host header
// 2) validate route/method
// 3) parse body and map request -> runtime payload
// 4) invoke runtime and return JSON
async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = String(req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const hostname = getHostname(req);

  if (!hostname) {
    writeJson(res, 400, { ok: false, error: "Missing Host/x-forwarded-host header" });
    return;
  }

  if (!TENANTS[hostname]) {
    writeJson(res, 404, { ok: false, error: `No runtime pool configured for host '${hostname}'` });
    return;
  }

  if (url.pathname !== "/invoke") {
    writeJson(res, 404, { ok: false, error: "Use POST /invoke" });
    return;
  }

  if (method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported for /invoke" });
    return;
  }

  try {
    const body = await readJsonBody(req);

    // Example of passing host-side context into runtime payload.
    const userIdHeader = req.headers["x-user-id"];
    const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader;
    const action = url.searchParams.get("action") ?? "request";

    const payload: RequestPayload & { method: string; path: string } = {
      userId: String(userId ?? "anonymous"),
      action,
      method,
      path: url.pathname,
      body,
    };

    const out = await invokeTenantRuntime(hostname, payload);
    writeJson(res, 200, out);
  } catch (err) {
    // Cheap status mapping: malformed payload -> 400, everything else -> 500.
    const msg = err instanceof Error ? err.message : String(err);
    const status = /JSON|body/i.test(msg) ? 400 : 500;
    writeJson(res, status, { ok: false, error: msg });
  }
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);

  // Single Node server hosting the app.
  // Runtime isolation happens behind this boundary per request.
  const server = createServer((req, res) => {
    void requestHandler(req, res);
  });

  const started = await new Promise<boolean>((resolve, reject) => {
    const onError = (err: unknown) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(true);
    });
  }).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    // In restricted sandboxes, binding a local port may not be allowed.
    // Fall back to a non-network runtime invocation so this example still runs.
    console.warn(`server listen failed (${msg}); running non-network fallback`);
    const out = await invokeTenantRuntime("api.local.test", {
      userId: "sandbox-user",
      action: "fallback",
      method: "POST",
      path: "/invoke",
      body: { mode: "offline" },
    });
    console.log("fallback result:", out);
    await director.stopAll().catch(() => undefined);
    return false;
  });
  if (!started) return;

  console.log(`server listening on http://127.0.0.1:${port}`);
  console.log("configured hosts:", Object.keys(TENANTS).join(", "));
  console.log("try:");
  console.log(
    `curl -s -X POST http://127.0.0.1:${port}/invoke?action=create -H 'host: api.local.test' -H 'content-type: application/json' -H 'x-user-id: u-100' -d '{"plan":"pro","region":"us-west"}'`,
  );

  // Graceful shutdown:
  // 1) stop accepting new HTTP connections
  // 2) close all Deno runtimes
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await director.stopAll().catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch(async (err) => {
  console.error(err);
  await director.stopAll().catch(() => undefined);
  process.exitCode = 1;
});
