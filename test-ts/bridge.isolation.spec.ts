import { DenoWorker } from "../src/index";
import { sleep, waitFor } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";

async function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    (async () => {
      await sleep(ms);
      throw new Error(`timeout: ${label}`);
    })(),
  ]);
}


describe("deno_worker: bridge isolation", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close({ force: true });
  });

  test(
    "control eval completes while data plane is saturated",
    async () => {
      dw = createTestWorker({ bridge: { channelSize: 16 } });

      await dw.eval(`
        globalThis.__isoCount = 0;
        on("message", (_m) => { __isoCount++; });
        0;
      `);

      const dataFlood = (async () => {
        for (let i = 0; i < 300; i += 1) {
          dw.postMessage({ t: "flood", i });
        }
      })();

      const control = withHardTimeout(dw.eval("40 + 2"), 4_000, "control-eval");

      await withHardTimeout(Promise.all([dataFlood, control]), 8_000, "control+data");
      await expect(control).resolves.toBe(42);
      await expect(withHardTimeout(dw.eval("__isoCount"), 3_000, "count")).resolves.toBeGreaterThan(0);
    },
    20_000,
  );

  test(
    "data messages still dispatch while many evals are queued",
    async () => {
      dw = createTestWorker({ bridge: { channelSize: 32 } });
      const seen: number[] = [];
      dw.on("message", (m) => {
        const mm = m as { echo?: unknown } | null;
        if (mm && typeof mm === "object" && mm.echo != null) seen.push(Number(mm.echo));
      });

      await dw.eval(`
        on("message", (m) => {
          if (m && m.i != null) postMessage({ echo: m.i });
        });
        0;
      `);

      const evals = Array.from({ length: 200 }, () => dw.eval("1 + 1"));
      for (let i = 0; i < 80; i += 1) dw.postMessage({ i });

      await withHardTimeout(Promise.all(evals), 20_000, "eval-flood");
      await waitFor(() => seen.length >= 80, 5_000, { label: "timeout: echoes" });
      expect(seen.length).toBeGreaterThanOrEqual(80);
    },
    30_000,
  );

  test(
    "force close settles pending control work during mixed-plane load",
    async () => {
      dw = createTestWorker({ bridge: { channelSize: 32 } });

      const pendingEvals = Array.from({ length: 120 }, (_x, i) =>
        dw.eval(`(${i}) + 1`)
      );

      for (let i = 0; i < 200; i += 1) {
        try {
          dw.postMessage({ closeFlood: i });
        } catch {
          break;
        }
      }

      await sleep(20);
      await dw.close({ force: true });

      const settled = await withHardTimeout(
        Promise.allSettled(pendingEvals),
        8_000,
        "pending-evals-settle",
      );
      expect(settled.length).toBe(120);
      expect(dw.isClosed()).toBe(true);
    },
    20_000,
  );

  test(
    "restart(force) does not leak stale queued data-plane messages into new runtime",
    async () => {
      dw = createTestWorker({ bridge: { channelSize: 16 } });
      const seen: any[] = [];
      dw.on("message", (m) => seen.push(m));

      await dw.eval(`
        on("message", (m) => {
          if (m && m.old != null) postMessage({ oldSeen: m.old });
        });
        0;
      `);

      for (let i = 0; i < 100; i += 1) {
        try {
          dw.postMessage({ old: i });
        } catch {
          break;
        }
      }

      await dw.restart({ force: true });
      seen.length = 0;

      await dw.eval(`
        on("message", (m) => {
          if (m && m.new != null) postMessage({ newSeen: m.new });
        });
        0;
      `);

      dw.postMessage({ new: 7 });
      await waitFor(() => seen.some((m) => m && m.newSeen === 7), 3_000, { label: "timeout: new-echo" });
      await sleep(200);
      expect(seen.some((m) => m && m.oldSeen != null)).toBe(false);
    },
    20_000,
  );

  test(
    "stream chunk ordering is preserved under interleaved control and data traffic",
    async () => {
      dw = createTestWorker({ bridge: { channelSize: 64 } });

      await dw.eval(`
        globalThis.__isoStreamOut = "";
        globalThis.__isoStreamTask = (async () => {
          const s = await hostStreams.accept("iso-stream");
          const chunks = [];
          for await (const c of s) chunks.push(c);
          const total = chunks.reduce((n, c) => n + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.byteLength;
          }
          __isoStreamOut = new TextDecoder().decode(merged);
        })();
        0;
      `);

      const writer = dw.stream.create("iso-stream");
      const parts = ["a", "b", "c", "d", "e", "f"];
      for (let i = 0; i < parts.length; i += 1) {
        await writer.write(new TextEncoder().encode(parts[i]));
        dw.postMessage({ noise: i });
        await dw.eval("0");
      }
      await writer.close();

      await withHardTimeout(dw.eval("__isoStreamTask"), 5_000, "stream-task");
      const out = await withHardTimeout(dw.eval("__isoStreamOut"), 3_000, "stream-out");
      expect(out).toBe(parts.join(""));
    },
    20_000,
  );
});
