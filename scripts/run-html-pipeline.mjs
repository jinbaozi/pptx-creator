import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeManifestFromHtml } from "./html-to-manifest.mjs";
import { repairHtmlLayout } from "./lib/html-layout-repair.mjs";
import { writeMeasurements } from "./measure-html.mjs";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { runPython } from "./lib/python-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { maxAttempts: 3 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-attempts") options.maxAttempts = Number(argv[++i]);
    else if (arg === "--design-system") options.designSystem = argv[++i];
    else positional.push(arg);
  }
  return { input: positional[0], outputDir: positional[1], options };
}

export async function runHtmlPipeline(inputPath, outputDir, options = {}) {
  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });

  const repair = await repairHtmlLayout(resolvedInput, resolvedOutput, {
    maxAttempts: options.maxAttempts ?? 3,
    screenshots: true
  });
  if (repair.report.summary.status !== "passed") {
    const blocked = {
      input: resolvedInput,
      outputDir: resolvedOutput,
      status: "blocked",
      blockedBy: "html-layout",
      htmlLayout: repair.layoutReport.summary
    };
    await writeFile(join(resolvedOutput, "pipeline-blocked.json"), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    const error = new Error(`HTML pipeline blocked: ${repair.report.summary.criticalRemaining} critical HTML layout issue(s) remain.`);
    error.summary = blocked;
    throw error;
  }

  const measurementsPath = join(resolvedOutput, "layout-measurements.json");
  const measurements = await writeMeasurements(repair.repairedPath, measurementsPath);
  const manifestPath = join(resolvedOutput, "deck.manifest.json");
  const converted = await writeManifestFromHtml(repair.repairedPath, manifestPath, {
    measurements,
    designSystem: options.designSystem,
    designMode: "balanced"
  });
  if (converted.contentCoverage?.ratio !== 1) {
    throw new Error(`HTML pipeline requires 100% content coverage; received ${converted.contentCoverage?.ratio ?? "unknown"}.`);
  }

  const deck = await runDeckPipeline(manifestPath, resolvedOutput, {
    inputType: "html",
    inputSource: resolvedInput,
    mode: "creative",
    strictLayoutSafety: true,
    copyManifest: false
  });
  const summary = {
    input: resolvedInput,
    repairedHtml: repair.repairedPath,
    measurements: measurementsPath,
    manifest: manifestPath,
    outputDir: resolvedOutput,
    status: deck.status,
    htmlLayout: repair.layoutReport.summary,
    contentCoverage: converted.contentCoverage
  };
  await writeFile(join(resolvedOutput, "html-pipeline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await runPython([join(root, "scripts/package-output.py"), resolvedOutput], { cwd: root });
  return summary;
}

async function main() {
  const { input, outputDir, options } = parseArgs(process.argv.slice(2));
  if (!input || !outputDir) {
    throw new Error("usage: run-html-pipeline.mjs <deck.html> <output-dir> [--max-attempts 3] [--design-system id]");
  }
  const summary = await runHtmlPipeline(input, outputDir, options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    if (error.summary) console.error(JSON.stringify(error.summary, null, 2));
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
