import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestWorker } from "./helpers.worker-harness";

function isBindPermissionError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  return err?.code === "EPERM" || /EPERM/i.test(msg);
}

async function startServer(routes: Record<string, string>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url || "/";
    const url = rawUrl.split("?")[0];
    const body = routes[url];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/typescript");
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server address unavailable");
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function makeTempCacheDir(prefix = "deno-director-remote-cache-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function withHardTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return await Promise.race([
    p,
    (async () => {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      throw new Error(`test hard-timeout after ${ms}ms`);
    })(),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe("moduleLoader.httpsResolve MVP", () => {
  test("remote http import is blocked when httpResolve is disabled", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const Application = class {}`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({ imports: true });
    try {
      const src = `
        import { Application } from "${srv.base}/oak/mod.ts";
        export const out = typeof Application;
      `;
      await expect(dw.module.eval(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });

  test("remote ts import works with httpsResolve+transpileTs", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    const cacheDir = await makeTempCacheDir();
    try {
      srv = await startServer({
        "/oak/mod.ts": `
          export class Application {
            static kind: string = "oak";
          }
        `,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({
      imports: true,
      transpileTs: true,
      moduleLoader: { httpsResolve: true, httpResolve: true, cacheDir },
      permissions: { import: true, net: true },
    });

    try {
      const src = `
        import { Application } from "${srv.base}/oak/mod.ts";
        export const out = Application.kind;
      `;
      await expect(dw.module.eval(src)).resolves.toMatchObject({ out: "oak" });
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("httpsResolve implicitly enables imports when imports is not set", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    const cacheDir = await makeTempCacheDir();
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const ok: string = "yes";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({
      transpileTs: true,
      moduleLoader: { httpsResolve: true, httpResolve: true, cacheDir },
      permissions: { import: true, net: true },
    });

    try {
      const src = `
        import { ok } from "${srv.base}/oak/mod.ts";
        export const out = ok;
      `;
      await expect(dw.module.eval(src)).resolves.toMatchObject({ out: "yes" });
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("remote ts import is rejected when transpileTs is false", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    const cacheDir = await makeTempCacheDir();
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const v: number = 7;`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({
      imports: true,
      transpileTs: false,
      moduleLoader: { httpsResolve: true, httpResolve: true, cacheDir },
      permissions: { import: true, net: true },
    });

    try {
      const src = `
        import { v } from "${srv.base}/oak/mod.ts";
        export const out = v;
      `;
      await expect(dw.module.eval(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("callback import path still enforces net/import permissions for remote URLs", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const v: string = "ok";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({
      imports: () => true,
      transpileTs: true,
      moduleLoader: { httpsResolve: true, httpResolve: true },
      permissions: { import: true, net: false },
    });

    try {
      const src = `
        import { v } from "${srv.base}/oak/mod.ts";
        export const out = v;
      `;
      await expect(dw.module.eval(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });

  test("permissions.import URL allowlist does not allow host-prefix confusion", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const v: string = "ok";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const url = new URL("/oak/mod.ts", srv.base);
    const confusedHost = `${url.protocol}//${url.host}.attacker.invalid${url.pathname}`;

    const dw = createTestWorker({
      imports: true,
      transpileTs: true,
      moduleLoader: { httpsResolve: true, httpResolve: true },
      permissions: { import: [srv.base], net: true },
    });

    try {
      const src = `
        import { v } from "${confusedHost}";
        export const out = v;
      `;
      await expect(dw.module.eval(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });

  test("imports callback promise timeout rejects instead of hanging", async () => {
    const dw = createTestWorker({
      imports: async () => await new Promise(() => {}),
    });

    try {
      const src = `
        import { x } from "virtual:never";
        export const out = x;
      `;
      await expect(withHardTimeout(dw.module.eval(src), 7000)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close({ force: true }).catch(() => undefined);
    }
  }, 12000);

  test("jsr specifier is blocked when jsrResolve is disabled", async () => {
    const dw = createTestWorker({
      imports: true,
      moduleLoader: { httpsResolve: true, jsrResolve: false },
      permissions: { import: true, net: true },
    });

    try {
      const src = `
        import { assert } from "jsr:@std/assert";
        export const out = typeof assert;
      `;
      await expect(dw.module.eval(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("jsrResolve maps @std/* to jsr.io and still enforces net permissions", async () => {
    const dw = createTestWorker({
      imports: true,
      moduleLoader: { httpsResolve: true, jsrResolve: true },
      permissions: { import: true, net: false },
    });

    try {
      const src = `
        import { assert } from "@std/assert";
        export const out = typeof assert;
      `;
      await expect(withHardTimeout(dw.module.eval(src), 12000)).rejects.toThrow(/jsr\.io/i);
    } finally {
      if (!dw.isClosed()) await dw.close().catch(() => undefined);
    }
  }, 20000);

  test("remote payload is rejected when it exceeds maxPayloadBytes", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/big/mod.ts": `export const data = "${"x".repeat(8192)}";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({
      imports: true,
      transpileTs: true,
      moduleLoader: { httpResolve: true, maxPayloadBytes: 1024 },
      permissions: { import: true, net: true },
    });

    try {
      const src = `
        import { data } from "${srv.base}/big/mod.ts";
        export const out = data.length;
      `;
      await expect(dw.module.eval(src)).rejects.toThrow(/payload too large/i);
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });

  test("permissions.import host/port rules enforce exact port while allowing exact origin", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/ok/mod.ts": `export const v = 42;`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const ok = createTestWorker({
      imports: true,
      transpileTs: true,
      moduleLoader: { httpsResolve: true, httpResolve: true },
      permissions: { import: [srv.base], net: true },
    });
    const wrongPort = new URL("/ok/mod.ts", srv.base);
    wrongPort.port = String(Number(wrongPort.port || "80") + 1);
    const bad = createTestWorker({
      imports: true,
      moduleLoader: { httpsResolve: true, httpResolve: true },
      permissions: { import: [wrongPort.origin], net: true },
    });

    try {
      await expect(
        ok.module.eval(`import { v } from "${srv.base}/ok/mod.ts"; export const out = v;`),
      ).resolves.toMatchObject({ out: 42 });
      await expect(
        bad.module.eval(`import { v } from "${srv.base}/ok/mod.ts"; export const out = v;`),
      ).rejects.toThrow(/permissions\.import|denied/i);
    } finally {
      if (!ok.isClosed()) await ok.close();
      if (!bad.isClosed()) await bad.close();
      await srv.close();
    }
  });

  test("permissions.import path boundary rejects sibling prefix collisions", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/api/mod.ts": `export const v = "ok";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = createTestWorker({
      imports: true,
      moduleLoader: { httpsResolve: true, httpResolve: true },
      permissions: { import: [`${srv.base}/ap`], net: true },
    });

    try {
      const src = `import { v } from "${srv.base}/api/mod.ts"; export const out = v;`;
      await expect(dw.module.eval(src)).rejects.toThrow(/permissions\.import|denied/i);
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });

  test("permissions.import URL allows query/fragment variations on same path", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/q/mod.ts": `export const v = "q-ok";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const allow = `${srv.base}/q`;
    const dw = createTestWorker({
      imports: true,
      transpileTs: true,
      moduleLoader: { httpsResolve: true, httpResolve: true },
      permissions: { import: [allow], net: true },
    });

    try {
      const src = `import { v } from "${srv.base}/q/mod.ts?x=1#frag"; export const out = v;`;
      await expect(dw.module.eval(src)).resolves.toMatchObject({ out: "q-ok" });
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });
});
