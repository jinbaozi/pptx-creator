import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeManifestFromHtml } from "./html-to-manifest.mjs";
import { fetchRemoteAssetSecure } from "./html-to-manifest.mjs";
import { writeMeasurements } from "./measure-html.mjs";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { writeHtmlLayoutReport } from "./run-html-layout-check.mjs";

function parseArgs(argv) {
  const options = { maxAttempts: 3 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-attempts") options.maxAttempts = Number(argv[++i]);
    else if (arg === "--design-system") options.designSystem = argv[++i];
    else if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--allow-remote-assets") options.allowRemoteAssets = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (options.mode !== undefined && !["creative", "replica"].includes(options.mode)) {
    throw new Error("--mode must be creative or replica");
  }
  return { input: positional[0], outputDir: positional[1], options };
}

function remoteAssetUrls(html) {
  const urls = new Set();
  const collectAttributeUrls = (value) => {
    for (const match of String(value ?? "").matchAll(/https?:\/\/[^\s,]+/gi)) {
      urls.add(match[0]);
    }
  };
  for (const match of html.matchAll(/\b(?:src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    collectAttributeUrls(match[1] ?? match[2] ?? match[3]);
  }
  for (const tag of html.matchAll(/<image\b[^>]*>/gi)) {
    for (const match of tag[0].matchAll(/\b(?:href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      collectAttributeUrls(match[1] ?? match[2] ?? match[3]);
    }
  }
  for (const match of html.matchAll(/url\(\s*["']?(https?:\/\/[^)'"\s]+)["']?\s*\)/gi)) urls.add(match[1]);
  return [...urls];
}

export async function localizeHtmlRemoteAssets(inputPath, outputDir, options = {}) {
  const html = await readFile(inputPath, "utf8");
  const urls = remoteAssetUrls(html);
  if (urls.length === 0) return resolve(inputPath);
  if (options.allowRemoteAssets !== true) {
    throw new Error("remote assets are disabled; pass --allow-remote-assets");
  }
  const assetsDir = join(resolve(outputDir), "assets");
  await mkdir(assetsDir, { recursive: true });
  let localized = html;
  for (const [index, url] of urls.entries()) {
    const suffix = extname(new URL(url).pathname).toLowerCase();
    const extension = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(suffix) ? suffix : ".img";
    const fileName = `remote-source-${String(index + 1).padStart(3, "0")}${extension}`;
    const data = await (options.fetchRemoteAsset ?? fetchRemoteAssetSecure)(url, options.remoteAssetLimits);
    await writeFile(join(assetsDir, fileName), data);
    localized = localized.split(url).join(`assets/${fileName}`);
  }
  const localizedPath = join(resolve(outputDir), "deck.localized-input.html");
  await writeFile(localizedPath, localized, "utf8");
  return localizedPath;
}

export async function runHtmlPipeline(inputPath, outputDir, options = {}) {
  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
  const manifestPath = join(resolvedOutput, "deck.manifest.json");
  const mode = options.mode ?? "creative";
  const preparation = {};
  let summary = null;
  const deck = await runDeckPipeline(resolvedInput, resolvedOutput, {
    inputType: "html",
    inputSource: resolvedInput,
    mode,
    strictLayoutSafety: true,
    copyManifest: false,
    maxRepairAttempts: options.maxAttempts ?? 3,
    prepareManifest: async () => {
      preparation.browserInput = await localizeHtmlRemoteAssets(resolvedInput, resolvedOutput, options);
      preparation.measurementsPath = join(resolvedOutput, "layout-measurements.json");
      preparation.measurements = await writeMeasurements(preparation.browserInput, preparation.measurementsPath);
      preparation.converted = await writeManifestFromHtml(preparation.browserInput, manifestPath, {
        measurements: preparation.measurements,
        designSystem: options.designSystem,
        designMode: mode === "replica" ? "replica" : "balanced",
        replicaSourcePath: resolvedInput,
        allowRemoteAssets: false
      });
      if (preparation.converted.contentCoverage?.ratio !== 1) {
        throw new Error(`HTML pipeline requires 100% content coverage; received ${preparation.converted.contentCoverage?.ratio ?? "unknown"}.`);
      }
      return { manifestPath };
    },
    routePreflight: async () => {
      const { report } = await writeHtmlLayoutReport(preparation.browserInput, resolvedOutput, { screenshots: true });
      preparation.htmlLayout = report.summary;
      return {
        ok: report.summary.criticalCount === 0,
        stdout: `criticalCount=${report.summary.criticalCount}`,
        stderr: report.summary.criticalCount === 0 ? "" : `${report.summary.criticalCount} critical HTML layout issue(s)`
      };
    },
    beforePackage: async () => {
      summary = {
        input: resolvedInput,
        preparedHtml: preparation.browserInput,
        measurements: preparation.measurementsPath,
        manifest: manifestPath,
        outputDir: resolvedOutput,
        status: "packaging",
        mode,
        htmlLayout: preparation.htmlLayout,
        contentCoverage: preparation.converted.contentCoverage,
        replicaCoverage: preparation.converted.replicaCoverage
      };
      await writeFile(join(resolvedOutput, "html-pipeline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    }
  });
  summary = { ...summary, status: deck.status, contract: deck.contract, steps: deck.steps };
  await writeFile(join(resolvedOutput, "html-pipeline-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function main() {
  const { input, outputDir, options } = parseArgs(process.argv.slice(2));
  if (!input || !outputDir) {
    throw new Error("usage: run-html-pipeline.mjs <deck.html> <output-dir> [--mode creative|replica] [--max-attempts 3] [--design-system id]");
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
