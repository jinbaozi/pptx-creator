import { readFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SkillError, errorRecord } from "./errors.mjs";
import { buildVisualScorecard } from "./scorecard.mjs";
import { validateVisualScorecard } from "./report-validation.mjs";
import { validatePresentationPackage } from "../validate-presentation-package.mjs";
import { assertSafeOutputDir, inside, readJson, sha256File, sha256Text, writeJson } from "./utils.mjs";

const QA_REPORT_PATH = "qa-report.json";
const FAILURE_REPORT_PATH = "failure-report.json";
const PACKAGE_PATH = "presentation-package.json";
const MANIFEST_PATH = "output-manifest.json";
const GENERATION_REPORT_PATH = "generation-report.json";
const VISUAL_SCORECARD_PATH = "visual-scorecard.json";
const TEXT_TO_HTML_EXTENSION = "pptx-creator.text-to-html/v2";
const qaSchemaPath = fileURLToPath(new URL("../../schemas/qa-report.schema.json", import.meta.url));
const qaSchemaValidator = new Ajv2020({ allErrors: true, strict: true });
addFormats(qaSchemaValidator);
const validateQaSchema = qaSchemaValidator.compile(JSON.parse(readFileSync(qaSchemaPath, "utf8")));

function finalizerIo(overrides = {}) {
  return {
    lstat: overrides.lstat ?? lstat,
    readdir: overrides.readdir ?? readdir,
    rm: overrides.rm ?? rm,
    readJson: overrides.readJson ?? readJson,
    sha256File: overrides.sha256File ?? sha256File,
    writeJson: overrides.writeJson ?? writeJson,
    validatePresentationPackage: overrides.validatePresentationPackage ?? validatePresentationPackage
  };
}

function outputPath(outputDir, relativePath) {
  const candidate = resolve(outputDir, relativePath);
  if (!inside(outputDir, candidate)) {
    throw new SkillError("E_OUTPUT_PATH", `Artifact escapes the output directory: ${relativePath}`);
  }
  return candidate;
}

function normalizedArtifactPath(outputDir, value, fieldPath) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new SkillError("E_OUTPUT_PATH", `${fieldPath} must be a non-empty output-relative path`, { path: fieldPath });
  }
  const candidate = outputPath(outputDir, value);
  const normalized = relative(outputDir, candidate).replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new SkillError("E_OUTPUT_PATH", `${fieldPath} must remain inside the output directory`, { path: fieldPath });
  }
  return normalized;
}

function schemaError(report) {
  const issue = validateQaSchema.errors?.[0];
  const path = issue?.instancePath ? `$${issue.instancePath}` : "$";
  return new SkillError(
    "E_QA_REPORT_SCHEMA",
    `${path} ${issue?.message ?? "does not match the QA report schema"}`,
    { path, details: { reportStatus: report?.status } }
  );
}

export function validateQaReport(report) {
  if (!validateQaSchema(report)) throw schemaError(report);
  if (report.status === "passed" && (!report.summary.passed || report.findings.length !== 0)) {
    throw new SkillError("E_QA_REPORT_SCHEMA", "A passed QA report must have a passed summary and no findings", { path: "$.status" });
  }
  if (report.status === "failed" && report.summary.passed) {
    throw new SkillError("E_QA_REPORT_SCHEMA", "A failed QA report cannot have a passed summary", { path: "$.summary.passed" });
  }
  return report;
}

async function outputEntry(outputDir, relativePath, io) {
  const path = outputPath(outputDir, relativePath);
  let stat;
  try {
    stat = await io.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new SkillError("E_OUTPUT_SYMLINK", `Output artifact cannot be a symbolic link: ${relativePath}`);
  }
  return { path, stat };
}

async function readOptionalJson(outputDir, relativePath, io) {
  const entry = await outputEntry(outputDir, relativePath, io);
  if (!entry) return null;
  if (!entry.stat.isFile()) {
    throw new SkillError("E_OUTPUT_ARTIFACT", `Output artifact must be a regular file: ${relativePath}`);
  }
  return io.readJson(entry.path);
}

async function removePath(path, io, options = {}) {
  try {
    await io.rm(path, { force: true, recursive: options.recursive === true });
  } catch {
    // A failed cleanup must not restore a previously accepted package.
  }
}

async function removeGeneratedEntry(outputDir, relativePath, io, options = {}) {
  const entry = await outputEntry(outputDir, relativePath, io);
  if (!entry) return;
  if (options.recursive) {
    if (!entry.stat.isDirectory()) {
      throw new SkillError("E_OUTPUT_ARTIFACT", `Expected a generated directory: ${relativePath}`);
    }
  } else if (!entry.stat.isFile()) {
    throw new SkillError("E_OUTPUT_ARTIFACT", `Expected a generated file: ${relativePath}`);
  }
  await io.rm(entry.path, { force: true, recursive: options.recursive === true });
}

async function writeArtifact(outputDir, relativePath, value, io, code = "E_REPORT_WRITE") {
  const path = outputPath(outputDir, relativePath);
  try {
    await io.writeJson(path, value);
  } catch (cause) {
    await removePath(path, io);
    throw new SkillError(code, `Cannot write ${relativePath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return path;
}

function attemptReportPaths(attempts) {
  return [...new Set((attempts ?? [])
    .map((attempt) => attempt?.report)
    .filter((report) => typeof report === "string" && report))];
}

async function existingReportPaths(outputDir, reports, io) {
  const existing = [];
  for (const report of reports) {
    const entry = await outputEntry(outputDir, report, io);
    if (!entry) continue;
    if (!entry.stat.isFile()) {
      throw new SkillError("E_OUTPUT_ARTIFACT", `QA report must be a regular file: ${report}`);
    }
    existing.push(report);
  }
  return existing;
}

function applyMeasurements(packageRecord, qaReport) {
  const next = structuredClone(packageRecord);
  const measurements = new Map((qaReport?.measurements ?? []).map((entry) => [entry.slideId, entry.components]));
  for (const slide of next.deck.slides) slide.components = measurements.get(slide.id) ?? [];
  return next;
}

function packageWithQaResult(packageRecord, qaReport, reports) {
  const next = applyMeasurements(packageRecord, qaReport);
  next.validation = { status: qaReport.status, reports };
  return next;
}

async function buildScorecard(outputDir, qaReport, io) {
  const [narrative, pagination, provenance] = await Promise.all([
    readOptionalJson(outputDir, "narrative-report.json", io),
    readOptionalJson(outputDir, "content-budget-report.json", io),
    readOptionalJson(outputDir, "provenance.json", io)
  ]);
  if (!narrative || !pagination || !provenance) {
    throw new SkillError("E_SCORECARD_INPUT", "Cannot score a delivery without narrative, pagination, and provenance reports");
  }
  return buildVisualScorecard({ qa: qaReport, narrative, pagination, provenance });
}

async function writeVisualScorecard(outputDir, qaReport, io) {
  const scorecard = await buildScorecard(outputDir, qaReport, io);
  validateVisualScorecard(scorecard);
  await writeArtifact(outputDir, VISUAL_SCORECARD_PATH, scorecard, io, "E_SCORECARD_WRITE");
  return scorecard;
}

async function bindVisualScorecard(packageRecord, outputDir, io) {
  const next = structuredClone(packageRecord);
  const extension = next.extensions?.[TEXT_TO_HTML_EXTENSION];
  if (!extension?.reports?.visualScorecard) return next;
  if (extension.reports.visualScorecard.path !== VISUAL_SCORECARD_PATH) {
    throw new SkillError("E_SCORECARD_PATH", "The text-to-html visual scorecard extension must point to visual-scorecard.json");
  }
  extension.reports.visualScorecard.sha256 = await io.sha256File(outputPath(outputDir, VISUAL_SCORECARD_PATH));
  return next;
}

function withScorecardFailure(qaReport, scorecard) {
  if (qaReport.status !== "passed" || scorecard.accepted) return qaReport;
  const finding = {
    severity: "error",
    code: "E_SCORECARD_FAILED",
    message: `${scorecard.hardErrors.length} visual scorecard hard finding(s) block delivery`,
    details: { hardFindingCodes: scorecard.hardErrors.map((item) => item.code) }
  };
  return {
    ...qaReport,
    status: "failed",
    findings: [...qaReport.findings, finding],
    summary: {
      ...qaReport.summary,
      passed: false,
      errorCount: qaReport.summary.errorCount + 1
    }
  };
}

async function writePackage(outputDir, packageRecord, io) {
  io.validatePresentationPackage(packageRecord);
  await writeArtifact(outputDir, PACKAGE_PATH, packageRecord, io, "E_PACKAGE_WRITE");
}

function failureQaReport(error, context, packageRecord) {
  const slideCount = packageRecord?.deck?.slides?.length;
  if (!Number.isInteger(slideCount) || slideCount < 1) return null;
  const timeoutMs = Math.max(90_000, Number(context.timeoutMs) || 90_000);
  const record = errorRecord(error);
  return {
    version: "1.0.0",
    status: "failed",
    timeoutMs,
    slideCount,
    viewports: [
      { name: "standard", width: 1280, height: 720, slides: [] },
      { name: "desktop", width: 1440, height: 900, slides: [] },
      { name: "mobile", width: 390, height: 844, slides: [] }
    ],
    navigation: { passed: false },
    print: { passed: false },
    findings: [{ severity: "error", code: record.code, message: record.message }],
    measurements: [],
    attempts: context.attempts ?? [],
    summary: { passed: false, errorCount: 1, screenshotCount: 0 },
    failure: record
  };
}

function failureEvidence(error, context, secondaryErrors = []) {
  return {
    version: "1.0.0",
    status: "failed",
    stage: context.stage ?? "qa",
    error: errorRecord(error),
    attempts: context.attempts ?? [],
    ...(secondaryErrors.length > 0 ? { secondaryErrors: secondaryErrors.map(errorRecord) } : {})
  };
}

async function generationBase(outputDir, configured, io, options = {}) {
  if (configured) return structuredClone(configured);
  try {
    const existing = await readOptionalJson(outputDir, GENERATION_REPORT_PATH, io);
    if (existing === null) return null;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new SkillError("E_GENERATION_REPORT", "generation-report.json must be an object");
    }
    return existing;
  } catch (error) {
    if (!options.recover) throw error;
    return { version: "1.0.0" };
  }
}

async function writeGenerationReport(outputDir, configured, context, io, options = {}) {
  const base = await generationBase(outputDir, configured, io, options);
  if (!base) return null;
  const report = structuredClone(base);
  report.status = context.status;
  report.attempts = context.attempts ?? [];
  delete report.qaReport;
  delete report.presentationPackage;
  delete report.outputManifest;
  delete report.failureReport;
  if (context.qaReportPath) report.qaReport = context.qaReportPath;
  if (context.packagePath) report.presentationPackage = context.packagePath;
  report.outputManifest = MANIFEST_PATH;
  if (context.failureReportPath) report.failureReport = context.failureReportPath;
  await writeArtifact(outputDir, GENERATION_REPORT_PATH, report, io);
  return report;
}

async function collectOutputFiles(outputDir, io, relativeDir = "") {
  const directory = outputPath(outputDir, relativeDir || ".");
  let entries;
  try {
    entries = await io.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause?.code === "ENOENT" && !relativeDir) return [];
    throw new SkillError("E_OUTPUT_MANIFEST", `Cannot list output artifacts: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (relativePath === MANIFEST_PATH) continue;
    if (entry.isSymbolicLink()) {
      throw new SkillError("E_OUTPUT_SYMLINK", `Output artifact cannot be a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectOutputFiles(outputDir, io, relativePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new SkillError("E_OUTPUT_ARTIFACT", `Output artifact must be a regular file: ${relativePath}`);
    }
    files.push(relativePath.replaceAll("\\", "/"));
  }
  return files;
}

function expectedOutputArtifacts(outputDir, packageRecord, context = {}) {
  if (packageRecord === null) return new Set();
  const expected = new Set([
    "presentation-package.json",
    "presentation-plan.json",
    "presentation-plan.source.json",
    "deck-manifest.json",
    "design-tokens.json",
    "design-intent.json",
    "content-budget-report.json",
    "narrative-report.json",
    "review-report.json",
    "asset-ledger.json",
    "license-report.json",
    "provenance.json",
    VISUAL_SCORECARD_PATH,
    "NOTICE",
    "speaker-notes.md",
    "sources.json",
    "assets/deck.css",
    "assets/deck.js",
    "assets/design-tokens.css",
    normalizedArtifactPath(outputDir, packageRecord.entrypoint, "$.entrypoint")
  ]);
  if (context.qaReport !== null) expected.add(QA_REPORT_PATH);
  for (const [index, asset] of packageRecord.assets.entries()) {
    expected.add(normalizedArtifactPath(outputDir, asset.path, `$.assets[${index}].path`));
  }
  for (const [index, attempt] of (context.attempts ?? []).entries()) {
    expected.add(normalizedArtifactPath(outputDir, attempt.report, `$.attempts[${index}].report`));
  }
  for (const [viewportIndex, viewport] of (context.qaReport?.viewports ?? []).entries()) {
    for (const [slideIndex, slide] of viewport.slides.entries()) {
      expected.add(normalizedArtifactPath(outputDir, slide.screenshot, `$.viewports[${viewportIndex}].slides[${slideIndex}].screenshot`));
    }
  }
  for (const [index, contactSheet] of (context.qaReport?.contactSheets ?? []).entries()) {
    expected.add(normalizedArtifactPath(outputDir, contactSheet.path, `$.contactSheets[${index}].path`));
  }
  if (context.generationReport) expected.add(GENERATION_REPORT_PATH);
  if (context.failureReport) expected.add(FAILURE_REPORT_PATH);
  return expected;
}

async function assertExpectedOutputArtifacts(outputDir, packageRecord, context, io) {
  const paths = (await collectOutputFiles(outputDir, io)).sort();
  const expected = expectedOutputArtifacts(outputDir, packageRecord, context);
  const unexpected = paths.filter((path) => !expected.has(path));
  const missing = [...expected].filter((path) => !paths.includes(path)).sort();
  if (unexpected.length > 0 || missing.length > 0) {
    throw new SkillError("E_OUTPUT_STALE", "Output contains unregistered or missing artifacts", {
      details: { unexpected, missing }
    });
  }
  return paths;
}

async function writeOutputManifest(outputDir, status, packageRecord, context, io) {
  if (packageRecord === null) {
    throw new SkillError("E_FINALIZATION_PACKAGE", "QA finalization requires presentation-package.json");
  }
  const paths = await assertExpectedOutputArtifacts(outputDir, packageRecord, context, io);
  const artifacts = [];
  for (const path of paths) {
    try {
      artifacts.push({ path, sha256: await io.sha256File(outputPath(outputDir, path)) });
    } catch (cause) {
      throw new SkillError("E_OUTPUT_MANIFEST", `Cannot hash ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }
  const manifest = {
    version: "1.0.0",
    producer: packageRecord?.producer ?? { skill: "text-to-html", version: "1.0.0" },
    status,
    entrypoint: packageRecord?.entrypoint ?? "index.html",
    artifacts,
    rootDigest: sha256Text(JSON.stringify(artifacts))
  };
  await writeArtifact(outputDir, MANIFEST_PATH, manifest, io, "E_OUTPUT_MANIFEST");
  return manifest;
}

async function clearPreviousQaEvidence(outputDir, io) {
  await removeGeneratedEntry(outputDir, MANIFEST_PATH, io);
  await removeGeneratedEntry(outputDir, FAILURE_REPORT_PATH, io);
  await removeGeneratedEntry(outputDir, "qa", io, { recursive: true });
  await removeGeneratedEntry(outputDir, "preview", io, { recursive: true });
}

export async function beginQaFinalization(outputDir, options = {}) {
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const io = finalizerIo(options.io ?? options);
  let packageInvalidated = false;
  try {
    await clearPreviousQaEvidence(resolvedOutput, io);
    const packageRecord = await readOptionalJson(resolvedOutput, PACKAGE_PATH, io);
    if (packageRecord === null) {
      await assertExpectedOutputArtifacts(resolvedOutput, null, {}, io);
      return { outputDir: resolvedOutput, packageRecord: null };
    }
    const pending = structuredClone(packageRecord);
    pending.validation = { status: "pending", reports: [QA_REPORT_PATH] };
    delete pending.validation.validatedAt;
    await writePackage(resolvedOutput, pending, io);
    packageInvalidated = true;
    const existingGenerationReport = await outputEntry(resolvedOutput, GENERATION_REPORT_PATH, io);
    await assertExpectedOutputArtifacts(resolvedOutput, pending, { generationReport: existingGenerationReport !== null }, io);
    return { outputDir: resolvedOutput, packageRecord: pending };
  } catch (error) {
    await removePath(outputPath(resolvedOutput, MANIFEST_PATH), io);
    if (!packageInvalidated) await removePath(outputPath(resolvedOutput, PACKAGE_PATH), io);
    throw error;
  }
}

export async function writeQaAttempt(outputDir, attempt, qaReport, options = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new SkillError("E_QA_ATTEMPT", "QA attempt must be a positive integer");
  }
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const io = finalizerIo(options.io ?? options);
  const reportPath = `qa/attempt-${String(attempt).padStart(2, "0")}.json`;
  await writeArtifact(resolvedOutput, reportPath, qaReport, io);
  return reportPath;
}

export async function finalizeQaRun(outputDir, input, options = {}) {
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const io = finalizerIo(options.io ?? options);
  const attempts = input.attempts ?? input.qaReport?.attempts ?? [];
  let qaReport = { ...input.qaReport, attempts };
  validateQaReport(qaReport);
  let scorecard = await writeVisualScorecard(resolvedOutput, qaReport, io);
  qaReport = withScorecardFailure(qaReport, scorecard);
  if (qaReport.status === "failed" && scorecard.accepted) {
    scorecard = await writeVisualScorecard(resolvedOutput, qaReport, io);
  }
  validateQaReport(qaReport);
  await writeArtifact(resolvedOutput, QA_REPORT_PATH, qaReport, io);

  let packageRecord = await readOptionalJson(resolvedOutput, PACKAGE_PATH, io);
  const attemptReports = await existingReportPaths(resolvedOutput, attemptReportPaths(attempts), io);
  const reports = [QA_REPORT_PATH, ...attemptReports];
  if (packageRecord !== null) {
    packageRecord = packageWithQaResult(packageRecord, qaReport, reports);
    packageRecord = await bindVisualScorecard(packageRecord, resolvedOutput, io);
    await writePackage(resolvedOutput, packageRecord, io);
  }
  const generationReport = await writeGenerationReport(resolvedOutput, input.generation, {
    status: qaReport.status,
    attempts,
    qaReportPath: QA_REPORT_PATH,
    packagePath: packageRecord ? PACKAGE_PATH : null
  }, io);
  const outputManifest = await writeOutputManifest(resolvedOutput, qaReport.status, packageRecord, {
    attempts,
    qaReport,
    generationReport: generationReport !== null
  }, io);
  return { status: qaReport.status, qaReport, scorecard, packageRecord, outputManifest };
}

export async function recordQaFailure(outputDir, error, context = {}, options = {}) {
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const io = finalizerIo(options.io ?? options);
  const secondaryErrors = [];
  await removePath(outputPath(resolvedOutput, MANIFEST_PATH), io);

  let packageRecord = null;
  try {
    packageRecord = await readOptionalJson(resolvedOutput, PACKAGE_PATH, io);
  } catch (readError) {
    secondaryErrors.push(readError);
  }

  let qaReport = failureQaReport(error, context, packageRecord);
  let qaReportPath = null;
  if (qaReport) {
    try {
      validateQaReport(qaReport);
      await writeArtifact(resolvedOutput, QA_REPORT_PATH, qaReport, io);
      qaReportPath = QA_REPORT_PATH;
    } catch (reportError) {
      secondaryErrors.push(reportError);
      qaReport = null;
    }
  }

  const failure = failureEvidence(error, context, secondaryErrors);
  let failureReportPath = null;
  try {
    await writeArtifact(resolvedOutput, FAILURE_REPORT_PATH, failure, io);
    failureReportPath = FAILURE_REPORT_PATH;
  } catch (failureWriteError) {
    secondaryErrors.push(failureWriteError);
  }

  let failedPackage = null;
  if (packageRecord !== null) {
    try {
      const attemptReports = await existingReportPaths(resolvedOutput, attemptReportPaths(context.attempts), io);
      const reports = [
        ...(qaReportPath ? [qaReportPath] : []),
        ...(failureReportPath ? [failureReportPath] : []),
        ...attemptReports
      ];
      if (reports.length === 0) throw new SkillError("E_FINALIZATION_EVIDENCE", "Cannot publish a failed package without failure evidence");
      failedPackage = packageWithQaResult(packageRecord, qaReport ?? { status: "failed", measurements: [] }, reports);
      failedPackage.validation.status = "failed";
      await writePackage(resolvedOutput, failedPackage, io);
    } catch (packageError) {
      secondaryErrors.push(packageError);
      failedPackage = null;
    }
  }
  if (!failedPackage) await removePath(outputPath(resolvedOutput, PACKAGE_PATH), io);

  let generationReport = null;
  try {
    generationReport = await writeGenerationReport(resolvedOutput, context.generation, {
      status: "failed",
      attempts: context.attempts ?? [],
      qaReportPath,
      packagePath: failedPackage ? PACKAGE_PATH : null,
      failureReportPath
    }, io, { recover: true });
  } catch (generationError) {
    secondaryErrors.push(generationError);
  }

  let outputManifest = null;
  try {
    outputManifest = await writeOutputManifest(resolvedOutput, "failed", failedPackage, {
      attempts: context.attempts ?? [],
      qaReport,
      generationReport: generationReport !== null,
      failureReport: failureReportPath !== null
    }, io);
  } catch (manifestError) {
    secondaryErrors.push(manifestError);
    await removePath(outputPath(resolvedOutput, MANIFEST_PATH), io);
  }
  return { status: "failed", qaReport, packageRecord: failedPackage, outputManifest, secondaryErrors };
}
