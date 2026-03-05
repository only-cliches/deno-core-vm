import { DenoWorker } from "../src/index";
import { sleep } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";

type StreamInternals = {
  handleIncomingStreamFrame: (frame: unknown) => boolean;
  emitStreamFrame: (frame: unknown) => unknown;
  streamBacklog: Map<unknown, unknown>;
  streamNameToId: Map<unknown, unknown>;
  streamById: Map<unknown, unknown>;
  streamIncoming: Map<unknown, unknown>;
  streamWriterWaiters: Map<unknown, unknown>;
  streamWriterCredits: Map<string, number>;
  consumeWriterCredit: (id: string, bytes: number) => void;
  waitForWriterCredit: (id: string, minBytes: number) => Promise<void>;
  addWriterCredit: (id: string, credit: number) => void;
};

function streamInternals(dw: DenoWorker): StreamInternals {
  return dw as unknown as StreamInternals;
}

function makeBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

describe("deno_worker: streams edge cases", () => {
  let dw: DenoWorker;
  jest.setTimeout(30_000);

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close({ force: true });
  });

  async function expectSettlesWithOptionalError(p: Promise<unknown>, pattern: RegExp): Promise<void> {
    const out = await p.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    if (!out.ok) {
      expect(String(out.error)).toMatch(pattern);
      return;
    }
    expect(out.value).toBeUndefined();
  }

  test("pending writer backpressure is rejected when worker force-closes", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeHoldStream = (async () => {
        await hostStreams.accept("edge-force-close");
        await new Promise(() => {});
      })();
      0;
    `);

    const writer = dw.stream.create("edge-force-close");
    const pending = writer.write(makeBytes(24 * 1024 * 1024));
    await sleep(40);
    await dw.close({ force: true });

    await expectSettlesWithOptionalError(pending, /force-closed|closed|released/i);
  });

  test("backpressure recovers while reader drains payload larger than stream window", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeDrainTask = (async () => {
        const s = await hostStreams.accept("edge-large-transfer");
        let total = 0;
        for await (const chunk of s) {
          total += chunk.byteLength;
          if ((total % (1024 * 1024)) === 0) {
            await new Promise((r) => setTimeout(r, 1));
          }
        }
        globalThis.__edgeDrainTotal = total;
      })();
      0;
    `);

    const writer = dw.stream.create("edge-large-transfer");
    const chunk = makeBytes(512 * 1024);
    const chunkCount = 12; // 6 MiB total, exceeds default 4 MiB window
    const chunks = Array.from({ length: chunkCount }, () => chunk);

    await expect(writer.writeMany(chunks)).resolves.toBe(chunkCount);
    await writer.close();
    await dw.eval("(__edgeDrainTask)");
    await expect(dw.eval("__edgeDrainTotal")).resolves.toBe(chunk.byteLength * chunkCount);
  });

  test("writeMany handles empty input without side effects", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeEmptyTask = (async () => {
        const s = await hostStreams.accept("edge-empty-writeMany");
        let count = 0;
        for await (const _chunk of s) count++;
        globalThis.__edgeEmptyCount = count;
      })();
      0;
    `);

    const writer = dw.stream.create("edge-empty-writeMany");
    await expect(writer.writeMany([])).resolves.toBe(0);
    await writer.close();
    await dw.eval("(__edgeEmptyTask)");
    await expect(dw.eval("__edgeEmptyCount")).resolves.toBe(0);
  });

  test("pending ready() is rejected when writer is cancelled", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeReadyCancelTask = (async () => {
        const s = await hostStreams.accept("edge-ready-cancel");
        await new Promise(() => {});
      })();
      0;
    `);

    const writer = dw.stream.create("edge-ready-cancel");
    const pending = writer.ready(32 * 1024 * 1024);
    await sleep(25);
    await writer.cancel("cancel-for-edge-test");
    await expectSettlesWithOptionalError(pending, /cancel|released/i);
  });

  test("many concurrent worker->Node streams drain without starvation", async () => {
    dw = createTestWorker({ bridge: { channelSize: 4096 } });

    const streamCount = 6;
    const chunkSize = 16 * 1024;
    const batchSize = 8;
    const rounds = 6;
    const expectedPerStream = chunkSize * batchSize * rounds;
    const keys = Array.from({ length: streamCount }, (_, i) => `edge-concurrent-down-${i}`);

    const readerTasks = keys.map(async (key) => {
      const reader = await dw.stream.accept(key);
      let total = 0;
      for await (const chunk of reader) {
        total += chunk.byteLength;
      }
      return total;
    });

    await dw.eval(`
      globalThis.__edgeWriteMany = async (keys, chunkSize, batchSize, rounds) => {
        const payload = new Uint8Array(chunkSize >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        await Promise.all(keys.map(async (key) => {
          const s = hostStreams.create(key);
          await s.ready(1);
          for (let r = 0; r < rounds; r++) {
            const chunks = new Array(batchSize).fill(payload);
            await s.writeMany(chunks);
          }
          await s.close();
        }));
        return "ok";
      };
      0;
    `);

    await expect(
      dw.eval("(__edgeWriteMany)", { args: [keys, chunkSize, batchSize, rounds] }),
    ).resolves.toBe("ok");

    const totals = await Promise.all(readerTasks);
    expect(totals).toHaveLength(streamCount);
    for (const total of totals) expect(total).toBe(expectedPerStream);
  });

  test("streamBacklogLimit bounds unaccepted worker->Node open streams", async () => {
    dw = createTestWorker({ bridge: { streamBacklogLimit: 1 } });

    const idw = streamInternals(dw);
    const inject = idw.handleIncomingStreamFrame.bind(idw);
    const tag = "__denojs_worker_stream_v1";

    expect(
      inject({ [tag]: true, t: "open", id: "edge-open-a", key: "edge-backlog-a" }),
    ).toBe(true);
    expect(idw.streamBacklog.size).toBe(1);

    expect(
      inject({ [tag]: true, t: "open", id: "edge-open-b", key: "edge-backlog-b" }),
    ).toBe(true);
    expect(idw.streamBacklog.size).toBe(1);
    expect(idw.streamNameToId.has("edge-backlog-b")).toBe(false);
  });

  test("pending accept waiter bypasses backlog cap for matching key", async () => {
    dw = createTestWorker({ bridge: { streamBacklogLimit: 1 } });

    const acceptPromise = dw.stream.accept("edge-backlog-wait");
    const idw = streamInternals(dw);
    const inject = idw.handleIncomingStreamFrame.bind(idw);
    const tag = "__denojs_worker_stream_v1";

    expect(inject({ [tag]: true, t: "open", id: "edge-open-1", key: "edge-backlog-1" })).toBe(true);
    expect(idw.streamBacklog.size).toBe(1);

    expect(inject({ [tag]: true, t: "open", id: "edge-open-2", key: "edge-backlog-wait" })).toBe(true);
    const reader = await acceptPromise;
    expect(reader).toBeDefined();
    await reader.cancel("done");
  });

  test("repeated backlog rejections do not grow stream maps", async () => {
    dw = createTestWorker({ bridge: { streamBacklogLimit: 1 } });
    const idw = streamInternals(dw);
    const inject = idw.handleIncomingStreamFrame.bind(idw);
    const tag = "__denojs_worker_stream_v1";

    inject({ [tag]: true, t: "open", id: "edge-open-base", key: "edge-backlog-base" });
    const beforeById = idw.streamById.size;

    for (let i = 0; i < 20; i++) {
      inject({ [tag]: true, t: "open", id: `edge-open-rej-${i}`, key: `edge-backlog-rej-${i}` });
    }

    expect(idw.streamBacklog.size).toBe(1);
    expect(idw.streamById.size).toBe(beforeById);
  });

  test("backlog rejection emits error and discard frames", async () => {
    dw = createTestWorker({ bridge: { streamBacklogLimit: 1 } });
    const sent: any[] = [];
    const idw = streamInternals(dw);
    const originalEmit = idw.emitStreamFrame.bind(idw);
    idw.emitStreamFrame = (frame: unknown) => {
      sent.push(frame);
      return originalEmit(frame);
    };

    const inject = idw.handleIncomingStreamFrame.bind(idw);
    const tag = "__denojs_worker_stream_v1";

    inject({ [tag]: true, t: "open", id: "edge-open-allow", key: "edge-bk-allow" });
    inject({ [tag]: true, t: "open", id: "edge-open-reject", key: "edge-bk-reject" });

    expect(sent.some((f) => f.t === "error" && f.id === "edge-open-reject")).toBe(true);
    expect(sent.some((f) => f.t === "discard" && f.id === "edge-open-reject")).toBe(true);
  });

  test("accept after rejected open waits for a later valid open", async () => {
    dw = createTestWorker({ bridge: { streamBacklogLimit: 1 } });
    const idw = streamInternals(dw);
    const inject = idw.handleIncomingStreamFrame.bind(idw);
    const tag = "__denojs_worker_stream_v1";

    inject({ [tag]: true, t: "open", id: "edge-open-a", key: "edge-over-a" });
    inject({ [tag]: true, t: "open", id: "edge-open-b", key: "edge-over-b" }); // rejected by cap

    let resolved = false;
    const pending = dw.stream.accept("edge-over-b").then((r) => {
      resolved = true;
      return r;
    });
    await sleep(30);
    expect(resolved).toBe(false);

    inject({ [tag]: true, t: "open", id: "edge-open-b2", key: "edge-over-b" });
    inject({ [tag]: true, t: "chunk", id: "edge-open-b2", chunk: new Uint8Array([7]) });
    inject({ [tag]: true, t: "close", id: "edge-open-b2" });

    const reader = await pending;
    const got: number[] = [];
    for await (const chunk of reader) {
      got.push(...Array.from(chunk));
    }
    expect(got).toEqual([7]);
  });

  test("ready(minBytes) waits at exact credit boundary and resumes after credit refill", async () => {
    dw = createTestWorker();
    const anyDw = streamInternals(dw);
    const id = "edge-credit-internal";

    anyDw.streamWriterCredits.set(id, 1);
    anyDw.consumeWriterCredit(id, 1);
    expect(anyDw.streamWriterCredits.get(id)).toBe(0);

    const pending = anyDw.waitForWriterCredit(id, 1);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await sleep(10);
    expect(done).toBe(false);

    anyDw.addWriterCredit(id, 1);
    await expect(pending).resolves.toBeUndefined();
  });

  test("pending writer ready rejects on force restart and internal waiter map is cleared", async () => {
    dw = createTestWorker();
    await dw.eval(`
      globalThis.__edgeRestartHold = (async () => {
        await hostStreams.accept("edge-restart-ready");
        await new Promise(() => {});
      })();
      0;
    `);

    const writer = dw.stream.create("edge-restart-ready");
    const pending = writer.ready(32 * 1024 * 1024);
    await sleep(20);
    await dw.restart({ force: true });
    await expectSettlesWithOptionalError(pending, /force-closed|released|closed/i);
    expect(streamInternals(dw).streamWriterWaiters.size).toBe(0);
  });

  test("force restart clears stale stream state and allows fresh open in next epoch", async () => {
    dw = createTestWorker();
    const anyDw = streamInternals(dw);
    const inject = anyDw.handleIncomingStreamFrame.bind(anyDw);
    const tag = "__denojs_worker_stream_v1";

    inject({ [tag]: true, t: "open", id: "edge-old-id", key: "edge-old-key" });
    inject({ [tag]: true, t: "chunk", id: "edge-old-id", chunk: new Uint8Array([1]) });
    expect(anyDw.streamById.size).toBeGreaterThan(0);
    expect(anyDw.streamIncoming.size).toBeGreaterThan(0);

    await dw.restart({ force: true });
    expect(anyDw.streamById.size).toBe(0);
    expect(anyDw.streamIncoming.size).toBe(0);
    expect(anyDw.streamBacklog.size).toBe(0);

    const acceptPromise = dw.stream.accept("edge-new-key");
    inject({ [tag]: true, t: "open", id: "edge-new-id", key: "edge-new-key" });
    const reader = await acceptPromise;
    expect(reader).toBeDefined();
    await reader.cancel("done");
  });
});
