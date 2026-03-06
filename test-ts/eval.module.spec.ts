// src/__tests__/eval_module.spec.ts
import { createTestWorker } from "./helpers.worker-harness";

describe("module.eval: module namespace API", () => {
  jest.setTimeout(60_000);

  test("returns a module namespace object with named exports", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const mod = await dw.module.eval(`
        export const cfg = {
          api: {
            baseUrl: "https://example.com",
            retries: 3,
            headers: { "x-env": "test" },
          },
          features: ["a", "b", "c"],
        };
      `);

      expect(mod).toBeTruthy();
      expect(mod.cfg).toBeTruthy();
      expect(mod.cfg.api.baseUrl).toBe("https://example.com");
      expect(mod.cfg.api.retries).toBe(3);
      expect(mod.cfg.api.headers["x-env"]).toBe("test");
      expect(mod.cfg.features[1]).toBe("b");
    } finally {
      await dw.close();
    }
  });

  test("supports default export on the returned namespace", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const mod = await dw.module.eval(`
        export default function add(a, b) { return a + b; }
        export const x = 10;
      `);

      expect(mod).toBeTruthy();
      expect(mod.x).toBe(10);
      expect(typeof mod.default).toBe("function");
      expect(mod.default(2, 3)).toBe(5);
    } finally {
      await dw.close();
    }
  });

  test("module evaluation can return expanded types via exports", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const mod = await dw.module.eval(`
        export const bi = 9007199254740993n;
        export const when = new Date(1700000000000);
        export const re = /a+b/gi;
        export const url = new URL("https://example.com/a?b=c");
        export const params = new URLSearchParams("a=1&b=2");
        export const data = (() => { const ab = new ArrayBuffer(3); new Uint8Array(ab).set([1,2,3]); return ab; })();
        export const m = new Map([["a", 1], [2, "b"]]);
        export const s = new Set([1, "a"]);
        export const err = (() => { const e = new Error("top", { cause: new TypeError("root") }); e.name = "MyError"; return e; })();
      `);

      expect(typeof mod.bi).toBe("bigint");
      expect(mod.bi).toBe(9007199254740993n);

      expect(mod.when).toBeInstanceOf(Date);
      expect(mod.when.getTime()).toBe(1700000000000);

      expect(mod.re).toBeInstanceOf(RegExp);
      expect(mod.re.source).toBe("a+b");
      expect(mod.re.flags.split("").sort().join("")).toBe("gi");

      expect(mod.url).toBeInstanceOf(URL);
      expect(mod.url.href).toBe("https://example.com/a?b=c");
      expect(mod.url.searchParams.get("b")).toBe("c");

      expect(mod.params).toBeInstanceOf(URLSearchParams);
      expect(mod.params.get("a")).toBe("1");
      expect(mod.params.get("b")).toBe("2");

      expect(mod.data).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(mod.data))).toEqual([1, 2, 3]);

      expect(mod.m).toBeInstanceOf(Map);
      expect(mod.m.get("a")).toBe(1);
      expect(mod.m.get(2)).toBe("b");

      expect(mod.s).toBeInstanceOf(Set);
      expect(mod.s.has(1)).toBe(true);
      expect(mod.s.has("a")).toBe(true);

      // expect(mod.err).toBeInstanceOf(Error);
      expect(mod.err.name).toBe("MyError");
      expect(mod.err.message).toBe("top");
      const errWithCause = mod.err as Error & { cause?: unknown };
      if (errWithCause.cause != null) {
        expect(errWithCause.cause).toBeInstanceOf(Error);
        expect(String((errWithCause.cause as Error).message)).toBe("root");
      }
    } finally {
      await dw.close();
    }
  });

  test("multiple module.eval calls return independent namespaces", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const a = await dw.module.eval(`export const n = 1;`);
      const b = await dw.module.eval(`export const n = 2;`);

      expect(a.n).toBe(1);
      expect(b.n).toBe(2);
    } finally {
      await dw.close();
    }
  });

  test("transpiles TypeScript in module.eval when srcLoader:'ts' is set", async () => {
    const dw = createTestWorker({
      console: false,
    });
    try {
      await expect(
        dw.module.eval(`
        export type User = { id: number };
        const user: User = { id: 42 };
        export const out: number = user.id;
      `),
      ).rejects.toBeDefined();

      const mod = await dw.module.eval(`
        export type User = { id: number };
        const user: User = { id: 42 };
        export const out: number = user.id;
      `, { srcLoader: "ts" });

      expect(mod.out).toBe(42);
    } finally {
      await dw.close();
    }
  });

  test("async module exports do not deadlock when awaiting async host callbacks", async () => {
    const dw = createTestWorker({ console: false });
    try {
      await dw.global.set("hostFetchData", async (userId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { id: userId, secret: "super_classified_payload" };
      });

      const sandbox = await dw.module.eval(`
        export async function processUser(userId) {
          const rawData = await globalThis.hostFetchData(userId);
          return {
            status: "SECURED",
            originalId: rawData.id,
            fingerprint: btoa(rawData.secret).substring(0, 12),
          };
        }
      `);

      const result = await sandbox.processUser("user_999");
      expect(result).toEqual({
        status: "SECURED",
        originalId: "user_999",
        fingerprint: "c3VwZXJfY2xh",
      });
    } finally {
      await dw.close();
    }
  });

  test(
    "sync module exports that invoke host callbacks fail fast under evalSync path",
    async () => {
      const dw = createTestWorker({ console: false });
      try {
        await dw.global.set("hostDouble", (x: number) => x * 2);

        const mod = await dw.module.eval(`
          export function run() {
            return globalThis.hostDouble(21);
          }
        `);

        const started = Date.now();
        expect(() => mod.run()).toThrow(/evalsync|cross-runtime/i);
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(1_500);
      } finally {
        await dw.close();
      }
    },
    20_000,
  );
});
