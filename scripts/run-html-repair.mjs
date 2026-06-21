import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repairHtmlLayout } from "./lib/html-layout-repair.mjs";

function parseArgs(argv) {
  const options = { maxAttempts: 3, screenshots: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-attempts") options.maxAttempts = Number(argv[++i]);
    else if (arg === "--no-screenshots") options.screenshots = false;
    else positional.push(arg);
  }
  return { input: positional[0], outputDir: positional[1], options };
}

async function main() {
  const { input, outputDir, options } = parseArgs(process.argv.slice(2));
  if (!input || !outputDir) {
    throw new Error("usage: run-html-repair.mjs <deck.html> <output-dir> [--max-attempts 3] [--no-screenshots]");
  }
  const result = await repairHtmlLayout(input, outputDir, options);
  process.stdout.write(`${JSON.stringify({
    repairedHtml: result.repairedPath,
    repairReport: result.reportPath,
    summary: result.report.summary
  }, null, 2)}\n`);
  if (result.report.summary.status !== "passed") process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
