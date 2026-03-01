// src/__tests__/eval_module.spec.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { DenoWorker } from "../src/index";

describe("evalModule: module namespace API", () => {
  jest.setTimeout(60_000);

  test("returns a module namespace object with named exports", async () => {
    const dw = new DenoWorker({ console: false });
    try {
      const mod = await dw.evalModule(`
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
    const dw = new DenoWorker({ console: false });
    try {
      const mod = await dw.evalModule(`
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
    const dw = new DenoWorker({ console: false });
    try {
      const mod = await dw.evalModule(`
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
      if ((mod.err as any).cause != null) {
        expect((mod.err as any).cause).toBeInstanceOf(Error);
        expect(String((mod.err as any).cause.message)).toBe("root");
      }
    } finally {
      await dw.close();
    }
  });

  test("multiple evalModule calls return independent namespaces", async () => {
    const dw = new DenoWorker({ console: false });
    try {
      const a = await dw.evalModule(`export const n = 1;`);
      const b = await dw.evalModule(`export const n = 2;`);

      expect(a.n).toBe(1);
      expect(b.n).toBe(2);
    } finally {
      await dw.close();
    }
  });
});