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

  test("stats.lastExecution updates after evalSync and contains finite numbers", async () => {
    const st0 = dw.stats.lastExecution;
    expect(st0).toBeDefined();

    expect(dw.evalSync("41 + 1")).toBe(42);
    const st1 = dw.stats.lastExecution;
    expect(typeof st1.cpuTimeMs).toBe("number");
    expect(typeof st1.evalTimeMs).toBe("number");
    expect(Number.isFinite(st1.cpuTimeMs!)).toBe(true);
    expect(Number.isFinite(st1.evalTimeMs!)).toBe(true);

    await expect(dw.eval("2 + 3")).resolves.toBe(5);
    const st2 = dw.stats.lastExecution;
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

  test("captures stats.lastExecution when available", async () => {
    await dw.eval("1 + 1");
    expect(dw.stats.lastExecution).toBeDefined();
    expect(dw.stats.lastExecution).toHaveProperty("cpuTimeMs");
    expect(dw.stats.lastExecution).toHaveProperty("evalTimeMs");
  });

  test("stats.activeOps reflects tracked async runtime operations", async () => {
    await dw.global.set(
      "nodeDelayForStats",
      async () => {
        await sleep(80);
        return 1;
      },
    );

    expect(dw.stats.activeOps).toBe(0);
    const pending = dw.eval(`
      (async () => {
        await nodeDelayForStats();
        return 42;
      })()
    `);

    await sleep(10);
    expect(dw.stats.activeOps).toBeGreaterThan(0);
    await expect(pending).resolves.toBe(42);
    expect(dw.stats.activeOps).toBe(0);
  });

  test("stats.cpu returns usagePercentage in the 0-100 range", async () => {
    await expect(dw.eval("for (let i = 0; i < 200_000; i++) {} 1;")).resolves.toBe(1);

    const cpu = await dw.stats.cpu({ measureMs: 1000 });
    expect(typeof cpu.usagePercentage).toBe("number");
    expect(cpu.usagePercentage).toBeGreaterThanOrEqual(0);
    expect(cpu.usagePercentage).toBeLessThanOrEqual(100);
    expect(cpu.measureMs).toBe(1000);
    expect(typeof cpu.cpuTimeMs).toBe("number");
    expect(cpu.cpuTimeMs).toBeGreaterThanOrEqual(0);

    const clamped = await dw.stats.cpu({ measureMs: 1 });
    expect(clamped.measureMs).toBe(10);
    expect(clamped.usagePercentage).toBeGreaterThanOrEqual(0);
    expect(clamped.usagePercentage).toBeLessThanOrEqual(100);
  });

  test("stats exposes rates/latency/eventLoopLag/stream/totals/reset", async () => {
    await expect(dw.eval("1 + 1")).resolves.toBe(2);
    await expect(dw.global.get<number>("Math.PI")).resolves.toBeCloseTo(Math.PI);
    const handle = await dw.handle.get("Math");
    await expect(handle.get<number>("PI")).resolves.toBeCloseTo(Math.PI);
    await handle.dispose();

    const rates = await dw.stats.rates({ windowMs: 1000 });
    expect(rates.windowMs).toBe(1000);
    expect(rates.evalPerSec).toBeGreaterThanOrEqual(0);
    expect(rates.handlePerSec).toBeGreaterThanOrEqual(0);
    expect(rates.globalPerSec).toBeGreaterThanOrEqual(0);
    expect(rates.messagesPerSec).toBeGreaterThanOrEqual(0);

    const latency = await dw.stats.latency({ windowMs: 1000 });
    expect(latency.windowMs).toBe(1000);
    expect(latency.count).toBeGreaterThanOrEqual(0);
    expect(latency.avgMs).toBeGreaterThanOrEqual(0);
    expect(latency.maxMs).toBeGreaterThanOrEqual(0);

    const lag = await dw.stats.eventLoopLag({ measureMs: 20 });
    expect(lag.measureMs).toBe(20);
    expect(lag.lagMs).toBeGreaterThanOrEqual(0);

    const stream = dw.stats.stream;
    expect(stream.activeStreams).toBeGreaterThanOrEqual(0);
    expect(stream.queuedChunks).toBeGreaterThanOrEqual(0);
    expect(stream.queuedBytes).toBeGreaterThanOrEqual(0);
    expect(stream.creditDebtBytes).toBeGreaterThanOrEqual(0);
    expect(stream.backlogSize).toBeGreaterThanOrEqual(0);

    const totals = dw.stats.totals;
    expect(totals.ops).toBeGreaterThanOrEqual(0);
    expect(totals.errors).toBeGreaterThanOrEqual(0);
    expect(totals.restarts).toBeGreaterThanOrEqual(0);
    expect(totals.messagesOut).toBeGreaterThanOrEqual(0);
    expect(totals.messagesIn).toBeGreaterThanOrEqual(0);
    expect(totals.bytesOut).toBeGreaterThanOrEqual(0);
    expect(totals.bytesIn).toBeGreaterThanOrEqual(0);

    dw.stats.reset();
    const afterReset = dw.stats.totals;
    expect(afterReset.ops).toBe(0);
    expect(afterReset.errors).toBe(0);
    expect(afterReset.messagesOut).toBe(0);
    expect(afterReset.messagesIn).toBe(0);
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
