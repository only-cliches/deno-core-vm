import type { ScenarioDef, WorkerCount } from "./types";
import { formatMs } from "./workload";

export function printMarkdownTable(
    scenarios: ScenarioDef[],
    imageLabel: string,
    workerCounts: WorkerCount[],
    times: Map<string, number>,
): void {
    const bestByWorker = new Map<WorkerCount, number>();
    for (const wc of workerCounts) {
        let best = Number.POSITIVE_INFINITY;
        for (const scenario of scenarios) {
            const t = times.get(`${scenario.key}:${wc}`);
            if (t != null && t < best) best = t;
        }
        if (Number.isFinite(best)) bestByWorker.set(wc, best);
    }

    const header = ["Main", "IPC", "Worker", ...workerCounts.map((w) => `${w} workers`)];
    const sep = ["---", "---", "---", ...workerCounts.map(() => "---:")];
    console.log(`_Image: ${imageLabel}_`);
    console.log(`| ${header.join(" | ")} |`);
    console.log(`| ${sep.join(" | ")} |`);

    for (const scenario of scenarios) {
        const row = [scenario.main, scenario.ipc, scenario.worker];
        for (const wc of workerCounts) {
            const key = `${scenario.key}:${wc}`;
            const t = times.get(key);
            if (t == null) {
                row.push("?");
                continue;
            }
            const best = bestByWorker.get(wc);
            const value = formatMs(t);
            row.push(best != null && Math.abs(t - best) < 1e-9 ? `**${value}**` : value);
        }
        console.log(`| ${row.join(" | ")} |`);
    }
}

export function printPlainTable(
    scenarios: ScenarioDef[],
    imageLabel: string,
    workerCounts: WorkerCount[],
    times: Map<string, number>,
): void {
    const bestByWorker = new Map<WorkerCount, number>();
    for (const wc of workerCounts) {
        let best = Number.POSITIVE_INFINITY;
        for (const scenario of scenarios) {
            const t = times.get(`${scenario.key}:${wc}`);
            if (t != null && t < best) best = t;
        }
        if (Number.isFinite(best)) bestByWorker.set(wc, best);
    }

    const headers = ["Main", "IPC", "Worker", ...workerCounts.map((w) => `${w} workers`)];
    const rows: string[][] = scenarios.map((scenario) => {
        const row = [scenario.main, scenario.ipc, scenario.worker];
        for (const wc of workerCounts) {
            const t = times.get(`${scenario.key}:${wc}`);
            if (t == null) {
                row.push("?");
                continue;
            }
            const best = bestByWorker.get(wc);
            const marker = best != null && Math.abs(t - best) < 1e-9 ? "* " : "";
            row.push(`${marker}${formatMs(t)}`);
        }
        return row;
    });

    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] == null ? 0 : r[i].length))));
    const numericStart = 3;
    for (let i = numericStart; i < widths.length; i += 1) widths[i] = Math.max(widths[i], 12);
    const padCell = (text: string, idx: number) =>
        idx >= numericStart ? text.padStart(widths[idx]) : text.padEnd(widths[idx]);
    const joinRow = (cells: string[]) => `| ${cells.map((c, i) => padCell(c, i)).join(" | ")} |`;
    const sep = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;

    console.log(`Image: ${imageLabel}`);
    console.log(sep);
    console.log(joinRow(headers));
    console.log(sep);
    for (const row of rows) console.log(joinRow(row));
    console.log(sep);
    console.log("* marks fastest in each worker column");
}
