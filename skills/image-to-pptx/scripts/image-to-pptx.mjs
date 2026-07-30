#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildHtmlPackage } from "./build_html_package.mjs";
import { renderPptx } from "./render_pptx.mjs";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REPAIRS = 3;

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

async function pythonCommand() {
  const command = process.env.IMAGE_TO_PPTX_PYTHON || "python3";
  await run(command, ["-c", "import PIL,pytesseract"], { code: "E_OCR_RUNTIME" });
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

function accepted(report, editability) {
  return report.status === "passed"
    && editability.status === "passed"
    && editability.level >= 3
    && editability.wholeSlideRasterCount === 0;
}

function applyCalibration(analysis, visual) {
  const next = structuredClone(analysis);
  let changes = 0;
  for (const slideCalibration of visual.calibration ?? []) {
    const slide = next.slides.find((item) => item.id === slideCalibration.slideId);
    if (!slide) continue;
    const objects = new Map(slide.objects.map((item) => [item.id, item]));
    for (const adjustment of slideCalibration.adjustments ?? []) {
      const object = objects.get(adjustment.id);
      if (!object || object.type !== "text") continue;
      const dx = Math.max(-18, Math.min(18, Number(adjustment.dx ?? 0)));
      const dy = Math.max(-18, Math.min(18, Number(adjustment.dy ?? 0)));
      const scale = Math.max(0.80, Math.min(1.14, Number(adjustment.fontScale ?? 1)));
      const spacingDelta = Math.max(-1.5, Math.min(6, Number(adjustment.charSpacingDeltaPt ?? 0)));
      if (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15 && Math.abs(scale - 1) < 0.002 && Math.abs(spacingDelta) < 0.05) continue;
      object.renderBox.x = Math.max(0, Math.min(slide.sizePx.width - object.renderBox.w, object.renderBox.x + dx));
      object.renderBox.y = Math.max(0, Math.min(slide.sizePx.height - object.renderBox.h, object.renderBox.y + dy));
      object.style.fontSizePt = Number(Math.max(6, object.style.fontSizePt * scale).toFixed(4));
      object.style.charSpacingPt = Number(Math.max(-2, Math.min(8, Number(object.style.charSpacingPt ?? 0) + spacingDelta)).toFixed(4));
      const targetWidth = object.pixelBox.w * 1.62 + 16;
      object.renderBox.w = Number(Math.min(slide.sizePx.width - object.renderBox.x, Math.max(object.renderBox.w, targetWidth)).toFixed(4));
      changes += 1;
    }
  }
  return { analysis: next, changes };
}

async function runCandidate({ python, output, analysis, iteration }) {
  const attempt = join(output, "reports", `attempt-${iteration}`);
  await mkdir(attempt, { recursive: true });
  const analysisPath = join(attempt, "analysis.json");
  const pptxPath = join(attempt, "candidate.pptx");
  const editabilityPath = join(attempt, "editability-report.json");
  const previewDir = join(attempt, "preview");
  const renderReportPath = join(attempt, "render-report.json");
  const visualPath = join(attempt, "visual-report.json");
  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
  const rendered = await renderPptx(analysisPath, pptxPath, editabilityPath, output);
  await run(python, [
    join(SKILL_ROOT, "scripts", "render_preview.py"),
    pptxPath,
    previewDir,
    "--width-px", String(analysis.deck.size.widthPx),
    "--width-in", String(analysis.deck.size.widthIn),
    "--report", renderReportPath,
    "--relative-to", output
  ], { code: "E_RENDER_RUNTIME" });
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
  return {
    iteration,
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
    accepted: accepted(visual, editability),
    score: scoreVisual(visual, editability)
  };
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
  const pptxName = passed ? "final.pptx" : "failed-candidate.pptx";
  const pptxPath = join(output, pptxName);
  await copyFile(best.pptxPath, pptxPath);
  await cp(best.previewDir, join(output, passed ? "preview" : "failed-preview"), { recursive: true });
  await copyFile(best.analysisPath, join(output, "analysis.json"));
  await copyFile(best.visualPath, join(output, "reports", "visual-report.json"));
  await copyFile(best.editabilityPath, join(output, "reports", "editability-report.json"));
  await copyFile(best.renderReportPath, join(output, "reports", "render-report.json"));
  const analysis = best.analysis;
  const findings = [
    ...(best.visual.findings ?? []),
    ...(best.editability.findings ?? [])
  ];
  const qa = {
    version: "1.0.0",
    status: passed ? "passed" : "failed",
    gate: "image-native-reconstruction",
    thresholds: best.visual.thresholds,
    slideCount: analysis.slides.length,
    attemptsUsed: history.length - 1,
    maxRepairAttempts: maxRepairs,
    visual: {
      status: best.visual.status,
      aggregate: best.visual.aggregate,
      report: "reports/visual-report.json"
    },
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
    repairHistory: history.map((candidate) => ({
      iteration: candidate.iteration,
      accepted: candidate.accepted,
      score: candidate.score,
      visualStatus: candidate.visual.status,
      editabilityLevel: candidate.editability.level
    })),
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
    history.push(best);
    for (let iteration = 1; !best.accepted && iteration <= options.maxRepairs; iteration += 1) {
      const calibrated = applyCalibration(best.analysis, best.visual);
      if (!calibrated.changes) break;
      const candidate = await runCandidate({
        python,
        output,
        analysis: calibrated.analysis,
        iteration
      });
      history.push(candidate);
      if (candidate.accepted || candidate.score < best.score) {
        best = candidate;
        analysis = candidate.analysis;
      } else {
        break;
      }
    }
    const published = await publishRun({
      output,
      best,
      history,
      maxRepairs: options.maxRepairs,
      htmlPackage: options.htmlPackage
    });
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
      attempts: history.length - 1
    };
  } catch (error) {
    if (error.code !== "E_QUALITY_GATE") {
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
  await check("python", python, ["-c", "import PIL,pytesseract; print('Pillow+pytesseract')"]);
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
