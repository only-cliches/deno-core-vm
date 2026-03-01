import { DenoWorker } from "../src/index";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const intervalMs = opts?.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const ok = await predicate();
      if (ok) return;
    } catch {
      // ignore
    }
    await sleep(intervalMs);
  }

  throw new Error("waitUntil timeout");
}

function isDateLike(x: any): boolean {
  if (!x || typeof x !== "object") return false;
  try {
    const ms = x.getTime?.();
    return typeof ms === "number" && Number.isFinite(ms);
  } catch {
    return false;
  }
}

describe("console option", () => {
  test("console: false disables all methods", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: false,
    });

    try {
      await dw.eval('console.log("x"); console.error("y"); 1 + 1;');

      await sleep(50);
      expect(received.length).toBe(0);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: node routes logs to Node console methods (smoke)", async () => {
    const received: any[] = [];
    const orig = console.log;

    console.log = (...args: any[]) => {
      received.push(["log", ...args]);
    };

    const dw = new DenoWorker({
      console: console,
    } as any);

    try {
      await dw.eval('console.log("hello", 1);');

      await waitUntil(() => received.length === 1);
      expect(received[0][0]).toBe("log");
      expect(received[0][1]).toBe("hello");
      expect(received[0][2]).toBe(1);
    } finally {
      console.log = orig;
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: per-method routing supports sync handlers", async () => {
    const received: any[][] = [];

    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval('console.log("a", 2);');

      await waitUntil(() => received.length === 1);
      expect(received[0]).toEqual(["a", 2]);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: per-method routing supports async handlers (awaited by wrapper)", async () => {
    const received: any[][] = [];

    const dw = new DenoWorker({
      console: {
        log: async (...args: any[]) => {
          await sleep(10);
          received.push(args);
        },
      },
    });

    try {
      await dw.eval('console.log("b", 3);');

      await waitUntil(() => received.length === 1);
      expect(received[0]).toEqual(["b", 3]);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: Date argument round-trips (top-level)", async () => {
    const received: any[][] = [];

    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval("console.log('x', new Date(0));");

      await waitUntil(() => received.length === 1);

      expect(received[0][0]).toBe("x");
      expect(isDateLike(received[0][1])).toBe(true);
      expect(received[0][1].getTime()).toBe(0);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console: setting warn:false disables warn but keeps others", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: {
        warn: false,
        log: (...args: any[]) => received.push(args),
      },
    });

    try {
      await dw.eval("console.warn('nope'); console.log('yep');");

      await waitUntil(() => received.length === 1);
      expect(received[0]).toEqual(["yep"]);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console callback errors are swallowed (sync)", async () => {
    const dw = new DenoWorker({
      console: {
        log: () => {
          throw new Error("boom");
        },
      },
    });

    try {
      await expect(dw.eval('console.log("x"); 42')).resolves.toBe(42);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console callback errors are swallowed (async rejection)", async () => {
    const dw = new DenoWorker({
      console: {
        log: async () => {
          await sleep(5);
          throw new Error("boom");
        },
      },
    });

    try {
      await expect(dw.eval('console.log("x"); 42')).resolves.toBe(42);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console argument dehydration: BigInt becomes string, symbol/function become null", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval('console.log(123n, Symbol("x"), function f() {});');

      await waitUntil(() => received.length === 1, { timeoutMs: 1500, intervalMs: 25 });

      expect(received[0][0]).toBe("123");
      expect(received[0][1]).toBeNull();
      expect(received[0][2]).toBeNull();
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console argument dehydration: circular objects are truncated", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval("const a = {}; a.self = a; console.log(a);");

      await waitUntil(() => received.length === 1, { timeoutMs: 1500, intervalMs: 25 });

      expect(received[0][0]).toEqual({ self: null });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console argument dehydration: Uint8Array becomes Buffer in Node callback", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval("console.log(new Uint8Array([1,2,3]));");

      await waitUntil(() => received.length === 1, { timeoutMs: 1500, intervalMs: 25 });

      const b = received[0][0];
      expect(Buffer.isBuffer(b)).toBe(true);
      expect(Array.from(b as Uint8Array)).toEqual([1, 2, 3]);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("console argument dehydration: nested Date markers are not automatically rehydrated", async () => {
    const received: any[][] = [];
    const dw = new DenoWorker({
      console: {
        log: (...args: any[]) => {
          received.push(args);
        },
      },
    });

    try {
      await dw.eval("console.log({ d: new Date(0) });");

      await waitUntil(() => received.length === 1, { timeoutMs: 1500, intervalMs: 25 });

      expect(received[0][0]).toEqual({ d: { __date: 0 } });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });
});