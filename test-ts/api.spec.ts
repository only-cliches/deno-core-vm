import { DenoWorker } from "../src/index";
import { sleep } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";

describe("DenoWorker API", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = createTestWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  test("postMessage throws and tryPostMessage returns false when closed", async () => {
    await dw.close();
    expect(dw.isClosed()).toBe(true);

    expect(dw.tryPostMessage({ a: 1 })).toBe(false);
    expect(() => dw.postMessage({ a: 1 })).toThrow(/postMessage failed/i);
  });

  test("lastExecutionStats updates after evalSync and contains finite numbers", async () => {
    const st0 = dw.lastExecutionStats;
    expect(st0).toBeDefined();

    expect(dw.evalSync("41 + 1")).toBe(42);
    const st1 = dw.lastExecutionStats;
    expect(typeof st1.cpuTimeMs).toBe("number");
    expect(typeof st1.evalTimeMs).toBe("number");
    expect(Number.isFinite(st1.cpuTimeMs!)).toBe(true);
    expect(Number.isFinite(st1.evalTimeMs!)).toBe(true);

    await expect(dw.eval("2 + 3")).resolves.toBe(5);
    const st2 = dw.lastExecutionStats;
    expect(typeof st2.cpuTimeMs).toBe("number");
    expect(typeof st2.evalTimeMs).toBe("number");
    expect(Number.isFinite(st2.cpuTimeMs!)).toBe(true);
    expect(Number.isFinite(st2.evalTimeMs!)).toBe(true);
  });

  test("eval evaluates basic expressions", async () => {
    await expect(dw.eval("1 + 1")).resolves.toBe(2);
    await expect(dw.eval('"Hello" + " " + "World"')).resolves.toBe("Hello World");
    await expect(dw.eval('({ a: 1, b: "test" })')).resolves.toEqual({ a: 1, b: "test" });
  });

  test("evalSync evaluates synchronously", () => {
    expect(dw.evalSync("1 + 2")).toBe(3);
  });

  test("captures lastExecutionStats when available", async () => {
    await dw.eval("1 + 1");
    expect(dw.lastExecutionStats).toBeDefined();
    expect(dw.lastExecutionStats).toHaveProperty("cpuTimeMs");
    expect(dw.lastExecutionStats).toHaveProperty("evalTimeMs");
  });

  test("module evaluation works (module.eval)", async () => {
    const code = `
      export function add(a, b) { return a + b; }
      export const out = add(10, 10);
    `;
    await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 20 });
  });

  test("timeout limits: long-running script rejects", async () => {
    jest.setTimeout(15_000);

    // If your native constructor does not yet accept options, instantiate via whatever
    // option path your JS wrapper supports. This assumes you will wire options later.
    const limited = createTestWorker({ limits: { maxEvalMs: 50 } });

    try {
      await expect(limited.eval("while (true) {}")).rejects.toBeTruthy();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("close triggers onClose", async () => {
    const events: string[] = [];
    dw.on("close", () => events.push("close"));

    await dw.close();
    await sleep(25);

    expect(events).toContain("close");
    expect(dw.isClosed()).toBe(true);
  });

  test("restart recreates runtime and preserves wrapper listeners", async () => {
    const messages: any[] = [];
    dw.on("message", (m) => messages.push(m));

    await expect(dw.eval("globalThis.__r = 7; __r")).resolves.toBe(7);
    await dw.restart();

    await expect(dw.eval("typeof globalThis.__r")).resolves.toBe("undefined");
    await expect(dw.eval("postMessage({ ok: 1 })")).resolves.toBeUndefined();
    await sleep(25);

    expect(messages).toEqual([{ ok: 1 }]);
    expect(dw.isClosed()).toBe(false);
  });

  test("concurrent restart calls settle to a single open runtime", async () => {
    await expect(Promise.all([dw.restart(), dw.restart(), dw.restart()])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await expect(dw.eval("40 + 2")).resolves.toBe(42);
    expect(dw.isClosed()).toBe(false);
  });

  test("stale close events from prior runtime do not close the restarted runtime", async () => {
    await dw.eval("1 + 1");
    const p = dw.restart();
    await p;
    await sleep(40);
    expect(dw.isClosed()).toBe(false);
    await expect(dw.eval("2 + 2")).resolves.toBe(4);
  });

  test("close({ force: true }) rejects in-flight API promises promptly", async () => {
    await dw.global.set(
      "nodeDelay",
      async () => {
        await sleep(200);
        return 1;
      },
    );

    const pending = dw.eval(`
      (async () => {
        await nodeDelay();
        return 42;
      })()
    `);
    const observed = pending.then(
      (value) => ({ status: "resolved" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );

    await sleep(15);
    await dw.close({ force: true });

    const out = await observed;
    expect(out.status).toBe("rejected");
    expect(dw.isClosed()).toBe(true);
  });

  test("restart({ force: true }) rejects in-flight work and boots a fresh runtime", async () => {
    await dw.global.set(
      "nodeDelay",
      async () => {
        await sleep(200);
        return 1;
      },
    );

    const pending = dw.eval(`
      (async () => {
        await nodeDelay();
        return "old";
      })()
    `);
    const observed = pending.then(
      (value) => ({ status: "resolved" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );

    await sleep(15);
    await dw.restart({ force: true });

    const out = await observed;
    expect(out.status).toBe("rejected");
    await expect(dw.eval("21 * 2")).resolves.toBe(42);
    expect(dw.isClosed()).toBe(false);
  });

  test("repeated worker create/close cycles complete without teardown hangs", async () => {
    const cycles = 12;
    for (let i = 0; i < cycles; i++) {
      const w = createTestWorker();
      await expect(w.eval(`${i} + 1`)).resolves.toBe(i + 1);
      await expect(w.close()).resolves.toBeUndefined();
      expect(w.isClosed()).toBe(true);
    }
  });
});
