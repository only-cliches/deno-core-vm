import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";

import { DenoWorker } from "../src/index";

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

async function rmRF(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

async function writeFile(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf8");
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close(() => reject(new Error("failed to bind ephemeral port")));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

function isBindPermissionError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  return err?.code === "EPERM" || /EPERM/i.test(msg);
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

describe("inspect + envFile", () => {
  test("inspect option starts inspector server (basic connect)", async () => {
    let port: number;
    try {
      port = await findFreePort();
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    let dw: DenoWorker | undefined;
    try {
      dw = new DenoWorker({
        inspect: { host: "127.0.0.1", port },
        permissions: { env: true },
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    try {
      const j = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      expect(typeof j).toBe("object");
      expect(j.Browser).toBe("denojs-worker");
    } finally {
      if (dw && !dw.isClosed()) await dw.close();
    }
  });

  test("inspect: host=localhost binds to 127.0.0.1", async () => {
    let port: number;
    try {
      port = await findFreePort();
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    let dw: DenoWorker | undefined;
    try {
      dw = new DenoWorker({
        inspect: { host: "localhost", port },
        permissions: { env: true },
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    try {
      const j = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      expect(j.Browser).toBe("denojs-worker");
    } finally {
      if (dw && !dw.isClosed()) await dw.close();
    }
  });

  test("env option injects values at startup and auto-enables env permission", async () => {
    const key = `TEST_ENV_${Date.now()}`;
    const dw = new DenoWorker({
      env: { [key]: "from-config" },
    });

    try {
      const v = await dw.eval(`Deno.env.get("${key}")`);
      expect(v).toBe("from-config");
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("envFile true loads .env from cwd upward", async () => {
    const root = await mkTempDir("denojs-worker-envfile-");
    const nested = path.join(root, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });

    const key = `TEST_ENV_${Date.now()}`;
    await writeFile(path.join(root, ".env"), `${key}=from-dotenv\n`);

    const dw = new DenoWorker({
      cwd: nested,
      envFile: true,
      permissions: { env: true, read: true },
    });

    try {
      const v = await dw.eval(`Deno.env.get("${key}")`);
      expect(v).toBe("from-dotenv");
    } finally {
      if (!dw.isClosed()) await dw.close();
      await rmRF(root);
    }
  });

  test("envFile string loads from explicit path", async () => {
    const root = await mkTempDir("denojs-worker-envfile-path-");
    const envPath = path.join(root, "config", "test.env");

    const key = `TEST_ENV_${Date.now()}`;
    await writeFile(envPath, `${key}=from-explicit\n`);

    const dw = new DenoWorker({
      cwd: root,
      envFile: envPath,
      permissions: { env: true, read: true },
    });

    try {
      const v = await dw.eval(`Deno.env.get("${key}")`);
      expect(v).toBe("from-explicit");
    } finally {
      if (!dw.isClosed()) await dw.close();
      await rmRF(root);
    }
  });

  test("envFile values are isolated to the worker that loaded them", async () => {
    const root = await mkTempDir("denojs-worker-envfile-isolated-");
    const nested = path.join(root, "runtime");
    await fs.mkdir(nested, { recursive: true });

    const key = `TEST_ENV_${Date.now()}`;
    await writeFile(path.join(root, ".env"), `${key}=from-dotenv-local\n`);

    const dw1 = new DenoWorker({
      cwd: nested,
      envFile: true,
      permissions: { env: true, read: true },
    });
    const dw2 = new DenoWorker({
      cwd: nested,
      permissions: { env: true, read: true },
    });

    try {
      expect(await dw1.eval(`Deno.env.get("${key}")`)).toBe("from-dotenv-local");
      expect(await dw2.eval(`Deno.env.get("${key}")`)).toBeUndefined();
    } finally {
      if (!dw1.isClosed()) await dw1.close();
      if (!dw2.isClosed()) await dw2.close();
      await rmRF(root);
    }
  });

  test("envFile: parses export prefix, quotes, and inline comments", async () => {
    const root = await mkTempDir("denojs-worker-envfile-parse-");
    const envPath = path.join(root, ".env");

    const k1 = `TEST_ENV_${Date.now()}_A`;
    const k2 = `TEST_ENV_${Date.now()}_B`;
    const k3 = `TEST_ENV_${Date.now()}_C`;

    await writeFile(
      envPath,
      [
        `export ${k1}="hello world"`,
        `${k2}='single quoted'`,
        `${k3}=unquoted # comment`,
        ``,
      ].join("\n")
    );

    const dw = new DenoWorker({
      cwd: root,
      envFile: true,
      permissions: { env: true, read: true },
    });

    try {
      expect(await dw.eval(`Deno.env.get("${k1}")`)).toBe("hello world");
      expect(await dw.eval(`Deno.env.get("${k2}")`)).toBe("single quoted");
      expect(await dw.eval(`Deno.env.get("${k3}")`)).toBe("unquoted");
    } finally {
      if (!dw.isClosed()) await dw.close();
      await rmRF(root);
    }
  });

  test("envFile auto-enables env permission (even if env:false is provided)", async () => {
    const root = await mkTempDir("denojs-worker-envfile-perms-");
    const envPath = path.join(root, ".env");

    const key = `TEST_ENV_${Date.now()}`;
    await writeFile(envPath, `${key}=secret\n`);

    const dw = new DenoWorker({
      cwd: root,
      envFile: true,
      permissions: { env: false, read: true },
    });

    try {
      await expect(dw.eval(`Deno.env.get("${key}")`)).resolves.toBe("secret");
    } finally {
      if (!dw.isClosed()) await dw.close();
      await rmRF(root);
    }
  });
});
