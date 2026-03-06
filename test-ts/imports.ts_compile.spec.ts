import { createTestWorker } from "./helpers.worker-harness";

describe("imports callback ts/tsx/jsx + dynamic flag", () => {
  test("imports callback receives isDynamicImport for static and dynamic loads", async () => {
    const seen: Array<{ specifier: string; isDynamicImport?: boolean }> = [];

    const dw = createTestWorker({
      permissions: { import: true },
      imports: (specifier: string, _referrer?: string, isDynamicImport?: boolean) => {
        seen.push({ specifier, isDynamicImport });

        if (specifier === "virtual:static") {
          // loader omitted => defaults to "js"
          return { source: "export default 1;" };
        }
        if (specifier === "virtual:dynamic") {
          return { source: "export default 2;", sourceLoader: "js" };
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

  test("imports callback can return { source, sourceLoader: 'ts' }", async () => {
    const dw = createTestWorker({
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-ts") return false;
        return {
          source: `
            const n: number = 41;
            export default n + 1;
          `,
          sourceLoader: "ts",
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

  test("imports callback rejects unresolved custom loader names", async () => {
    const dw = createTestWorker({
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-custom-unresolved") return false;
        return {
          source: `export default 1;`,
          sourceLoader: "custom-unresolved",
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:typed-custom-unresolved";
          export const out = v;
        `),
      ).rejects.toThrow(/Import blocked/i);
    } finally {
      await dw.close();
    }
  });

  test("imports callback can use arbitrary custom loaders resolved by async loader callbacks", async () => {
    const dw = createTestWorker({
      permissions: { import: true },
      sourceLoaders: [
        async ({ source, sourceLoader }) => {
          if (sourceLoader !== "typed-ts") return;
          return { source, sourceLoader: "ts" };
        },
      ],
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-via-custom-loader") return false;
        return {
          source: `
            const n: number = 41;
            export default n + 1;
          `,
          sourceLoader: "typed-ts",
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:typed-via-custom-loader";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: 42 });
    } finally {
      await dw.close();
    }
  });

  test("sourceLoaders:false rejects non-js import loaders (strict js mode)", async () => {
    const dw = createTestWorker({
      sourceLoaders: false,
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:strict-js-only") return false;
        return {
          source: `const n: number = 1; export default n;`,
          sourceLoader: "ts",
        };
      },
    });

    try {
      await expect(
        dw.module.eval(`
          import v from "virtual:strict-js-only";
          export const out = v;
        `),
      ).rejects.toThrow(/strict js mode|sourceLoaders:\s*false|Import blocked/i);
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { source, sourceLoader: 'tsx' } with tsCompiler jsxFactory settings", async () => {
    const dw = createTestWorker({
      tsCompiler: {
        jsx: "react",
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
      },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-tsx") return false;
        return {
          source: `
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
          sourceLoader: "tsx",
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

  test("imports callback can return { source, sourceLoader: 'jsx' } with tsCompiler jsxFactory settings", async () => {
    const dw = createTestWorker({
      tsCompiler: {
        jsx: "react",
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
      },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-jsx") return false;
        return {
          source: `
            function h(tag, props) {
              return tag + ":" + props.value;
            }

            const out = <div value="ok-jsx" />;
            export default out;
          `,
          sourceLoader: "jsx",
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
