import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

describe("deno_worker: limits", () => {

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
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

    test(
    "limits: per-eval maxEvalMs overrides worker default (and recovery works)",
    async () => {
      const dw = createTestWorker({ limits: { maxEvalMs: 30 }, bridge: { channelSize: 256 } });

      const burn80ms = `
        (() => {
          const end = Date.now() + 80;
          while (Date.now() < end) {}
          return 7;
        })()
      `;

      await expect(dw.eval(burn80ms)).rejects.toBeDefined();

      await expect(dw.eval(burn80ms, { maxEvalMs: 200 })).resolves.toBe(7);

      await expect(dw.eval("40 + 2")).resolves.toBe(42);

      await dw.close();
    },
    20_000
  );

  test(
    "limits: maxEvalMs eventually rejects or resolves, but never hangs",
    async () => {
      const dw = createTestWorker({ limits: { maxEvalMs: 100 }, bridge: { channelSize: 256 } });

      const p = dw.eval("while (true) {}"); // worst case
      await expect(withHardTimeout(p, 2000)).rejects.toBeDefined();

      await dw.close();
    },
    15_000
  );

  test(
    "limits: evalSync waits behind an in-flight eval",
    async () => {
      const dw = createTestWorker({ limits: { maxEvalMs: 2_000 }, bridge: { channelSize: 8 } });

      const busy = dw.eval(`
        (() => {
          const end = Date.now() + 450;
          while (Date.now() < end) {}
          return 1;
        })()
      `);

      await sleep(30);

      const start = Date.now();
      const syncOut = dw.evalSync("1 + 1");
      const elapsed = Date.now() - start;
      expect(syncOut).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(250);

      await expect(busy).resolves.toBe(1);
      if (!dw.isClosed()) await dw.close({ force: true });
    },
    15_000
  );

  test(
    "limits: evalModule waits behind an in-flight eval instead of failing",
    async () => {
      const dw = createTestWorker({ limits: { maxEvalMs: 2_000 }, bridge: { channelSize: 8 } });
      try {
        const busy = dw.eval(`
          (() => {
            const end = Date.now() + 450;
            while (Date.now() < end) {}
            return "busy-done";
          })()
        `);

        await sleep(30);
        const start = Date.now();
        const mod = dw.evalModule(`
          export const answer = 42;
        `);

        await expect(withHardTimeout(busy, 4_000)).resolves.toBe("busy-done");
        await expect(withHardTimeout(mod, 4_000)).resolves.toMatchObject({ answer: 42 });
        expect(Date.now() - start).toBeGreaterThanOrEqual(250);
      } finally {
        if (!dw.isClosed()) await dw.close({ force: true });
      }
    },
    15_000
  );

  test(
    "limits: delayed catch attachment on eval rejection does not emit unhandledRejection",
    async () => {
      const dw = createTestWorker({ limits: { maxEvalMs: 25 }, bridge: { channelSize: 8 } });
      const unhandled: string[] = [];
      const onUnhandled = (reason: unknown) => {
        const msg =
          typeof reason === "object" && reason && "message" in (reason as any)
            ? String((reason as any).message)
            : String(reason);
        unhandled.push(msg);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const pending = dw.eval("while (true) {}");
        await sleep(60); // attach handler after rejection would normally have occurred

        const err = await pending.then(
          () => "",
          (e) => String((e as any)?.message ?? e),
        );
        expect(err).toMatch(/execution terminated/i);

        await sleep(0);
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        if (!dw.isClosed()) await dw.close({ force: true });
      }
    },
    15_000
  );
});
