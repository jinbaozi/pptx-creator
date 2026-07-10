#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { buildConsistencyReport } from "./lib/consistency-report-writer.mjs";
import { preflightFonts } from "./lib/font-preflight.mjs";
import { writePipelineReports } from "./lib/pipeline-report-writer.mjs";
import { runPython } from "./lib/python-utils.mjs";
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
  "replica-fidelity-proof.json",
  "visual-review.json",
  "html-pipeline-summary.json",
  "run.json"
]);

export async function clearConsumableOutputs(outputDir, protectedPaths = []) {
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
  await Promise.all(CONSUMABLE_OUTPUTS.map(async (name) => {
    const candidate = resolve(outputDir, name);
    if (!protectedSet.has(candidate)) await rm(candidate, { force: true });
  }));
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
  const archiveObjectCount = slideXml.reduce((sum, xml) => sum + (xml.match(/<p:(?:sp|pic|graphicFrame)\b/g) ?? []).length, 0);
  const counters = intermediate.countersBySlide ?? [intermediate.editabilityCounter ?? {}];
  const renderedNativeObjects = counters.reduce((sum, item) => sum
    + (item.text ?? 0) + (item.shape ?? 0) + (item.image ?? 0) + (item.table ?? 0), 0);
  const expectedSlides = manifest.slides?.length ?? 0;
  const coveredElements = Number(coverage.coveredElements ?? 0);
  const ok = slideNames.length === expectedSlides
    && archiveObjectCount >= coveredElements
    && renderedNativeObjects >= coveredElements;
  return {
    status: ok ? "passed" : "failed",
    route,
    capability: "openxml-structural-proof",
    expectedSlides,
    renderedSlides: slideNames.length,
    coveredElements,
    renderedNativeObjects,
    archiveObjectCount
  };
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
  await clearConsumableOutputs(resolvedOutput, [resolvedInput]);
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
  const creativeReview = mode === "creative" ? reviewManifest(manifest, { mode: "creative" }) : null;
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
      && (mode !== "creative" || (creativeReview.deckScore >= 70 && creativeReview.slopRisk <= 60))
      && (mode !== "replica" || replicaProofAvailable),
    stdout: mode === "creative" ? `deckScore=${creativeReview.deckScore}; slopRisk=${creativeReview.slopRisk}` : (routePreflight.stdout || fontPreflight.source),
    stderr: routePreflight.ok === false
      ? routePreflight.stderr
      : !layout.ok ? layout.stderr : (mode === "replica" && !replicaProofAvailable ? "strict replica fidelity proof capability unavailable" : "")
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
    ? await proveReplicaFidelity(join(resolvedOutput, "final.pptx"), manifest, coverage, intermediate, route)
    : null;
  if (replicaProof) {
    await writeFile(join(resolvedOutput, "replica-fidelity-proof.json"), `${JSON.stringify(replicaProof, null, 2)}\n`, "utf8");
  }
  const proofOk = mode === "creative"
    ? creativeReview.deckScore >= 70 && creativeReview.slopRisk <= 60
    : mode === "replica" ? replicaProof.status === "passed" : (intermediate.editabilityCounter?.text ?? 0) > 0;
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

  if (options.copyManifest !== false) await copyFile(resolvedManifest, join(resolvedOutput, "deck.manifest.json"));
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
