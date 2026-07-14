#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { runBoundedRepair } from "./lib/bounded-repair.mjs";
import { buildConsistencyReport } from "./lib/consistency-report-writer.mjs";
import { applyContextualTaste, editabilityLevelFromCounter, qualityFromReview } from "./lib/contextual-taste.mjs";
import { buildCreativeRepairPatch, compareCreativeProof } from "./lib/creative-repair.mjs";
import { buildCreativeVisualProof, proofContentHash, summarizeCreativeRepair } from "./lib/creative-visual-proof.mjs";
import { compareRefinementProof, routeRefinementFindings } from "./lib/creative-refinement.mjs";
import { createFontMetricsCatalog, preflightFonts } from "./lib/font-preflight.mjs";
import { writePipelineReports } from "./lib/pipeline-report-writer.mjs";
import { runPython } from "./lib/python-utils.mjs";
import { applyRepairPatch } from "./lib/repair-patch.mjs";
import { verifyReplicaEvidence } from "./lib/replica-evidence.mjs";
import { validateJsonSchema } from "./lib/schema-utils.mjs";
import { reviewManifest } from "./lib/visual-critic.mjs";
import { buildTextFitReport } from "./lib/text-fit.mjs";
import {
  assertNoSymlinkBelowTrustedAnchor,
  verifiedRouteOwnedAssetPaths
} from "./lib/registry.mjs";
import { parseDesignFile } from "./parse-design-md.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_OUTPUTS = Object.freeze([
  "final.pptx",
  "output-manifest.json",
  "deck.manifest.json",
  "semantic-slide-ir.json",
  "assets/asset-registry.json",
  "creative-candidates.json",
  "creative-selection.json",
  "creative-direction-blind",
  "editable-report.md",
  "qa-report.md",
  "compatibility-report.md",
  "consistency-report.json",
  "consistency-report.md",
  "layout-safety-report.json",
  "text-fit-report.json",
  "html-layout-report.json",
  "html-repair-report.json",
  "quality-report.json",
  "quality-report.md",
  "creative-proof.json",
  "creative-proof",
  "host-visual-review.json",
  "refinement-plan.json",
  ".creative-refinement",
  ".creative-repair",
  "replica-evidence.json",
  "visual-regression-report.json",
  "visual-review.json",
  "html-pipeline-summary.json",
  "html-preview",
  "preview",
  "previews",
  "run.json",
  "pipeline-blocked.json"
]);
const CONSUMABLE_OUTPUTS = Object.freeze([
  "final.pptx",
  "output-manifest.json",
  "deck.manifest.json",
  "editable-report.md",
  "qa-report.md",
  "compatibility-report.md",
  "consistency-report.json",
  "consistency-report.md",
  "layout-safety-report.json",
  "text-fit-report.json",
  "html-layout-report.json",
  "html-repair-report.json",
  "layout-measurements.json",
  "inputHints.json",
  "image-hints.json",
  "deck.manifest.skeleton.json",
  "image-replica-analysis.json",
  "replica-layer-plan.json",
  "pdf-page-hints.json",
  "pdf-pages",
  "deck.localized-input.html",
  "deck.repaired.html",
  "html-preview",
  "preview",
  "previews",
  "design-system",
  "deck.plan.json",
  "semantic-slide-ir.json",
  "assets/asset-registry.json",
  "creative-candidates.json",
  "creative-selection.json",
  "creative-direction-blind",
  "quality-report.json",
  "quality-report.md",
  "creative-proof.json",
  "creative-proof",
  "host-visual-review.json",
  ".creative-repair",
  "replica-evidence.json",
  "visual-regression-report.json",
  "visual-review.json",
  "html-pipeline-summary.json",
  "run.json",
  ".pptx-generated-assets.json.tmp"
]);

export function escapePreviewHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function hasSymlinkAncestor(candidate, outputRoot) {
  const parent = dirname(candidate);
  const relativeParent = relative(outputRoot, parent);
  if (relativeParent === "" || relativeParent === ".") return false;
  if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`)) return true;
  let cursor = outputRoot;
  for (const segment of relativeParent.split(sep)) {
    cursor = resolve(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

async function removeOwnedPath(candidate, protectedSet, outputRoot) {
  if (await hasSymlinkAncestor(candidate, outputRoot)) return;
  if (protectedSet.has(candidate)) return;
  const prefix = `${candidate}${sep}`;
  const hasProtectedDescendant = [...protectedSet].some((path) => path.startsWith(prefix));
  if (!hasProtectedDescendant) {
    await rm(candidate, { force: true, recursive: true });
    return;
  }
  let entries;
  try { entries = await readdir(candidate, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map((entry) => removeOwnedPath(resolve(candidate, entry.name), protectedSet, outputRoot)));
}

export async function invalidatePublishedOutputs(outputDir, protectedPaths = []) {
  const outputRoot = resolve(outputDir);
  try { assertNoSymlinkBelowTrustedAnchor(outputRoot, { allowMissing: false }); } catch { return; }
  try {
    const rootEntry = await lstat(outputRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return;
  } catch { return; }
  const protectedSet = new Set(protectedPaths.map((candidate) => resolve(candidate)));
  let dynamicOutputs = [];
  try {
    dynamicOutputs = (await readdir(outputRoot))
      .filter((name) => /^preview-diff-.*\.json$/i.test(name))
      .map((name) => resolve(outputRoot, name));
  } catch {}
  const candidates = [
    ...PUBLISHED_OUTPUTS.map((name) => resolve(outputRoot, name)),
    ...dynamicOutputs
  ];
  await Promise.all([...new Set(candidates)].map((candidate) => removeOwnedPath(candidate, protectedSet, outputRoot)));
}

export async function clearConsumableOutputs(outputDir, protectedPaths = []) {
  const outputRoot = resolve(outputDir);
  try { assertNoSymlinkBelowTrustedAnchor(outputRoot, { allowMissing: false }); } catch { return; }
  try {
    const rootEntry = await lstat(outputRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return;
  } catch { return; }
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
  const ownershipPath = resolve(outputRoot, ".pptx-generated-assets.json");
  let ownedAssets = [];
  try {
    const registry = JSON.parse(await readFile(ownershipPath, "utf8"));
    ownedAssets = verifiedRouteOwnedAssetPaths(outputRoot, registry, [...protectedSet]);
  } catch {}
  let dynamicOutputs = [];
  try {
    dynamicOutputs = (await readdir(outputRoot))
      .filter((name) => /^preview-diff-.*\.json$/i.test(name))
      .map((name) => resolve(outputRoot, name));
  } catch {}
  const candidates = [
    ...CONSUMABLE_OUTPUTS.map((name) => resolve(outputRoot, name)),
    ...ownedAssets,
    ...dynamicOutputs,
    ownershipPath
  ];
  await Promise.all([...new Set(candidates)].map((candidate) => removeOwnedPath(candidate, protectedSet, outputRoot)));
}

async function assertRealPipelineOutputDirectory(outputDir) {
  const outputRoot = resolve(outputDir);
  assertNoSymlinkBelowTrustedAnchor(outputRoot, { allowMissing: true });
  await mkdir(outputRoot, { recursive: true });
  assertNoSymlinkBelowTrustedAnchor(outputRoot, { allowMissing: false });
  const entry = await lstat(outputRoot);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`pipeline output must be a real directory, not a symbolic link: ${outputRoot}`);
  }
  return outputRoot;
}

async function atomicWritePipelineArtifact(outputDir, targetPath, bytes) {
  const outputRoot = await assertRealPipelineOutputDirectory(outputDir);
  const target = resolve(targetPath);
  if (target === outputRoot || !target.startsWith(`${outputRoot}${sep}`)) {
    throw new Error(`pipeline artifact target escapes output directory: ${target}`);
  }
  const parent = dirname(target);
  assertNoSymlinkBelowTrustedAnchor(parent, { allowMissing: false });
  const stageDir = await mkdtemp(join(parent, `.pipeline-stage-${process.pid}-`));
  const stageFile = join(stageDir, "artifact");
  let renamed = false;
  try {
    assertNoSymlinkBelowTrustedAnchor(stageDir, { allowMissing: false });
    const handle = await open(
      stageFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    const stageEntry = await lstat(stageFile);
    if (!stageEntry.isFile() || stageEntry.isSymbolicLink()) {
      throw new Error(`pipeline stage artifact must be a real regular file: ${stageFile}`);
    }
    await assertRealPipelineOutputDirectory(outputRoot);
    assertNoSymlinkBelowTrustedAnchor(parent, { allowMissing: false });
    await rename(stageFile, target);
    renamed = true;
    await assertRealPipelineOutputDirectory(outputRoot);
    assertNoSymlinkBelowTrustedAnchor(parent, { allowMissing: false });
    const targetEntry = await lstat(target);
    if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
      throw new Error(`pipeline artifact target must be a real regular file: ${target}`);
    }
    await rmdir(stageDir);
  } catch (error) {
    if (renamed) {
      try {
        assertNoSymlinkBelowTrustedAnchor(parent, { allowMissing: false });
        const targetEntry = await lstat(target);
        if (targetEntry.isFile() || targetEntry.isSymbolicLink()) await unlink(target);
      } catch {}
    }
    await unlink(stageFile).catch(() => {});
    await rmdir(stageDir).catch(() => {});
    throw error;
  }
}

export function shouldCopyManifest(manifestPath, outputDir) {
  return resolve(manifestPath) !== resolve(outputDir, "deck.manifest.json");
}

export function normalizeRepairLimit(value = 3) {
  const numeric = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 3;
  return Math.max(0, Math.min(3, numeric));
}

export function hasCompleteReplicaProof(coverage) {
  if (!coverage || Number(coverage.coverage) !== 1) return false;
  if ((coverage.droppedElements?.length ?? 0) > 0 || (coverage.unsupportedEffects?.length ?? 0) > 0) return false;
  return (coverage.slides ?? []).every((slide) => Number(slide.coverage) === 1
    && (slide.droppedElements?.length ?? 0) === 0
    && (slide.unsupportedEffects?.length ?? 0) === 0);
}

export function hasCreativeEditabilityPrerequisites(manifest = {}) {
  const elements = (manifest.slides ?? []).flatMap((slide) => slide.elements ?? []);
  const hasText = elements.some((element) => element?.type === "text");
  const nativeVisualTypes = new Set(["shape", "table", "line", "icon", "chart", "diagram"]);
  return hasText && elements.some((element) => nativeVisualTypes.has(element?.type));
}

export function buildPipelinePlan({ route = "text", mode = "direct", proofAvailable = true } = {}) {
  if (mode === "replica") {
    if (!["html", "image", "pdf"].includes(route)) throw new Error(`replica mode is unsupported for route ${route}`);
    if (!proofAvailable) throw new Error(`strict replica fidelity proof is unavailable for route ${route}`);
    return ["validate", "replica-preflight", "render", "fidelity-proof", "bounded-repair", "package"];
  }
  if (route !== "text") throw new Error(`${route} requires replica mode`);
  if (mode === "creative") {
    return ["validate", "creative-layout-taste-preflight", "render", "creative-proof", "bounded-repair", "package"];
  }
  if (mode === "direct") {
    return ["validate", "light-preflight", "render", "editability-proof", "bounded-repair", "package"];
  }
  throw new Error(`unsupported route mode: ${mode}`);
}

export async function executePipelinePlan(plan, executeStep) {
  const results = [];
  for (const stage of plan) {
    const result = await executeStep(stage);
    results.push({ stage, ...result });
    if (!result?.ok) {
      const error = new Error(`pipeline failed at ${stage}`);
      error.stage = stage;
      error.results = results;
      throw error;
    }
  }
  return results;
}

function createStageGuard(plan) {
  let cursor = 0;
  return {
    enter(stage) {
      const expected = plan[cursor];
      if (stage !== expected) throw new Error(`pipeline contract violation: expected ${expected}, received ${stage}`);
      cursor += 1;
    },
    complete() {
      if (cursor !== plan.length) throw new Error(`pipeline contract incomplete: ${cursor}/${plan.length} stages`);
    }
  };
}

export async function proveReplicaFidelity(pptxPath, manifest, coverage, intermediate, route) {
  if (route !== "html") {
    return { status: "unavailable", route, capability: "openxml-structural-proof" };
  }
  if (!hasCompleteReplicaProof(coverage)) {
    return { status: "failed", route, capability: "openxml-structural-proof", reason: "incomplete-source-coverage" };
  }
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slideXml = await Promise.all(slideNames.map((name) => zip.files[name].async("string")));
  const counters = intermediate.countersBySlide ?? [intermediate.editabilityCounter ?? {}];
  const expectedSlides = manifest.slides?.length ?? 0;
  const perSlide = Array.from({ length: expectedSlides }, (_, slideIndex) => {
    const archiveObjectCount = (slideXml[slideIndex]?.match(/<p:(?:sp|pic|graphicFrame)\b/g) ?? []).length;
    const counter = counters[slideIndex] ?? {};
    const renderedNativeObjects = (counter.text ?? 0) + (counter.shape ?? 0) + (counter.image ?? 0) + (counter.table ?? 0);
    const rawCovered = coverage.slides?.[slideIndex]?.coveredElements ?? (expectedSlides === 1 ? coverage.coveredElements : undefined);
    const coveredElements = Number.isFinite(Number(rawCovered)) ? Number(rawCovered) : null;
    return { slideIndex, coveredElements, renderedNativeObjects, archiveObjectCount, ok: coveredElements !== null && archiveObjectCount >= coveredElements && renderedNativeObjects >= coveredElements };
  });
  const archiveObjectCount = perSlide.reduce((sum, slide) => sum + slide.archiveObjectCount, 0);
  const renderedNativeObjects = perSlide.reduce((sum, slide) => sum + slide.renderedNativeObjects, 0);
  const coveredElements = perSlide.reduce((sum, slide) => sum + (slide.coveredElements ?? 0), 0);
  const ok = slideNames.length === expectedSlides && perSlide.every((slide) => slide.ok);
  return {
    status: ok ? "passed" : "failed",
    route,
    capability: "openxml-structural-proof",
    expectedSlides,
    renderedSlides: slideNames.length,
    coveredElements,
    renderedNativeObjects,
    archiveObjectCount,
    perSlide
  };
}

function unavailableMetric(reason) {
  return { status: "unavailable", value: null, reason };
}

function unavailableFidelity(route) {
  const names = route === "html"
    ? ["ssim", "normalizedMae", "bboxP95Drift", "fontMapping", "colorMapping"]
    : ["ssim", "ocrCer", "bboxIou", "paletteDeltaE2000P95", "nativeHighConfidenceTextRecall"];
  return Object.fromEntries(names.map((name) => [name, unavailableMetric("source-render-comparison-not-implemented")]));
}

function coversSlide(bbox, size) {
  return Number(bbox?.x ?? 0) <= 0.01 && Number(bbox?.y ?? 0) <= 0.01
    && Number(bbox?.width ?? 0) >= Number(size.width) * 0.98
    && Number(bbox?.height ?? 0) >= Number(size.height) * 0.98;
}

function rasterFallback(item, { size, zOrder, reason, fullSlide } = {}) {
  const provenance = item?.replicaFallback ?? item?.fallbackProvenance ?? {};
  const bbox = provenance.bbox ?? {
    x: Number(item?.x ?? 0), y: Number(item?.y ?? 0),
    width: Number(item?.w ?? item?.width ?? size.width), height: Number(item?.h ?? item?.height ?? size.height)
  };
  return {
    kind: "raster",
    fullSlide: provenance.fullSlide === true || fullSlide === true || coversSlide(bbox, size),
    reason: provenance.reason ?? reason,
    bbox,
    zOrder: Number.isInteger(provenance.zOrder) ? provenance.zOrder : zOrder,
    nativeAlternativesAttempted: Array.isArray(provenance.nativeAlternativesAttempted) ? provenance.nativeAlternativesAttempted : []
  };
}

function inventorySlideFallbacks(slide, size, coverageSlide) {
  const explicit = slide.replicaFallbacks ?? coverageSlide?.fallbacks ?? [];
  const generated = [];
  if (slide.background?.type === "image" || slide.backgroundImage) {
    generated.push(rasterFallback({}, { size, zOrder: -1, reason: "raster-background-layer", fullSlide: true }));
  }
  for (const [zOrder, element] of (slide.elements ?? []).entries()) {
    if (element.type === "image" || element.type === "cropped-asset") {
      generated.push(rasterFallback(element, { size, zOrder, reason: element.type === "cropped-asset" ? "localized-raster-fallback" : "raster-image-layer" }));
    }
  }
  const seen = new Set();
  return [...explicit, ...generated].filter((item) => {
    const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true;
  });
}

export async function buildReplicaEvidence({ pptxPath, manifest, coverage, intermediate, route, sourcePath, renderPath, retryCount = 0 }) {
  const structuralProof = await proveReplicaFidelity(pptxPath, manifest, coverage, intermediate, route);
  const pageCount = manifest.slides?.length ?? 0;
  const nominalSize = { width: manifest.deck?.size?.width ?? 0, height: manifest.deck?.size?.height ?? 0 };
  const counters = intermediate.countersBySlide ?? [intermediate.editabilityCounter ?? {}];
  const nativeCoverage = Number.isFinite(Number(coverage?.coverage))
    ? { status: "available", value: Number(coverage.nativeCoverage ?? coverage.coverage) }
    : unavailableMetric("native-coverage-not-measured");
  const fidelity = unavailableFidelity(route);
  let fallbackInventory = true;
  const perSlide = Array.from({ length: pageCount }, (_, slideIndex) => {
    const slide = manifest.slides?.[slideIndex] ?? {};
    const explicit = slide.replicaFallbacks ?? coverage?.slides?.[slideIndex]?.fallbacks;
    const unsupported = slide.replicaUnsupportedEffects ?? coverage?.slides?.[slideIndex]?.unsupportedEffects ?? [];
    if (explicit === undefined && unsupported.length > 0) fallbackInventory = false;
    return {
      slideIndex,
      fidelity: structuredClone(fidelity),
      nativeCoverage: coverage?.slides?.[slideIndex]?.coverage === undefined ? structuredClone(nativeCoverage) : { status: "available", value: Number(coverage.slides[slideIndex].nativeCoverage ?? coverage.slides[slideIndex].coverage) },
      editability: { level: editabilityLevelFromCounter(counters[slideIndex] ?? {}) },
      fallbacks: inventorySlideFallbacks(slide, nominalSize, coverage?.slides?.[slideIndex])
    };
  });
  const aggregateFallbacks = perSlide.flatMap((slide) => slide.fallbacks);
  const aggregateLevel = Math.min(...perSlide.map((slide) => slide.editability.level));
  return verifyReplicaEvidence({
    version: "0.1.0", mode: "replica", route,
    paths: {
      source: sourcePath ? { status: "available", path: String(sourcePath) } : { status: "unavailable", path: null, reason: "source-path-missing" },
      render: renderPath ? { status: "available", path: String(renderPath) } : { status: "unavailable", path: null, reason: "render-artifact-not-generated" }
    },
    capabilities: {
      sourceRenderComparison: false,
      nativeObjectInspection: structuralProof.status !== "unavailable",
      fallbackInventory
    },
    thresholds: {},
    retry: retryCount > 0
      ? { status: "available", attempts: Array.from({ length: retryCount }, (_, index) => ({ iteration: index + 1, outcome: "measured" })) }
      : { status: "unavailable", attempts: [], reason: "no-repair-needed-for-initial-proof" },
    accepted: true,
    source: { pageCount, size: nominalSize },
    render: { pageCount: structuralProof.renderedSlides ?? pageCount, size: nominalSize },
    perSlide,
    aggregate: { fidelity, nativeCoverage, editability: { level: aggregateLevel }, fallbacks: aggregateFallbacks },
    blockingFindings: structuralProof.status === "passed" ? [] : [`structural-proof-${structuralProof.status}`]
  });
}

async function runStep(label, command, args) {
  try {
    const result = await execFileAsync(command, args, { cwd: root });
    return { label, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      label,
      ok: false,
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? error.message
    };
  }
}

async function runPythonStep(label, args) {
  try {
    const result = await runPython(args, { cwd: root });
    return { label, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      label,
      ok: false,
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? error.message
    };
  }
}

async function defaultRenderCreativeArtifact({ root: repoRoot = root, manifestPath, pptxPath, manifest }) {
  const rendered = await runStep("render", process.execPath, [
    join(repoRoot, "scripts/render-pptx.mjs"), manifestPath, pptxPath
  ]);
  if (!rendered.ok) throw new Error(rendered.stderr || rendered.stdout || "creative renderer failed");
  let intermediate;
  try { intermediate = JSON.parse(rendered.stdout).intermediate; } catch {}
  if (!intermediate) throw new Error("renderer did not emit intermediate facts");
  return { manifest, manifestPath, pptxPath, intermediate, stdout: rendered.stdout, stderr: rendered.stderr };
}

function renderedArtifact(result, fallback) {
  const value = result?.artifact ?? result ?? {};
  return {
    ...fallback,
    ...value,
    manifest: value.manifest ?? fallback.manifest,
    manifestPath: value.manifestPath ?? fallback.manifestPath,
    pptxPath: value.pptxPath ?? fallback.pptxPath,
    intermediate: value.intermediate ?? result?.intermediate ?? fallback.intermediate
  };
}

async function buildCreativeTextFit(manifest, manifestPath, design) {
  const activeDesign = design ?? await parseDesignFile(resolve(dirname(manifestPath), manifest.designSystem.source));
  const fontCatalog = await createFontMetricsCatalog();
  const textFit = await buildTextFitReport(manifest, {
    designTokens: activeDesign.tokens,
    fontCatalog,
    ...(fontCatalog.source === "unavailable"
      ? { source: "unavailable", reason: "fontkit could not open any installed font faces" }
      : {})
  });
  const schema = JSON.parse(await readFile(join(root, "schemas/text-fit-report.schema.json"), "utf8"));
  const validation = validateJsonSchema(textFit, schema);
  if (!validation.valid) {
    throw new Error(`text-fit report contract invalid: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }
  return { design: activeDesign, textFit };
}

async function reviewCreativeArtifact(manifest, planIntent, reviewer) {
  const rawReview = typeof reviewer === "function"
    ? await reviewer(manifest, { mode: "creative", planIntent })
    : reviewManifest(manifest, { mode: "creative" });
  return applyContextualTaste(rawReview, manifest, planIntent);
}

async function validateCreativeProofContract(proof) {
  const schema = JSON.parse(await readFile(join(root, "schemas/creative-proof.schema.json"), "utf8"));
  const validation = validateJsonSchema(proof, schema);
  if (!validation.valid) {
    throw new Error(`creative proof contract invalid: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }
}

async function assessCreativeArtifact({
  artifact,
  repoRoot = root,
  outputDir,
  evidenceDir,
  planIntent,
  fontPreflight,
  buildCreativeProof,
  reviewCreativeManifest,
  design: suppliedDesign,
  textFit: suppliedTextFit,
  proofContext = {},
  hostFinalReview = null,
  layoutSafety = true,
  writeAttemptEvidence = false
}) {
  const manifest = artifact.manifest ?? JSON.parse(await readFile(artifact.manifestPath, "utf8"));
  const textFitResult = suppliedTextFit
    ? { design: suppliedDesign ?? await parseDesignFile(resolve(dirname(artifact.manifestPath), manifest.designSystem.source)), textFit: suppliedTextFit }
    : await buildCreativeTextFit(manifest, artifact.manifestPath, suppliedDesign);
  const review = await reviewCreativeArtifact(manifest, planIntent, reviewCreativeManifest);
  const quality = qualityFromReview(review, editabilityLevelFromCounter(artifact.intermediate?.editabilityCounter), fontPreflight);
  const repair = summarizeCreativeRepair({ attempts: 0, stopReason: "not-run", history: [] });
  const proofBuilder = typeof buildCreativeProof === "function" ? buildCreativeProof : buildCreativeVisualProof;
  const proof = await proofBuilder({
    root: repoRoot,
    pptxPath: artifact.pptxPath,
    outputDir,
    evidenceDir,
    manifest,
    review,
    textFit: textFitResult.textFit,
    quality,
    repair,
    intermediate: artifact.intermediate,
    proofContext: { ...proofContext, design: proofContext.design ?? textFitResult.design, layoutSafety },
    hostFinalReview
  });
  await validateCreativeProofContract(proof);
  if (writeAttemptEvidence) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "text-fit-report.json"), `${JSON.stringify(textFitResult.textFit, null, 2)}\n`, "utf8");
    await writeFile(join(evidenceDir, "visual-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
    await writeFile(join(evidenceDir, "quality-report.json"), `${JSON.stringify(quality, null, 2)}\n`, "utf8");
    await writeFile(join(evidenceDir, "creative-proof.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }
  return {
    ...artifact,
    manifest,
    design: textFitResult.design,
    fontPreflight,
    textFit: textFitResult.textFit,
    review,
    quality,
    proof,
    evidenceDir
  };
}

async function materializeCreativeCandidate({
  iteration,
  manifest,
  sourceManifestPath,
  publicManifestPath,
  repoRoot = root,
  outputDir,
  planIntent,
  buildCreativeProof,
  reviewCreativeManifest,
  renderCreativeArtifact,
  proofContext,
  hostFinalReview,
  layoutSafety
}) {
  const attemptDir = join(outputDir, ".creative-repair", `attempt-${iteration}`);
  const evidenceDir = join(outputDir, "creative-proof", "attempts", String(iteration));
  await rm(attemptDir, { recursive: true, force: true });
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(attemptDir, { recursive: true });
  const manifestPath = join(attemptDir, "deck.manifest.json");
  const renderManifestPath = join(attemptDir, "render.manifest.json");
  const pptxPath = join(attemptDir, "final.pptx");
  try {
    const suppliedManifest = manifest ?? JSON.parse(await readFile(sourceManifestPath, "utf8"));
    const sourceBase = dirname(resolve(sourceManifestPath ?? publicManifestPath ?? manifestPath));
    const candidate = structuredClone(suppliedManifest);
    const absoluteLocalPath = (value) => typeof value === "string" && value.length > 0 && !/^https?:\/\//i.test(value)
      ? resolve(sourceBase, value)
      : value;
    if (candidate.designSystem && typeof candidate.designSystem === "object") {
      candidate.designSystem.source = absoluteLocalPath(candidate.designSystem.source);
    }
    for (const asset of Array.isArray(candidate.assets) ? candidate.assets : []) {
      if (asset && typeof asset === "object") asset.src = absoluteLocalPath(asset.src);
    }
    for (const slide of Array.isArray(candidate.slides) ? candidate.slides : []) {
      if (!slide || typeof slide !== "object") continue;
      if (slide.background?.type === "image") slide.background.src = absoluteLocalPath(slide.background.src);
      for (const element of Array.isArray(slide.elements) ? slide.elements : []) {
        if (!element || typeof element !== "object") continue;
        if (["image", "cropped-asset"].includes(element.type) && element.src) {
          element.src = absoluteLocalPath(element.src);
        }
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    try {
      await runPython([join(repoRoot, "scripts/validate-manifest.py"), manifestPath], { cwd: repoRoot });
    } catch (error) {
      const detail = error.stderr?.toString?.().trim()
        || error.stdout?.toString?.().trim()
        || (error instanceof Error ? error.message : String(error));
      throw new Error(`candidate manifest invalid: ${detail}`);
    }

    const design = await parseDesignFile(candidate.designSystem.source);
    const candidateFontPreflight = await preflightFonts(candidate, design);
    const { textFit: candidateTextFit } = await buildCreativeTextFit(candidate, manifestPath, design);
    await writeFile(renderManifestPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    const renderer = typeof renderCreativeArtifact === "function" ? renderCreativeArtifact : defaultRenderCreativeArtifact;
    const renderedResult = renderedArtifact(await renderer({
      root: repoRoot,
      iteration,
      outputDir: attemptDir,
      manifest: candidate,
      manifestPath: renderManifestPath,
      pptxPath
    }), { manifest: candidate, manifestPath: renderManifestPath, pptxPath });
    const rendered = {
      ...renderedResult,
      manifest: candidate,
      manifestPath,
      publicManifestPath: publicManifestPath ?? sourceManifestPath,
      pptxPath: renderedResult.pptxPath ?? pptxPath
    };
    if (!rendered.intermediate) throw new Error("creative repair renderer did not emit intermediate facts");
    return assessCreativeArtifact({
      artifact: rendered,
      repoRoot,
      outputDir,
      evidenceDir,
      planIntent,
      fontPreflight: candidateFontPreflight,
      buildCreativeProof,
      reviewCreativeManifest,
      design,
      textFit: candidateTextFit,
      proofContext,
      hostFinalReview,
      layoutSafety,
      writeAttemptEvidence: true
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeFile(join(attemptDir, "materialization-failure.json"), `${JSON.stringify({ iteration, reason }, null, 2)}\n`, "utf8");
    throw error;
  }
}

export async function runCreativeRepairAttempt({
  iteration,
  artifact,
  root: repoRoot = root,
  outputDir,
  publicManifestPath,
  planIntent,
  buildCreativeProof,
  reviewCreativeManifest,
  renderCreativeArtifact,
  proofContext,
  hostFinalReview,
  layoutSafety
}) {
  const manifest = artifact?.manifest ?? (artifact?.manifestPath
    ? JSON.parse(await readFile(artifact.manifestPath, "utf8"))
    : null);
  const repairPatch = buildCreativeRepairPatch(artifact?.review, iteration, manifest);
  if (!manifest || repairPatch.patches.length === 0) return { proof: null, artifact: null };
  try {
    const candidate = await materializeCreativeCandidate({
      iteration,
      manifest: applyRepairPatch(manifest, repairPatch),
      sourceManifestPath: artifact?.publicManifestPath ?? artifact?.manifestPath,
      publicManifestPath: publicManifestPath ?? artifact?.publicManifestPath ?? artifact?.manifestPath,
      repoRoot,
      outputDir,
      planIntent,
      buildCreativeProof,
      reviewCreativeManifest,
      renderCreativeArtifact,
      proofContext,
      hostFinalReview,
      layoutSafety
    });
    return { proof: candidate.proof, artifact: candidate };
  } catch {
    return { proof: null, artifact: null };
  }
}

async function runCallbackCreativeRepairAttempt({
  callback,
  iteration,
  proof,
  artifact,
  outputDir,
  route,
  publicManifestPath,
  planIntent,
  buildCreativeProof,
  reviewCreativeManifest,
  renderCreativeArtifact,
  proofContext,
  hostFinalReview,
  layoutSafety
}) {
  const supplied = await callback({ iteration, proof, artifact, manifest: artifact?.manifest, outputDir, route, mode: "creative" });
  const candidateArtifact = supplied?.artifact ?? supplied;
  const candidateManifest = candidateArtifact?.manifest ?? null;
  const candidateManifestPath = candidateArtifact?.manifestPath ?? null;
  if (!candidateManifest && !candidateManifestPath) return { proof: null, artifact: null };
  try {
    const candidate = await materializeCreativeCandidate({
      iteration,
      manifest: candidateManifest,
      sourceManifestPath: candidateManifestPath ?? artifact?.publicManifestPath ?? artifact?.manifestPath,
      publicManifestPath: publicManifestPath ?? artifact?.publicManifestPath ?? artifact?.manifestPath,
      outputDir,
      planIntent,
      buildCreativeProof,
      reviewCreativeManifest,
      renderCreativeArtifact,
      proofContext,
      hostFinalReview,
      layoutSafety
    });
    return { proof: candidate.proof, artifact: candidate };
  } catch {
    return { proof: null, artifact: null };
  }
}

function normalizeInputType(value, manifest) {
  if (["html", "image", "pdf", "text", "manifest", "mixed", "design-first"].includes(value)) return value;
  if (["html", "image", "pdf", "text", "manifest", "mixed"].includes(manifest?.metadata?.inputType)) {
    return manifest.metadata.inputType;
  }
  return "text";
}

function deterministicCreativeProofPassed(proof) {
  if (!proof || proof.version !== "0.2.0") return false;
  const deterministicGates = (proof.hardGates ?? []).filter((gate) => gate.required && gate.id !== "final-host-review");
  const deterministicSevere = (proof.findings ?? []).some((finding) =>
    ["P0", "P1"].includes(finding?.severity) && finding?.source !== "host-visual-review"
  );
  return deterministicGates.length > 0
    && deterministicGates.every((gate) => gate.status === "passed")
    && !deterministicSevere;
}

function isDirectionProbeProof(proof) {
  return proof?.identity?.purpose === "direction-probe";
}

async function blockForHostFinalReview({ resolvedManifest, resolvedOutput, steps, proof, detail }) {
  await validateCreativeProofContract(proof);
  await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  await rm(join(resolvedOutput, "final.pptx"), { force: true });
  await rm(join(resolvedOutput, "run.json"), { force: true });
  await rm(join(resolvedOutput, "output-manifest.json"), { force: true });
  await blockPipeline(resolvedManifest, resolvedOutput, steps, "host-final-visual-review", detail);
}

async function blockForRefinement({ resolvedManifest, resolvedOutput, steps, proof, manifest, proofContext }) {
  const sourceHash = proofContentHash(proof);
  const plan = routeRefinementFindings(proof, {
    sourceProofPath: "creative-proof.json",
    attemptBudget: { used: proofContext?.refinementState?.plan?.attemptBudget?.used ?? proof.repair?.attempts ?? 0, max: 3 },
    brandLocked: proofContext?.ir?.designIntent?.locks?.brandLocked === true,
    sourceLocked: proofContext?.ir?.designIntent?.locks?.sourceLocked === true,
    signatureMoment: proofContext?.refinementState?.plan?.signatureMoment ?? null,
    ir: proofContext?.ir,
    manifest
  });
  const planSchema = JSON.parse(await readFile(join(root, "schemas/refinement-plan.schema.json"), "utf8"));
  const planContract = validateJsonSchema(plan, planSchema);
  if (!planContract.valid) throw new Error(`refinement plan contract invalid: ${planContract.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  const nextProof = {
    ...proof,
    refinement: {
      status: plan.operations.length ? "planned" : "failed",
      plan,
      history: proofContext?.refinementState?.history ?? [],
      finalIdentity: null
    }
  };
  await validateCreativeProofContract(nextProof);
  await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(nextProof, null, 2)}\n`, "utf8");
  await writeFile(join(resolvedOutput, "refinement-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const bestDir = join(resolvedOutput, ".creative-refinement");
  await mkdir(bestDir, { recursive: true });
  await writeFile(join(bestDir, "best-proof.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  await rm(join(resolvedOutput, "final.pptx"), { force: true });
  await rm(join(resolvedOutput, "run.json"), { force: true });
  await rm(join(resolvedOutput, "output-manifest.json"), { force: true });
  const blockedBy = plan.operations.length ? "awaiting-refinement-approval" : "creative-refinement";
  const detail = plan.operations.length
    ? `dry-run refinement plan ${plan.planId} is ready and bound to ${sourceHash}; approve exactly one operation in a protected --refinement-state sidecar`
    : "Host rejection contains no supported evidence-bound refinement operation";
  await blockPipeline(resolvedManifest, resolvedOutput, steps, blockedBy, detail);
}

async function blockPipeline(resolvedManifest, resolvedOutput, steps, blockedBy, detail = null) {
  const summary = {
    manifest: resolvedManifest,
    outputDir: resolvedOutput,
    steps: steps.map(({ label, ok, attempts, maxAttempts, stopReason }) => ({ label, ok, ...(attempts!==undefined?{attempts,maxAttempts,stopReason}: {}) })),
    status: "blocked",
    blockedBy,
    ...(detail ? { detail } : {})
  };
  await atomicWritePipelineArtifact(
    resolvedOutput,
    join(resolvedOutput, "pipeline-blocked.json"),
    Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8")
  );
  const error = new Error(`pipeline blocked at ${blockedBy}${detail ? `: ${detail}` : ""}`);
  error.summary = summary;
  if (["host-final-visual-review", "awaiting-refinement-approval", "creative-refinement"].includes(blockedBy)) error.preserveLocalizedAssets = true;
  throw error;
}

async function rollbackBeforePackage(options, context) {
  if (typeof options.beforePackageRollback !== "function") return;
  try {
    await options.beforePackageRollback(context);
  } catch {}
}

export async function publishRepairArtifact(items) {
  const token = randomUUID();
  const entries = items
    .filter((item) => item?.source && item?.target && resolve(item.source) !== resolve(item.target))
    .map((item) => ({
      ...item,
      stage: `${item.target}.repair-stage-${token}`,
      backup: `${item.target}.repair-backup-${token}`,
      backed: false,
      published: false
    }));
  if (!entries.length) return;

  try {
    for (const entry of entries) {
      const sourceStat = await stat(entry.source);
      await mkdir(dirname(entry.stage), { recursive: true });
      if (sourceStat.isDirectory()) await cp(entry.source, entry.stage, { recursive: true });
      else await copyFile(entry.source, entry.stage);
    }
  } catch (error) {
    await Promise.all(entries.map((entry) => rm(entry.stage, { force: true, recursive: true })));
    throw error;
  }

  try {
    for (const entry of entries) {
      try {
        await rename(entry.target, entry.backup);
        entry.backed = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const entry of entries) {
      await rename(entry.stage, entry.target);
      entry.published = true;
    }
  } catch (error) {
    for (const entry of [...entries].reverse()) {
      if (entry.published) await rm(entry.target, { force: true, recursive: true });
      if (entry.backed) await rename(entry.backup, entry.target).catch(() => {});
      await rm(entry.stage, { force: true, recursive: true });
    }
    throw error;
  }

  await Promise.all(entries.map((entry) => rm(entry.backup, { force: true, recursive: true }).catch(() => {})));
}

export async function runDeckPipeline(manifestPath, outputDir, options = {}) {
  const resolvedInput = resolve(manifestPath);
  let resolvedManifest = resolvedInput;
  const resolvedOutput = await assertRealPipelineOutputDirectory(outputDir);
  await clearConsumableOutputs(resolvedOutput, [resolvedInput, ...(options.protectedInputs ?? [])]);
  await rm(join(resolvedOutput, "pipeline-blocked.json"), { force: true });

  let manifest = null;
  let routeHint = null;
  if (typeof options.prepareManifest !== "function") {
    try { routeHint = JSON.parse(await readFile(resolvedInput, "utf8")); } catch {}
  }
  const inputType = normalizeInputType(options.inputType, routeHint);
  const route = ["html", "image", "pdf"].includes(inputType) ? inputType : "text";
  const mode = options.mode ?? routeHint?.metadata?.mode ?? (route === "text" ? "direct" : "replica");
  let inputSource = options.inputSource ?? resolvedInput;
  const steps = [];
  const contract = buildPipelinePlan({ route, mode, proofAvailable: true });
  const stageGuard = createStageGuard(contract);

  stageGuard.enter("validate");
  try {
    if (typeof options.prepareManifest === "function") {
      const prepared = await options.prepareManifest({ inputPath: resolvedInput, outputDir: resolvedOutput });
      resolvedManifest = resolve(prepared?.manifestPath ?? prepared);
    }
    manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
    inputSource = options.inputSource ?? manifest.metadata?.replicaSource?.path ?? resolvedInput;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push({ label: "validate", ok: false, stderr: detail });
    await blockPipeline(resolvedInput, resolvedOutput, steps, "validate", detail);
  }
  const validation = await runPythonStep("validate", [join(root, "scripts/validate-manifest.py"), resolvedManifest]);
  steps.push(validation);
  if (!validation.ok) await blockPipeline(resolvedManifest, resolvedOutput, steps, "validate", validation.stderr || validation.stdout);

  let design;
  let fontPreflight;
  let textFitReport;
  try {
    design = await parseDesignFile(resolve(dirname(resolvedManifest), manifest.designSystem.source));
    fontPreflight = await preflightFonts(manifest, design);
    const fontCatalog = await createFontMetricsCatalog();
    textFitReport = await buildTextFitReport(manifest, {
      designTokens: design.tokens,
      fontCatalog,
      ...(fontCatalog.source === "unavailable"
        ? { source: "unavailable", reason: "fontkit could not open any installed font faces" }
        : {})
    });
    const textFitSchema = JSON.parse(await readFile(join(root, "schemas/text-fit-report.schema.json"), "utf8"));
    const textFitValidation = validateJsonSchema(textFitReport, textFitSchema);
    if (!textFitValidation.valid) {
      throw new Error(`text-fit report contract invalid: ${textFitValidation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
    }
    await writeFile(join(resolvedOutput, "text-fit-report.json"), `${JSON.stringify(textFitReport, null, 2)}\n`, "utf8");
  } catch (error) {
    steps.push({ label: `${mode}-preflight`, ok: false });
    await blockPipeline(resolvedManifest, resolvedOutput, steps, `${mode}-preflight`, error instanceof Error ? error.message : String(error));
  }

  const layoutSafetyPath = join(resolvedOutput, "layout-safety-report.json");
  const layoutFlags = ["--output", layoutSafetyPath];
  if (mode !== "direct" && options.allowLayoutViolation !== true) layoutFlags.push("--strict-layout-safety");
  if (options.allowLayoutViolation === true) layoutFlags.push("--allow-layout-violation");
  if (mode === "replica") layoutFlags.push("--replica-mode");
  const layout = await runStep("layout-safety", process.execPath, [
    join(root, "scripts/run-layout-safety-check.mjs"), resolvedManifest, ...layoutFlags
  ]);

  const coverage = manifest.metadata?.replicaSource?.coverage;
  const replicaProofAvailable = hasCompleteReplicaProof(coverage);
  const planIntent = manifest.metadata?.designIntent?.source === "deck.plan" ? {
    designRead: manifest.metadata.designIntent.read,
    dials: manifest.metadata.designIntent.dials,
    intentOverride: manifest.metadata.designIntent.intentOverride
  } : { designRead: "Creative manifest", dials: { compositionVariance: 50, visualDensity: 50, visualEnergy: 50 } };
  let creativeReview = null;
  let creativeQuality = null;
  let creativeVisualProof = null;
  let repairAttempts = 0;
  let routePreflight = { ok: true, stdout: "" };
  if (typeof options.routePreflight === "function") {
    try {
      routePreflight = await options.routePreflight({
        inputPath: resolvedInput,
        manifestPath: resolvedManifest,
        manifest,
        outputDir: resolvedOutput
      });
    } catch (error) {
      routePreflight = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
    }
  }
  const preflightLabel = mode === "creative"
    ? "creative-layout-taste-preflight"
    : mode === "replica" ? "replica-preflight" : "light-preflight";
  const creativeEditabilityReady = mode !== "creative" || hasCreativeEditabilityPrerequisites(manifest);
  const preflight = {
    label: preflightLabel,
    ok: routePreflight.ok !== false
      && layout.ok
      && (mode !== "creative" || textFitReport?.status === "passed")
      && (mode !== "creative" || fontPreflight?.source !== "unavailable" || Object.keys(fontPreflight?.availability ?? {}).length === 0)
      && creativeEditabilityReady
      && (mode !== "replica" || replicaProofAvailable || typeof options.buildReplicaProof === "function"),
    stdout: mode === "creative" ? `textFit=${textFitReport?.status ?? "unavailable"}; fonts=${fontPreflight?.source ?? "unavailable"}` : (routePreflight.stdout || fontPreflight.source),
    stderr: routePreflight.ok === false
      ? routePreflight.stderr
      : !layout.ok ? layout.stderr
        : mode === "creative" && textFitReport?.status !== "passed" ? `text fit ${textFitReport?.status ?? "unavailable"}: ${textFitReport?.summary?.overflowCount ?? 0} overflow(s)`
          : mode === "creative" && fontPreflight?.source === "unavailable" && Object.keys(fontPreflight?.availability ?? {}).length > 0 ? "font preflight capability unavailable"
            : mode === "creative" && !creativeEditabilityReady ? "creative editability prerequisites require native text and native visual objects"
          : (mode === "replica" && !replicaProofAvailable && typeof options.buildReplicaProof !== "function" ? "strict replica fidelity proof capability unavailable" : "")
  };
  stageGuard.enter(preflightLabel);
  steps.push(preflight);
  if (!preflight.ok) await blockPipeline(resolvedManifest, resolvedOutput, steps, preflightLabel, preflight.stderr || preflight.stdout);

  stageGuard.enter("render");
  const finalPptxPath = join(resolvedOutput, "final.pptx");
  let render;
  let intermediate;
  if (mode === "creative") {
    try {
      const renderer = typeof options.renderCreativeArtifact === "function"
        ? options.renderCreativeArtifact
        : defaultRenderCreativeArtifact;
      const rendered = renderedArtifact(await renderer({
        root,
        iteration: 0,
        outputDir: resolvedOutput,
        manifest,
        manifestPath: resolvedManifest,
        pptxPath: finalPptxPath
      }), { manifest, manifestPath: resolvedManifest, pptxPath: finalPptxPath });
      intermediate = rendered.intermediate;
      render = { label: "render", ok: Boolean(intermediate), stdout: rendered.stdout ?? "creative renderer completed", stderr: rendered.stderr ?? "" };
    } catch (error) {
      render = { label: "render", ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  } else {
    render = await runStep("render", process.execPath, [
      join(root, "scripts/render-pptx.mjs"), resolvedManifest, finalPptxPath
    ]);
    if (render.ok) {
      try { intermediate = JSON.parse(render.stdout).intermediate; } catch {}
    }
  }
  steps.push(render);
  if (!render.ok) await blockPipeline(resolvedManifest, resolvedOutput, steps, "render", render.stderr || render.stdout);
  if (!intermediate) {
    steps.push({ label: "render-contract", ok: false });
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "render-contract", "renderer did not emit intermediate facts");
  }
  intermediate.fontNames = (fontPreflight.fallback ?? []).map((entry) => ({ element: "design-tokens", ...entry }));
  intermediate.fontFallback = fontPreflight.fallback ?? [];
  intermediate.preview = { status: "unavailable", reason: "preview-diff-capability-not-selected" };

  const proofLabel = mode === "creative" ? "creative-proof" : mode === "replica" ? "fidelity-proof" : "editability-proof";
  stageGuard.enter(proofLabel);
  let initialCreativeArtifact = null;
  if (mode === "creative") {
    initialCreativeArtifact = await assessCreativeArtifact({
      artifact: { manifest, manifestPath: resolvedManifest, publicManifestPath: resolvedManifest, pptxPath: finalPptxPath, intermediate },
      outputDir: resolvedOutput,
      evidenceDir: join(resolvedOutput, "creative-proof"),
      planIntent,
      fontPreflight,
      buildCreativeProof: options.buildCreativeProof,
      reviewCreativeManifest: options.reviewCreativeManifest,
      design,
      textFit: textFitReport,
      proofContext: options.proofContext,
      hostFinalReview: options.hostFinalReview,
      layoutSafety: layout.ok
    });
    creativeReview = initialCreativeArtifact.review;
    creativeQuality = initialCreativeArtifact.quality;
    creativeVisualProof = initialCreativeArtifact.proof;
  }
  let replicaProof = mode === "replica"
    ? (typeof options.buildReplicaProof === "function"
      ? await options.buildReplicaProof({
        pptxPath: join(resolvedOutput, "final.pptx"), manifest, coverage, intermediate, route,
        buildBaseEvidence: ({ renderPath, retryCount = 0 }) => buildReplicaEvidence({
          pptxPath: join(resolvedOutput, "final.pptx"), manifest, coverage, intermediate, route,
          sourcePath: inputSource, renderPath, retryCount
        })
      })
      : await buildReplicaEvidence({
        pptxPath: join(resolvedOutput, "final.pptx"), manifest, coverage, intermediate, route,
        sourcePath: inputSource, renderPath: null
      }))
    : null;
  if (replicaProof) {
    const replicaEvidenceSchema = JSON.parse(await readFile(join(root, "schemas/replica-evidence.schema.json"), "utf8"));
    const contractValidation = validateJsonSchema(replicaProof, replicaEvidenceSchema);
    if (!contractValidation.valid) {
      throw new Error(`replica evidence contract invalid: ${contractValidation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
    }
    await writeFile(join(resolvedOutput, "replica-evidence.json"), `${JSON.stringify(replicaProof, null, 2)}\n`, "utf8");
  }
  let proofOk = mode === "creative"
    ? deterministicCreativeProofPassed(creativeVisualProof)
      && (isDirectionProbeProof(creativeVisualProof) || creativeVisualProof?.accepted === true)
    : mode === "replica" ? replicaProof.accepted === true : (intermediate.editabilityCounter?.text ?? 0) > 0;
  const proofStep = { label: proofLabel, ok: proofOk };
  steps.push(proofStep);
  const repairLimit = normalizeRepairLimit(options.maxRepairAttempts ?? 3);
  stageGuard.enter("bounded-repair");
  if (mode === "creative" && options.enableLegacyCreativeAutoRepair === true && !deterministicCreativeProofPassed(creativeVisualProof)) {
    const attempt = typeof options.runRepairAttempt === "function"
      ? ({ iteration, proof, artifact }) => runCallbackCreativeRepairAttempt({
        callback: options.runRepairAttempt,
        iteration,
        proof,
        artifact,
        outputDir: resolvedOutput,
        route,
        publicManifestPath: resolvedManifest,
        planIntent,
        buildCreativeProof: options.buildCreativeProof,
        reviewCreativeManifest: options.reviewCreativeManifest,
        renderCreativeArtifact: options.renderCreativeArtifact,
        proofContext: options.proofContext,
        hostFinalReview: options.hostFinalReview,
        layoutSafety: layout.ok
      })
      : ({ iteration, artifact }) => runCreativeRepairAttempt({
        iteration,
        artifact,
        root,
        outputDir: resolvedOutput,
        publicManifestPath: resolvedManifest,
        planIntent,
        buildCreativeProof: options.buildCreativeProof,
        reviewCreativeManifest: options.reviewCreativeManifest,
        renderCreativeArtifact: options.renderCreativeArtifact,
        proofContext: options.proofContext,
        hostFinalReview: options.hostFinalReview,
        layoutSafety: layout.ok
      });
    const repair = await runBoundedRepair({
      initialProof: creativeVisualProof,
      initialArtifact: initialCreativeArtifact,
      maxAttempts: repairLimit,
      attempt,
      compare: compareCreativeProof,
      accept: deterministicCreativeProofPassed
    });
    repairAttempts = repair.attempts;
    const finalRepair = summarizeCreativeRepair({ attempts: repair.attempts, stopReason: repair.stopReason, history: repair.history });
    proofOk = repair.accepted === true && deterministicCreativeProofPassed(repair.proof);
    proofStep.ok = proofOk;
    if (!proofOk) {
      creativeVisualProof = { ...(repair.proof ?? initialCreativeArtifact.proof), repair: finalRepair };
      await validateCreativeProofContract(creativeVisualProof);
      await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(creativeVisualProof, null, 2)}\n`, "utf8");
      steps.push({ label: "bounded-repair", ok: false, attempts: repair.attempts, maxAttempts: repairLimit, stopReason: repair.stopReason });
      const visualDetail = (creativeVisualProof.findings ?? [])
        .filter((finding) => ["P0", "P1"].includes(finding.severity))
        .map((finding) => `${finding.type}: ${finding.message}`)
        .join("; ");
      await blockPipeline(resolvedManifest, resolvedOutput, steps, "bounded-repair", `${proofLabel} failed; ${visualDetail || repair.stopReason}`);
    }
    const accepted = repair.artifact;
    const publicEvidenceDir = join(resolvedOutput, "creative-proof");
    try {
      await publishRepairArtifact([
        { source: accepted?.manifestPath, target: resolvedManifest },
        { source: accepted?.pptxPath, target: finalPptxPath },
        { source: join(accepted?.evidenceDir ?? "", "slides"), target: join(publicEvidenceDir, "slides") }
      ]);
    } catch (error) {
      const publicationRepair = summarizeCreativeRepair({
        attempts: repair.attempts,
        stopReason: "publication-failed",
        history: repair.history
      });
      creativeVisualProof = {
        ...(repair.proof ?? initialCreativeArtifact.proof),
        repair: publicationRepair
      };
      proofOk = false;
      proofStep.ok = false;
      await validateCreativeProofContract(creativeVisualProof);
      await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(creativeVisualProof, null, 2)}\n`, "utf8");
      steps.push({ label: "bounded-repair", ok: false, attempts: repair.attempts, maxAttempts: repairLimit, stopReason: "publication-failed" });
      await blockPipeline(
        resolvedManifest,
        resolvedOutput,
        steps,
        "bounded-repair",
        `creative repair publication failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    manifest = accepted.manifest;
    intermediate = accepted.intermediate;
    design = accepted.design;
    fontPreflight = accepted.fontPreflight;
    textFitReport = accepted.textFit;
    creativeReview = accepted.review;
    creativeQuality = accepted.quality;
    const reassessed = await assessCreativeArtifact({
      artifact: { ...accepted, manifestPath: resolvedManifest, publicManifestPath: resolvedManifest, pptxPath: finalPptxPath },
      outputDir: resolvedOutput,
      evidenceDir: publicEvidenceDir,
      planIntent,
      fontPreflight,
      buildCreativeProof: options.buildCreativeProof,
      reviewCreativeManifest: options.reviewCreativeManifest,
      design,
      textFit: textFitReport,
      proofContext: options.proofContext,
      hostFinalReview: options.hostFinalReview,
      layoutSafety: layout.ok
    });
    creativeVisualProof = { ...reassessed.proof, repair: finalRepair };
    creativeReview = reassessed.review;
    creativeQuality = reassessed.quality;
    proofOk = deterministicCreativeProofPassed(creativeVisualProof)
      && (isDirectionProbeProof(creativeVisualProof) || creativeVisualProof.accepted === true);
    proofStep.ok = proofOk;
    await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(creativeVisualProof, null, 2)}\n`, "utf8");
    steps.push({ label: "bounded-repair", ok: true, attempts: repair.attempts, maxAttempts: repairLimit, stopReason: repair.stopReason });
  } else if (mode !== "creative" && !proofOk) {
    const repair = await runBoundedRepair({
      initialProof: replicaProof,
      initialArtifact: { manifestPath: resolvedManifest, pptxPath: finalPptxPath, ...(options.initialRepairArtifact ?? {}) },
      maxAttempts: repairLimit,
      attempt: typeof options.runRepairAttempt === "function"
        ? ({ iteration, proof, artifact }) => options.runRepairAttempt({ iteration, proof, artifact, manifest, outputDir: resolvedOutput, route, mode })
        : undefined
    });
    replicaProof = repair.proof;
    proofOk = repair.accepted;
    proofStep.ok = proofOk;
    if (replicaProof && repair.attempts > 0) {
      replicaProof = { ...replicaProof, retry: { status: "available", attempts: repair.history.map(({ iteration, outcome }) => ({ iteration, outcome })) } };
    }
    if (replicaProof) {
      const schema = JSON.parse(await readFile(join(root, "schemas/replica-evidence.schema.json"), "utf8"));
      const validation = validateJsonSchema(replicaProof, schema);
      if (!validation.valid) throw new Error(`repaired replica evidence contract invalid: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
      await writeFile(join(resolvedOutput, "replica-evidence.json"), `${JSON.stringify(replicaProof, null, 2)}\n`, "utf8");
    }
    if (!proofOk) {
      steps.push({ label: "bounded-repair", ok: false, attempts: repair.attempts, maxAttempts: repairLimit, stopReason: repair.stopReason });
      await blockPipeline(resolvedManifest, resolvedOutput, steps, "bounded-repair", `${proofLabel} failed; ${repair.stopReason}`);
    }
    await publishRepairArtifact([
      { source: repair.artifact?.manifestPath, target: resolvedManifest },
      { source: repair.artifact?.pptxPath, target: finalPptxPath },
      { source: repair.artifact?.planPath, target: options.initialRepairArtifact?.planPath }
    ]);
    manifest = repair.artifact?.manifest ?? JSON.parse(await readFile(resolvedManifest, "utf8"));
    intermediate = repair.artifact?.intermediate ?? intermediate;
    steps.push({ label: "bounded-repair", ok: true, attempts: repair.attempts, maxAttempts: repairLimit, stopReason: repair.stopReason });
  } else {
    if (mode === "creative") {
      const deterministicPassed = deterministicCreativeProofPassed(creativeVisualProof);
      creativeVisualProof = {
        ...creativeVisualProof,
        repair: summarizeCreativeRepair({
          attempts: 0,
          stopReason: deterministicPassed ? "initial-deterministic-proof-passed" : "evidence-led-refinement-required",
          history: []
        })
      };
      await validateCreativeProofContract(creativeVisualProof);
      await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(creativeVisualProof, null, 2)}\n`, "utf8");
    }
    const stopReason = mode === "creative" && !deterministicCreativeProofPassed(creativeVisualProof)
      ? "evidence-led-refinement-required"
      : "initial-deterministic-proof-passed";
    steps.push({ label: "bounded-repair", ok: mode !== "creative" || deterministicCreativeProofPassed(creativeVisualProof), attempts: 0, maxAttempts: repairLimit, stopReason });
  }

  if (mode === "creative" && !isDirectionProbeProof(creativeVisualProof) && creativeVisualProof?.accepted !== true
    && creativeVisualProof?.hostVisualReview?.status === "completed"
    && !(options.proofContext?.refinementState?.status === "applied" && options.proofContext?.bestProof)) {
    proofStep.ok = false;
    await blockForRefinement({ resolvedManifest, resolvedOutput, steps, proof: creativeVisualProof, manifest, proofContext: options.proofContext });
  }
  if (mode === "creative" && creativeVisualProof?.hostVisualReview?.status === "completed"
    && options.proofContext?.refinementState?.status === "applied" && options.proofContext?.bestProof) {
    const comparison = compareRefinementProof(creativeVisualProof, options.proofContext.bestProof);
    creativeVisualProof = {
      ...creativeVisualProof,
      refinement: {
        ...creativeVisualProof.refinement,
        history: (creativeVisualProof.refinement?.history ?? []).map((entry, index, history) => index === history.length - 1 ? {
          ...entry,
          comparison,
          outcome: creativeVisualProof.accepted && comparison >= 0 ? "accepted" : comparison > 0 ? "improved" : "no-improvement"
        } : entry)
      }
    };
    await validateCreativeProofContract(creativeVisualProof);
    await writeFile(join(resolvedOutput, "creative-proof.json"), `${JSON.stringify(creativeVisualProof, null, 2)}\n`, "utf8");
    if (comparison < 0 || (comparison === 0 && creativeVisualProof.accepted !== true)) {
      await rm(join(resolvedOutput, "final.pptx"), { force: true });
      await rm(join(resolvedOutput, "run.json"), { force: true });
      await rm(join(resolvedOutput, "output-manifest.json"), { force: true });
      await blockPipeline(resolvedManifest, resolvedOutput, steps, "creative-refinement", "candidate did not improve the artifact-bound best proof; best diagnostic state retained");
    }
    if (comparison > 0 && creativeVisualProof.accepted !== true) {
      await blockForRefinement({ resolvedManifest, resolvedOutput, steps, proof: creativeVisualProof, manifest, proofContext: options.proofContext });
    }
  }
  if (mode === "creative" && !isDirectionProbeProof(creativeVisualProof) && creativeVisualProof?.accepted !== true) {
    proofStep.ok = false;
    const hostStatus = creativeVisualProof?.hostVisualReview?.status ?? "missing";
    const detail = hostStatus === "missing"
      ? "full-deck evidence is ready; inspect every rendered slide and rerun with --host-final-review"
      : `Host final visual review is ${hostStatus}; regenerate a complete packet-bound review and rerun`;
    await blockForHostFinalReview({ resolvedManifest, resolvedOutput, steps, proof: creativeVisualProof, detail });
  }
  if (mode === "creative" && creativeVisualProof?.accepted === true) {
    await writeFile(join(resolvedOutput, "host-visual-review.json"), `${JSON.stringify(options.hostFinalReview, null, 2)}\n`, "utf8");
  }

  intermediate.fontNames = (fontPreflight.fallback ?? []).map((entry) => ({ element: "design-tokens", ...entry }));
  intermediate.fontFallback = fontPreflight.fallback ?? [];
  intermediate.preview = { status: "unavailable", reason: "preview-diff-capability-not-selected" };

  if (mode === "creative") {
    await writeFile(join(resolvedOutput, "text-fit-report.json"), `${JSON.stringify(textFitReport, null, 2)}\n`, "utf8");
    await writeFile(join(resolvedOutput, "visual-review.json"), `${JSON.stringify(creativeReview, null, 2)}\n`, "utf8");
    await writeFile(join(resolvedOutput, "quality-report.json"), `${JSON.stringify(creativeQuality, null, 2)}\n`, "utf8");
    const p0Count = (creativeVisualProof?.findings ?? []).filter((finding) => finding.severity === "P0").length;
    const p1Count = (creativeVisualProof?.findings ?? []).filter((finding) => finding.severity === "P1").length;
    const qualityMarkdown = `# Creative quality report\n\nStatus: **${creativeQuality.gate.passed && creativeVisualProof?.accepted ? "PASS" : "BLOCK"}**\n\n- Deck score: ${creativeQuality.deckScore} (minimum 80)\n- Slide floor: ${Math.min(...creativeQuality.slides.map((slide) => slide.score))} (minimum 70)\n- Slop risk: ${creativeQuality.slopRisk} (maximum 20)\n- Critical findings: ${creativeQuality.criticalFindings} (required 0)\n- Rendered slides: ${creativeVisualProof?.rendering?.renderedPageCount ?? 0}/${creativeVisualProof?.rendering?.expectedPageCount ?? manifest.slides.length}\n- Visual proof P0/P1: ${p0Count}/${p1Count} (required 0/0)\n- Host final review: ${creativeVisualProof?.hostVisualReview?.status ?? "missing"}\n- Editability: L${creativeQuality.editabilityLevel} (minimum L4)\n- Font preflight: ${creativeQuality.compatibility.source}; ${creativeQuality.compatibility.fallback.length} fallback(s)\n`;
    await writeFile(join(resolvedOutput, "quality-report.md"), qualityMarkdown, "utf8");
    const previewDir = join(resolvedOutput, "preview");
    await mkdir(previewDir, { recursive: true });
    const previewTitle = escapePreviewHtml(manifest.deck.title);
    await writeFile(join(previewDir, "index.html"), `<!doctype html><meta charset="utf-8"><title>${previewTitle}</title><main><h1>${previewTitle}</h1><p>Creative quality: ${creativeQuality.gate.passed && creativeVisualProof?.accepted ? "PASS" : "BLOCK"}</p><figure><img src="../creative-proof/slides/contact-sheet.png" alt="Rendered slide contact sheet" style="max-width:100%;height:auto"><figcaption>LibreOffice render evidence for all ${creativeVisualProof?.rendering?.renderedPageCount ?? 0} slides</figcaption></figure><ol>${manifest.slides.map((slide) => `<li>${escapePreviewHtml(slide.title)}</li>`).join("")}</ol></main>\n`, "utf8");
  }
  if (mode === "replica" && replicaProof) {
    const quality = {
      version: "0.1.0", mode: "replica", route,
      status: replicaProof.accepted ? "passed" : "blocked",
      fidelity: replicaProof.aggregate.fidelity,
      nativeCoverage: replicaProof.aggregate.nativeCoverage,
      editability: replicaProof.aggregate.editability,
      fallbacks: replicaProof.aggregate.fallbacks,
      retry: replicaProof.retry,
      blockingFindings: replicaProof.blockingFindings
    };
    await writeFile(join(resolvedOutput, "quality-report.json"), `${JSON.stringify(quality, null, 2)}\n`, "utf8");
    await writeFile(join(resolvedOutput, "quality-report.md"), `# Replica quality report\n\nStatus: **${replicaProof.accepted ? "PASS" : "BLOCK"}**\n\n- Route: ${route}\n- SSIM: ${replicaProof.aggregate.fidelity.ssim?.value ?? "N/A"}\n- Normalized MAE: ${replicaProof.aggregate.fidelity.normalizedMae?.value ?? "N/A"}\n- Native coverage: ${replicaProof.aggregate.nativeCoverage?.value ?? "N/A"}\n- Editability: L${replicaProof.aggregate.editability?.level ?? "N/A"}\n- Local raster fallbacks: ${replicaProof.aggregate.fallbacks?.length ?? 0}\n- Retry attempts: ${replicaProof.retry?.attempts?.length ?? 0}\n`, "utf8");
    const previewDir = join(resolvedOutput, "preview");
    await mkdir(previewDir, { recursive: true });
    const pages = replicaProof.perSlide.map((slide) => `<figure><img src="../evidence/render/slide-${slide.slideIndex + 1}.png" alt="Rendered slide ${slide.slideIndex + 1}"><figcaption>Slide ${slide.slideIndex + 1}: SSIM ${slide.fidelity.ssim?.value ?? "N/A"}</figcaption></figure>`).join("");
    await writeFile(join(previewDir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Replica proof</title><main><h1>Replica proof: ${replicaProof.accepted ? "PASS" : "BLOCK"}</h1><p>SSIM ${replicaProof.aggregate.fidelity.ssim?.value ?? "N/A"}; native coverage ${replicaProof.aggregate.nativeCoverage?.value ?? "N/A"}</p>${pages}</main>\n`, "utf8");
  }
  let layoutSafetyStatus;
  let beforePackageStarted = false;
  try {
    const report = JSON.parse(await readFile(layoutSafetyPath, "utf8"));
    layoutSafetyStatus = (report?.summary?.criticalCount ?? 0) === 0 ? "passed" : "violated-with-flag";
  } catch { layoutSafetyStatus = undefined; }
  try {
    const reportOptions = {
      inputType,
      inputSource,
      feedback: {
        retryCount: mode === "creative" ? repairAttempts : 0,
        accepted: options.acceptResult === true ? true : null,
        acceptedAt: options.acceptResult === true ? new Date().toISOString() : null
      },
      qualityTargets: coverage ? { ...(options.qualityTargets ?? {}), replicaCoverage: coverage } : (options.qualityTargets ?? {}),
      ...(layoutSafetyStatus ? { layoutSafety: layoutSafetyStatus } : {}),
      ...(creativeReview ? { slopRisk: creativeReview.slopRisk } : {})
    };
    const { json, md } = buildConsistencyReport(manifest, intermediate, reportOptions);
    await writeFile(join(resolvedOutput, "consistency-report.json"), `${json}\n`, "utf8");
    await writeFile(join(resolvedOutput, "consistency-report.md"), `${md}\n`, "utf8");
    await writePipelineReports(
      resolvedOutput,
      manifest,
      design,
      intermediate.countersBySlide ?? [intermediate.editabilityCounter],
      { proofStatus: "passed", textFitStatus: textFitReport?.status ?? "unavailable" }
    );
    if (typeof options.beforePackage === "function") {
      beforePackageStarted = true;
      await options.beforePackage({ route, mode, status: "passed", outputDir: resolvedOutput });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push({ label: "reports", ok: false });
    if (beforePackageStarted) {
      await rollbackBeforePackage(options, {
        route, mode, status: "blocked", outputDir: resolvedOutput, blockedBy: "reports", error
      });
    }
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "reports", detail);
  }

  let packaged;
  try {
    if (options.copyManifest !== false && shouldCopyManifest(resolvedManifest, resolvedOutput)) {
      await copyFile(resolvedManifest, join(resolvedOutput, "deck.manifest.json"));
    }
    if (typeof options.beforePackageCommit === "function") {
      await options.beforePackageCommit({ route, mode, status: "passed", outputDir: resolvedOutput });
    }
    stageGuard.enter("package");
    packaged = await runPythonStep("package", [join(root, "scripts/package-output.py"), resolvedOutput]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push({ label: "package", ok: false });
    if (beforePackageStarted) {
      await rollbackBeforePackage(options, {
        route, mode, status: "blocked", outputDir: resolvedOutput, blockedBy: "package", error
      });
    }
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "package", detail);
  }
  steps.push(packaged);
  if (!packaged.ok) {
    const detail = packaged.stderr || packaged.stdout;
    if (beforePackageStarted) {
      await rollbackBeforePackage(options, {
        route, mode, status: "blocked", outputDir: resolvedOutput, blockedBy: "package", error: detail
      });
    }
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "package", detail);
  }

  stageGuard.complete();
  return {
    manifest: resolvedManifest,
    outputDir: resolvedOutput,
    route,
    mode,
    contract,
    steps: steps.map(({ label, ok, attempts, maxAttempts }) => ({
      label,
      ok,
      ...(attempts !== undefined ? { attempts, maxAttempts } : {})
    })),
    status: "passed"
  };
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-type") options.inputType = argv[++index];
    else if (arg === "--input-source") options.inputSource = argv[++index];
    else if (arg === "--allow-layout-violation") options.allowLayoutViolation = true;
    else if (arg === "--accept-result") options.acceptResult = true;
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--max-repair-attempts") options.maxRepairAttempts = Number(argv[++index]);
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { manifest: positional[0], outputDir: positional[1] ?? "output", options };
}

async function main() {
  const { manifest, outputDir, options } = parseArgs(process.argv.slice(2));
  if (!manifest) throw new Error("usage: run-deck-pipeline.mjs <deck.manifest.json> [output-dir] [--mode direct|creative|replica]");
  if (options.mode !== undefined && !["direct", "creative", "replica"].includes(options.mode)) {
    throw new Error(`unsupported pipeline mode: ${options.mode}; expected direct, creative or replica`);
  }
  const summary = await runDeckPipeline(manifest, outputDir, options);
  console.log(JSON.stringify(summary, null, 2));
}

let invokedDirectly = false;
try { invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (invokedDirectly) {
  main().catch((error) => {
    if (error?.summary) console.error(JSON.stringify(error.summary, null, 2));
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
