#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { buildConsistencyReport } from "./lib/consistency-report-writer.mjs";
import { applyContextualTaste, editabilityLevelFromCounter, qualityFromReview } from "./lib/contextual-taste.mjs";
import { preflightFonts } from "./lib/font-preflight.mjs";
import { writePipelineReports } from "./lib/pipeline-report-writer.mjs";
import { runPython } from "./lib/python-utils.mjs";
import { verifyReplicaEvidence } from "./lib/replica-evidence.mjs";
import { validateJsonSchema } from "./lib/schema-utils.mjs";
import { reviewManifest } from "./lib/visual-critic.mjs";
import { parseDesignFile } from "./parse-design-md.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  "quality-report.json",
  "quality-report.md",
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

async function removeOwnedPath(candidate, protectedSet) {
  if (protectedSet.has(candidate)) return;
  const prefix = `${candidate}${sep}`;
  const hasProtectedDescendant = [...protectedSet].some((path) => path.startsWith(prefix));
  if (!hasProtectedDescendant) {
    await rm(candidate, { force: true, recursive: true });
    return;
  }
  let entries;
  try { entries = await readdir(candidate, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map((entry) => removeOwnedPath(resolve(candidate, entry.name), protectedSet)));
}

export async function clearConsumableOutputs(outputDir, protectedPaths = []) {
  const outputRoot = resolve(outputDir);
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
  const ownershipPath = resolve(outputRoot, ".pptx-generated-assets.json");
  let ownedAssets = [];
  try {
    const registry = JSON.parse(await readFile(ownershipPath, "utf8"));
    ownedAssets = (registry.files ?? [])
      .filter((path) => typeof path === "string")
      .map((path) => resolve(outputRoot, path))
      .filter((path) => path.startsWith(`${outputRoot}${sep}`));
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
  await Promise.all([...new Set(candidates)].map((candidate) => removeOwnedPath(candidate, protectedSet)));
  const assetsDir = resolve(outputRoot, "assets");
  try { if ((await readdir(assetsDir)).length === 0) await rm(assetsDir, { force: true, recursive: true }); } catch {}
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
    ? { status: "available", value: Number(coverage.coverage) }
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
      nativeCoverage: coverage?.slides?.[slideIndex]?.coverage === undefined ? structuredClone(nativeCoverage) : { status: "available", value: Number(coverage.slides[slideIndex].coverage) },
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
    retry: { status: "unavailable", attempts: [], reason: "bounded-repair-loop-not-implemented" },
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

function normalizeInputType(value, manifest) {
  if (["html", "image", "pdf", "text", "manifest", "mixed", "design-first"].includes(value)) return value;
  if (["html", "image", "pdf", "text", "manifest", "mixed"].includes(manifest?.metadata?.inputType)) {
    return manifest.metadata.inputType;
  }
  return "text";
}

async function blockPipeline(resolvedManifest, resolvedOutput, steps, blockedBy, detail = null) {
  const summary = {
    manifest: resolvedManifest,
    outputDir: resolvedOutput,
    steps: steps.map(({ label, ok }) => ({ label, ok })),
    status: "blocked",
    blockedBy,
    ...(detail ? { detail } : {})
  };
  await writeFile(join(resolvedOutput, "pipeline-blocked.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const error = new Error(`pipeline blocked at ${blockedBy}${detail ? `: ${detail}` : ""}`);
  error.summary = summary;
  throw error;
}

export async function runDeckPipeline(manifestPath, outputDir, options = {}) {
  const resolvedInput = resolve(manifestPath);
  let resolvedManifest = resolvedInput;
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
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
  try {
    design = await parseDesignFile(resolve(dirname(resolvedManifest), manifest.designSystem.source));
    fontPreflight = await preflightFonts(manifest, design);
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
  const creativeReview = mode === "creative"
    ? applyContextualTaste(reviewManifest(manifest, { mode: "creative" }), manifest, planIntent)
    : null;
  const creativePreflightGate = mode === "creative"
    ? qualityFromReview(creativeReview, 5, fontPreflight).gate
    : null;
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
  const preflight = {
    label: preflightLabel,
    ok: routePreflight.ok !== false
      && layout.ok
      && (mode !== "creative" || creativePreflightGate.passed)
      && (mode !== "replica" || replicaProofAvailable),
    stdout: mode === "creative" ? `deckScore=${creativeReview.deckScore}; slopRisk=${creativeReview.slopRisk}; gate=${creativePreflightGate.passed ? "pass" : "block"}` : (routePreflight.stdout || fontPreflight.source),
    stderr: routePreflight.ok === false
      ? routePreflight.stderr
      : !layout.ok ? layout.stderr
        : mode === "creative" && !creativePreflightGate.passed ? creativePreflightGate.reasons.join("; ")
          : (mode === "replica" && !replicaProofAvailable ? "strict replica fidelity proof capability unavailable" : "")
  };
  stageGuard.enter(preflightLabel);
  steps.push(preflight);
  if (!preflight.ok) await blockPipeline(resolvedManifest, resolvedOutput, steps, preflightLabel, preflight.stderr || preflight.stdout);

  stageGuard.enter("render");
  const render = await runStep("render", process.execPath, [
    join(root, "scripts/render-pptx.mjs"), resolvedManifest, join(resolvedOutput, "final.pptx")
  ]);
  steps.push(render);
  if (!render.ok) await blockPipeline(resolvedManifest, resolvedOutput, steps, "render", render.stderr || render.stdout);

  let intermediate;
  try {
    intermediate = JSON.parse(render.stdout).intermediate;
  } catch {
    steps.push({ label: "render-contract", ok: false });
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "render-contract", "renderer did not emit intermediate facts");
  }
  intermediate.fontNames = (fontPreflight.fallback ?? []).map((entry) => ({ element: "design-tokens", ...entry }));
  intermediate.fontFallback = fontPreflight.fallback ?? [];
  intermediate.preview = { status: "unavailable", reason: "preview-diff-capability-not-selected" };

  const proofLabel = mode === "creative" ? "creative-proof" : mode === "replica" ? "fidelity-proof" : "editability-proof";
  stageGuard.enter(proofLabel);
  const replicaProof = mode === "replica"
    ? await buildReplicaEvidence({
      pptxPath: join(resolvedOutput, "final.pptx"), manifest, coverage, intermediate, route,
      sourcePath: inputSource, renderPath: null
    })
    : null;
  if (replicaProof) {
    const replicaEvidenceSchema = JSON.parse(await readFile(join(root, "schemas/replica-evidence.schema.json"), "utf8"));
    const contractValidation = validateJsonSchema(replicaProof, replicaEvidenceSchema);
    if (!contractValidation.valid) {
      throw new Error(`replica evidence contract invalid: ${contractValidation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
    }
    await writeFile(join(resolvedOutput, "replica-evidence.json"), `${JSON.stringify(replicaProof, null, 2)}\n`, "utf8");
  }
  const creativeQuality = mode === "creative"
    ? qualityFromReview(creativeReview, editabilityLevelFromCounter(intermediate.editabilityCounter), fontPreflight)
    : null;
  const proofOk = mode === "creative"
    ? creativeQuality.gate.passed
    : mode === "replica" ? replicaProof.accepted === true : (intermediate.editabilityCounter?.text ?? 0) > 0;
  steps.push({ label: proofLabel, ok: proofOk });
  const repairLimit = normalizeRepairLimit(options.maxRepairAttempts ?? 3);
  stageGuard.enter("bounded-repair");
  if (!proofOk) {
    steps.push({ label: "bounded-repair", ok: false, attempts: 0, maxAttempts: repairLimit });
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "bounded-repair", `${proofLabel} failed and no deterministic repair was available`);
  }
  steps.push({ label: "bounded-repair", ok: true, attempts: 0, maxAttempts: repairLimit });

  if (mode === "creative") {
    await writeFile(join(resolvedOutput, "visual-review.json"), `${JSON.stringify(creativeReview, null, 2)}\n`, "utf8");
    await writeFile(join(resolvedOutput, "quality-report.json"), `${JSON.stringify(creativeQuality, null, 2)}\n`, "utf8");
    const qualityMarkdown = `# Creative quality report\n\nStatus: **${creativeQuality.gate.passed ? "PASS" : "BLOCK"}**\n\n- Deck score: ${creativeQuality.deckScore} (minimum 80)\n- Slide floor: ${Math.min(...creativeQuality.slides.map((slide) => slide.score))} (minimum 70)\n- Slop risk: ${creativeQuality.slopRisk} (maximum 20)\n- Critical findings: ${creativeQuality.criticalFindings} (required 0)\n- Editability: L${creativeQuality.editabilityLevel} (minimum L4)\n- Font preflight: ${creativeQuality.compatibility.source}; ${creativeQuality.compatibility.fallback.length} fallback(s)\n`;
    await writeFile(join(resolvedOutput, "quality-report.md"), qualityMarkdown, "utf8");
    const previewDir = join(resolvedOutput, "preview");
    await mkdir(previewDir, { recursive: true });
    const previewTitle = escapePreviewHtml(manifest.deck.title);
    await writeFile(join(previewDir, "index.html"), `<!doctype html><meta charset="utf-8"><title>${previewTitle}</title><main><h1>${previewTitle}</h1><p>Creative quality: ${creativeQuality.gate.passed ? "PASS" : "BLOCK"}</p><ol>${manifest.slides.map((slide) => `<li>${escapePreviewHtml(slide.title)}</li>`).join("")}</ol></main>\n`, "utf8");
  }
  let layoutSafetyStatus;
  try {
    const report = JSON.parse(await readFile(layoutSafetyPath, "utf8"));
    layoutSafetyStatus = (report?.summary?.criticalCount ?? 0) === 0 ? "passed" : "violated-with-flag";
  } catch { layoutSafetyStatus = undefined; }
  try {
    const reportOptions = {
      inputType,
      inputSource,
      feedback: {
        retryCount: 0,
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
      { proofStatus: "passed" }
    );
    if (typeof options.beforePackage === "function") {
      await options.beforePackage({ route, mode, status: "passed", outputDir: resolvedOutput });
    }
  } catch (error) {
    steps.push({ label: "reports", ok: false });
    await blockPipeline(resolvedManifest, resolvedOutput, steps, "reports", error instanceof Error ? error.message : String(error));
  }

  if (options.copyManifest !== false && shouldCopyManifest(resolvedManifest, resolvedOutput)) {
    await copyFile(resolvedManifest, join(resolvedOutput, "deck.manifest.json"));
  }
  stageGuard.enter("package");
  const packaged = await runPythonStep("package", [join(root, "scripts/package-output.py"), resolvedOutput]);
  steps.push(packaged);
  if (!packaged.ok) await blockPipeline(resolvedManifest, resolvedOutput, steps, "package", packaged.stderr || packaged.stdout);

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
