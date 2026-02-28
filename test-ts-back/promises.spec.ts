import { DenoWorker } from "../src/index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("deno_worker: promises and error propagation", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("resolves a promise returned by the worker", async () => {
    dw = new DenoWorker();
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

  // it("rejects with an Error for worker-thrown errors", async () => {
  //   dw = new DenoWorker();
  //   await expect(dw.eval(`(async () => { throw new Error("Worker Boom"); })()`)).rejects.toThrow(
  //     "Worker Boom"
  //   );
  // });

  it("propagates a Node-injected async function result into the worker", async () => {
    dw = new DenoWorker();

    const asyncIdentity = async (val: string) => {
      await sleep(25);
      return "Node processed: " + val;
    };

    await dw.setGlobal("asyncIdentity", asyncIdentity);

    const script = `
      (async () => {
        const res = await asyncIdentity("hello");
        return res;
      })()
    `;

    await expect(dw.eval(script)).resolves.toBe("Node processed: hello");
  });

  it("propagates Node-injected async function errors into the worker as Error-like values", async () => {
    dw = new DenoWorker();

    const nodeFn = jest.fn(async () => {
      const err: any = new Error("Node Boom!");
      err.name = "NodeCustomError";
      err.code = "E_NODE";
      throw err;
    });

    await dw.setGlobal("nodeFn", nodeFn);

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
});