import { createTestWorker } from "./helpers.worker-harness";

describe("imports callback ts/tsx/jsx + dynamic flag", () => {
  test("imports callback receives isDynamicImport for static and dynamic loads", async () => {
    const seen: Array<{ specifier: string; isDynamicImport?: boolean }> = [];

    const dw = createTestWorker({
      transpileTs: true,
      permissions: { import: true },
      imports: (specifier: string, _referrer?: string, isDynamicImport?: boolean) => {
        seen.push({ specifier, isDynamicImport });

        if (specifier === "virtual:static") {
          return { js: "export default 1;" };
        }
        if (specifier === "virtual:dynamic") {
          return { js: "export default 2;" };
        }

        return false;
      },
    });

    try {
      const out = await dw.module.eval(`
        import s from "virtual:static";
        const d = await import("virtual:dynamic");
        export const result = [s, d.default];
      `);

      const resultOut = out as { result?: unknown[] };
      const first = resultOut?.result?.[0];
      const second = resultOut?.result?.[1];
      expect([first, second]).toEqual([1, 2]);

      const staticCall = seen.find((x) => x.specifier === "virtual:static");
      const dynamicCall = seen.find((x) => x.specifier === "virtual:dynamic");

      expect(staticCall).toBeTruthy();
      expect(staticCall?.isDynamicImport).toBe(false);
      expect(dynamicCall).toBeTruthy();
      expect(dynamicCall?.isDynamicImport).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { ts }", async () => {
    const dw = createTestWorker({
      transpileTs: true,
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-ts") return false;
        return {
          ts: `
            const n: number = 41;
            export default n + 1;
          `,
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:typed-ts";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: 42 });
    } finally {
      await dw.close();
    }
  });

  test("imports callback { ts } rejects with guidance when transpileTs is disabled", async () => {
    const dw = createTestWorker({
      transpileTs: false,
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-ts-disabled") return false;
        return {
          ts: `
            const n: number = 1;
            export default n;
          `,
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:typed-ts-disabled";
          export const out = v;
        `),
      ).rejects.toThrow(/transpileTs:\s*true/i);
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { tsx } with tsCompiler jsxFactory settings", async () => {
    const dw = createTestWorker({
      transpileTs: true,
      tsCompiler: {
        jsx: "react",
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
      },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-tsx") return false;
        return {
          tsx: `
            declare global {
              namespace JSX {
                interface IntrinsicElements {
                  div: { value: string };
                }
              }
            }

            function h(tag: string, props: { value: string }) {
              return tag + ":" + props.value;
            }

            const out = <div value="ok" />;
            export default out;
          `,
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:typed-tsx";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: "div:ok" });
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { jsx } with tsCompiler jsxFactory settings", async () => {
    const dw = createTestWorker({
      transpileTs: true,
      tsCompiler: {
        jsx: "react",
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
      },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-jsx") return false;
        return {
          jsx: `
            function h(tag, props) {
              return tag + ":" + props.value;
            }

            const out = <div value="ok-jsx" />;
            export default out;
          `,
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:typed-jsx";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: "div:ok-jsx" });
    } finally {
      await dw.close();
    }
  });
});
