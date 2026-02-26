// save as: dump-rs-files.mjs
import { promises as fs } from "node:fs";
import path from "node:path";

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await walk(fullPath)));
    } else if (entry.isFile() && (entry.name.endsWith(".rs") || entry.name.endsWith(".js"))) {
      results.push(fullPath);
    }
  }

  return results;
}

function toPosixRelative(base, target) {
  return path.relative(base, target).split(path.sep).join("/");
}

async function main() {
  const cwd = process.cwd();
  const srcDir = path.join(cwd, "src");
  const outputPath = path.join(cwd, "rust-files-dump.md");

  let srcStat;
  try {
    srcStat = await fs.stat(srcDir);
  } catch {
    console.error(`Could not find src directory: ${srcDir}`);
    process.exit(1);
  }

  if (!srcStat.isDirectory()) {
    console.error(`Path exists but is not a directory: ${srcDir}`);
    process.exit(1);
  }

  const rsFiles = await walk(srcDir);
  rsFiles.sort((a, b) => a.localeCompare(b));

  const lines = [];
  lines.push("# Rust Files Dump");
  lines.push("");
  lines.push(`Generated from \`src\` under \`${cwd}\``);
  lines.push("");

  if (rsFiles.length === 0) {
    lines.push("_No .rs files found._");
  } else {
    for (const filePath of rsFiles) {
      const rel = toPosixRelative(cwd, filePath);
      let content;

      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (err) {
        content = `/* Failed to read file: ${String(err?.message || err)} */`;
      }

      lines.push(`## ${rel}`);
      lines.push("");
      lines.push("```rs");
      lines.push(content);
      if (!content.endsWith("\n")) lines.push("");
      lines.push("```");
      lines.push("");
    }
  }

  await fs.writeFile(outputPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outputPath} (${rsFiles.length} .rs file${rsFiles.length === 1 ? "" : "s"})`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});