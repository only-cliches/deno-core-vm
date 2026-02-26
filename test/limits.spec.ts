import { DenoWorker } from "../index";

describe("deno_worker: limits", () => {

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function withHardTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return await Promise.race([
      p,
      (async () => {
        await sleep(ms);
        throw new Error(`test hard-timeout after ${ms}ms`);
      })(),
    ]);
  }

  test(
    "limits: maxEvalMs eventually rejects or resolves, but never hangs",
    async () => {
      const dw = new DenoWorker({ maxEvalMs: 100, channelSize: 256 });

      const p = dw.eval("while (true) {}"); // worst case
      await expect(withHardTimeout(p, 2000)).rejects.toBeDefined();

      await dw.close();
    },
    15_000
  );
});