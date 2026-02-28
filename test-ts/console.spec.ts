import { DenoWorker } from "../src/index";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  cond: () => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number }
) {
  const timeoutMs = opts?.timeoutMs ?? 1000;
  const intervalMs = opts?.intervalMs ?? 25;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(intervalMs);
  }
  throw new Error("waitUntil: timed out");
}

function isNoopFunctionSource(src: unknown): boolean {
  if (typeof src !== "string") return false;
  return /function\s*\(\)\s*{\s*}/.test(src);
}

function isDateLike(x: unknown): x is Date {
  if (!x || typeof x !== "object") return false;
  return (
    Object.prototype.toString.call(x) === "[object Date]" &&
    typeof (x as any).getTime === "function"
  );
}

function captureStdioForMarkers(markers: string[]) {
  const outHits: string[] = [];
  const errHits: string[] = [];

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  function toText(chunk: any): string {
    if (typeof chunk === "string") return chunk;
    try {
      if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
    } catch {
      // ignore
    }
    try {
      return String(chunk ?? "");
    } catch {
      return "";
    }
  }

  function normalizeWriteArgs(args: any[]) {
    const [chunk, a2, a3] = args;
    let encoding: any = undefined;
    let cb: any = undefined;

    if (typeof a2 === "function") {
      cb = a2;
    } else {
      encoding = a2;
      if (typeof a3 === "function") cb = a3;
    }

    return { chunk, encoding, cb };
  }

  const outSpy = jest.spyOn(process.stdout, "write").mockImplementation((...args: any[]) => {
    const { chunk, encoding, cb } = normalizeWriteArgs(args);
    const s = toText(chunk);

    for (const m of markers) {
      if (s.includes(m)) {
        outHits.push(m);
        if (typeof cb === "function") cb();
        return true;
      }
    }

    return origOut(chunk, encoding, cb);
  });

  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation((...args: any[]) => {
    const { chunk, encoding, cb } = normalizeWriteArgs(args);
    const s = toText(chunk);

    for (const m of markers) {
      if (s.includes(m)) {
        errHits.push(m);
        if (typeof cb === "function") cb();
        return true;
      }
    }

    return origErr(chunk, encoding, cb);
  });

  return {
    outHits,
    errHits,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("DenoWorker console option", () => {
  test("console: false replaces console methods with no-ops", async () => {
    const dw = new DenoWorker({ console: false });

    try {
      const logSrc = await dw.eval("Function.prototype.toString.call(console.log)");
      const warnSrc = await dw.eval("Function.prototype.toString.call(console.warn)");
      const errSrc = await dw.eval("Function.prototype.toString.call(console.error)");

      expect(isNoopFunctionSource(logSrc)).toBe(true);
      expect(isNoopFunctionSource(warnSrc)).toBe(true);
      expect(isNoopFunctionSource(errSrc)).toBe(true);

      await expect(dw.eval('console.log("x"); console.warn("y"); console.error("z"); 123'))
        .resolves.toBe(123);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: { log: fn } routes console.log args to Node callback", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval('console.log("a", 1, { x: 2 }, new Date(0));');

      await waitUntil(() => received.length === 1, { timeoutMs: 1500, intervalMs: 25 });

      expect(received[0][0]).toBe("a");
      expect(received[0][1]).toBe(1);
      expect(received[0][2]).toEqual({ x: 2 });

      expect(isDateLike(received[0][3])).toBe(true);
      expect((received[0][3] as Date).getTime()).toBe(0);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: { warn: false } suppresses warn while log routes", async () => {
    const logs: string[] = [];
    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => logs.push(String(args[0])),
        warn: false,
      },
    });

    try {
      const warnSrc = await dw.eval("Function.prototype.toString.call(console.warn)");
      expect(isNoopFunctionSource(warnSrc)).toBe(true);

      await dw.eval('console.warn("w1"); console.log("l1"); console.warn("w2"); console.log("l2");');

      await waitUntil(() => logs.length === 2, { timeoutMs: 1500, intervalMs: 25 });
      expect(logs).toEqual(["l1", "l2"]);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: { log: async fn } supports async callbacks", async () => {
    const seen: string[] = [];
    const dw = new DenoWorker({
      console: {
        log: async (...args: any[]) => {
          await sleep(10);
          seen.push(String(args[0]));
        },
      },
    });

    try {
      await dw.eval('console.log("x"); console.log("y");');

      await waitUntil(() => seen.length === 2, { timeoutMs: 2000, intervalMs: 25 });
      expect(seen.sort()).toEqual(["x", "y"]);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: console routes to Node stdio", async () => {
    const markers = ["node-log", "node-err"];
    const cap = captureStdioForMarkers(markers);

    const dw = new DenoWorker({ console: console });

    try {
      await dw.eval('console.log("node-log", 1); console.error("node-err");');

      await waitUntil(
        () => {
          const all = [...cap.outHits, ...cap.errHits];
          return markers.every((m) => all.includes(m));
        },
        { timeoutMs: 2500, intervalMs: 25 }
      );

      const all = [...cap.outHits, ...cap.errHits];
      expect(all).toContain("node-log");
      expect(all).toContain("node-err");
    } finally {
      cap.restore();
      if (!dw.isClosed()) await dw.close();
    }
  });
});