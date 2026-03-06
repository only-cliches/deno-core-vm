import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        sourceLoaders: [
            async ({ source, sourceLoader }) => {
                if (sourceLoader !== "app-ts") return;
                return { source, sourceLoader: "ts" };
            },
        ],
        imports: (specifier: string) => {
            if (specifier === "app:math") {
                return {
                    source: `
                        export const add = (a: number, b: number) => a + b;
                        export default { add };
                    `,
                    sourceLoader: "app-ts",
                };
            }

            return false;
        },
    });

    try {
        const mod = await worker.module.eval(`
            import { add } from "app:math";
            export const out = add(20, 22);
        `);

        console.log("out:", mod.out);
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
