import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_ROOT = join(SKILL_ROOT, "tests", "fixtures", "visual-benchmark-matrix");
export const MANIFEST_PATH = join(FIXTURE_ROOT, "manifest.json");
export const CLI_PATH = join(SKILL_ROOT, "scripts", "image-to-pptx.mjs");

export const MATRIX_CATEGORIES = Object.freeze([
  "zh-dense",
  "en-info",
  "mixed-language",
  "flowchart",
  "table-dashboard",
  "photography",
  "illustration",
  "effects",
  "low-resolution",
  "portrait-non16x9"
]);

export const MATRIX_THRESHOLDS = Object.freeze({
  ssim: { operator: ">=", value: 0.94 },
  ocrCer: { operator: "<=", value: 0.02 },
  bboxIou: { operator: ">=", value: 0.90 },
  paletteDeltaE2000P95: { operator: "<=", value: 3.0 },
  nativeHighConfidenceTextRecall: { operator: ">=", value: 0.90 },
  editability: { operator: ">=", value: 3 },
  wholeSlideRaster: { operator: "==", value: 0 },
  ownershipOverlap: { operator: "==", value: 0 },
  ownershipConflict: { operator: "==", value: 0 },
  rasterAreaShare: { operator: "<=", value: 0.65 }
});

export const MATRIX_BUDGET = Object.freeze({
  caseTimeoutMs: 300_000,
  categoryTimeoutMs: 1_200_000,
  maxCommands: 10,
  maxRepairs: 3,
  objectMultiplier: 4,
  objectAllowance: 50
});

const LANGS_BY_CATEGORY = Object.freeze({
  "zh-dense": "eng+chi_sim",
  "mixed-language": "eng+chi_sim"
});
const ROUTES = new Set(["native-all", "native-plus-local-assets", "bounded-raster"]);
const HEX_DIGEST = /^[0-9a-f]{64}$/iu;
const MANIFEST_THRESHOLD_NAMES = Object.freeze({
  ocrCer: "cer",
  bboxIou: "bboxIoU",
  nativeHighConfidenceTextRecall: "nativeTextRecall"
});

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function digestManifestObject(manifest) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(manifest))).digest("hex");
}

export function safeRelativePath(root, value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value)) {
    throw error("E_MATRIX_PATH", `${label} must be a relative path`);
  }
  const parts = value.split(/[\\/]+/u);
  if (parts.includes("..")) throw error("E_MATRIX_PATH", `${label} contains traversal`);
  const base = resolve(root);
  const target = resolve(base, value);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw error("E_MATRIX_PATH", `${label} escapes root`);
  }
  return target;
}

export function sampleOutputPath(root, sampleId) {
  if (typeof sampleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sampleId)) {
    throw error("E_MATRIX_PATH", "sample id is not a safe output token");
  }
  return safeRelativePath(root, join("runs", sampleId), "sample output");
}

export function assertManifestPolicy(manifest) {
  if (manifest?.deterministic?.network !== false || manifest?.deterministic?.model !== null) {
    throw error("E_MATRIX_POLICY", "manifest permits network or a model");
  }
  if (!Number.isInteger(manifest?.deterministic?.seed)) throw error("E_MATRIX_POLICY", "manifest seed is not fixed");
  for (const [name, rule] of Object.entries(MATRIX_THRESHOLDS)) {
    const declared = manifest?.thresholds?.[MANIFEST_THRESHOLD_NAMES[name] ?? name];
    if (!declared || declared.operator !== rule.operator || Number(declared.value) !== rule.value) {
      throw error("E_MATRIX_POLICY", `manifest threshold ${name} differs from the fixed gate`);
    }
  }
  if (manifest?.evaluation?.status !== "not-run" || manifest?.evaluation?.visualResults !== null) {
    throw error("E_MATRIX_POLICY", "manifest evaluation must remain not-run with null visualResults");
  }
  for (const sample of manifest?.samples ?? []) {
    const evaluation = sample?.evaluation;
    if (evaluation?.status !== "not-run" || evaluation?.metrics !== null
        || (Object.hasOwn(evaluation ?? {}, "visualResults") && evaluation.visualResults !== null)
        || (Object.hasOwn(evaluation ?? {}, "renderingResult") && evaluation.renderingResult !== null)) {
      throw error("E_MATRIX_POLICY", `${sample?.id ?? "sample"} evaluation must remain not-run with null results`);
    }
  }
}

export function selectCategory(manifest, category) {
  if (!MATRIX_CATEGORIES.includes(category)) {
    throw error("E_MATRIX_CATEGORY", `IMAGE_TO_PPTX_MATRIX_CATEGORY must be one of: ${MATRIX_CATEGORIES.join(", ")}`);
  }
  const samples = (manifest.samples ?? []).filter((sample) => sample.category === category);
  const expected = Number(manifest.quotas?.[category] ?? manifest.categoryQuotas?.[category] ?? 0);
  if (samples.length !== expected || ![5, 10].includes(expected)) {
    throw error("E_MATRIX_QUOTA", `${category} has ${samples.length} samples; expected a 5/10 quota`);
  }
  return samples.sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
}

function thresholdErrors(metrics) {
  const failures = [];
  for (const [name, rule] of Object.entries(MATRIX_THRESHOLDS)) {
    if (!(name in metrics) || !Number.isFinite(Number(metrics[name]))) {
      failures.push(`${name} is unavailable`);
      continue;
    }
    const value = Number(metrics[name]);
    if (rule.operator === ">=" && value < rule.value) failures.push(`${name} ${value} < ${rule.value}`);
    if (rule.operator === "<=" && value > rule.value) failures.push(`${name} ${value} > ${rule.value}`);
    if (rule.operator === "==" && value !== rule.value) failures.push(`${name} ${value} != ${rule.value}`);
  }
  return failures;
}

export function validateMetrics(metrics) {
  const failures = thresholdErrors(metrics);
  if (failures.length) throw error("E_MATRIX_METRIC", failures.join("; "));
  return true;
}

export function validateObjectCount(sample, objectCount, budgets = MATRIX_BUDGET) {
  const maxObjects = Number(sample.truth?.objectCount ?? 0) * budgets.objectMultiplier + budgets.objectAllowance;
  if (Number(objectCount) > maxObjects) throw error("E_MATRIX_OBJECT_EXPLOSION", `${sample.id} has ${objectCount} objects; max ${maxObjects}`);
  return { objectCount: Number(objectCount), maxObjects };
}

function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) {
        if (offset + 7 > buffer.length) break;
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += Math.max(2, length);
    }
  }
  throw error("E_MATRIX_IMAGE", "cannot read preview image dimensions");
}

async function assertPreviewDimensions(output, run, expected) {
  const pages = run?.summary?.preview?.pages;
  if (!Array.isArray(pages) || pages.length !== 1) throw error("E_MATRIX_RENDER_SIZE", "run summary has no single preview page");
  const path = safeRelativePath(output, pages[0], "preview page");
  const actual = imageDimensions(await readFile(path));
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw error("E_MATRIX_RENDER_SIZE", `preview is ${actual.width}x${actual.height}; expected ${expected.width}x${expected.height}`);
  }
}

export async function assertAssetReferences(output, analysis) {
  const sourceById = new Map((analysis.sources ?? []).map((source) => [String(source.id), source]));
  let assetCount = 0;
  for (const slide of analysis.slides ?? []) {
    for (const asset of slide.ownershipReport?.assets ?? []) {
      assetCount += 1;
      const assetPath = safeRelativePath(output, asset.asset, `${asset.objectId}.asset`);
      const maskPath = safeRelativePath(output, asset.mask, `${asset.objectId}.mask`);
      if (!HEX_DIGEST.test(String(asset.assetDigest)) || !HEX_DIGEST.test(String(asset.maskDigest))) {
        throw error("E_MATRIX_PROVENANCE", `${asset.objectId} asset/mask digest is incomplete`);
      }
      if (await digest(assetPath) !== asset.assetDigest || await digest(maskPath) !== asset.maskDigest) {
        throw error("E_MATRIX_PROVENANCE", `${asset.objectId} asset/mask digest mismatch`);
      }
      const source = sourceById.get(String(asset.sourceRef));
      const normalizedSourceDigest = source?.normalizedSha256;
      if (!source || !HEX_DIGEST.test(String(normalizedSourceDigest)) || !HEX_DIGEST.test(String(asset.sourceDigest))
          || !HEX_DIGEST.test(String(asset.normalizedSourceDigest))
          || String(asset.sourceDigest) !== String(normalizedSourceDigest)
          || String(asset.normalizedSourceDigest) !== String(normalizedSourceDigest)) {
        throw error("E_MATRIX_PROVENANCE", `${asset.objectId} source provenance is incomplete`);
      }
      const sourcePath = safeRelativePath(output, source.path, `${asset.objectId}.source`);
      if (await digest(sourcePath) !== String(source.sha256)) throw error("E_MATRIX_PROVENANCE", `${asset.objectId} original source digest mismatch`);
      if (source.normalizedPath) {
        const normalizedPath = safeRelativePath(output, source.normalizedPath, `${asset.objectId}.normalizedSource`);
        if (await digest(normalizedPath) !== String(normalizedSourceDigest)) throw error("E_MATRIX_PROVENANCE", `${asset.objectId} normalized source digest mismatch`);
      }
    }
  }
  return assetCount;
}

async function assertSourceBinding(output, source, sample) {
  if (!source || String(source.sha256) !== String(sample.source.sha256) || !HEX_DIGEST.test(String(source.sha256))) {
    throw error("E_MATRIX_PROVENANCE", `${sample.id} analysis source digest differs from manifest`);
  }
  const normalizedSourceDigest = source.normalizedSha256;
  if (!HEX_DIGEST.test(String(normalizedSourceDigest))
      || !source.normalizedSha256) {
    throw error("E_MATRIX_PROVENANCE", `${sample.id} normalized source digest fields disagree`);
  }
  const sourcePath = safeRelativePath(output, source.path, `${sample.id}.source`);
  if (await digest(sourcePath) !== source.sha256) throw error("E_MATRIX_PROVENANCE", `${sample.id} original source digest mismatch`);
  if (!source.normalizedPath) throw error("E_MATRIX_PROVENANCE", `${sample.id} normalized source path is missing`);
  const normalizedPath = safeRelativePath(output, source.normalizedPath, `${sample.id}.normalizedSource`);
  if (await digest(normalizedPath) !== normalizedSourceDigest) throw error("E_MATRIX_PROVENANCE", `${sample.id} normalized source digest mismatch`);
  return normalizedSourceDigest;
}

function winnerStrategies(analysis) {
  return (analysis.slides ?? []).flatMap((slide) => (slide.reconstructionPlan?.regions ?? [])
    .map((region) => region.candidates?.find((candidate) => String(candidate.id) === String(region.winnerId))?.strategy)
    .filter(Boolean));
}

export function routeContract(sample, analysis, assetCount) {
  const expected = sample.acceptedStrategy?.route;
  if (!ROUTES.has(expected)) throw error("E_MATRIX_ROUTE", `${sample.id} has an invalid acceptedStrategy.route`);
  const strategies = winnerStrategies(analysis);
  if (!strategies.length) throw error("E_MATRIX_ROUTE", `${sample.id} has no reconstruction-plan winners`);
  const unique = [...new Set(strategies)];
  if (unique.some((strategy) => !ROUTES.has(strategy))) throw error("E_MATRIX_ROUTE", `${sample.id} has an unknown winner strategy`);
  if (expected === "native-all" && (assetCount !== 0 || unique.some((value) => value !== "native-all"))) {
    throw error("E_MATRIX_ROUTE", `${sample.id} expected native-all; winners=${unique.join(",")}; assets=${assetCount}`);
  }
  if (expected === "native-plus-local-assets" && (assetCount < 1 || !unique.some((value) => ["native-plus-local-assets", "bounded-raster"].includes(value)))) {
    throw error("E_MATRIX_ROUTE", `${sample.id} expected local assets; winners=${unique.join(",")}; assets=${assetCount}`);
  }
  if (expected === "bounded-raster" && (assetCount < 1 || !unique.includes("bounded-raster"))) {
    throw error("E_MATRIX_ROUTE", `${sample.id} expected bounded-raster; winners=${unique.join(",")}; assets=${assetCount}`);
  }
  return { expected, winners: unique, assetCount, matched: true };
}

export async function validateSampleArtifacts({ sample, output, qa, run, analysis, render, visual, editability }) {
  if (!qa || !run || !analysis || !render || !visual || !editability) throw error("E_MATRIX_ARTIFACT", `${sample.id} has incomplete result artifacts`);
  if (qa.status !== "passed" || run.status !== "passed" || visual.status !== "passed" || editability.status !== "passed") {
    throw error("E_MATRIX_STATUS", `${sample.id} did not pass all result statuses`);
  }
  const source = analysis.sources?.find((item) => String(item.id) === String(analysis.slides?.[0]?.sourceRef)) ?? analysis.sources?.[0];
  const expectedSize = sample.dimensions;
  if (!source || source.originalSize?.width !== expectedSize.width || source.originalSize?.height !== expectedSize.height) {
    throw error("E_MATRIX_SOURCE_SIZE", `${sample.id} source dimensions differ from manifest`);
  }
  await assertSourceBinding(output, source, sample);
  const slide = analysis.slides?.[0];
  if (!slide || slide.sizePx?.width !== expectedSize.width || slide.sizePx?.height !== expectedSize.height) {
    throw error("E_MATRIX_SOURCE_SIZE", `${sample.id} analysis dimensions differ from manifest`);
  }
  if (render.requestedSize?.width !== expectedSize.width || render.requestedSize?.height !== expectedSize.height || render.requestedSize?.unit !== "px") {
    throw error("E_MATRIX_RENDER_SIZE", `${sample.id} render dimensions differ from manifest`);
  }
  await assertPreviewDimensions(output, run, expectedSize);
  const aggregate = visual.aggregate ?? qa.visual?.aggregate ?? {};
  const ownershipReports = (analysis.slides ?? []).map((item) => item.ownershipReport);
  if (!ownershipReports.length || ownershipReports.some((report) => !report || report.status !== "passed"
      || !Number.isFinite(Number(report.conflictPixels))
      || !Number.isFinite(Number(report.rasterNativeOverlapPixels))
      || !Number.isFinite(Number(report.duplicateVisibleContent)))) {
    throw error("E_MATRIX_OWNERSHIP", `${sample.id} ownership report is incomplete`);
  }
  const metrics = {
    ssim: aggregate.ssim,
    ocrCer: aggregate.ocrCer,
    bboxIou: aggregate.bboxIou,
    paletteDeltaE2000P95: aggregate.paletteDeltaE2000P95,
    nativeHighConfidenceTextRecall: aggregate.nativeHighConfidenceTextRecall,
    editability: editability.level,
    wholeSlideRaster: editability.wholeSlideRasterCount,
    ownershipOverlap: ownershipReports.reduce((sum, item) => sum + Number(item?.rasterNativeOverlapPixels ?? 0), 0),
    ownershipConflict: ownershipReports.reduce((sum, item) => sum + Number(item?.conflictPixels ?? 0), 0),
    rasterAreaShare: editability.rasterAreaShare
  };
  validateMetrics(metrics);
  if (editability.level < Number(sample.expectedEditabilityLevel ?? sample.expectedFeatures?.editabilityTarget ?? 3)) {
    throw error("E_MATRIX_EDITABILITY", `${sample.id} editability is below its expected level`);
  }
  if (editability.rasterAreaShare > Number(sample.maximumRasterShare ?? sample.expectedFeatures?.rasterAreaShareMax ?? 0.65)) {
    throw error("E_MATRIX_RASTER", `${sample.id} raster area share exceeds its sample gate`);
  }
  const objectCount = (analysis.slides ?? []).reduce((sum, item) => sum + (item.objects?.length ?? 0), 0);
  const objectBudget = validateObjectCount(sample, objectCount);
  const attempts = Number(qa.attemptsUsed);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MATRIX_BUDGET.maxRepairs) throw error("E_MATRIX_BUDGET", `${sample.id} exceeds repair budget`);
  const history = qa.repairHistory;
  if (!Array.isArray(history) || history.length !== attempts + 1 || history.some((item, index) => Number(item.iteration) !== index)) {
    throw error("E_MATRIX_HISTORY", `${sample.id} repair history is not continuous`);
  }
  if (qa.repairSafety?.status !== "passed" || qa.ownership?.status !== "passed") throw error("E_MATRIX_VALIDATOR", `${sample.id} final validators did not pass`);
  if (!run.summary?.qa || !run.summary?.renderReport || !run.summary?.reconstructionPlanRef) throw error("E_MATRIX_VALIDATOR", `${sample.id} run is missing validator-bound summaries`);
  const assetCount = await assertAssetReferences(output, analysis);
  const route = routeContract(sample, analysis, assetCount);
  return { metrics, attempts, objectCount, maxObjects: objectBudget.maxObjects, route };
}

function sanitizedEnvironment() {
  const env = { ...process.env, IMAGE_TO_PPTX_VISUAL_MATRIX: "1", IMAGE_TO_PPTX_NETWORK: "0", IMAGE_TO_PPTX_MODEL: "null" };
  for (const key of Object.keys(env)) if (/(?:API_KEY|OPENAI|ANTHROPIC|GEMINI)/iu.test(key)) delete env[key];
  return env;
}

export async function executeBuild({ source, output, category, timeoutMs }) {
  const args = [CLI_PATH, "build", "--output", output, "--langs", LANGS_BY_CATEGORY[category] ?? "eng", "--max-repairs", String(MATRIX_BUDGET.maxRepairs), "--no-html-package", source];
  return execFileAsync(process.execPath, args, {
    cwd: SKILL_ROOT,
    env: sanitizedEnvironment(),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });
}

async function resultArtifacts(output) {
  const load = async (name) => (await exists(join(output, name)) ? readJson(join(output, name)) : null);
  return {
    qa: await load("qa-report.json"),
    run: await load("run.json"),
    analysis: await load("analysis.json"),
    render: await load("reports/render-report.json"),
    visual: await load("reports/visual-report.json"),
    editability: await load("reports/editability-report.json")
  };
}

async function runOne(sample, outputRoot, state, execute) {
  const started = Date.now();
  const output = sampleOutputPath(outputRoot, sample.id);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  let validation = null;
  let failure = null;
  try {
    if (state.commands >= state.budgets.maxCommands) throw error("E_MATRIX_BUDGET", "command budget exhausted");
    if (Date.now() - state.started > state.budgets.categoryTimeoutMs) throw error("E_MATRIX_BUDGET", "category timeout budget exhausted");
    const source = safeRelativePath(FIXTURE_ROOT, sample.source.path, `${sample.id}.source`);
    if (await digest(source) !== sample.source.sha256) throw error("E_MATRIX_PROVENANCE", `${sample.id} fixture source digest differs from manifest`);
    state.commands += 1;
    await execute({ source, output, category: sample.category, timeoutMs: state.budgets.caseTimeoutMs });
    const artifacts = await resultArtifacts(output);
    validation = await validateSampleArtifacts({ sample, output, ...artifacts });
  } catch (caught) {
    failure = { code: caught.code ?? "E_MATRIX_CASE", message: caught.message ?? String(caught) };
  }
  const durationMs = Date.now() - started;
  return {
    id: sample.id,
    category: sample.category,
    ordinal: sample.ordinal,
    status: failure ? "failed" : "passed",
    durationMs,
    attempts: validation?.attempts ?? null,
    metrics: validation?.metrics ?? null,
    route: validation?.route ?? null,
    objectCount: validation?.objectCount ?? null,
    maxObjects: validation?.maxObjects ?? null,
    output: relative(outputRoot, output).replaceAll("\\", "/"),
    error: failure
  };
}

export async function runMatrix({ manifest, category, outputRoot = join(tmpdir(), "image-to-pptx-visual-matrix"), execute = executeBuild, budgets = MATRIX_BUDGET } = {}) {
  const loaded = manifest ?? await readJson(MANIFEST_PATH);
  const manifestEvidence = manifest == null
    ? { path: "tests/fixtures/visual-benchmark-matrix/manifest.json", sha256: await digest(MANIFEST_PATH) }
    : { path: "<in-memory>", sha256: digestManifestObject(loaded) };
  assertManifestPolicy(loaded);
  const samples = selectCategory(loaded, category);
  const root = resolve(outputRoot);
  await mkdir(join(root, "runs"), { recursive: true });
  const state = { started: Date.now(), commands: 0, budgets: { ...MATRIX_BUDGET, ...budgets } };
  const records = [];
  for (const sample of samples) records.push(await runOne(sample, root, state, execute));
  const summary = {
    kind: "image-to-pptx-visual-benchmark-summary",
    version: "1.0.0",
    category,
    sampleCount: samples.length,
    status: records.every((item) => item.status === "passed") ? "passed" : "failed",
    durationMs: Date.now() - state.started,
    commandCount: state.commands,
    budgets: state.budgets,
    manifest: manifestEvidence,
    samples: records
  };
  const summaryPath = join(root, "summaries", `${category}.json`);
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (summary.status !== "passed") throw Object.assign(error("E_MATRIX_FAILED", `${category} visual matrix failed; summary written to ${summaryPath}`), { summaryPath, summary });
  return { summary, summaryPath };
}
