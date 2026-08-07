#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildHtmlPackage } from "./build_html_package.mjs";
import { renderPptx } from "./render_pptx.mjs";
import { reconstructionRepairSafety, validateOutput, validateReconstructionPlan } from "./validate_output.mjs";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REPAIRS = 3;
const REPAIR_BEAM_WIDTH = 4;

function cliError(code, message, exitCode = 1) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function validatePublishedReference(output, reference, label) {
  if (!reference || typeof reference !== "object" || typeof reference.path !== "string" || !reference.path
      || reference.path.includes("\0") || isAbsolute(reference.path) || reference.path.split(/[\\/]+/u).includes("..")) {
    throw cliError("E_CONTRACT", `${label} reference path is invalid`);
  }
  const root = resolve(output);
  const path = resolve(root, reference.path);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw cliError("E_CONTRACT", `${label} reference escapes output`);
  }
  if (!await exists(path)) throw cliError("E_CONTRACT", `${label} reference is missing: ${reference.path}`);
  if (await digest(path) !== reference.sha256) throw cliError("E_CONTRACT", `${label} reference digest mismatch`);
  return path;
}

const HEX_COLOR = /^#[0-9A-F]{6}$/i;

function clampNumber(value, minimum, maximum, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function measuredNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function regionKey(slideId, regionId) {
  return `${String(slideId)}\u0000${String(regionId)}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function relativeTo(root, path) {
  return resolve(path).slice(resolve(root).length + 1).replaceAll("\\", "/");
}

async function atomicCopyFile(source, target) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await copyFile(source, temporary);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicCopyDirectory(source, target) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function removeIncompleteDelivery(output) {
  for (const name of ["final.pptx", "preview", "html-package", "run.json", "qa-report.json"]) {
    await rm(join(output, name), { recursive: true, force: true });
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? SKILL_ROOT,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 180_000,
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const message = String(error.stderr ?? error.stdout ?? error.message).trim();
    try {
      const payload = JSON.parse(message.split("\n").at(-1));
      if (payload.code) throw cliError(payload.code, payload.message ?? message);
    } catch (parsed) {
      if (parsed?.code) throw parsed;
    }
    throw cliError(options.code ?? "E_PROCESS", message || `${command} failed`);
  }
}

function collectRequestedFonts(analysis) {
  const families = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/(?:fontfamily|fontface)$/iu.test(key) && typeof child === "string") {
        for (const family of child.split(",").map((item) => item.trim()).filter(Boolean)) families.add(family);
      }
      visit(child);
    }
  };
  visit(analysis);
  return [...families].sort();
}

async function diagnoseFonts(analysis) {
  const requested = collectRequestedFonts(analysis);
  const diagnostics = [];
  for (const family of requested) {
    try {
      const result = await run("fc-match", ["-f", "%{family}", family], { timeout: 10_000, code: "E_FONT_RUNTIME" });
      const matched = String(result.stdout || "").trim().split(",")[0].trim();
      if (!matched) {
        diagnostics.push({ requested: family, status: "unavailable", matched: null });
        continue;
      }
      diagnostics.push({
        requested: family,
        status: matched.toLowerCase() === family.toLowerCase() ? "available" : "substituted",
        matched
      });
    } catch (error) {
      diagnostics.push({ requested: family, status: "unavailable", matched: null, detail: error.message });
    }
  }
  return diagnostics;
}

async function pythonCommand() {
  const command = process.env.IMAGE_TO_PPTX_PYTHON || "python3";
  await run(command, ["-c", "import PIL,pytesseract"], { code: "E_OCR_RUNTIME" });
  await run(command, ["-c", "import numpy,skimage"], { code: "E_VISUAL_RUNTIME" });
  await run(command, ["-c", "import fontTools"], { code: "E_FONT_RUNTIME" });
  return command;
}

async function collectInputs(items) {
  const inputs = [];
  for (const item of items) {
    const path = resolve(item);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw cliError("E_INPUT_FORMAT", `input does not exist: ${path}`);
    }
    if (info.isDirectory()) {
      const children = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && IMAGE_SUFFIXES.has(extname(entry.name).toLowerCase()))
        .map((entry) => join(path, entry.name))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      inputs.push(...children);
    } else if (info.isFile() && IMAGE_SUFFIXES.has(extname(path).toLowerCase())) {
      inputs.push(path);
    } else {
      throw cliError("E_INPUT_FORMAT", `unsupported input: ${path}`);
    }
  }
  if (!inputs.length) throw cliError("E_INPUT_REQUIRED", "at least one PNG, JPEG, or WebP image is required");
  return inputs;
}

async function prepareOutput(outputDir) {
  const out = resolve(outputDir);
  if (await exists(out)) {
    const entries = await readdir(out);
    if (entries.length) throw cliError("E_OUTPUT_NOT_EMPTY", `output directory must be empty: ${out}`);
  }
  await mkdir(out, { recursive: true });
  return out;
}

function parseBuild(argv) {
  const options = {
    output: null,
    title: null,
    langs: "eng",
    ocrThreshold: 0.70,
    maxRepairs: 3,
    htmlPackage: true,
    inputs: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") options.output = argv[++index];
    else if (value === "--title") options.title = argv[++index];
    else if (value === "--langs") options.langs = argv[++index];
    else if (value === "--ocr-threshold") options.ocrThreshold = Number(argv[++index]);
    else if (value === "--max-repairs") options.maxRepairs = Number(argv[++index]);
    else if (value === "--html-package") options.htmlPackage = true;
    else if (value === "--no-html-package") options.htmlPackage = false;
    else if (value.startsWith("--")) throw cliError("E_ARGUMENT", `unknown option: ${value}`);
    else options.inputs.push(value);
  }
  if (!options.output) throw cliError("E_ARGUMENT", "--output is required");
  if (!Number.isFinite(options.ocrThreshold) || options.ocrThreshold < 0 || options.ocrThreshold > 1) {
    throw cliError("E_ARGUMENT", "--ocr-threshold must be in [0,1]");
  }
  if (!Number.isInteger(options.maxRepairs) || options.maxRepairs < 0 || options.maxRepairs > MAX_REPAIRS) {
    throw cliError("E_ARGUMENT", "--max-repairs must be an integer in [0,3]");
  }
  return options;
}

function scoreVisual(report, editability) {
  const values = report.aggregate ?? {};
  const deficits = [
    Math.max(0, 0.94 - Number(values.ssim ?? -1)) * 10,
    Math.max(0, Number(values.ocrCer ?? 1) - 0.02) * 10,
    Math.max(0, 0.90 - Number(values.bboxIou ?? -1)) * 10,
    Math.max(0, Number(values.paletteDeltaE2000P95 ?? 100) - 3) / 10,
    Math.max(0, 0.90 - Number(values.nativeHighConfidenceTextRecall ?? -1)) * 10,
    Math.max(0, 3 - Number(editability.level ?? 0))
  ];
  return Number(deficits.reduce((sum, value) => sum + value, 0).toFixed(8));
}

function accepted(report, editability, analysis = null, renderReport = null) {
  const ownershipPassed = Array.isArray(analysis?.slides) && analysis.slides.length > 0
    && analysis.slides.every((slide) => {
    const ownership = slide.ownershipReport;
    return Boolean(ownership) && (ownership.status === "passed"
      && Number(ownership.conflictPixels ?? 0) === 0
      && Number(ownership.rasterNativeOverlapPixels ?? 0) === 0
      && Number(ownership.duplicateVisibleContent ?? 0) === 0
      && Number(ownership.unassignedShare ?? 0) <= Number(ownership.unassignedBudget ?? 0));
  });
  const fontsAvailable = !Array.isArray(renderReport?.fonts)
    || renderReport.fonts.every((font) => font?.status === "available");
  return report.status === "passed"
    && editability.status === "passed"
    && editability.level >= 3
    && editability.wholeSlideRasterCount === 0
    && ownershipPassed
    && fontsAvailable;
}

export function repairHasProgress(current, candidate) {
  const hasRegionalEvidence = (current.visual?.slides ?? []).some((slide) => Array.isArray(slide.regionMeasurements));
  if (!hasRegionalEvidence) {
    // Keep the legacy helper useful for callers that only provide aggregate
    // diagnostics. Real build reports always carry measured region evidence
    // and use the strict branch below.
    if (candidate.accepted || candidate.score < current.score) return true;
  } else if (!hardMetricsDoNotRegress(current.visual, candidate.visual, current.editability, candidate.editability)) {
    return false;
  }
  const before = current.visual?.aggregate ?? {};
  const after = candidate.visual?.aggregate ?? {};
  const improvements = [
    Number(after.ssim) - Number(before.ssim),
    Number(before.ocrCer) - Number(after.ocrCer),
    Number(after.bboxIou) - Number(before.bboxIou),
    Number(before.paletteDeltaE2000P95) - Number(after.paletteDeltaE2000P95),
    Number(after.nativeHighConfidenceTextRecall) - Number(before.nativeHighConfidenceTextRecall),
    (Number(candidate.editability?.level) - Number(current.editability?.level)) / 10
  ].filter(Number.isFinite);
  if (hasRegionalEvidence) {
    const actionKeys = (candidate.appliedActions ?? [])
      .filter((item) => item.slideId !== undefined && item.regionId !== undefined && item.regionId !== null)
      .map((item) => regionKey(item.slideId, item.regionId));
    return localMetricsImproved(current.visual, candidate.visual, actionKeys.length ? actionKeys : null)
      && improvements.some((value) => value >= 0.005);
  }
  // Legacy aggregate-only callers retain the old deterministic Pareto helper.
  return improvements.some((value) => value >= 0.01);
}

export function applyCalibration(analysis, visual) {
  const next = structuredClone(analysis);
  let changes = 0;
  const appliedActions = [];
  const recordAction = (slide, adjustment, beforeStrategy = null, afterStrategy = null) => {
    appliedActions.push({
      slideId: slide.id,
      regionId: adjustment.regionId ?? null,
      action: adjustment.action ?? adjustment.category ?? "adjustment",
      id: adjustment.id ?? null,
      category: adjustment.category ?? null,
      targetStrategy: adjustment.targetStrategy ?? null,
      beforeStrategy,
      afterStrategy,
      sourceBound: adjustment.sourceBound === true
    });
  };
  for (const slideCalibration of visual.calibration ?? []) {
    const slide = next.slides.find((item) => item.id === slideCalibration.slideId);
    if (!slide) continue;
    const topRegionIds = new Set((slideCalibration.topRegionIds ?? []).map(String));
    const objects = new Map(slide.objects.map((item) => [item.id, item]));
    const adjustments = [...(slideCalibration.adjustments ?? [])];
    // When measured geometry has no executable action, trial the first
    // observable route candidate in the bounded beam.  Route-only metadata is
    // never applied: the candidate must carry a renderer-observable action.
    if (!adjustments.length) {
      const routeTrial = (slideCalibration.candidateBeam ?? []).find((item) => item.action === "route-switch" && item.status === "proposed" && item.actions?.length);
      if (routeTrial) adjustments.push(...routeTrial.actions);
    }
    for (const adjustment of adjustments) {
      if (adjustment.sourceBound !== true) continue;
      if (adjustment.regionId && topRegionIds.size > 0 && !topRegionIds.has(String(adjustment.regionId))) continue;
      const category = adjustment.category ?? (objects.get(adjustment.id)?.type === "text" ? "text" : "shape");
      if (category === "route" || String(adjustment.id ?? "").startsWith("__route__:")) {
        const regionId = String(adjustment.regionId ?? String(adjustment.id ?? "").slice("__route__:".length));
        const strategy = String(adjustment.targetStrategy ?? "");
        const region = (slide.reconstructionPlan?.regions ?? []).find((item) => String(item.id) === regionId);
        const candidate = region?.candidates?.find((item) => String(item.strategy) === strategy);
        if (!region || !candidate?.eligible || !["native-all", "native-plus-local-assets", "bounded-raster"].includes(strategy)) continue;
        slide.routeOverrides = { ...(slide.routeOverrides ?? {}), [regionId]: strategy };
        changes += 1;
        const before = region?.candidates?.find((item) => String(item.id) === String(region.winnerId))?.strategy ?? null;
        recordAction(slide, adjustment, before, strategy);
        continue;
      }
      if (category === "background" || adjustment.id === "__background__") {
        const candidate = String(adjustment.backgroundColor ?? "");
        if (HEX_COLOR.test(candidate) && candidate.toUpperCase() !== String(slide.background ?? "").toUpperCase()) {
          slide.background = candidate.toUpperCase();
          changes += 1;
          recordAction(slide, adjustment);
        }
        continue;
      }
      if (category === "z-order" || adjustment.id === "__z-order__") {
        const zDelta = Math.round(clampNumber(adjustment.zDelta, -1, 1, 0));
        if (!zDelta) continue;
        const ranked = [...slide.objects].sort((left, right) => (left.z ?? 0) - (right.z ?? 0) || left.id.localeCompare(right.id));
        const index = ranked.findIndex((object) => object.id === adjustment.objectId || object.id === adjustment.targetId);
        if (index < 0) continue;
        const [object] = ranked.splice(index, 1);
        ranked.splice(Math.max(0, Math.min(ranked.length, index + zDelta)), 0, object);
        ranked.forEach((item, z) => { item.z = z; });
        changes += 1;
        recordAction(slide, adjustment);
        continue;
      }
      const object = objects.get(adjustment.id);
      if (!object) continue;
      const slideWidth = Number(slide.sizePx?.width ?? analysis.deck.size.widthPx);
      const slideHeight = Number(slide.sizePx?.height ?? analysis.deck.size.heightPx);
      const sourceBox = object.type === "text" ? object.renderBox : object.pixelBox;
      if (!sourceBox) continue;
      const dx = clampNumber(adjustment.dx, -24, 24, 0);
      const dy = clampNumber(adjustment.dy, -24, 24, 0);
      const dw = clampNumber(adjustment.dw, -32, 32, 0);
      const dh = clampNumber(adjustment.dh, -32, 32, 0);
      const nextBox = {
        x: Math.max(0, Math.min(slideWidth - 1, sourceBox.x + dx)),
        y: Math.max(0, Math.min(slideHeight - 1, sourceBox.y + dy)),
        w: Math.max(1, Math.min(slideWidth, sourceBox.w + dw)),
        h: Math.max(1, Math.min(slideHeight, sourceBox.h + dh))
      };
      nextBox.w = Math.min(nextBox.w, slideWidth - nextBox.x);
      nextBox.h = Math.min(nextBox.h, slideHeight - nextBox.y);
      const scale = Math.max(0.80, Math.min(1.14, Number(adjustment.fontScale ?? 1)));
      const spacingDelta = Math.max(-1.5, Math.min(6, Number(adjustment.charSpacingDeltaPt ?? 0)));
      const color = String(adjustment.color ?? "");
      if (object.type === "text") {
        const changedText = Math.abs(dx) >= 0.15 || Math.abs(dy) >= 0.15
          || Math.abs(dw) >= 0.15 || Math.abs(dh) >= 0.15
          || Math.abs(scale - 1) >= 0.002 || Math.abs(spacingDelta) >= 0.05;
        if (!changedText) continue;
        object.renderBox = {
          x: Number(nextBox.x.toFixed(4)),
          y: Number(nextBox.y.toFixed(4)),
          w: Number(nextBox.w.toFixed(4)),
          h: Number(nextBox.h.toFixed(4))
        };
        object.style.fontSizePt = Number(Math.max(6, object.style.fontSizePt * scale).toFixed(4));
        object.style.charSpacingPt = Number(Math.max(-2, Math.min(8, Number(object.style.charSpacingPt ?? 0) + spacingDelta)).toFixed(4));
        changes += 1;
        recordAction(slide, adjustment, null, null);
        continue;
      }
      const changedBox = ["x", "y", "w", "h"].some((key) => Math.abs(Number(nextBox[key]) - Number(sourceBox[key])) > 0.15);
      const changedColor = HEX_COLOR.test(color)
        && color.toUpperCase() !== String(object.color ?? object.style?.color ?? "").toUpperCase();
      if (!changedBox && !changedColor) continue;
      object.pixelBox = nextBox;
      if (changedColor) object.color = color.toUpperCase();
      if (object.type === "image") {
        const asset = (slide.ownershipReport?.assets ?? []).find((item) => String(item.objectId) === String(object.id));
        if (asset) {
          asset.pagePixelBox = { ...nextBox };
        }
      }
      changes += 1;
      recordAction(slide, adjustment, null, null);
    }
  }
  return { analysis: next, changes, appliedActions };
}

async function rebuildReconstructionPlan({ python, output, analysisPath, analysis, iteration }) {
  const reportPath = `reports/attempt-${iteration}/reconstruction-plan.json`;
  await writeJson(analysisPath, analysis);
  await run(python, [
    join(SKILL_ROOT, "scripts", "rebuild_reconstruction_plan.py"),
    analysisPath,
    "--package-root", output,
    "--report", reportPath
  ], { code: "E_RECONSTRUCTION_PLAN" });
  return JSON.parse(await readFile(analysisPath, "utf8"));
}

export function localMetricsImproved(currentVisual, candidateVisual, targetRegionKeys = null) {
  const before = (currentVisual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => ({ slideId: slide.slideId, item })));
  const afterByKey = new Map((candidateVisual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [regionKey(slide.slideId, item.id), item])));
  const topKeys = new Set((currentVisual?.slides ?? []).flatMap((slide) => (slide.repairQueue ?? []).map((id) => regionKey(slide.slideId, id))));
  const targetKeys = targetRegionKeys ? new Set(targetRegionKeys.map(String)) : topKeys;
  const relevant = before.filter(({ slideId, item }) => targetKeys.size === 0 || targetKeys.has(regionKey(slideId, item.id)));
  return relevant.some(({ slideId, item }) => {
    const after = afterByKey.get(regionKey(slideId, item.id));
    if (!after) return false;
    const improvements = [];
    if (measuredNumber(item.regionSSIM) && measuredNumber(after.regionSSIM)) improvements.push(after.regionSSIM - item.regionSSIM);
    if (measuredNumber(item.ocrCER) && measuredNumber(after.ocrCER)) improvements.push(item.ocrCER - after.ocrCER);
    if (measuredNumber(item.bboxIoU) && measuredNumber(after.bboxIoU)) improvements.push(after.bboxIoU - item.bboxIoU);
    if (measuredNumber(item.normalizedMAE) && measuredNumber(after.normalizedMAE)) improvements.push(item.normalizedMAE - after.normalizedMAE);
    if (measuredNumber(item.paletteDeltaE2000P95) && measuredNumber(after.paletteDeltaE2000P95)) improvements.push(item.paletteDeltaE2000P95 - after.paletteDeltaE2000P95);
    return improvements.some((value) => value >= 0.005);
  });
}

function hardMetricsDoNotRegress(currentVisual, candidateVisual, currentEditability, candidateEditability) {
  if (Boolean(currentVisual?.thresholds) !== Boolean(candidateVisual?.thresholds)) return false;
  if (Boolean(currentVisual?.ssim) !== Boolean(candidateVisual?.ssim)) return false;
  if (currentVisual?.thresholds && candidateVisual?.thresholds
      && canonicalValue(currentVisual.thresholds) !== canonicalValue(candidateVisual.thresholds)) return false;
  if (currentVisual?.ssim && candidateVisual?.ssim
      && canonicalValue(currentVisual.ssim) !== canonicalValue(candidateVisual.ssim)) return false;
  const before = currentVisual?.aggregate ?? {};
  const after = candidateVisual?.aggregate ?? {};
  const higherIsBetter = ["ssim", "bboxIou", "nativeHighConfidenceTextRecall"];
  const lowerIsBetter = ["ocrCer", "paletteDeltaE2000P95"];
  for (const name of higherIsBetter) {
    if (measuredNumber(before[name]) && !measuredNumber(after[name])) return false;
    if (measuredNumber(before[name]) && measuredNumber(after[name]) && after[name] + 1e-9 < before[name]) return false;
  }
  for (const name of lowerIsBetter) {
    if (measuredNumber(before[name]) && !measuredNumber(after[name])) return false;
    if (measuredNumber(before[name]) && measuredNumber(after[name]) && after[name] - 1e-9 > before[name]) return false;
  }
  if (measuredNumber(currentEditability?.rasterAreaShare) && !measuredNumber(candidateEditability?.rasterAreaShare)) return false;
  if (measuredNumber(currentEditability?.rasterAreaShare) && measuredNumber(candidateEditability?.rasterAreaShare)
      && candidateEditability.rasterAreaShare - 1e-9 > currentEditability.rasterAreaShare) return false;
  if (measuredNumber(currentEditability?.level) && measuredNumber(candidateEditability?.level)
      && candidateEditability.level < currentEditability.level) return false;
  if (measuredNumber(currentEditability?.wholeSlideRasterCount) && measuredNumber(candidateEditability?.wholeSlideRasterCount)
      && candidateEditability.wholeSlideRasterCount > currentEditability.wholeSlideRasterCount) return false;
  return true;
}

function noObservableRouteDelta(currentVisual, candidateVisual, appliedActions = []) {
  if (!appliedActions.some((item) => item.action === "route-switch" || item.category === "route")) return false;
  const beforeByKey = new Map((currentVisual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [regionKey(slide.slideId, item.id), item])));
  const afterByKey = new Map((candidateVisual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [regionKey(slide.slideId, item.id), item])));
  return appliedActions.filter((item) => item.action === "route-switch" || item.category === "route").every((item) => {
    const before = beforeByKey.get(regionKey(item.slideId, item.regionId));
    const after = afterByKey.get(regionKey(item.slideId, item.regionId));
    if (!before || !after) return false;
    const beforeDigest = before.renderCropDigest ?? null;
    const afterDigest = after.renderCropDigest ?? null;
    const metricKeys = ["regionSSIM", "ocrCER", "bboxIoU", "normalizedMAE", "paletteDeltaE2000P95"];
    return beforeDigest === afterDigest && metricKeys.every((key) => canonicalValue(before[key]) === canonicalValue(after[key]));
  });
}

async function runCandidate({ python, output, analysis, iteration, attemptId = String(iteration), appliedActions = [] }) {
  const attempt = join(output, "reports", `attempt-${attemptId}`);
  await mkdir(attempt, { recursive: true });
  const analysisPath = join(attempt, "analysis.json");
  const pptxPath = join(attempt, "candidate.pptx");
  const editabilityPath = join(attempt, "editability-report.json");
  const previewDir = join(attempt, "preview");
  const renderReportPath = join(attempt, "render-report.json");
  const visualPath = join(attempt, "visual-report.json");
  let candidateAnalysis = analysis;
  if (iteration > 0) {
    candidateAnalysis = await rebuildReconstructionPlan({ python, output, analysisPath, analysis, iteration: attemptId });
  } else {
    await writeFile(analysisPath, `${JSON.stringify(candidateAnalysis, null, 2)}\n`);
  }
  // Validate every candidate's plan/ref/digest before the renderer consumes it.
  await validateReconstructionPlan(output, candidateAnalysis);
  analysis = candidateAnalysis;
  const rendered = await renderPptx(analysisPath, pptxPath, editabilityPath, output);
  await run(python, [
    join(SKILL_ROOT, "scripts", "render_preview.py"),
    pptxPath,
    previewDir,
    "--width-px", String(analysis.deck.size.widthPx),
    "--height-px", String(analysis.deck.size.heightPx),
    "--report", renderReportPath,
    "--relative-to", output
  ], { code: "E_RENDER_RUNTIME" });
  const previewReport = JSON.parse(await readFile(renderReportPath, "utf8"));
  previewReport.fonts = await diagnoseFonts(analysis);
  previewReport.fontInventory = analysis.fontInventoryRef;
  previewReport.lineage = {
    sourcePptx: {
      path: relativeTo(output, pptxPath),
      sha256: await digest(pptxPath)
    },
    reconstructionPlanRef: analysis.reconstructionPlanRef,
    preview: {
      directory: relativeTo(output, previewDir),
      pages: []
    }
  };
  for (const page of previewReport.pages ?? []) {
    const pagePath = resolve(output, page);
    previewReport.lineage.preview.pages.push({
      path: relativeTo(output, pagePath),
      sha256: await digest(pagePath)
    });
  }
  await writeJson(renderReportPath, previewReport);
  await run(python, [
    join(SKILL_ROOT, "scripts", "measure_visual.py"),
    analysisPath,
    previewDir,
    "--package-root", output,
    "--diff-dir", join(attempt, "diff"),
    "--output", visualPath
  ], { code: "E_VISUAL_MEASURE" });
  const visual = JSON.parse(await readFile(visualPath, "utf8"));
  const editability = rendered.editability;
  const finalQualityPassed = accepted(visual, editability, analysis, previewReport);
  return {
    iteration,
    attemptId,
    attempt,
    analysis,
    analysisPath,
    pptxPath,
    editabilityPath,
    previewDir,
    renderReportPath,
    visualPath,
    visual,
    editability,
    appliedActions,
    accepted: finalQualityPassed,
    finalQualityPassed,
    stepAccepted: false,
    selectedForNextRound: false,
    progressed: false,
    score: scoreVisual(visual, editability)
  };
}

export function boundedRepairBeam(visual) {
  const regionsByKey = new Map((visual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [regionKey(slide.slideId, item.id), item])));
  const ordered = (visual?.slides ?? []).flatMap((slide) => (slide.repairCandidates ?? [])
    .filter((item) => item.status === "proposed" && Array.isArray(item.actions) && item.actions.length > 0)
    .map((item) => ({ ...item, slideId: slide.slideId, impact: regionsByKey.get(regionKey(slide.slideId, item.regionId))?.impact ?? null })))
    .sort((left, right) => (
      (measuredNumber(right.impact) ? right.impact : -1) - (measuredNumber(left.impact) ? left.impact : -1)
      || String(left.slideId).localeCompare(String(right.slideId))
      || String(left.regionId).localeCompare(String(right.regionId))
      || String(left.candidateId).localeCompare(String(right.candidateId))
    ));
  const selected = [];
  const selectedRegions = new Set();
  for (const candidate of ordered) {
    if (selected.length >= REPAIR_BEAM_WIDTH) break;
    const key = regionKey(candidate.slideId, candidate.regionId);
    if (selectedRegions.has(key)) continue;
    selected.push(candidate);
    selectedRegions.add(key);
  }
  for (const candidate of ordered) {
    if (selected.length >= REPAIR_BEAM_WIDTH) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

export async function summarizeBeamEvaluations(output, evaluated) {
  return Promise.all(evaluated.map(async (item) => {
    let candidateRef = null;
    let candidateDigest = null;
    if (item.pptxPath) {
      candidateDigest = await digest(item.pptxPath);
      candidateRef = { path: relativeTo(output, item.pptxPath), sha256: candidateDigest };
    }
    return {
      candidateId: item.candidateId ?? item.beamCandidate?.candidateId ?? null,
      regionId: item.regionId ?? item.beamCandidate?.regionId ?? null,
      action: item.action ?? item.beamCandidate?.action ?? null,
      accepted: Boolean(item.stepAccepted ?? item.accepted),
      stepAccepted: item.stepAccepted ?? false,
      selectedForNextRound: Boolean(item.selectedForNextRound),
      finalQualityPassed: Boolean(item.finalQualityPassed ?? item.accepted),
      rejectionReason: item.rejectionReason ?? null,
      candidateDigest,
      candidateRef,
      reconstructionPlanRef: item.analysis?.reconstructionPlanRef ?? null
    };
  }));
}

function visualForBeamCandidate(visual, beamCandidate) {
  const next = structuredClone(visual);
  next.calibration = (next.slides ?? []).map((slide) => {
    const selected = String(slide.slideId) === String(beamCandidate.slideId);
    if (!selected) return { slideId: slide.slideId, adjustments: [], topRegionIds: [] };
    return {
      slideId: slide.slideId,
      adjustments: beamCandidate.actions,
      topRegionIds: [String(beamCandidate.regionId)],
      candidateBeam: [beamCandidate]
    };
  });
  return next;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function allFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(root, path));
    else if (entry.isFile()) files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return files;
}

async function publishRun({ output, best, history, maxRepairs, htmlPackage }) {
  const passed = best.accepted;
  const analysis = best.analysis;
  const pptxName = passed ? "final.pptx" : "failed-candidate.pptx";
  const pptxPath = join(output, pptxName);
  const previewName = passed ? "preview" : "failed-preview";
  const previewPath = join(output, previewName);
  // Publish the candidate and its preview as complete filesystem entries. A
  // partially copied final must never be observable as a delivery artifact.
  await atomicCopyFile(best.pptxPath, pptxPath);
  await atomicCopyDirectory(best.previewDir, previewPath);
  await copyFile(best.analysisPath, join(output, "analysis.json"));
  await copyFile(best.visualPath, join(output, "reports", "visual-report.json"));
  await copyFile(best.editabilityPath, join(output, "reports", "editability-report.json"));
  await copyFile(best.renderReportPath, join(output, "reports", "render-report.json"));
  await validatePublishedReference(output, analysis.reconstructionPlanRef, "reconstruction plan");
  await validatePublishedReference(output, analysis.fontInventoryRef, "font inventory");
  const renderReportPath = join(output, "reports", "render-report.json");
  const renderReport = JSON.parse(await readFile(renderReportPath, "utf8"));
  const publishedPages = [];
  for (const page of (await readdir(previewPath)).filter((name) => name.endsWith(".png")).sort()) {
    const pagePath = join(previewPath, page);
    publishedPages.push({
      path: relativeTo(output, pagePath),
      sha256: await digest(pagePath)
    });
  }
  renderReport.lineage = {
    sourcePptx: { path: pptxName, sha256: await digest(pptxPath) },
    reconstructionPlanRef: analysis.reconstructionPlanRef,
    preview: { directory: `${previewName}/`, pages: publishedPages }
  };
  await writeJson(renderReportPath, renderReport);
  const findings = [
    ...(best.visual.findings ?? []),
    ...(best.editability.findings ?? [])
  ];
  const ownershipReports = analysis.slides.map((slide) => slide.ownershipReport);
  const ownership = {
      status: ownershipReports.every((report) => report && report.status === "passed"
        && Number(report.conflictPixels ?? 0) === 0
        && Number(report.rasterNativeOverlapPixels ?? 0) === 0
        && Number(report.duplicateVisibleContent ?? 0) === 0
        && Number(report.unassignedShare ?? 0) <= Number(report.unassignedBudget ?? 0)) ? "passed" : "failed",
      report: "analysis.json",
      conflictPixels: ownershipReports.reduce((sum, report) => sum + Number(report?.conflictPixels ?? 0), 0),
      rasterNativeOverlapPixels: ownershipReports.reduce((sum, report) => sum + Number(report?.rasterNativeOverlapPixels ?? 0), 0),
      duplicateVisibleContent: ownershipReports.reduce((sum, report) => sum + Number(report?.duplicateVisibleContent ?? 0), 0),
      unassignedPixels: ownershipReports.reduce((sum, report) => sum + Number(report?.unassignedPixels ?? 0), 0)
    };
  const repairSafetyPages = await Promise.all(analysis.slides.map(async (slide) => ({
    slideId: String(slide.id),
    ...(await reconstructionRepairSafety(slide, output))
  })));
  const repairSafety = {
    status: repairSafetyPages.every((page) => page.status === "passed") ? "passed" : "failed",
    report: "analysis.json",
    pages: repairSafetyPages
  };
  const repairHistory = await Promise.all(history.map(async (candidate, index) => {
    const previous = history[index - 1] ?? null;
    const beforeRegions = new Map((previous?.visual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [regionKey(slide.slideId, item.id), item])));
    const metricSnapshot = (region) => region ? {
      regionId: String(region.id),
      measurement: region.measurement ?? "source-render-crop",
      metricStatus: region.metricStatus ?? {},
      impactStatus: region.impactStatus ?? {},
      impact: measuredNumber(region.impact) ? region.impact : null,
      regionSSIM: measuredNumber(region.regionSSIM) ? region.regionSSIM : null,
      ocrCER: measuredNumber(region.ocrCER) ? region.ocrCER : null,
      bboxIoU: measuredNumber(region.bboxIoU) ? region.bboxIoU : null,
      normalizedMAE: measuredNumber(region.normalizedMAE) ? region.normalizedMAE : null,
      paletteDeltaE2000P95: measuredNumber(region.paletteDeltaE2000P95) ? region.paletteDeltaE2000P95 : null,
      sourceCropDigest: typeof region.sourceCropDigest === "string" ? region.sourceCropDigest : null,
      renderCropDigest: typeof region.renderCropDigest === "string" ? region.renderCropDigest : null
    } : null;
    const regionEntries = (candidate.appliedActions ?? []).map((item) => {
      const slide = (candidate.visual?.slides ?? []).find((value) => String(value.slideId) === String(item.slideId));
      const after = slide?.regionMeasurements?.find((region) => String(region.id) === String(item.regionId));
      const before = beforeRegions.get(regionKey(item.slideId, item.regionId));
      const beforePlan = previous?.analysis?.slides?.find((value) => String(value.id) === String(item.slideId))?.reconstructionPlan?.regions?.find((region) => String(region.id) === String(item.regionId));
      const afterPlan = candidate.analysis?.slides?.find((value) => String(value.id) === String(item.slideId))?.reconstructionPlan?.regions?.find((region) => String(region.id) === String(item.regionId));
      const strategyFor = (planRegion) => planRegion?.candidates?.find((value) => String(value.id) === String(planRegion?.winnerId))?.strategy ?? null;
      const metricDelta = {};
      for (const name of ["regionSSIM", "ocrCER", "bboxIoU", "normalizedMAE", "paletteDeltaE2000P95"]) {
        if (measuredNumber(before?.[name]) && measuredNumber(after?.[name])) metricDelta[name] = Number((after[name] - before[name]).toFixed(8));
      }
      return {
        slideId: String(item.slideId),
        regionId: String(item.regionId),
        action: item.action,
        id: item.id ?? null,
        category: item.category ?? null,
        targetStrategy: item.targetStrategy ?? null,
        beforeStrategy: strategyFor(beforePlan),
        afterStrategy: strategyFor(afterPlan),
        sourceBound: item.sourceBound === true,
        beforeMetrics: metricSnapshot(before),
        afterMetrics: metricSnapshot(after),
        deltaMetrics: metricDelta
      };
    });
    const candidateDigest = await digest(candidate.pptxPath);
    const analysisDigest = await digest(candidate.analysisPath);
    const visualDigest = await digest(candidate.visualPath);
    const renderDigest = await digest(candidate.renderReportPath);
    const editabilityDigest = await digest(candidate.editabilityPath);
    return {
      round: candidate.iteration,
      iteration: candidate.iteration,
      regionId: regionEntries[0]?.regionId ?? null,
      action: regionEntries[0]?.action ?? "none",
      actions: regionEntries,
      beforeStrategy: regionEntries[0]?.beforeStrategy ?? null,
      afterStrategy: regionEntries[0]?.afterStrategy ?? null,
      beforeMetrics: regionEntries[0]?.beforeMetrics ?? null,
      afterMetrics: regionEntries[0]?.afterMetrics ?? null,
      deltaMetrics: regionEntries[0]?.deltaMetrics ?? {},
      rasterDelta: measuredNumber(candidate.editability?.rasterAreaShare) && measuredNumber(previous?.editability?.rasterAreaShare)
        ? Number((candidate.editability.rasterAreaShare - previous.editability.rasterAreaShare).toFixed(8))
        : null,
      stepAccepted: Boolean(candidate.stepAccepted),
      selectedForNextRound: Boolean(candidate.selectedForNextRound),
      finalQualityPassed: Boolean(candidate.finalQualityPassed ?? candidate.accepted),
      accepted: Boolean(candidate.stepAccepted),
      rejectionReason: candidate.rejectionReason ?? null,
      candidateRef: { path: relativeTo(output, candidate.pptxPath), sha256: candidateDigest },
      analysisRef: { path: relativeTo(output, candidate.analysisPath), sha256: analysisDigest },
      visualReportRef: { path: relativeTo(output, candidate.visualPath), sha256: visualDigest },
      renderReportRef: { path: relativeTo(output, candidate.renderReportPath), sha256: renderDigest },
      editabilityReportRef: { path: relativeTo(output, candidate.editabilityPath), sha256: editabilityDigest },
      candidateDigest,
      reconstructionPlanRef: candidate.analysis.reconstructionPlanRef,
      candidatePlanDigest: candidate.analysis.reconstructionPlanRef?.sha256 ?? null,
      score: candidate.score,
      visualStatus: candidate.visual.status,
      editabilityLevel: candidate.editability.level,
      status: candidate.iteration === 0 ? "baseline" : "applied",
      beamEvaluations: candidate.beamEvaluations ?? []
    };
  }));
  const qa = {
    version: "1.0.0",
    status: passed ? "passed" : "failed",
    gate: "image-native-reconstruction",
    thresholds: best.visual.thresholds,
    slideCount: analysis.slides.length,
    attemptsUsed: history.length - 1,
    maxRepairAttempts: maxRepairs,
    reconstructionPlanRef: analysis.reconstructionPlanRef,
    render: {
      engine: renderReport.engine,
      requestedSize: renderReport.requestedSize,
      report: "reports/render-report.json"
    },
    visual: {
      status: best.visual.status,
      aggregate: best.visual.aggregate,
      ssim: best.visual.ssim,
      report: "reports/visual-report.json"
    },
    runtime: renderReport.runtime,
    fonts: renderReport.fonts,
    fontInventory: analysis.fontInventoryRef,
    editability: {
      status: best.editability.status,
      level: best.editability.level,
      nativeTextRecall: best.editability.nativeTextRecall,
      nativeObjectCount: best.editability.nativeObjectCount,
      rasterObjectCount: best.editability.rasterObjectCount,
      rasterAreaShare: best.editability.rasterAreaShare,
      wholeSlideRasterCount: best.editability.wholeSlideRasterCount,
      report: "reports/editability-report.json"
    },
    ownership,
    repairSafety,
    repairHistory,
    degradations: analysis.degradations,
    findings,
    artifacts: {
      pptx: pptxName,
      preview: passed ? "preview/" : "failed-preview/",
      analysis: "analysis.json",
      ocr: "ocr-report.json",
      lowConfidence: "reports/low-confidence/"
    }
  };
  const qaPath = join(output, "qa-report.json");
  await writeJson(qaPath, qa);
  let html = null;
  if (passed && htmlPackage) {
    html = await buildHtmlPackage(join(output, "analysis.json"), qaPath, join(output, "html-package"));
  }
  const qaDigest = await digest(qaPath);
  const previewSummary = {
    directory: `${previewName}/`,
    pageCount: publishedPages.length,
    pages: publishedPages
  };
  const artifacts = (await allFiles(output))
    .filter((path) => path !== "run.json" && path !== "failure.json");
  const indexed = [];
  for (const artifact of artifacts) {
    const path = join(output, artifact);
    indexed.push({ path: artifact, sha256: await digest(path), bytes: (await stat(path)).size });
  }
  const runIndex = {
    version: "1.0.0",
    producer: { skill: "image-to-pptx", version: "2.0.0" },
    status: qa.status,
    slideCount: analysis.slides.length,
    sourceDigests: analysis.sources.map((source) => ({
      id: source.id,
      path: source.path,
      sha256: source.sha256
    })),
    summary: {
      qa: { path: "qa-report.json", sha256: qaDigest },
      pptx: { path: pptxName, sha256: await digest(pptxPath) },
      preview: previewSummary,
      renderReport: { path: "reports/render-report.json", sha256: await digest(renderReportPath) },
      reconstructionPlanRef: analysis.reconstructionPlanRef
    },
    artifacts: indexed,
    protocol: html ? { id: "pptx-creator.presentation-package", version: "1.0.0", path: "html-package/presentation-package.json" } : null
  };
  await writeJson(join(output, "run.json"), runIndex);
  if (!passed) {
    const failure = {
      version: "1.0.0",
      status: "failed",
      code: "E_QUALITY_GATE",
      message: `quality gate failed after ${history.length - 1} repair attempts`,
      remainingFindings: findings,
      candidate: pptxName,
      qaReport: "qa-report.json"
    };
    await writeJson(join(output, "failure.json"), failure);
  }
  return { qa, runIndex, pptxPath, html };
}

export async function build(options) {
  const inputs = await collectInputs(options.inputs);
  const output = await prepareOutput(options.output);
  try {
    const python = await pythonCommand();
    await mkdir(join(output, "sources"), { recursive: true });
    await mkdir(join(output, "assets"), { recursive: true });
    await mkdir(join(output, "reports", "low-confidence"), { recursive: true });
    const copied = [];
    for (const [index, source] of inputs.entries()) {
      const suffix = extname(source).toLowerCase();
      const target = join(output, "sources", `slide-${String(index + 1).padStart(3, "0")}${suffix}`);
      await copyFile(source, target);
      copied.push(target);
    }
    const analysisPath = join(output, "analysis.json");
    const ocrPath = join(output, "ocr-report.json");
    await run(python, [
      join(SKILL_ROOT, "scripts", "analyze_images.py"),
      ...copied,
      "--package-root", output,
      "--output", analysisPath,
      "--ocr-report", ocrPath,
      "--assets-dir", join(output, "assets"),
      "--annotations-dir", join(output, "reports", "low-confidence"),
      "--title", options.title || basename(inputs[0], extname(inputs[0])),
      "--langs", options.langs,
      "--ocr-threshold", String(options.ocrThreshold)
    ], { code: "E_ANALYSIS" });
    let analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    await writeJson(join(output, "design-tokens.json"), analysis.designTokens);
    await writeJson(join(output, "reports", "degradation-log.json"), {
      version: "1.0.0",
      degradations: analysis.degradations
    });
    const history = [];
    let best = await runCandidate({ python, output, analysis, iteration: 0 });
    let current = best;
    history.push(best);
    for (let iteration = 1; !best.accepted && iteration <= options.maxRepairs; iteration += 1) {
      const beam = boundedRepairBeam(current.visual);
      if (!beam.length) break;
      const evaluated = [];
      for (const [beamIndex, beamCandidate] of beam.entries()) {
        const trialVisual = visualForBeamCandidate(current.visual, beamCandidate);
        const calibrated = applyCalibration(current.analysis, trialVisual);
        if (!calibrated.changes) {
          evaluated.push({ candidateId: beamCandidate.candidateId, regionId: beamCandidate.regionId, action: beamCandidate.action, rejectionReason: "no-applicable-source-bound-action" });
          continue;
        }
        try {
          const candidate = await runCandidate({
            python,
            output,
            analysis: calibrated.analysis,
            iteration,
            attemptId: `${iteration}-candidate-${beamIndex + 1}`,
            appliedActions: calibrated.appliedActions
          });
          const progressed = repairHasProgress(current, candidate);
          candidate.progressed = progressed;
          candidate.stepAccepted = progressed;
          candidate.finalQualityPassed = Boolean(candidate.accepted);
          if (!progressed) {
            candidate.accepted = false;
            candidate.rejectionReason = noObservableRouteDelta(current.visual, candidate.visual, calibrated.appliedActions)
              ? "no-observable-render-delta"
              : hardMetricsDoNotRegress(current.visual, candidate.visual, current.editability, candidate.editability)
                ? "no-local-hard-metric-improvement"
                : "full-page-hard-regression";
          }
          candidate.beamCandidate = beamCandidate;
          evaluated.push(candidate);
        } catch (error) {
          evaluated.push({ candidateId: beamCandidate.candidateId, regionId: beamCandidate.regionId, action: beamCandidate.action, rejectionReason: error.code ?? "candidate-render-failed", error: error.message });
        }
      }
      const viable = evaluated.filter((candidate) => candidate.visual && candidate.progressed === true);
      if (!viable.length) {
        // Keep the failed round's evidence on the already-published current
        // candidate. The history array owns this same object, so a failed
        // bounded round remains auditable even when no candidate is selected.
        const beamEvaluations = await summarizeBeamEvaluations(output, evaluated);
        current.beamEvaluations = [...(current.beamEvaluations ?? []), ...beamEvaluations];
        break;
      }
      viable.sort((left, right) => Number(right.accepted) - Number(left.accepted) || left.score - right.score || String(left.beamCandidate?.candidateId ?? "").localeCompare(String(right.beamCandidate?.candidateId ?? "")));
      const candidate = viable[0];
      for (const item of evaluated) item.selectedForNextRound = item === candidate;
      const beamEvaluations = await summarizeBeamEvaluations(output, evaluated);
      candidate.beamEvaluations = beamEvaluations;
      history.push(candidate);
      candidate.selectedForNextRound = true;
      best = candidate;
      analysis = candidate.analysis;
      current = candidate;
    }
    const published = await publishRun({
      output,
      best,
      history,
      maxRepairs: options.maxRepairs,
      htmlPackage: options.htmlPackage
    });
    // No result is returned until both the JSON schemas and the emitted
    // filesystem lineage (paths, digests, and preview source) validate.
    const validated = await validateOutput(output);
    if (!best.accepted) {
      const error = cliError("E_QUALITY_GATE", `quality gate failed; see ${join(output, "failure.json")}`, 2);
      error.summary = { output, qa: published.qa, history: history.map((item) => ({ iteration: item.iteration, score: item.score })) };
      throw error;
    }
    return {
      status: "passed",
      output,
      pptx: published.pptxPath,
      qaReport: join(output, "qa-report.json"),
      htmlPackage: published.html?.outputDir ?? null,
      attempts: history.length - 1,
      validation: validated
    };
  } catch (error) {
    if (error.code !== "E_QUALITY_GATE") {
      // A protocol/schema/lineage failure after rendering must not leave a
      // superficially complete delivery behind. Attempt reports and source
      // evidence remain available for diagnosis.
      await removeIncompleteDelivery(output);
      await writeJson(join(output, "failure.json"), {
        version: "1.0.0",
        status: "failed",
        code: error.code ?? "E_UNKNOWN",
        message: error.message
      });
    }
    throw error;
  }
}

async function doctor() {
  const checks = [];
  const check = async (name, command, args) => {
    try {
      const result = await run(command, args, { timeout: 30_000, code: `E_${name.toUpperCase()}_RUNTIME` });
      checks.push({ name, status: "available", version: String(result.stdout || result.stderr).split("\n")[0].trim() });
    } catch (error) {
      checks.push({ name, status: "missing", detail: error.message });
    }
  };
  const python = process.env.IMAGE_TO_PPTX_PYTHON || "python3";
  await check("python", python, [
    "-c",
    "import platform, PIL, pytesseract, numpy, skimage; " +
      "print('Python ' + platform.python_version() + '; '" +
      "+ 'Pillow ' + PIL.__version__ + '; pytesseract ' + pytesseract.__version__ " +
      "+ '; numpy ' + numpy.__version__ + '; scikit-image ' + skimage.__version__)"
  ]);
  await check("fontTools", python, ["-c", "import fontTools; print('fontTools ' + fontTools.__version__)"]);
  await check("tesseract", "tesseract", ["--version"]);
  await check("libreoffice", "soffice", ["--version"]);
  await check("pdftoppm", "pdftoppm", ["-v"]);
  const result = {
    status: checks.every((item) => item.status === "available") ? "passed" : "failed",
    skill: "image-to-pptx",
    version: "2.0.0",
    checks
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  if (command === "doctor") return doctor();
  if (command === "build") {
    const result = await build(parseBuild(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write("Usage: image-to-pptx.mjs doctor | build --output DIR [options] IMAGE...\n");
  if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error.code ?? "E_UNKNOWN",
      message: error.message,
      ...(error.summary ? { summary: error.summary } : {})
    }, null, 2)}\n`);
    process.exitCode = Number(error.exitCode ?? 1);
  });
}
