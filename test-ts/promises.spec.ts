import { DenoWorker } from "../src/index";
import { sleep } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";

describe("deno_worker: promises and error propagation", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = createTestWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("rejects with non-Error values (e.g. string) without crashing the bridge", async () => {
    await expect(dw.eval(`Promise.reject("nope")`)).rejects.toEqual("nope");
  });

  it("propagates worker-thrown non-Error values as rejection reasons", async () => {
    await expect(dw.eval(`(() => { throw "boom"; })()`)).rejects.toEqual("boom");
  });

  it("propagates non-Error rejection reasons", async () => {
    await expect(dw.eval(`Promise.reject("nope")`)).rejects.toBe("nope");
    await expect(dw.eval(`Promise.reject(null)`)).rejects.toBeNull();
    await expect(dw.eval(`Promise.reject({ x: 1 })`)).rejects.toEqual({ x: 1 });
  });

  it("settles nested promise returns", async () => {
    await expect(dw.eval(`Promise.resolve(Promise.resolve(7))`)).resolves.toBe(7);
    await expect(dw.eval(`(async () => Promise.resolve(5))()`)).resolves.toBe(5);
  });

  it("propagates Node-injected sync function errors into the worker (via host call)", async () => {
    const nodeFn = jest.fn(() => {
      throw new Error("SyncBoom");
    });

    await dw.global.set("nodeFn", nodeFn);

    const script = `
      (async () => {
        try {
          nodeFn();
          return "nope";
        } catch (e) {
          return { name: e?.name, message: e?.message };
        }
      })()
    `;

    await expect(dw.eval(script)).resolves.toMatchObject({
      name: "Error",
      message: expect.stringMatching(/SyncBoom/),
    });
    expect(nodeFn).toHaveBeenCalledTimes(1);
  });

  it("resolves a promise returned by the worker", async () => {
    const script = `
      (async () => {
        const step1 = await Promise.resolve("step 1");
        const step2 = await Promise.resolve("step 2");
        const step3 = await Promise.resolve("step 3");
        return step1 + " -> " + step2 + " -> " + step3;
      })()
    `;
    await expect(dw.eval(script)).resolves.toBe("step 1 -> step 2 -> step 3");
  });

  it("propagates a Node-injected async function result into the worker", async () => {
    const asyncIdentity = async (val: string) => {
      await sleep(25);
      return "Node processed: " + val;
    };

    await dw.global.set("asyncIdentity", asyncIdentity);

    const script = `
      (async () => {
        const res = await asyncIdentity("hello");
        return res;
      })()
    `;

    await expect(dw.eval(script)).resolves.toBe("Node processed: hello");
  });

  it("propagates Node-injected async function errors into the worker as Error-like values", async () => {
    const nodeFn = jest.fn(async () => {
      const err: any = new Error("Node Boom!");
      err.name = "NodeCustomError";
      err.code = "E_NODE";
      throw err;
    });

    await dw.global.set("nodeFn", nodeFn);

    const script = `
      (async () => {
        try {
          await nodeFn();
          return "nope";
        } catch (e) {
          return {
            name: e?.name,
            message: e?.message,
            code: e?.code,
          };
        }
      })()
    `;

    await expect(dw.eval(script)).resolves.toMatchObject({
      name: "NodeCustomError",
      message: "Node Boom!",
      code: "E_NODE",
    });
  });

  it("in-flight eval from prior runtime always settles across restart", async () => {
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
        return 123;
      })()
    `);

    await sleep(15);
    await dw.restart();

    const settled = await pending.then(
      (value) => ({ status: "resolved" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    expect(settled.status === "resolved" || settled.status === "rejected").toBe(true);
    await expect(dw.eval("100 + 23")).resolves.toBe(123);
  });
});
