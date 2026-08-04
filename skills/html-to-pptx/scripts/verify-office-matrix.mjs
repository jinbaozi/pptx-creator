#!/usr/bin/env node
/**
 * Verify the target-office render matrix without treating detection as proof.
 *
 * LibreOffice has a supported headless CLI adapter and can be rendered here.
 * PowerPoint (Windows COM) and WPS are detected separately; GUI-only targets
 * remain `detected-but-not-automatable` until a target PNG directory is
 * supplied. Every supplied render directory is compared with the self-
 * contained compare-deck.py implementation.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PPTX_CREATOR_PYTHON || process.env.HTML_TO_PPTX_PYTHON || "python3";
const COMPARE_SCRIPT = join(SKILL_ROOT, "scripts", "compare-deck.py");
const RENDER_SCRIPT = join(SKILL_ROOT, "scripts", "render-preview.py");
const MATRIX_VERSION = "1.0.0";

const TARGET_IDS = ["libreoffice", "powerpoint", "wps"];

function defaultWhich(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}

function defaultExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function firstFound(candidates, which = defaultWhich, exists = defaultExists) {
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (exists(candidate)) return candidate;
      continue;
    }
    const found = which(candidate);
    if (found) return found;
  }
  return null;
}

function normalizePlatform(value) {
  return String(value || process.platform).toLowerCase();
}

function detectionBase(id, label, adapter, status, details = {}) {
  return {
    id,
    label,
    adapter,
    detectionStatus: status,
    status,
    ...details
  };
}

export function detectLibreOfficeAdapter(options = {}) {
  const platform = normalizePlatform(options.platform);
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? defaultExists;
  const binary = options.binary
    ?? firstFound(
      platform === "win32"
        ? ["soffice", "libreoffice", "C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"]
        : ["soffice", "libreoffice"],
      which,
      exists
    );
  if (!binary) {
    return detectionBase("libreoffice", "LibreOffice", "libreoffice-headless", "unavailable", {
      capability: "headless-cli",
      binary: null,
      note: "LibreOffice headless CLI was not found."
    });
  }
  return detectionBase("libreoffice", "LibreOffice", "libreoffice-headless", "available", {
    capability: "headless-cli",
    binary,
    canRender: true,
    note: "Safe headless conversion uses render-preview.py and pdftoppm."
  });
}

function powerPointCandidates(platform) {
  if (platform === "win32") {
    return [
      "powerpnt.exe",
      "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
      "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE"
    ];
  }
  if (platform === "darwin") return ["/Applications/Microsoft PowerPoint.app"];
  return ["powerpnt"];
}

/**
 * PowerPoint's supported embedding/render contract is Windows COM. The
 * command is returned as data and is only executed on Windows when the
 * caller explicitly asks to render; this keeps macOS GUI discovery read-only.
 */
export function detectPowerPointAdapter(options = {}) {
  const platform = normalizePlatform(options.platform);
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? defaultExists;
  const application = options.application
    ?? firstFound(powerPointCandidates(platform), which, exists);
  const powershell = options.powershell
    ?? firstFound(platform === "win32" ? ["powershell.exe", "powershell"] : ["pwsh", "powershell"], which, exists);
  if (!application) {
    return detectionBase("powerpoint", "PowerPoint", "powerpoint-com", "unavailable", {
      capability: platform === "win32" ? "windows-com" : "gui",
      application: null,
      powershell: powershell ?? null,
      embedding: { supported: platform === "win32", method: "Presentation.SaveAs(..., EmbedFonts) / SaveCopyAs(..., EmbedTrueTypeFonts)" },
      note: "PowerPoint application was not detected."
    });
  }
  if (platform !== "win32" || !powershell) {
    return detectionBase("powerpoint", "PowerPoint", "powerpoint-com", "detected-but-not-automatable", {
      capability: platform === "win32" ? "windows-com" : "gui",
      application,
      powershell: powershell ?? null,
      embedding: { supported: platform === "win32", method: "Presentation.SaveAs(..., EmbedFonts) / SaveCopyAs(..., EmbedTrueTypeFonts)" },
      note: platform === "win32"
        ? "PowerPoint was found but PowerShell/COM automation is unavailable."
        : "PowerPoint GUI was found; render externally (no macOS GUI automation is attempted)."
    });
  }
  return detectionBase("powerpoint", "PowerPoint", "powerpoint-com", "available", {
    capability: "windows-com",
    application,
    powershell,
    canRender: true,
    embedding: { supported: true, method: "Presentation.SaveAs(..., EmbedFonts) / SaveCopyAs(..., EmbedTrueTypeFonts)" },
    note: "Windows COM adapter is available; it can save a PDF and request font embedding."
  });
}

function wpsCandidates(platform) {
  if (platform === "darwin") {
    return [
      "wps",
      "wpsoffice",
      "/Applications/wpsoffice.app/Contents/MacOS/wpsoffice",
      "/Applications/WPS Office.app/Contents/MacOS/wpsoffice",
      "/Applications/wpsoffice.app"
    ];
  }
  if (platform === "win32") return ["wps.exe", "wpsoffice.exe", "C:\\Program Files\\Kingsoft\\WPS Office\\ksolaunch.exe"];
  return ["wps", "wpsoffice"];
}

export function detectWpsAdapter(options = {}) {
  const platform = normalizePlatform(options.platform);
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? defaultExists;
  const application = options.application
    ?? firstFound(wpsCandidates(platform), which, exists);
  if (!application) {
    return detectionBase("wps", "WPS", "wps", "unavailable", {
      capability: "gui-or-undocumented-cli",
      application: null,
      note: "WPS application/CLI was not detected."
    });
  }
  return detectionBase("wps", "WPS", "wps", "detected-but-not-automatable", {
    capability: "gui-or-undocumented-cli",
    application,
    canRender: false,
    note: "WPS was detected, but no safe, deterministic headless renderer is assumed; provide external PNGs."
  });
}

export function discoverOfficeAdapters(options = {}) {
  return {
    libreoffice: detectLibreOfficeAdapter(options),
    powerpoint: detectPowerPointAdapter(options),
    wps: detectWpsAdapter(options)
  };
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Return a self-contained Windows PowerPoint COM script. It is intentionally
 * not run while building the matrix unless the adapter is Windows/available.
 */
export function buildPowerPointComScript({ pptxPath, pdfPath, embeddedPath = null } = {}) {
  if (!pptxPath || !pdfPath) throw new TypeError("pptxPath and pdfPath are required");
  const input = quotePowerShell(resolve(pptxPath));
  const pdf = quotePowerShell(resolve(pdfPath));
  const embedded = embeddedPath ? quotePowerShell(resolve(embeddedPath)) : null;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ppt = New-Object -ComObject PowerPoint.Application",
    "$ppt.Visible = $false",
    `\$presentation = \$ppt.Presentations.Open(${input}, $true, $false, $false)`,
    embedded
      ? `\$presentation.SaveCopyAs(${embedded}, 24, -1) # ppSaveAsOpenXMLPresentation, msoTrue / EmbedTrueTypeFonts contract`
      : "$null = $presentation",
    `\$presentation.SaveAs(${pdf}, 32) # ppSaveAsPDF`,
    "$presentation.Close()",
    "$ppt.Quit()"
  ].join("\n");
}

/**
 * Build the embedding-only Windows COM script. The third argument is
 * intentionally explicit: 24 is ppSaveAsOpenXMLPresentation and -1 is
 * msoTrue for EmbedTrueTypeFonts/EmbedFonts. No raw font payload is written.
 */
export function buildPowerPointEmbedScript({ pptxPath, outputPath } = {}) {
  if (!pptxPath || !outputPath) throw new TypeError("pptxPath and outputPath are required");
  const input = quotePowerShell(resolve(pptxPath));
  const output = quotePowerShell(resolve(outputPath));
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ppt = New-Object -ComObject PowerPoint.Application",
    "$ppt.Visible = $false",
    `\$presentation = \$ppt.Presentations.Open(${input}, $true, $false, $false)`,
    `\$presentation.SaveCopyAs(${output}, 24, -1) # ppSaveAsOpenXMLPresentation, msoTrue / EmbedTrueTypeFonts`,
    "$presentation.Close()",
    "$ppt.Quit()"
  ].join("\n");
}

/**
 * Validate the only evidence accepted for legal font embedding. The
 * authoritative preflight field is `request.embedding`; older/hand-authored
 * reports may expose only `request.resolved.embedding`. If both are present,
 * their `canEmbed` values must agree. False, null, missing, restricted, and
 * conflicting values block the operation.
 */
export function validateFontEmbeddingReport(report) {
  if (!report || typeof report !== "object") {
    return {
      allowed: false,
      status: "failed",
      reason: "font-report-missing",
      requestCount: 0,
      blocked: []
    };
  }
  const requests = Array.isArray(report.resolutions)
    ? report.resolutions
    : Array.isArray(report.faceMatches)
      ? report.faceMatches
      : null;
  if (!requests) {
    return {
      allowed: false,
      status: "failed",
      reason: "font-report-resolutions-missing",
      requestCount: 0,
      blocked: []
    };
  }
  const blocked = requests.flatMap((request, index) => {
    const hasDirectEvidence = Boolean(request && Object.prototype.hasOwnProperty.call(request, "embedding"));
    const hasResolvedEvidence = Boolean(request?.resolved && Object.prototype.hasOwnProperty.call(request.resolved, "embedding"));
    const directCanEmbed = request?.embedding?.canEmbed;
    const resolvedCanEmbed = request?.resolved?.embedding?.canEmbed;
    const evidenceConflict = hasDirectEvidence && hasResolvedEvidence && directCanEmbed !== resolvedCanEmbed;
    const canEmbed = hasDirectEvidence ? directCanEmbed : resolvedCanEmbed;
    if (!evidenceConflict && canEmbed === true) return [];
    return [{
      index,
      requested: request?.requested?.family ?? request?.requested?.fontFamily ?? null,
      canEmbed: canEmbed ?? null,
      reason: evidenceConflict
        ? "embedding-evidence-conflict"
        : canEmbed === false
        ? "embedding-restricted"
        : "embedding-permission-unknown"
    }];
  });
  return {
    allowed: blocked.length === 0,
    status: blocked.length === 0 ? "permitted" : "failed",
    reason: blocked.length === 0 ? "all-requested-faces-embeddable" : blocked[0].reason,
    requestCount: requests.length,
    blocked
  };
}

function parseRenderDirectories(value) {
  const output = {};
  for (const item of value ?? []) {
    const raw = String(item);
    const separator = raw.includes("=") ? "=" : ":";
    const index = raw.indexOf(separator);
    if (index <= 0) throw new Error(`--render-dir must be target=path: ${raw}`);
    const target = raw.slice(0, index).trim().toLowerCase();
    const path = raw.slice(index + 1).trim();
    if (!TARGET_IDS.includes(target)) throw new Error(`unknown office target: ${target}`);
    if (!path) throw new Error(`render directory is empty for ${target}`);
    output[target] = resolve(path);
  }
  return output;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runCommand(command, args, options = {}) {
  if (typeof options.commandRunner === "function") {
    return options.commandRunner(command, args, options);
  }
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 240_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? ""
    };
  }
}

async function compareRender(sourceDir, renderDir, outputPath, options = {}) {
  if (!(await isDirectory(sourceDir))) {
    return { ok: false, status: "failed", note: `source PNG directory not found: ${sourceDir}` };
  }
  if (!(await isDirectory(renderDir))) {
    return { ok: false, status: "failed", note: `render PNG directory not found: ${renderDir}` };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await runCommand(options.python ?? PYTHON, [
    COMPARE_SCRIPT,
    sourceDir,
    renderDir,
    outputPath,
    ...(options.threshold != null ? ["--threshold", String(options.threshold)] : [])
  ], { cwd: SKILL_ROOT, timeout: options.timeout });
  if (!(await existsAsync(outputPath))) {
    return { ok: false, status: "failed", note: result.stderr || "compare-deck did not write a report" };
  }
  try {
    const report = await readJson(outputPath);
    return { ok: Boolean(report.summary?.passed), status: report.summary?.passed ? "passed" : "failed", report, note: result.ok ? null : result.stderr };
  } catch (error) {
    return { ok: false, status: "failed", note: `compare-deck report is invalid: ${error.message}` };
  }
}

async function existsAsync(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path, options = {}) {
  if (typeof options.pathExists === "function") return Boolean(await options.pathExists(path));
  return existsAsync(path);
}

async function loadFontReport(input) {
  if (!input) return { report: null, path: null, error: "font-report-missing" };
  if (typeof input === "object") return { report: input, path: null, error: null };
  const path = resolve(String(input));
  try {
    return { report: await readJson(path), path, error: null };
  } catch (error) {
    return { report: null, path, error: (error?.code === "ENOENT" ? "font-report-missing" : "font-report-invalid") };
  }
}

/**
 * Request a legal-font PowerPoint copy. The function is deliberately narrow:
 * it refuses non-Windows/GUI adapters, missing reports, unknown licenses, and
 * restricted faces before invoking any COM command.
 */
export async function embedFontsWithPowerPoint(options = {}) {
  const adapter = options.adapter ?? {};
  const outputPath = options.embedFontsOutput ?? options.outputPath;
  const platform = normalizePlatform(options.platform);
  const validation = options.validation ?? validateFontEmbeddingReport(options.fontReport);
  const base = {
    requested: true,
    status: "failed",
    output: null,
    requestedOutput: outputPath ? resolve(outputPath) : null,
    fontReport: options.fontReportPath ?? null,
    validation,
    reason: validation.reason
  };
  if (!outputPath) return { ...base, reason: "embed-fonts-output-missing" };
  if (adapter.detectionStatus === "unavailable" || adapter.status === "unavailable") {
    return { ...base, status: "unavailable", reason: "powerpoint-com-adapter-unavailable" };
  }
  if (adapter.id !== "powerpoint" || adapter.adapter !== "powerpoint-com") {
    return { ...base, reason: "powerpoint-com-adapter-required" };
  }
  if (platform !== "win32" || adapter.status !== "available") {
    return {
      ...base,
      status: adapter.detectionStatus === "detected-but-not-automatable"
        ? "detected-but-not-automatable"
        : "failed",
      reason: platform !== "win32" ? "powerpoint-com-requires-windows" : "powerpoint-com-adapter-not-available"
    };
  }
  if (!validation.allowed) {
    return { ...base, reason: validation.reason };
  }
  if (!options.pptxPath) return { ...base, reason: "pptx-input-missing" };
  const script = buildPowerPointEmbedScript({ pptxPath: options.pptxPath, outputPath });
  const result = await runCommand(adapter.powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], { timeout: options.timeout, commandRunner: options.commandRunner });
  if (!result.ok) {
    return { ...base, reason: result.stderr || "powerpoint-com-font-embedding-failed" };
  }
  if (!(await pathExists(resolve(outputPath), options))) {
    return { ...base, reason: "powerpoint-com-did-not-write-embedded-output" };
  }
  return {
    ...base,
    status: "passed",
    output: resolve(outputPath),
    reason: "powerpoint-com-saved-embedded-copy"
  };
}

async function renderLibreOffice(adapter, pptxPath, renderDir, options = {}) {
  await mkdir(renderDir, { recursive: true });
  const previewReport = join(renderDir, "preview-report.json");
  const result = await runCommand(options.python ?? PYTHON, [
    RENDER_SCRIPT,
    pptxPath,
    renderDir,
    "--report",
    previewReport
  ], { cwd: SKILL_ROOT, timeout: options.timeout });
  if (!(await existsAsync(previewReport))) {
    return { ok: false, status: "failed", note: result.stderr || "LibreOffice preview report was not written" };
  }
  const report = await readJson(previewReport);
  if (report.status !== "ok") {
    return { ok: false, status: "failed", report, note: report.note || result.stderr || "LibreOffice rendering failed" };
  }
  return { ok: true, status: "available", report, note: "LibreOffice PNG render completed" };
}

async function renderPowerPoint(adapter, pptxPath, renderDir, options = {}) {
  if (normalizePlatform(options.platform) !== "win32" || adapter.status !== "available") {
    return { ok: false, status: adapter.status, note: adapter.note };
  }
  await mkdir(renderDir, { recursive: true });
  const pdfPath = join(renderDir, `${basename(pptxPath).replace(/\.[^.]+$/, "")}.pdf`);
  const script = buildPowerPointComScript({ pptxPath, pdfPath });
  const result = await runCommand(adapter.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    timeout: options.timeout,
    commandRunner: options.commandRunner
  });
  if (!result.ok) return { ok: false, status: "failed", note: result.stderr || "PowerPoint COM render failed" };
  const rasterizer = options.pdftoppm ?? defaultWhich("pdftoppm");
  if (!rasterizer) return { ok: false, status: "failed", note: "PowerPoint COM produced a PDF, but pdftoppm was not found" };
  const raster = await runCommand(rasterizer, ["-png", "-r", "96", pdfPath, join(renderDir, "slide")], {
    timeout: options.timeout,
    commandRunner: options.commandRunner
  });
  if (!raster.ok) return { ok: false, status: "failed", note: raster.stderr || "PowerPoint PDF rasterization failed" };
  return { ok: true, status: "available", note: "PowerPoint COM PDF was rasterized with pdftoppm" };
}

function resultStatus(adapter, comparison, renderResult) {
  if (adapter.detectionStatus === "unavailable") return "unavailable";
  if (comparison) return comparison.status;
  if (renderResult?.status === "failed") return "failed";
  if (adapter.detectionStatus === "detected-but-not-automatable") return "detected-but-not-automatable";
  return adapter.status === "available" ? "available" : adapter.status;
}

/**
 * Run the matrix. `renderDirs` may contain external PNG directories keyed by
 * target id; these are always compared with compare-deck.py and retained in
 * the per-target report.
 */
export async function verifyOfficeMatrix(options = {}) {
  const adapters = options.adapters ?? discoverOfficeAdapters(options);
  const sourceDir = options.sourceDir ? resolve(options.sourceDir) : null;
  const pptxPath = options.pptxPath ? resolve(options.pptxPath) : null;
  const renderDirs = options.renderDirs ?? {};
  const embeddingRequested = Boolean(options.embedFontsOutput);
  let embedding = null;
  if (embeddingRequested) {
    const loadedFontReport = await loadFontReport(options.fontReport);
    const validation = validateFontEmbeddingReport(loadedFontReport.report);
    embedding = await embedFontsWithPowerPoint({
      adapter: adapters.powerpoint,
      platform: options.platform,
      pptxPath,
      embedFontsOutput: options.embedFontsOutput,
      fontReport: loadedFontReport.report,
      fontReportPath: loadedFontReport.path ?? (typeof options.fontReport === "string" ? resolve(options.fontReport) : null),
      validation,
      timeout: options.timeout,
      commandRunner: options.commandRunner,
      pathExists: options.pathExists
    });
    if (loadedFontReport.error && embedding.status === "failed") {
      embedding = { ...embedding, reason: loadedFontReport.error, validation };
    }
  }
  const outputDir = resolve(options.outputDir ?? (options.outputPath
    ? dirname(resolve(options.outputPath))
    : join(process.cwd(), "office-matrix")));
  const outputPath = resolve(options.outputPath ?? join(outputDir, "office-matrix.json"));
  await mkdir(outputDir, { recursive: true });
  const targets = {};
  for (const id of TARGET_IDS) {
    const adapter = adapters[id];
    const externalRenderDir = renderDirs[id] ? resolve(renderDirs[id]) : null;
    let render = null;
    let comparison = null;
    const powerPointEmbeddingBlocked = id === "powerpoint"
      && embeddingRequested
      && embedding?.status !== "passed";
    if (externalRenderDir) {
      render = { mode: "external", directory: externalRenderDir };
    } else if (!powerPointEmbeddingBlocked && pptxPath && adapter?.status === "available" && adapter.id === "libreoffice") {
      const directory = join(outputDir, `${id}-render`);
      render = { mode: "automatic", directory };
      render = { ...render, ...(await renderLibreOffice(adapter, pptxPath, directory, options)) };
    } else if (!powerPointEmbeddingBlocked && pptxPath && adapter?.status === "available" && adapter.id === "powerpoint") {
      const directory = join(outputDir, `${id}-render`);
      render = { mode: "automatic", directory };
      const renderPptxPath = embedding?.status === "passed" && embedding.output
        ? embedding.output
        : pptxPath;
      render = { ...render, ...(await renderPowerPoint(adapter, renderPptxPath, directory, options)) };
    }
    if (!powerPointEmbeddingBlocked && sourceDir && externalRenderDir) {
      comparison = await compareRender(
        sourceDir,
        externalRenderDir,
        join(outputDir, `${id}-comparison.json`),
        options
      );
    } else if (!powerPointEmbeddingBlocked && sourceDir && render?.directory && render?.status === "available") {
      comparison = await compareRender(
        sourceDir,
        render.directory,
        join(outputDir, `${id}-comparison.json`),
        options
      );
    }
    let status = resultStatus(adapter, comparison, render);
    if (id === "powerpoint" && embeddingRequested && embedding) {
      if (embedding.status === "failed") status = "failed";
      else if (embedding.status === "unavailable") status = "unavailable";
      else if (embedding.status === "detected-but-not-automatable") status = "detected-but-not-automatable";
    }
    targets[id] = {
      ...adapter,
      status,
      render,
      comparison,
      ...(id === "powerpoint" && embeddingRequested ? { embedding } : {}),
      passed: status === "passed",
      note: status === "detected-but-not-automatable"
        ? `${adapter.note} Waiting for external render evidence.`
        : adapter.note
    };
  }
  const summary = aggregateMatrixStatus(Object.values(targets));
  const report = {
    version: MATRIX_VERSION,
    source: { pptx: pptxPath, sourcePngDirectory: sourceDir },
    embedding,
    targets,
    summary
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(outputPath, text, "utf8");
  return report;
}

export function aggregateMatrixStatus(targets) {
  const statuses = (targets ?? []).map((target) => target?.status);
  if (statuses.length === 0) return { status: "unavailable", passed: false, counts: {} };
  const counts = Object.fromEntries([...new Set(statuses)].sort().map((status) => [status, statuses.filter((value) => value === status).length]));
  let status = "available";
  if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("unavailable")) status = "unavailable";
  else if (statuses.includes("detected-but-not-automatable")) status = "detected-but-not-automatable";
  else if (statuses.every((value) => value === "passed")) status = "passed";
  else if (statuses.includes("available")) status = "available";
  return { status, passed: status === "passed", counts };
}

function parseArgs(argv) {
  const options = { renderDirs: {} };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pptx") options.pptxPath = argv[++index];
    else if (arg === "--source-dir") options.sourceDir = argv[++index];
    else if (arg === "--output") options.outputPath = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--python") options.python = argv[++index];
    else if (arg === "--embed-fonts-output") options.embedFontsOutput = argv[++index];
    else if (arg === "--font-report") options.fontReport = argv[++index];
    else if (arg === "--render-dir") {
      const value = argv[++index];
      const parsed = parseRenderDirectories([value]);
      Object.assign(options.renderDirs, parsed);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else positionals.push(arg);
  }
  if (positionals.length > 0) throw new Error(`unexpected argument: ${positionals[0]}`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: verify-office-matrix.mjs [--pptx final.pptx] [--source-dir html-pngs] [--render-dir target=png-dir] [--embed-fonts-output embedded.pptx --font-report font-report.json] --output matrix.json");
    return;
  }
  const report = await verifyOfficeMatrix(options);
  console.log(JSON.stringify(report, null, 2));
  // A matrix is evidence, not a reason to hide failures. Keep a non-zero exit
  // for failed comparisons while allowing unavailable/detected targets to be
  // inspected and completed externally.
  if (report.summary.status === "failed") process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const __test__ = {
  embedFontsWithPowerPoint,
  loadFontReport,
  parseArgs,
  parseRenderDirectories,
  resultStatus,
  validateFontEmbeddingReport
};
