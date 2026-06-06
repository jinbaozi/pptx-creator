import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { runPython } from "./lib/python-utils.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function defaultRenderPreview(pptxPath, previewDir) {
  const reportPath = join(dirname(previewDir), "preview-render-report.json");
  try {
    await runPython([join(root, "scripts/render-preview.py"), pptxPath, previewDir, "-o", reportPath], { cwd: root });
  } catch (error) {
    if (error.code !== 2) {
      throw error;
    }
  }
  return JSON.parse(await readFile(reportPath, "utf8"));
}

async function defaultComparePreview(referencePath, candidatePath, outputPath) {
  await runPython([join(root, "scripts/compare-preview.py"), referencePath, candidatePath, "-o", outputPath], {
    cwd: root
  });
  return JSON.parse(await readFile(outputPath, "utf8"));
}

async function imageFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function comparisonStatus(comparisons) {
  if (comparisons.some((item) => item.verdict === "divergent")) {
    return "failed";
  }
  if (comparisons.some((item) => item.verdict === "moderate")) {
    return "review";
  }
  return "passed";
}

export async function runVisualRegression(manifestPath, outputDir, options = {}) {
  const resolvedManifest = resolve(manifestPath);
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });

  const steps = [];
  const pipeline = await runDeckPipeline(resolvedManifest, resolvedOutput);
  steps.push({ label: "pipeline", ok: pipeline.status === "passed" });

  const pptxPath = join(resolvedOutput, "final.pptx");
  const previewDir = join(resolvedOutput, "preview");
  const renderPreview = options.renderPreview ?? defaultRenderPreview;
  const preview = await renderPreview(pptxPath, previewDir);
  steps.push({ label: "render-preview", ok: preview.status !== "failed" });

  const report = {
    version: "0.1.0",
    manifest: resolvedManifest,
    outputDir: resolvedOutput,
    steps,
    preview,
    comparisons: [],
    status: "deferred",
    note: "Preview rendering was deferred; install LibreOffice to enable visual regression."
  };

  if (preview.status === "failed") {
    report.status = "failed";
    report.note = preview.note || "Preview rendering failed.";
  } else if (preview.status === "ok") {
    if (!options.referenceDir) {
      report.status = "baseline-needed";
      report.note = "Preview rendered. Provide --reference-dir to compare against a baseline.";
    } else {
      const references = await imageFiles(options.referenceDir);
      const candidates = preview.previews ?? [];
      const comparePreview = options.comparePreview ?? defaultComparePreview;
      const count = Math.min(references.length, candidates.length);
      for (let index = 0; index < count; index += 1) {
        const diffPath = join(resolvedOutput, `preview-diff-${String(index + 1).padStart(2, "0")}.json`);
        report.comparisons.push(await comparePreview(references[index], candidates[index], diffPath));
      }
      steps.push({ label: "compare-preview", ok: count > 0 && references.length === candidates.length });
      report.status = count === 0 || references.length !== candidates.length ? "review" : comparisonStatus(report.comparisons);
      report.note =
        report.status === "passed"
          ? "All preview comparisons are close."
          : "Visual regression needs host-agent review.";
    }
  }

  await writeFile(join(resolvedOutput, "visual-regression-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

function parseArgs(argv) {
  const args = [...argv];
  const manifest = args.shift();
  const outputDir = args.shift() ?? "output";
  const parsed = { manifest, outputDir, referenceDir: undefined };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--reference-dir") {
      parsed.referenceDir = args.shift();
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    fail("usage: run-visual-regression.mjs <deck.manifest.json> [output-dir] [--reference-dir dir]");
  }
  const report = await runVisualRegression(args.manifest, args.outputDir, {
    referenceDir: args.referenceDir ? resolve(args.referenceDir) : undefined
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") {
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] &&
  (import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href ||
    import.meta.url === new URL(`file:///${resolve(process.argv[1]).replace(/\\/g, "/")}`).href);

if (invokedDirectly) {
  main();
}
