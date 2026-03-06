import { sleep, waitFor } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";
import pLimit from "p-limit";

function makeBigObject(bytes: number) {
    // JSON-friendly payload that is large but deterministic
    const chunk = "x".repeat(1024);
    const count = Math.max(1, Math.floor(bytes / 1024));
    return {
        kind: "big",
        parts: Array.from({ length: count }, (_, i) => `${i}:${chunk}`),
    };
}


describe("DenoWorker stress and backpressure", () => {

    test(
        "tryPostMessage stays true while worker is busy by queueing until drained",
        async () => {
            const prevStrict = process.env.DENOJS_WORKER_STRICT_CHANNEL;
            delete process.env.DENOJS_WORKER_STRICT_CHANNEL;

            const dw = createTestWorker({ bridge: { channelSize: 8 }, limits: { maxEvalMs: 500 } });
            try {
                await dw.eval("0");
                const busy = dw.eval(`
                    (() => {
                      const end = Date.now() + 150;
                      while (Date.now() < end) {}
                      return "done";
                    })()
                `);

                let ok = 0;
                let failed = 0;

                for (let i = 0; i < 512; i++) {
                    const enq = dw.tryPostMessage({ i });
                    if (enq) ok++;
                    else {
                        failed++;
                        break;
                    }
                }

                await busy.catch(() => { });

                expect(ok).toBeGreaterThan(0);
                expect(failed).toBe(0);
            } finally {
                if (!dw.isClosed()) await dw.close();
                if (prevStrict !== undefined) process.env.DENOJS_WORKER_STRICT_CHANNEL = prevStrict;
            }
        },
        20_000
    );

    test(
        "churn: create and close repeatedly without deadlock",
        async () => {
            for (let i = 0; i < 50; i++) {
                const dw = createTestWorker();
                await dw.eval("1 + 1");
                await dw.close();
                await waitFor(() => dw.isClosed(), 1000);
            }
        },
        30_000
    );

    test(
        "stress: eval queue drains even when concurrency exceeds channel capacity",
        async () => {
            const dw = createTestWorker({ bridge: { channelSize: 32 } });

            const tasks = Array.from({ length: 200 }, () => dw.eval("1 + 1"));
            const results = await Promise.allSettled(tasks);

            const ok = results.filter((r) => r.status === "fulfilled").length;
            const bad = results.filter((r) => r.status === "rejected").length;

            expect(ok).toBe(200);
            expect(bad).toBe(0);

            await dw.close();
        },
        20_000
    );

    test(
        "stress: many eval calls with bounded concurrency",
        async () => {
            const dw = createTestWorker({ bridge: { channelSize: 512 } });

            const limit = pLimit(64); // below bridge.channelSize
            const tasks = Array.from({ length: 2000 }, (_, i) =>
                limit(async () => {
                    const v = await dw.eval(`${i} + 1`);
                    expect(v).toBe(i + 1);
                })
            );

            await Promise.all(tasks);
            await dw.close();
        },
        30_000
    );

    test("sustains many eval calls in parallel", async () => {
        jest.setTimeout(30_000);
        const dw = createTestWorker({ bridge: { channelSize: 512 } });

        try {
            const N = 200;
            const promises = Array.from({ length: N }, (_, i) =>
                dw.eval("(n) => n + 1", { args: [i] })
            );
            const out = await Promise.all(promises);

            expect(out).toHaveLength(N);
            expect(out[0]).toBe(1);
            expect(out[N - 1]).toBe(N);
        } finally {
            if (!dw.isClosed()) await dw.close();
        }
    });

    test("handles large payload round-trip", async () => {
        jest.setTimeout(30_000);
        const dw = createTestWorker();

        try {
            const input = makeBigObject(2 * 1024 * 1024); // ~2MB of strings
            const out = await dw.eval("(x) => x", { args: [input] });
            expect(out).toEqual(input);
        } finally {
            if (!dw.isClosed()) await dw.close();
        }
    });

    test("stress: sync host function calls from Deno side", async () => {
        jest.setTimeout(30_000);
        const dw = createTestWorker({ bridge: { channelSize: 512 } });

        try {
            const double = jest.fn((x: number) => x * 2);
            await dw.global.set("double", double);

            const N = 250;
            const results = await Promise.all(
                Array.from({ length: N }, (_, i) => dw.eval("double", { args: [i] }))
            );

            expect(results[0]).toBe(0);
            expect(results[10]).toBe(20);
            expect(results[N - 1]).toBe((N - 1) * 2);

            // Confirm Node actually received calls (not required for perf, but useful)
            expect(double).toHaveBeenCalled();
        } finally {
            if (!dw.isClosed()) await dw.close();
        }
    });

    test("stress: async host function calls from Deno side", async () => {
        jest.setTimeout(30_000);
        const dw = createTestWorker({ bridge: { channelSize: 512 } });

        try {
            const addAsync = jest.fn(async (x: number) => {
                await sleep(2);
                return x + 1;
            });
            await dw.global.set("addAsync", addAsync);

            const N = 100;
            const results = await Promise.all(
                Array.from({ length: N }, (_, i) => dw.eval("addAsync", { args: [i] }))
            );

            expect(results[0]).toBe(1);
            expect(results[N - 1]).toBe(N);
            expect(addAsync).toHaveBeenCalled();
        } finally {
            if (!dw.isClosed()) await dw.close();
        }
    });

    test("stress: bidirectional postMessage volume", async () => {
        jest.setTimeout(30_000);
        const dw = createTestWorker({ bridge: { channelSize: 512 } });

        try {
            const receivedFromDeno: any[] = [];
            dw.on("message", (msg) => receivedFromDeno.push(msg));

            // Deno -> Node messages
            const N = 200;
            await dw.eval(`
        for (let i = 0; i < ${N}; i++) postMessage({ dir: "deno->node", i });
        "ok";
      `);

            // Node -> Deno messages + Deno captures last received
            await dw.eval(`globalThis.__received = []; on("message", (m) => __received.push(m)); "ok";`);
            for (let i = 0; i < N; i++) dw.postMessage({ dir: "node->deno", i });

            await sleep(150);

            expect(receivedFromDeno.length).toBeGreaterThanOrEqual(N);

            const denoSide = await dw.eval("__received.length");
            expect(denoSide).toBeGreaterThanOrEqual(N);
        } finally {
            if (!dw.isClosed()) await dw.close();
        }
    });

    test("churn: create and close repeatedly without deadlock", async () => {
        for (let i = 0; i < 50; i++) {
            const dw = createTestWorker();
            await dw.eval("1 + 1");
            await dw.close();
            expect(dw.isClosed()).toBe(true);
        }
    }, 30_000);

});
