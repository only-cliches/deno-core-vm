import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        imports: (specifier: string) => {
            if (specifier === "app:math") {
                return {
                    js: `
                        export const add = (a, b) => a + b;
                        export default { add };
                    `,
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
