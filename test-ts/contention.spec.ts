import { DenoWorker } from "../src/index";
import { sleep } from "./helpers.time";
import { closeTrackedWorkers, createTestWorker } from "./helpers.worker-harness";

async function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    (async () => {
      await sleep(ms);
      throw new Error(`timeout: ${label}`);
    })(),
  ]);
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.trunc(n);
}

async function closeWorkerFully(dw: DenoWorker): Promise<void> {
  const native = (dw as unknown as { native?: unknown })?.native as
    | { __isRegistered?: () => boolean; forceDispose?: () => void }
    | undefined;
  if (dw.isClosed()) {
    try {
      if (native?.__isRegistered?.()) native.forceDispose?.();
    } catch {
      // ignore
    }
    return;
  }
  try {
    await withHardTimeout(dw.close(), 6_000, "graceful-close");
  } catch {
    if (!dw.isClosed()) {
      await withHardTimeout(dw.close({ force: true }), 6_000, "force-close");
    }
  }
  for (let i = 0; i < 20; i += 1) {
    let registered = false;
    try {
      registered = Boolean(native?.__isRegistered?.());
    } catch {
      registered = false;
    }
    if (!registered) return;
    await sleep(25);
  }
  try {
    native?.forceDispose?.();
  } catch {
    // ignore
  }
  await sleep(50);
}

describe("deno_worker: contention", () => {
  afterAll(async () => {
    await closeTrackedWorkers(true);
    await sleep(200);
  });

  test(
    "10 runtimes synchronize host function fanout and stream bursts",
    async () => {
      const runtimeCount = 10;
      const hostCallsPerRuntime = 10;
      const startAt = Date.now() + 1200;

      const workers: DenoWorker[] = Array.from({ length: runtimeCount }, () =>
        createTestWorker({ bridge: { channelSize: 512 } }),
      );

      try {
        await Promise.all(
          workers.map((dw, idx) => dw.setGlobal("hostBump", (n: number) => n + idx)),
        );

        const perWorkerTasks = workers.map(async (dw, idx) => {
          const downloadKey = `contend-download-${idx}`;
          const downloadPayload = `worker->node:${idx}`;

          const functionStormTask = dw.eval(
            `
              async (targetTs, calls) => {
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                while (Date.now() < targetTs) await wait(1);
                const vals = await Promise.all(
                  Array.from({ length: calls }, (_x, i) => hostBump(i))
                );
                return vals.length;
              }
            `,
            { args: [startAt, hostCallsPerRuntime] },
          );

          const nodeReadTask = (async () => {
            const reader = await dw.stream.accept(downloadKey);
            const chunks: Uint8Array[] = [];
            for await (const chunk of reader) chunks.push(chunk);
            return decodeChunks(chunks);
          })();

          const workerDownloadProducerTask = dw.eval(
            `
              async (targetTs, downloadKey, payload) => {
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                while (Date.now() < targetTs) await wait(1);
                const s = hostStreams.create(downloadKey);
                await s.write(new TextEncoder().encode(payload));
                await s.close();
                return true;
              }
            `,
            { args: [startAt, downloadKey, downloadPayload] },
          );

          const [fnCount, downloadedSeen] = await withHardTimeout(
            Promise.all([
              withHardTimeout(functionStormTask, 12_000, `worker-${idx}-function-storm`),
              withHardTimeout(nodeReadTask, 12_000, `worker-${idx}-node-read`),
              withHardTimeout(workerDownloadProducerTask, 12_000, `worker-${idx}-download-producer`),
            ]).then(([count, downloaded]) => [count, downloaded] as const),
            20_000,
            `worker-${idx}-scenario`,
          );

          return { idx, fnCount, downloadedSeen, downloadPayload };
        });

        const all = await withHardTimeout(
          Promise.all(perWorkerTasks),
          35_000,
          "all-workers",
        );

        expect(all).toHaveLength(runtimeCount);
        for (const out of all) {
          expect(out.downloadedSeen).toBe(out.downloadPayload);
          expect(out.fnCount).toBe(hostCallsPerRuntime);
        }
      } finally {
        await Promise.all(
          workers.map(async (dw) => {
            await closeWorkerFully(dw);
          }),
        );
      }
    },
    50_000,
  );

  test(
    "20 runtimes: mixed eval/module.eval + stream fanout all queue and drain",
    async () => {
      const runtimeCount = 20;
      const streamsPerRuntime = 6;
      const hostCallsPerRuntime = 40;
      const startAt = Date.now() + 1200;

      const workers: DenoWorker[] = Array.from({ length: runtimeCount }, () =>
        createTestWorker({ bridge: { channelSize: 512 } }),
      );

      try {
        await Promise.all(
          workers.map((dw, idx) => dw.setGlobal("hostBump", (n: number) => n + idx)),
        );

        const perWorker = workers.map(async (dw, idx) => {
          const streamKeys = Array.from(
            { length: streamsPerRuntime },
            (_x, i) => `contend-r${idx}-s${i}`,
          );
          const expected = streamKeys.map((_, i) => `payload-r${idx}-s${i}-${"x".repeat(128)}`);

          const nodeReaders = streamKeys.map((key) =>
            withHardTimeout(
              (async () => {
                const reader = await dw.stream.accept(key);
                const chunks: Uint8Array[] = [];
                for await (const chunk of reader) chunks.push(chunk);
                return decodeChunks(chunks);
              })(),
              20_000,
              `worker-${idx}-read-${key}`,
            ),
          );

          const functionStormTask = dw.eval(
            `
              async (targetTs, calls) => {
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                while (Date.now() < targetTs) await wait(1);
                const vals = await Promise.all(
                  Array.from({ length: calls }, (_x, i) => hostBump(i))
                );
                return vals.length;
              }
            `,
            { args: [startAt, hostCallsPerRuntime] },
          );

          const moduleTask = dw.module.eval(`
            export const marker = ${idx} + 1000;
            export const kind = "contention-module";
          `);

          const producerTask = dw.eval(
            `
              async (targetTs, keys, payloads) => {
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                while (Date.now() < targetTs) await wait(1);
                await Promise.all(
                  keys.map(async (k, i) => {
                    const s = hostStreams.create(k);
                    await s.write(new TextEncoder().encode(String(payloads[i])));
                    await s.close();
                  })
                );
                return true;
              }
            `,
            { args: [startAt, streamKeys, expected] },
          );

          const [fnCount, moduleOut, _producer, seen] = await withHardTimeout(
            Promise.all([
              functionStormTask,
              moduleTask,
              producerTask,
              Promise.all(nodeReaders),
            ]),
            35_000,
            `worker-${idx}-mixed`,
          );

          return { idx, fnCount, moduleOut, seen, expected };
        });

        const all = await withHardTimeout(Promise.all(perWorker), 80_000, "mixed-all-workers");
        expect(all).toHaveLength(runtimeCount);
        for (const out of all) {
          expect(out.fnCount).toBe(hostCallsPerRuntime);
          expect(out.moduleOut).toMatchObject({ marker: out.idx + 1000, kind: "contention-module" });
          expect(out.seen).toEqual(out.expected);
        }
      } finally {
        await Promise.all(
          workers.map(async (dw) => {
            if (!dw.isClosed()) await dw.close({ force: true });
          }),
        );
      }
    },
    110_000,
  );

  test(
    "single runtime: 48 simultaneous stream pairs plus host-call storm",
    async () => {
      const dw = createTestWorker({ bridge: { channelSize: 1024 } });
      const pairs = 48;
      const startAt = Date.now() + 800;

      try {
        await dw.setGlobal("hostInc", (n: number) => n + 1);

        const pairData = Array.from({ length: pairs }, (_x, i) => ({
          up: `extreme-up-${i}`,
          down: `extreme-down-${i}`,
          payload: `node->worker-${i}-${"y".repeat(256)}`,
        }));

        const nodeDownReaders = pairData.map((d) =>
          withHardTimeout(
            (async () => {
              const reader = await dw.stream.accept(d.down);
              const chunks: Uint8Array[] = [];
              for await (const chunk of reader) chunks.push(chunk);
              return decodeChunks(chunks);
            })(),
            60_000,
            `down-read-${d.down}`,
          ),
        );

        const nodeUploads = pairData.map((d, i) =>
          withHardTimeout(
            (async () => {
              await sleep(i % 8);
              const writer = dw.stream.create(d.up);
              await writer.write(new TextEncoder().encode(d.payload));
              await writer.close();
              return true;
            })(),
            20_000,
            `up-write-${d.up}`,
          ),
        );

        await withHardTimeout(Promise.all(nodeUploads), 30_000, "up-uploads");

        const workerTask = dw.eval(
          `
            async (targetTs, pairs, count) => {
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              while (Date.now() < targetTs) await wait(1);

              const storm = Promise.all(
                Array.from({ length: count }, (_x, i) => hostInc(i))
              );

              const streamWork = Promise.all(
                pairs.map(async (p) => {
                  const incoming = await hostStreams.accept(p.up);
                  const chunks = [];
                  for await (const chunk of incoming) chunks.push(chunk);
                  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
                  const out = hostStreams.create(p.down);
                  await out.write(new TextEncoder().encode(String(p.down + ":" + total)));
                  await out.close();
                })
              );

              const [stormOut] = await Promise.all([storm, streamWork]);
              return stormOut.length;
            }
          `,
          { args: [startAt, pairData, 300] },
        );

        const [stormCount, downSeen] = await withHardTimeout(
          Promise.all([
            workerTask,
            Promise.all(nodeDownReaders),
          ]).then(([count, seen]) => [count, seen] as const),
          90_000,
          "single-runtime-extreme",
        );

        expect(stormCount).toBe(300);
        expect(downSeen).toHaveLength(pairs);
        for (let i = 0; i < pairData.length; i += 1) {
          const d = pairData[i];
          expect(downSeen[i]).toBe(`${d.down}:${new TextEncoder().encode(d.payload).byteLength}`);
        }
      } finally {
        await closeWorkerFully(dw);
      }
    },
    120_000,
  );

  test(
    "ABSURD contention: multi-wave runtime swarm with dense stream and host-call pressure",
    async () => {
      const runtimeCount = envInt("DENO_DIRECTOR_ABSURD_RUNTIMES", 28);
      const waves = envInt("DENO_DIRECTOR_ABSURD_WAVES", 3);
      const streamsPerRuntime = envInt("DENO_DIRECTOR_ABSURD_STREAMS", 10);
      const hostCallsPerRuntime = envInt("DENO_DIRECTOR_ABSURD_HOST_CALLS", 80);

      const workers: DenoWorker[] = Array.from({ length: runtimeCount }, () =>
        createTestWorker({ bridge: { channelSize: 1024 } }),
      );

      try {
        await Promise.all(
          workers.map((dw, idx) => dw.setGlobal("hostMix", (n: number) => n + idx)),
        );

        for (let wave = 0; wave < waves; wave += 1) {
          const startAt = Date.now() + 1000 + wave * 5;
          const perWorker = workers.map(async (dw, idx) => {
            const keys = Array.from(
              { length: streamsPerRuntime },
              (_x, i) => `absurd-w${wave}-r${idx}-s${i}`,
            );
            const expected = keys.map(
              (_k, i) => `W${wave}:R${idx}:S${i}:${"z".repeat(96)}`,
            );

            const nodeReaders = keys.map((key) =>
              withHardTimeout(
                (async () => {
                  const r = await dw.stream.accept(key);
                  const chunks: Uint8Array[] = [];
                  for await (const c of r) chunks.push(c);
                  return decodeChunks(chunks);
                })(),
                35_000,
                `wave-${wave}-r-${idx}-read-${key}`,
              ),
            );

            const hostStorm = dw.eval(
              `
                async (targetTs, calls) => {
                  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                  while (Date.now() < targetTs) await wait(1);
                  const vals = await Promise.all(
                    Array.from({ length: calls }, (_x, i) => hostMix(i))
                  );
                  return vals.length;
                }
              `,
              { args: [startAt, hostCallsPerRuntime] },
            );

            const moduleTask = dw.module.eval(`
              export const wave = ${wave};
              export const runtime = ${idx};
              export const marker = "absurd";
            `);

            const producerTask = dw.eval(
              `
                async (targetTs, keys, payloads) => {
                  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                  while (Date.now() < targetTs) await wait(1);
                  await Promise.all(keys.map(async (k, i) => {
                    const s = hostStreams.create(k);
                    const payload = String(payloads[i]);
                    await s.write(new TextEncoder().encode(payload.slice(0, payload.length / 2)));
                    await s.write(new TextEncoder().encode(payload.slice(payload.length / 2)));
                    await s.close();
                  }));
                  return true;
                }
              `,
              { args: [startAt, keys, expected] },
            );

            const [count, mod, _produced, seen] = await withHardTimeout(
              Promise.all([hostStorm, moduleTask, producerTask, Promise.all(nodeReaders)]),
              55_000,
              `wave-${wave}-r-${idx}-bundle`,
            );

            return { count, mod, seen, expected, idx };
          });

          const out = await withHardTimeout(
            Promise.all(perWorker),
            140_000,
            `absurd-wave-${wave}`,
          );

          expect(out).toHaveLength(runtimeCount);
          for (const row of out) {
            expect(row.count).toBe(hostCallsPerRuntime);
            expect(row.mod).toMatchObject({ wave, runtime: row.idx, marker: "absurd" });
            expect(row.seen).toEqual(row.expected);
          }
        }
      } finally {
        await Promise.all(
          workers.map(async (dw) => {
            await closeWorkerFully(dw);
          }),
        );
      }
    },
    220_000,
  );
});
