import { DenoWorker } from "../src/index";

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

    await dw.eval(`hostPostMessage({ hello: "from worker" })`);
    await sleep(50);

    expect(messages).toContainEqual({ hello: "from worker" });
  });

  it("swallows exceptions thrown in Node message handlers and continues delivering", async () => {
    dw = new DenoWorker();
    const seen: any[] = [];

    dw.on("message", (msg: any) => {
      seen.push(msg);
      if (msg && msg.n === 1) {
        throw new Error("handler boom");
      }
    });

    await dw.eval(`hostPostMessage({ n: 1 })`);
    await dw.eval(`hostPostMessage({ n: 2 })`);
    await sleep(80);

    expect(seen).toContainEqual({ n: 1 });
    expect(seen).toContainEqual({ n: 2 });
  });

  it("dispatches Node -> worker messages to both on('message') and addEventListener('message')", async () => {
    dw = new DenoWorker();

    await dw.eval(`
      globalThis.count = 0;
      on("message", () => { globalThis.count++; });
      addEventListener("message", () => { globalThis.count++; });
    `);

    dw.postMessage({ ping: true });
    await sleep(80);

    await expect(dw.eval("globalThis.count")).resolves.toBe(2);
  });

  it("worker addEventListener('message') receives Node postMessage", async () => {
    dw = new DenoWorker();

    await dw.eval(`
      globalThis.receivedA = null;
      globalThis.receivedB = null;

      on("message", (msg) => { globalThis.receivedA = msg; });
      addEventListener("message", (e) => { globalThis.receivedB = e; });
    `);

    dw.postMessage({ a: 1 });
    await sleep(50);

    await expect(dw.eval("globalThis.receivedA")).resolves.toEqual({ a: 1 });
    await expect(dw.eval("globalThis.receivedB")).resolves.toEqual({ a: 1 });
  });

  it("worker postMessage is aliased to hostPostMessage (worker -> Node)", async () => {
    dw = new DenoWorker();
    const messages: any[] = [];

    dw.on("message", (msg: any) => messages.push(msg));

    await dw.eval(`postMessage({ via: "postMessage" })`);
    await sleep(80);

    expect(messages).toContainEqual({ via: "postMessage" });
  });

  it("sends messages to the worker", async () => {
    dw = new DenoWorker();

    await dw.eval(`
      globalThis.received = null;
      on("message", (msg) => { globalThis.received = msg; });
    `);

    dw.postMessage({ foo: "bar" });
    await sleep(50);

    await expect(dw.eval("globalThis.received")).resolves.toEqual({ foo: "bar" });
  });

  it("round-trips recursive message graphs", async () => {
    dw = new DenoWorker();
    const seen: any[] = [];
    dw.on("message", (msg: any) => seen.push(msg));

    await dw.eval(`
      on("message", (msg) => {
        globalThis.received = msg;
        postMessage(msg);
      });
    `);

    const a: any = { name: "a" };
    const b: any = { name: "b", a };
    a.self = a;
    a.b = b;
    a.same = b;

    dw.postMessage(a);
    await sleep(80);

    const recv = await dw.eval("globalThis.received");
    expect(recv.self).toBe(recv);
    expect(recv.b.a).toBe(recv);
    expect(recv.same).toBe(recv.b);

    expect(seen.length).toBeGreaterThan(0);
    const echoed = seen[seen.length - 1];
    expect(echoed.self).toBe(echoed);
    expect(echoed.b.a).toBe(echoed);
    expect(echoed.same).toBe(echoed.b);
  });
});
