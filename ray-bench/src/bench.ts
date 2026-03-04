import { performance } from "node:perf_hooks";
import { printMarkdownTable, printPlainTable } from "./format";
import { allScenarios } from "./scenarios";
import type { BenchConfig } from "./types";
import { scenarioOrder } from "./types";
import { buildTasks, formatMs, median } from "./workload";

function parseArgs(): BenchConfig {
    const args = process.argv.slice(2);
    const out: BenchConfig = {
        width: 1024,
        height: 1024,
        tileHeight: 16,
        workerCounts: [4, 8, 12, 16, 32],
        iterations: 1,
        warmup: 0,
        scenarios: [...scenarioOrder],
        format: "plain",
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--width") out.width = Number(args[++i]);
        else if (arg === "--height") out.height = Number(args[++i]);
        else if (arg === "--tile") out.tileHeight = Number(args[++i]);
        else if (arg === "--iterations") out.iterations = Number(args[++i]);
        else if (arg === "--warmup") out.warmup = Number(args[++i]);
        else if (arg === "--workers") {
            out.workerCounts = args[++i]
                .split(",")
                .map((v) => Number(v.trim()))
                .filter((v): v is 4 | 8 | 12 | 16 | 32 => v === 4 || v === 8 || v === 12 || v === 16 || v === 32);
        } else if (arg === "--scenarios") {
            const wanted = new Set(args[++i].split(",").map((v) => v.trim()));
            out.scenarios = scenarioOrder.filter((k) => wanted.has(k));
        } else if (arg === "--format") {
            const fmt = String(args[++i] ?? "").trim().toLowerCase();
            if (fmt === "plain" || fmt === "markdown") out.format = fmt;
            else throw new Error("Invalid --format (allowed: plain, markdown)");
        }
    }

    if (!Number.isFinite(out.width) || out.width <= 0) throw new Error("Invalid --width");
    if (!Number.isFinite(out.height) || out.height <= 0) throw new Error("Invalid --height");
    if (!Number.isFinite(out.tileHeight) || out.tileHeight <= 0) throw new Error("Invalid --tile");
    if (!Number.isFinite(out.iterations) || out.iterations <= 0) throw new Error("Invalid --iterations");
    if (!Number.isFinite(out.warmup) || out.warmup < 0) throw new Error("Invalid --warmup");
    if (out.workerCounts.length === 0) throw new Error("No valid --workers values (allowed: 4,8,12,16,32)");
    if (out.scenarios.length === 0) throw new Error("No scenarios selected");

    return out;
}

async function main(): Promise<void> {
    const config = parseArgs();
    const scenarios = allScenarios.filter((s) => config.scenarios.includes(s.key));
    const tasks = buildTasks(config.width, config.height, config.tileHeight);

    console.log("# Ray Bench");
    console.log(
        `config: width=${config.width} height=${config.height} tileHeight=${config.tileHeight} tasks=${tasks.length} iterations=${config.iterations} warmup=${config.warmup}`,
    );

    const times = new Map<string, number>();
    let baselineChecksum: number | undefined;

    for (const scenario of scenarios) {
        for (const wc of config.workerCounts) {
            console.log(`running: ${scenario.label} @ ${wc} workers`);

            const context = scenario.setup ? await scenario.setup(wc) : undefined;

            try {
                for (let i = 0; i < config.warmup; i += 1) {
                    await scenario.run(tasks, wc, context);
                }

                const iterTimes: number[] = [];
                let checksum: number | undefined;

                for (let i = 0; i < config.iterations; i += 1) {
                    const t0 = performance.now();
                    const current = await scenario.run(tasks, wc, context);
                    const dt = performance.now() - t0;
                    iterTimes.push(dt);
                    if (checksum == null) checksum = current;
                    else if (checksum !== current) {
                        throw new Error(
                            `Inconsistent checksum within scenario ${scenario.key} workers=${wc}: ${checksum} vs ${current}`,
                        );
                    }
                }

                if (checksum == null) throw new Error("Missing checksum");
                if (baselineChecksum == null) baselineChecksum = checksum;
                if (checksum !== baselineChecksum) {
                    throw new Error(
                        `Checksum mismatch for ${scenario.key} workers=${wc}: expected ${baselineChecksum}, got ${checksum}`,
                    );
                }

                const med = median(iterTimes);
                times.set(`${scenario.key}:${wc}`, med);
                console.log(`done: ${scenario.label} @ ${wc} -> ${formatMs(med)} (checksum=${checksum})`);
            } finally {
                if (scenario.teardown) {
                    await scenario.teardown(context);
                }
            }
        }
    }

    console.log("");
    const imageLabel = `${config.width}x${config.height}`;
    if (config.format === "markdown") printMarkdownTable(scenarios, imageLabel, config.workerCounts, times);
    else printPlainTable(scenarios, imageLabel, config.workerCounts, times);
}

main().catch((err) => {
    console.error("ray-bench failed:", err);
    process.exitCode = 1;
});
