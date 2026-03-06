import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        // Loaders run in order. Built-in loader runs after this chain.
        sourceLoaders: [
            async ({ src, srcLoader }) => {
                // Alias custom loader name -> built-in TS transpiler.
                if (srcLoader === "custom-ts") {
                    return { src, srcLoader: "ts" };
                }

                // Override a custom format by compiling to JS yourself.
                if (srcLoader === "kv") {
                    const out: Record<string, string> = {};
                    for (const raw of src.split("\n")) {
                        const line = raw.trim();
                        if (!line || line.startsWith("#")) continue;
                        const idx = line.indexOf("=");
                        if (idx <= 0) continue;
                        const key = line.slice(0, idx).trim();
                        const value = line.slice(idx + 1).trim();
                        out[key] = value;
                    }
                    return { src: `export default ${JSON.stringify(out)};`, srcLoader: "js" };
                }

                // Example of hard-disabling a loader mode.
                if (srcLoader === "tsx") {
                    throw new Error("tsx loader is disabled in this runtime");
                }
            },
        ],
        imports: (specifier: string) => {
            if (specifier === "app:typed") {
                return {
                    src: `
                        const n: number = 41;
                        export default n + 1;
                    `,
                    srcLoader: "custom-ts",
                };
            }

            if (specifier === "app:config") {
                return {
                    src: `
                        # key=value pairs
                        env=prod
                        region=us-west-2
                    `,
                    srcLoader: "kv",
                };
            }

            return false;
        },
    });

    try {
        const mod = await worker.module.eval(`
            import typed from "app:typed";
            import config from "app:config";
            export const out = { typed, config };
        `);
        console.log(mod.out);
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
