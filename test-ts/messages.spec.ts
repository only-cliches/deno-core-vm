import { DenoWorker } from "../src/index";
import { EventEmitter } from "events";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("deno_worker: messaging", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("receives messages from the worker", async () => {
    dw = new DenoWorker();
    const messages: any[] = [];

    dw.on("message", (msg: any) => messages.push(msg));

    await dw.eval(`postMessage({ hello: "from worker" })`);
    await sleep(50);

    expect(messages).toContainEqual({ hello: "from worker" });
  });

  it("sends messages to the worker", async () => {
    dw = new DenoWorker();
    const events = new EventEmitter();

    await dw.eval(`
      let received = null;
      on("message", (msg) => { received = msg; });
    `);

    events.once("ready", () => void 0);

    dw.postMessage({ foo: "bar" });
    await sleep(50);

    await expect(dw.eval("received")).resolves.toEqual({ foo: "bar" });
  });
});