#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SkillError, runCli } from "./lib/errors.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { validatePresentationPackage } from "./validate-presentation-package.mjs";
import { runBrowserQa } from "./lib/qa.mjs";
import { buildDeck } from "./lib/render.mjs";
import { parseOptions, readJson, sha256File, writeJson } from "./lib/utils.mjs";

const REPAIRABLE_CODES = new Set([
  "E_TEXT_OVERFLOW",
  "E_CONTENT_CLIPPED",
  "E_ELEMENT_BOUNDS",
  "E_MODULE_OVERLAP",
  "E_CONTRAST"
]);

async function finalizePackage(outputDir, qaReport) {
  const packagePath = join(outputDir, "presentation-package.json");
  const packageRecord = await readJson(packagePath);
  const measurements = new Map(qaReport.measurements.map((entry) => [entry.slideId, entry.components]));
  for (const slide of packageRecord.deck.slides) slide.components = measurements.get(slide.id) ?? [];
  packageRecord.validation = {
    status: qaReport.status,
    reports: [
      "qa-report.json",
      ...qaReport.attempts.map((attempt) => attempt.report)
    ]
  };
  await writeJson(packagePath, packageRecord);
  validatePresentationPackage(packageRecord);
  return packageRecord;
}

async function writeOutputManifest(outputDir, packageRecord, qaReport) {
  const files = [
    "index.html",
    "presentation-plan.json",
    "presentation-plan.source.json",
    "deck-manifest.json",
    "presentation-package.json",
    "design-tokens.json",
    "speaker-notes.md",
    "sources.json",
    "qa-report.json",
    "assets/deck.css",
    "assets/deck.js",
    "assets/design-tokens.css",
    ...packageRecord.assets.map((asset) => asset.path),
    ...qaReport.viewports.flatMap((viewport) => viewport.slides.map((slide) => slide.screenshot))
  ];
  const uniqueFiles = [...new Set(files)].sort();
  const artifacts = [];
  for (const path of uniqueFiles) {
    artifacts.push({ path, sha256: await sha256File(join(outputDir, path)) });
  }
  const manifest = {
    version: "1.0.0",
    producer: { skill: "text-to-html", version: "1.0.0" },
    status: qaReport.status,
    entrypoint: "index.html",
    artifacts
  };
  await writeJson(join(outputDir, "output-manifest.json"), manifest);
  return manifest;
}

export async function runPipeline(planPath, outputDir, options = {}) {
  const maxAttempts = Number(options.maxAttempts ?? 3);
  const timeoutMs = Number(options.timeoutMs ?? 90_000);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    const error = new Error("--max-attempts must be an integer from 1 to 3");
    error.code = "E_USAGE";
    throw error;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 90_000) {
    const error = new Error("--timeout-ms must be at least 90000");
    error.code = "E_USAGE";
    throw error;
  }
  const validated = await validatePlanFile(planPath);
  const resolvedOutput = resolve(outputDir);
  const attempts = [];
  let finalQa;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const repairLevel = attempt - 1;
    await buildDeck(validated.plan, validated.planPath, resolvedOutput, { repairLevel });
    const qa = await runBrowserQa(resolvedOutput, { timeoutMs });
    const attemptPath = join(resolvedOutput, "qa", `attempt-${String(attempt).padStart(2, "0")}.json`);
    await writeJson(attemptPath, { ...qa, attempt, repairLevel });
    attempts.push({
      attempt,
      repairLevel,
      status: qa.status,
      findingCodes: [...new Set(qa.findings.map((item) => item.code))],
      report: relative(resolvedOutput, attemptPath).replaceAll("\\", "/")
    });
    finalQa = qa;
    if (qa.status === "passed") break;
    const repairable = qa.findings.length > 0 && qa.findings.every((item) => REPAIRABLE_CODES.has(item.code));
    if (!repairable) break;
  }
  const qaReport = { ...finalQa, attempts };
  await writeJson(join(resolvedOutput, "qa-report.json"), qaReport);
  const packageRecord = await finalizePackage(resolvedOutput, qaReport);
  await writeOutputManifest(resolvedOutput, packageRecord, qaReport);
  await writeJson(join(resolvedOutput, "generation-report.json"), {
    version: "1.0.0",
    status: qaReport.status,
    plan: {
      deckId: validated.plan.deck.id,
      hostReview: validated.plan.hostReview,
      assumptions: validated.plan.assumptions
    },
    attempts,
    qaReport: "qa-report.json",
    presentationPackage: "presentation-package.json",
    outputManifest: "output-manifest.json"
  });
  if (qaReport.status !== "passed") {
    throw new SkillError("E_QA_FAILED", `${qaReport.findings.length} blocking browser finding(s) remain after ${attempts.length} attempt(s)`, {
      details: { attempts, findings: qaReport.findings }
    });
  }
  return {
    status: "passed",
    outputDir: resolvedOutput,
    entrypoint: join(resolvedOutput, "index.html"),
    slideCount: packageRecord.deck.slides.length,
    attemptCount: attempts.length,
    screenshotCount: qaReport.summary.screenshotCount,
    protocol: `${packageRecord.protocol}@${packageRecord.version}`
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseOptions(argv);
  if (positional.length !== 2) {
    const error = new Error("usage: run-pipeline.mjs <presentation-plan.json> <output-dir> [--max-attempts 3] [--timeout-ms 90000]");
    error.code = "E_USAGE";
    throw error;
  }
  const result = await runPipeline(positional[0], positional[1], {
    maxAttempts: options["max-attempts"],
    timeoutMs: options["timeout-ms"]
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
