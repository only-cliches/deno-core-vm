#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { transformSync } from "esbuild";

function sumJsBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += sumJsBytes(fullPath);
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".js") {
      const code = readFileSync(fullPath, "utf8");
      const minified = transformSync(code, {
        loader: "js",
        minify: true,
      });
      total += Buffer.byteLength(minified.code, "utf8");
    }
  }
  return total;
}

const outDir = mkdtempSync(join(tmpdir(), "deno-director-ts-size-"));

try {
  execFileSync(
    "npx",
    ["tsc", "--project", "tsconfig.idx.json", "--outDir", outDir, "--pretty", "false"],
    { stdio: "inherit" },
  );

  const totalBytes = sumJsBytes(outDir);
  console.log(totalBytes);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
