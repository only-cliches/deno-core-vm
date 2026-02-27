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
    } else if (entry.isFile() && (entry.name.endsWith(".rs") || entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) {
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
  
  lines.push("# Rules ");
  lines.push("- The goal of this project is to build a Deno powered VM that runs from NodeJS.");
  lines.push("- Always return complete code snippets with context so I know where to put them.");
  lines.push("- If more than 50% of a file needs to be replaced, just provide the whole file. ");
  lines.push("- Unless otherwise stated: prioritize secure, modular, maintainable code. ");
  lines.push("- If you see the same issue/bug come up more than twice, try a different approach to the problem.");
  lines.push("- If there is an ambiguity in a request, ask clarifying questions before generating code. ");
  lines.push("- If you believe there is a better approach/solution than the one I suggest, let me know. ");
  lines.push("- Do not explain why something works unless I ask.");
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