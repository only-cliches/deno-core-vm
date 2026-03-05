import { DenoWorkerLifecycleContext } from "../src/index";
import { sleep } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";

describe("DenoWorker on/off event adapters", () => {
  test("on('lifecycle') receives lifecycle events and off() unsubscribes", async () => {
    const phases: string[] = [];
    const dw = createTestWorker();
    const lifecycleCb = (ctx: DenoWorkerLifecycleContext) => phases.push(ctx.phase);

    dw.on("lifecycle", lifecycleCb);
    await dw.close();

    expect(phases).toEqual(["beforeStop", "afterStop"]);

    phases.length = 0;
    const dw2 = createTestWorker();
    dw2.on("lifecycle", lifecycleCb);
    dw2.off("lifecycle", lifecycleCb);
    await dw2.close();

    expect(phases).toEqual([]);
  });

  test("on('message') can be removed with off()", async () => {
    const received: any[] = [];
    const dw = createTestWorker();
    const cb = (msg: any) => received.push(msg);

    dw.on("message", cb);
    await dw.eval(`postMessage({ a: 1 })`);
    await sleep(20);
    expect(received).toEqual([{ a: 1 }]);

    dw.off("message", cb);
    await dw.eval(`postMessage({ a: 2 })`);
    await sleep(20);
    expect(received).toEqual([{ a: 1 }]);

    await dw.close();
  });

  test("message listeners are not duplicated across multiple restarts", async () => {
    const hits: any[] = [];
    const dw = createTestWorker();
    const cb = (msg: any) => hits.push(msg);
    dw.on("message", cb);

    await dw.restart();
    await dw.restart();
    await dw.restart();

    await dw.eval(`postMessage({ once: true })`);
    await sleep(20);

    expect(hits).toEqual([{ once: true }]);
    await dw.close();
  });

  test("off() before restart remains effective after restart", async () => {
    const hits: any[] = [];
    const dw = createTestWorker();
    const cb = (msg: any) => hits.push(msg);
    dw.on("message", cb);
    dw.off("message", cb);

    await dw.restart();
    await dw.eval(`postMessage({ shouldNotArrive: true })`);
    await sleep(20);

    expect(hits).toEqual([]);
    await dw.close();
  });

  test("on('runtime') can be removed with off()", async () => {
    const hits: any[] = [];
    const dw = createTestWorker();
    const cb = (event: any) => hits.push(event.kind);
    dw.on("runtime", cb);
    await dw.eval("1 + 1");
    expect(hits).toContain("eval.begin");
    expect(hits).toContain("eval.end");

    dw.off("runtime", cb);
    hits.length = 0;
    await dw.eval("2 + 2");
    expect(hits).toEqual([]);
    await dw.close();
  });
});
