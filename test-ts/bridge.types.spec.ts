import { createTestWorker } from "./helpers.worker-harness";

function u8of(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error(`Expected ArrayBuffer or view, got: ${Object.prototype.toString.call(x)}`);
}

function bytesEq(actual: unknown, expected: number[]) {
  const a = Array.from(u8of(actual));
  expect(a).toEqual(expected);
}

function expectMapEq(m: unknown, entries: Array<[unknown, unknown]>) {
  const map = m as Map<unknown, unknown>;
  expect(m).toBeInstanceOf(Map);
  expect(map.size).toBe(entries.length);
  for (const [k, v] of entries) {
    expect(map.get(k)).toEqual(v);
  }
}

function expectSetEq(s: unknown, values: unknown[]) {
  const set = s as Set<unknown>;
  expect(s).toBeInstanceOf(Set);
  expect(set.size).toBe(values.length);
  for (const v of values) {
    expect(set.has(v)).toBe(true);
  }
}

describe("bridge: expanded types", () => {
  jest.setTimeout(60_000);

  test("Deno -> Node: BigInt", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval("9007199254740993n");
      expect(typeof out).toBe("bigint");
      expect(out).toBe(9007199254740993n);
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: BigInt", async () => {
    const dw = createTestWorker({ console: false });
    try {
      await dw.setGlobal("x", 9007199254740993n);
      expect(await dw.eval("typeof x")).toBe("bigint");
      expect(await dw.eval("x + 2n")).toBe(9007199254740995n);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: Date", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval("new Date(1700000000000)");
      expect(out).toBeInstanceOf(Date);
      expect(out.getTime()).toBe(1700000000000);
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: Date", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const d = new Date(1700000000000);
      await dw.setGlobal("d", d);
      expect(await dw.eval("d instanceof Date")).toBe(true);
      expect(await dw.eval("d.getTime()")).toBe(1700000000000);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: RegExp", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval("(/a+b/gi)");
      expect(out).toBeInstanceOf(RegExp);
      expect(out.source).toBe("a+b");
      expect(out.flags.split("").sort().join("")).toBe("gi");
      expect(out.test("AAB")).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: RegExp", async () => {
    const dw = createTestWorker({ console: false });
    try {
      await dw.setGlobal("r", /a+b/gi);
      expect(await dw.eval("r instanceof RegExp")).toBe(true);
      expect(await dw.eval("r.test('AAB')")).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: ArrayBuffer", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval(
        "(() => { const ab = new ArrayBuffer(3); new Uint8Array(ab).set([1,2,3]); return ab; })()",
      );
      expect(out).toBeInstanceOf(ArrayBuffer);
      bytesEq(out, [1, 2, 3]);
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: ArrayBuffer", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const ab = new ArrayBuffer(3);
      new Uint8Array(ab).set([7, 8, 9]);
      await dw.setGlobal("ab", ab);
      expect(await dw.eval("ab instanceof ArrayBuffer")).toBe(true);
      expect(await dw.eval("Array.from(new Uint8Array(ab))")).toEqual([7, 8, 9]);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: TypedArrays (roundtrip class + bytes)", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const cases: Array<[string, number[] | bigint[]]> = [
        ["Uint8Array", [1, 2, 255]],
        ["Int8Array", [-1, 0, 1]],
        ["Uint16Array", [1, 2, 65535]],
        ["Int16Array", [-2, 0, 2]],
        ["Uint32Array", [1, 2, 4294967295]],
        ["Int32Array", [-2, 0, 2]],
        ["Float32Array", [1.5, -2.25, 3.75]],
        ["Float64Array", [1.5, -2.25, 3.75]],
        ["Uint8ClampedArray", [0, 128, 255]],
        ["BigInt64Array", [1n, -2n, 3n]],
        ["BigUint64Array", [1n, 2n, 3n]],
      ];

      for (const [ctorName, vals] of cases) {
        const src = (() => {
          if (ctorName === "BigInt64Array") {
            return `new BigInt64Array([1n,-2n,3n])`;
          }
          if (ctorName === "BigUint64Array") {
            return `new BigUint64Array([1n,2n,3n])`;
          }
          if (ctorName === "Float32Array" || ctorName === "Float64Array") {
            return `new ${ctorName}([1.5,-2.25,3.75])`;
          }
          if (ctorName === "Int8Array") return `new Int8Array([-1,0,1])`;
          if (ctorName === "Int16Array") return `new Int16Array([-2,0,2])`;
          if (ctorName === "Int32Array") return `new Int32Array([-2,0,2])`;
          if (ctorName === "Uint8Array") return `new Uint8Array([1,2,255])`;
          if (ctorName === "Uint8ClampedArray") return `new Uint8ClampedArray([0,128,255])`;
          if (ctorName === "Uint16Array") return `new Uint16Array([1,2,65535])`;
          if (ctorName === "Uint32Array") return `new Uint32Array([1,2,4294967295])`;
          return `new ${ctorName}([1,2,3])`;
        })();

        const out = await dw.eval(`(() => { const x = ${src}; return x; })()`);
        const ctor = (globalThis as unknown as Record<string, Function>)[ctorName];
        expect(out).toBeInstanceOf(ctor);

        if (ctorName === "BigInt64Array" || ctorName === "BigUint64Array") {
          expect(Array.from(out as ArrayLike<bigint>)).toEqual(vals as bigint[]);
        } else if (ctorName === "Float32Array" || ctorName === "Float64Array") {
          // Float comparisons: exact for these literals on both sides is fine, but keep it tolerant anyway.
          const got = Array.from(out as ArrayLike<number>);
          expect(got.length).toBe(3);
          const numVals = vals as number[];
          expect(got[0]).toBeCloseTo(numVals[0], 6);
          expect(got[1]).toBeCloseTo(numVals[1], 6);
          expect(got[2]).toBeCloseTo(numVals[2], 6);
        } else {
          expect(Array.from(out as ArrayLike<number>)).toEqual(vals as number[]);
        }
      }
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: TypedArrays + DataView", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const i16 = new Int16Array([1, 2, 3]);
      await dw.setGlobal("i16", i16);
      expect(await dw.eval("i16 instanceof Int16Array")).toBe(true);
      expect(await dw.eval("i16[1]")).toBe(2);

      const ab = new ArrayBuffer(4);
      const dv = new DataView(ab);
      dv.setUint32(0, 0x01020304, false);
      await dw.setGlobal("dv", dv);
      expect(await dw.eval("dv instanceof DataView")).toBe(true);
      expect(await dw.eval("dv.getUint32(0, false)")).toBe(0x01020304);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: DataView", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval(
        "(() => { const ab = new ArrayBuffer(4); const dv = new DataView(ab); dv.setUint32(0, 0x01020304, false); return dv; })()",
      );
      expect(out).toBeInstanceOf(DataView);
      expect((out as DataView).getUint32(0, false)).toBe(0x01020304);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: Map (primitive keys only)", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval("new Map([['a', 1], [2, 'b'], [true, false]])");
      expectMapEq(out, [
        ["a", 1],
        [2, "b"],
        [true, false],
      ]);
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: Map (primitive keys only)", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const m = new Map<any, any>([
        ["a", 1],
        [2, "b"],
        [true, false],
      ]);
      await dw.setGlobal("m", m);
      expect(await dw.eval("m instanceof Map")).toBe(true);
      expect(await dw.eval("m.get('a')")).toBe(1);
      expect(await dw.eval("m.get(2)")).toBe("b");
      expect(await dw.eval("m.get(true)")).toBe(false);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: Set", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval("new Set([1, 'a', true])");
      expectSetEq(out, [1, "a", true]);
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: Set", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const s = new Set<any>([1, "a", true]);
      await dw.setGlobal("s", s);
      expect(await dw.eval("s instanceof Set")).toBe(true);
      expect(await dw.eval("s.has(1)")).toBe(true);
      expect(await dw.eval("s.has('a')")).toBe(true);
      expect(await dw.eval("s.has(true)")).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: Error (name/message/stack/cause best-effort)", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const out = await dw.eval(
        "(() => { const cause = new TypeError('root'); const e = new Error('top', { cause }); e.name = 'MyError'; return e; })()",
      );
      expect(out).toBeInstanceOf(Error);
      expect(out.name).toBe("MyError");
      expect(out.message).toBe("top");

      // cause is best-effort. If implemented, it should be Error-like.
      const errWithCause = out as Error & { cause?: unknown };
      if (errWithCause.cause != null) {
        expect(errWithCause.cause).toBeInstanceOf(Error);
        expect(String((errWithCause.cause as Error).message)).toBe("root");
      }
    } finally {
      await dw.close();
    }
  });

  test("Deno -> Node: URL + URLSearchParams", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const url = await dw.eval("new URL('https://example.com/a?b=c')");
      expect(url).toBeInstanceOf(URL);
      expect(url.href).toBe("https://example.com/a?b=c");
      expect(url.hostname).toBe("example.com");
      expect(url.searchParams.get("b")).toBe("c");

      const usp = await dw.eval("new URLSearchParams('a=1&b=2')");
      expect(usp).toBeInstanceOf(URLSearchParams);
      expect(usp.get("a")).toBe("1");
      expect(usp.get("b")).toBe("2");
    } finally {
      await dw.close();
    }
  });

  test("Node -> Deno: URL + URLSearchParams", async () => {
    const dw = createTestWorker({ console: false });
    try {
      const url = new URL("https://example.com/a?b=c");
      await dw.setGlobal("u", url);

      expect(await dw.eval("u instanceof URL")).toBe(true);
      expect(await dw.eval("u.href")).toBe("https://example.com/a?b=c");
      expect(await dw.eval("u.searchParams.get('b')")).toBe("c");

      const usp = new URLSearchParams("a=1&b=2");
      await dw.setGlobal("usp", usp);
      expect(await dw.eval("usp instanceof URLSearchParams")).toBe(true);
      expect(await dw.eval("usp.get('a')")).toBe("1");
      expect(await dw.eval("usp.get('b')")).toBe("2");
    } finally {
      await dw.close();
    }
  });
});
