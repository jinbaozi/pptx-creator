import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeManifestFromHtml } from "./html-to-manifest.mjs";
import { fetchRemoteAssetSecure } from "./html-to-manifest.mjs";
import { writeMeasurements } from "./measure-html.mjs";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { writeHtmlLayoutReport } from "./run-html-layout-check.mjs";
import { withSettledHtmlPage } from "./lib/html-layout-audit.mjs";
import { renderAndMeasureHtmlReplica } from "./lib/html-replica-proof.mjs";

async function captureReplicaSourceAndFallbacks(inputPath, outputDir, measurements, manifest) {
  const evidenceDir = join(outputDir, "evidence");
  const sourceDir = join(evidenceDir, "source");
  const fallbackDir = join(evidenceDir, "fallback");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(fallbackDir, { recursive: true });
  const sourcePaths = [];
  const fallbackPlans = [];
  await withSettledHtmlPage(inputPath, {
    viewportWidth: measurements.viewport.width,
    viewportHeight: measurements.viewport.height,
    javaScriptEnabled: false,
    networkEnabled: false
  }, async (page) => {
    const slides = page.locator(".pptx-slide, [data-slide]");
    const count = await slides.count();
    for (let slideIndex = 0; slideIndex < Math.max(1, count); slideIndex += 1) {
      const sourcePath = join(sourceDir, `slide-${String(slideIndex + 1).padStart(3, "0")}.png`);
      if (count) await slides.nth(slideIndex).screenshot({ path: sourcePath });
      else await page.screenshot({ path: sourcePath, clip: { x: 0, y: 0, width: measurements.viewport.width, height: measurements.viewport.height } });
      sourcePaths.push(sourcePath);
    }
    for (const [slideIndex, slide] of (manifest.slides ?? []).entries()) {
      const effects = slide.replicaUnsupportedEffects ?? [];
      for (const [effectIndex, effect] of effects.entries()) {
        if (effect.elementId === "__slide-background") throw new Error("full-slide unsupported HTML effects cannot use a raster fallback");
        const measurement = measurements.elements.find((item) => item.slideIndex === slideIndex && item.id === effect.elementId);
        if (!measurement?.px || measurement.px.w >= measurements.viewport.width * 0.98 || measurement.px.h >= measurements.viewport.height * 0.98) {
          throw new Error(`unsupported effect ${effect.elementId} does not have a safe localized crop`);
        }
        const fileName = `fallback-${String(slideIndex + 1).padStart(3, "0")}-${String(effectIndex + 1).padStart(3, "0")}.png`;
        const cropPath = join(fallbackDir, fileName);
        const slideBox = count ? await slides.nth(slideIndex).boundingBox() : { x: 0, y: 0 };
        await page.screenshot({ path: cropPath, omitBackground: true, clip: {
          x: Math.max(0, slideBox.x + measurement.px.x), y: Math.max(0, slideBox.y + measurement.px.y),
          width: measurement.px.w, height: measurement.px.h
        } });
        const reason = [effect.filter && `filter:${effect.filter}`, effect.clipPath && `clip:${effect.clipPath}`, effect.backdropFilter && `backdrop-filter:${effect.backdropFilter}`, effect.backgroundImage && `background:${effect.backgroundImage}`, effect.unsupportedVisual].filter(Boolean).join("; ") || "unsupported-css-effect";
        fallbackPlans.push({ slideIndex, elementId: effect.elementId, src: `evidence/fallback/${fileName}`, box: { x: measurement.x, y: measurement.y, w: measurement.w, h: measurement.h }, reason, zOrder: Number(measurement.style?.zIndex ?? 0) });
      }
    }
  });
  return { sourcePaths, sourceDir, fallbackPlans };
}

function applyLocalizedFallbacks(manifest, measurements, fallbackPlans) {
  for (const plan of fallbackPlans) {
    const slide = manifest.slides[plan.slideIndex];
    const provenance = { kind: "raster", fullSlide: false, reason: plan.reason, bbox: { x: plan.box.x, y: plan.box.y, width: plan.box.w, height: plan.box.h }, zOrder: plan.zOrder, nativeAlternativesAttempted: ["native-shape", "native-gradient", "native-shadow"] };
    const elementIndex = Math.max(0, (slide.elements ?? []).findIndex((item) => item.id === plan.elementId));
    const retained = (slide.elements ?? []).filter((item) => item.id !== plan.elementId);
    retained.splice(Math.min(elementIndex, retained.length), 0, { type: "cropped-asset", id: `${plan.elementId}-localized-fallback`, src: plan.src, ...plan.box, replicaFallback: provenance });
    slide.elements = retained;
    slide.replicaFallbacks = [...(slide.replicaFallbacks ?? []), provenance];
    slide.replicaUnsupportedEffects = (slide.replicaUnsupportedEffects ?? []).filter((effect) => effect.elementId !== plan.elementId);
  }
  const slideArea = measurements.viewport.width * measurements.viewport.height;
  const rasterArea = fallbackPlans.reduce((sum, item) => sum + item.box.w / manifest.deck.size.width * measurements.viewport.width * item.box.h / manifest.deck.size.height * measurements.viewport.height, 0);
  const nativeCoverage = Math.max(0, Math.min(1, 1 - rasterArea / (slideArea * Math.max(1, manifest.slides.length))));
  const coverage = manifest.metadata.replicaSource.coverage;
  coverage.nativeCoverage = Number(nativeCoverage.toFixed(4));
  coverage.unsupportedEffects = (coverage.unsupportedEffects ?? []).filter((effect) => !fallbackPlans.some((plan) => plan.elementId === effect.elementId && plan.slideIndex === (coverage.slides ?? []).findIndex((slide) => slide.slideId === effect.slideId)));
  for (const [slideIndex, slide] of (coverage.slides ?? []).entries()) {
    slide.unsupportedEffects = (slide.unsupportedEffects ?? []).filter((effect) => !fallbackPlans.some((plan) => plan.slideIndex === slideIndex && plan.elementId === effect.elementId));
    const slideFallbackArea = fallbackPlans
      .filter((item) => item.slideIndex === slideIndex)
      .reduce((sum, item) => sum + item.box.w / manifest.deck.size.width * measurements.viewport.width * item.box.h / manifest.deck.size.height * measurements.viewport.height, 0);
    slide.nativeCoverage = Number(Math.max(0, Math.min(1, 1 - slideFallbackArea / slideArea)).toFixed(4));
  }
  return coverage;
}

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
  const runDirName = `.pptx-run-${randomUUID()}`;
  const runAssetsDir = join(assetsDir, runDirName);
  await mkdir(runAssetsDir);
  let localized = html;
  const plans = urls.map((url, index) => {
    const suffix = extname(new URL(url).pathname).toLowerCase();
    const extension = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(suffix) ? suffix : ".img";
    const fileName = `remote-source-${String(index + 1).padStart(3, "0")}${extension}`;
    return { url, fileName, relativePath: `assets/${runDirName}/${fileName}` };
  });
  const ownershipPath = join(resolve(outputDir), ".pptx-generated-assets.json");
  const ownershipTempPath = `${ownershipPath}.tmp`;
  try {
    await writeFile(ownershipTempPath, `${JSON.stringify({
      version: "0.1.0",
      files: [`assets/${runDirName}`],
      plannedFiles: plans.map((plan) => plan.relativePath)
    }, null, 2)}\n`, "utf8");
    await rename(ownershipTempPath, ownershipPath);
  } catch (error) {
    await rm(runAssetsDir, { force: true, recursive: true });
    throw error;
  }
  for (const plan of plans) {
    const data = await (options.fetchRemoteAsset ?? fetchRemoteAssetSecure)(plan.url, options.remoteAssetLimits);
    await writeFile(join(runAssetsDir, plan.fileName), data);
    localized = localized.split(plan.url).join(plan.relativePath);
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
  const mode = options.mode ?? "replica";
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
      preparation.measurements = await writeMeasurements(preparation.browserInput, preparation.measurementsPath, {
        replica: mode === "replica",
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
        slideWidth: options.slideWidth,
        slideHeight: options.slideHeight
      });
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
      if (mode === "replica" && preparation.measurements.elements.length === 0) {
        throw new Error("strict HTML replica produced no visible DOM measurements");
      }
      if (mode === "replica") {
        preparation.artifacts = await captureReplicaSourceAndFallbacks(preparation.browserInput, resolvedOutput, preparation.measurements, preparation.converted.manifest);
        preparation.converted.replicaCoverage = applyLocalizedFallbacks(preparation.converted.manifest, preparation.measurements, preparation.artifacts.fallbackPlans);
        await writeFile(manifestPath, `${JSON.stringify(preparation.converted.manifest, null, 2)}\n`, "utf8");
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
    buildReplicaProof: mode === "replica" ? async ({ manifest, coverage, intermediate, buildBaseEvidence }) => renderAndMeasureHtmlReplica({
      root: resolve(new URL("..", import.meta.url).pathname), outputDir: resolvedOutput,
      sourcePaths: preparation.artifacts.sourcePaths, sourceArtifactPath: preparation.artifacts.sourceDir, manifest, measurements: preparation.measurements,
      coverage, intermediate, buildBaseEvidence
    }) : undefined,
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
