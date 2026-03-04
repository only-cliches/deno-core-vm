import { mergeWorkerOptions } from "../src/ts/options";

describe("options.mergeWorkerOptions", () => {
  test("deep merges limits instead of replacing object", () => {
    const merged = mergeWorkerOptions(
      { limits: { maxEvalMs: 25, maxHandle: 2 } },
      { limits: { maxMemoryBytes: 1024 * 1024 }, permissions: { wasm: false } },
    );

    expect(merged?.limits).toMatchObject({
      maxEvalMs: 25,
      maxHandle: 2,
      maxMemoryBytes: 1024 * 1024,
    });
    expect(merged?.permissions).toMatchObject({
      wasm: false,
    });
  });

  test("deep merges moduleLoader instead of replacing object", () => {
    const merged = mergeWorkerOptions(
      { moduleLoader: { httpsResolve: true, httpResolve: true } },
      { moduleLoader: { maxPayloadBytes: 1024, reload: true } },
    );

    expect(merged?.moduleLoader).toMatchObject({
      httpsResolve: true,
      httpResolve: true,
      maxPayloadBytes: 1024,
      reload: true,
    });
  });

  test("deep merges all nested sections in one composition", () => {
    const merged = mergeWorkerOptions(
      {
        permissions: { read: true, env: ["A"] },
        lifecycle: { afterStart: () => undefined },
        bridge: { channelSize: 32 },
        limits: { maxEvalMs: 25 },
        moduleLoader: { httpsResolve: true },
      },
      {
        permissions: { write: true },
        lifecycle: { beforeStop: () => undefined },
        bridge: { streamWindowBytes: 1024 },
        limits: { maxHandle: 10 },
        moduleLoader: { jsrResolve: true },
      },
    );

    expect(merged?.permissions).toMatchObject({ read: true, write: true, env: ["A"] });
    expect(merged?.lifecycle).toMatchObject({
      afterStart: expect.any(Function),
      beforeStop: expect.any(Function),
    });
    expect(merged?.bridge).toMatchObject({ channelSize: 32, streamWindowBytes: 1024 });
    expect(merged?.limits).toMatchObject({ maxEvalMs: 25, maxHandle: 10 });
    expect(merged?.moduleLoader).toMatchObject({ httpsResolve: true, jsrResolve: true });
  });
});
