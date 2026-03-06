import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        // Loaders run in order. Built-in loader runs after this chain.
        sourceLoaders: [
            async ({ source, sourceLoader }) => {
                // Alias custom loader name -> built-in TS transpiler.
                if (sourceLoader === "custom-ts") {
                    return { source, sourceLoader: "ts" };
                }

                // Override a custom format by compiling to JS yourself.
                if (sourceLoader === "kv") {
                    const out: Record<string, string> = {};
                    for (const raw of source.split("\n")) {
                        const line = raw.trim();
                        if (!line || line.startsWith("#")) continue;
                        const idx = line.indexOf("=");
                        if (idx <= 0) continue;
                        const key = line.slice(0, idx).trim();
                        const value = line.slice(idx + 1).trim();
                        out[key] = value;
                    }
                    return { source: `export default ${JSON.stringify(out)};`, sourceLoader: "js" };
                }

                // Example of hard-disabling a loader mode.
                if (sourceLoader === "tsx") {
                    throw new Error("tsx loader is disabled in this runtime");
                }
            },
        ],
        imports: (specifier: string) => {
            if (specifier === "app:typed") {
                return {
                    source: `
                        const n: number = 41;
                        export default n + 1;
                    `,
                    sourceLoader: "custom-ts",
                };
            }

            if (specifier === "app:config") {
                return {
                    source: `
                        # key=value pairs
                        env=prod
                        region=us-west-2
                    `,
                    sourceLoader: "kv",
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
