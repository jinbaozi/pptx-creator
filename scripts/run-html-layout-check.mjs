import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditHtmlFile } from "./lib/html-layout-audit.mjs";

function parseArgs(argv) {
  const options = { screenshots: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--viewport-width") options.viewportWidth = Number(argv[++i]);
    else if (arg === "--viewport-height") options.viewportHeight = Number(argv[++i]);
    else if (arg === "--no-screenshots") options.screenshots = false;
    else positional.push(arg);
  }
  return { input: positional[0], outputDir: positional[1], options };
}

export async function writeHtmlLayoutReport(inputPath, outputDir, options = {}) {
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
  const report = await auditHtmlFile(inputPath, { ...options, outputDir: resolvedOutput });
  const reportPath = join(resolvedOutput, "html-layout-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}

async function main() {
  const { input, outputDir, options } = parseArgs(process.argv.slice(2));
  if (!input || !outputDir) {
    throw new Error("usage: run-html-layout-check.mjs <deck.html> <output-dir> [--viewport-width 1280] [--viewport-height 720] [--no-screenshots]");
  }
  const { report, reportPath } = await writeHtmlLayoutReport(input, outputDir, options);
  process.stdout.write(`${JSON.stringify({ reportPath, summary: report.summary }, null, 2)}\n`);
  if (report.summary.criticalCount > 0) process.exitCode = 2;
}

const invokedDirectly = process.argv[1]
  && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
