#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SkillError, runCli } from "./lib/errors.mjs";
import { beginQaFinalization, finalizeQaRun, recordQaFailure, writeQaAttempt } from "./lib/finalization.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { runBrowserQa } from "./lib/qa.mjs";
import { buildDeck } from "./lib/render.mjs";
import { assertTestRuntimeOverrides } from "./lib/runtime-provenance.mjs";
import { assertSafeOutputDir, parseOptions } from "./lib/utils.mjs";

const REPAIRABLE_CODES = new Set([
  "E_TEXT_OVERFLOW",
  "E_CONTENT_CLIPPED",
  "E_ELEMENT_BOUNDS",
  "E_MODULE_OVERLAP",
  "E_CONTRAST"
]);

function generationPlan(plan, mode) {
  return {
    deckId: plan.deck.id,
    planVersion: plan.version,
    mode,
    review: plan.review,
    designIntentLock: plan.designIntent.lock,
    assumptions: plan.assumptions
  };
}

export async function runPipeline(planPath, outputDir, options = {}, runtime = {}) {
  assertTestRuntimeOverrides(runtime, "runPipeline");
  const mode = options.mode ?? "quality";
  if (!["quality", "balanced", "draft"].includes(mode)) {
    const error = new Error("--mode must be quality, balanced, or draft");
    error.code = "E_USAGE";
    throw error;
  }
  const maxAllowedAttempts = mode === "quality" ? 3 : (mode === "balanced" ? 2 : 1);
  const maxAttempts = Number(options.maxAttempts ?? maxAllowedAttempts);
  const timeoutMs = Number(options.timeoutMs ?? 90_000);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > maxAllowedAttempts) {
    const error = new Error(`--max-attempts must be an integer from 1 to ${maxAllowedAttempts} in ${mode} mode`);
    error.code = "E_USAGE";
    throw error;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 90_000) {
    const error = new Error("--timeout-ms must be at least 90000");
    error.code = "E_USAGE";
    throw error;
  }
  const validated = await validatePlanFile(planPath, { allowUnreviewed: mode === "draft" });
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const runQa = runtime.runBrowserQa ?? runBrowserQa;
  const build = runtime.buildDeck ?? buildDeck;
  const finalizationOptions = runtime.finalization ?? {};
  if (mode === "draft") {
    const built = await build(validated.plan, validated.planPath, resolvedOutput, {
      repairLevel: 0,
      allowUnreviewed: true
    });
    return {
      status: "pending",
      mode,
      outputDir: resolvedOutput,
      entrypoint: built.indexPath,
      slideCount: validated.plan.slides.length,
      nextActions: ["Host must complete content, design, and rights approvals before quality QA can publish a passed package."]
    };
  }
  const attempts = [];
  let finalQa;
  let finalization;
  try {
    await beginQaFinalization(resolvedOutput, finalizationOptions);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const repairLevel = attempt - 1;
      await build(validated.plan, validated.planPath, resolvedOutput, { repairLevel });
      const qa = await runQa(resolvedOutput, { timeoutMs });
      const report = await writeQaAttempt(resolvedOutput, attempt, { ...qa, attempt, repairLevel }, finalizationOptions);
      attempts.push({
        attempt,
        repairLevel,
        status: qa.status,
        findingCodes: [...new Set(qa.findings.map((item) => item.code))],
        report
      });
      finalQa = qa;
      if (qa.status === "passed") break;
      const repairable = qa.findings.length > 0 && qa.findings.every((item) => REPAIRABLE_CODES.has(item.code));
      if (!repairable) break;
    }
    finalization = await finalizeQaRun(resolvedOutput, {
      qaReport: { ...finalQa, attempts },
      attempts,
      generation: {
        version: "2.0.0",
        mode,
        plan: generationPlan(validated.plan, mode)
      }
    }, finalizationOptions);
  } catch (error) {
    await recordQaFailure(resolvedOutput, error, {
      stage: "pipeline",
      timeoutMs,
      attempts,
      generation: {
        version: "2.0.0",
        mode,
        plan: generationPlan(validated.plan, mode)
      }
    }, finalizationOptions);
    throw error;
  }
  if (finalization.status !== "passed") {
    throw new SkillError("E_QA_FAILED", `${finalization.qaReport.findings.length} blocking browser finding(s) remain after ${attempts.length} attempt(s)`, {
      details: { attempts, findings: finalization.qaReport.findings }
    });
  }
  return {
    status: "passed",
    mode,
    outputDir: resolvedOutput,
    entrypoint: join(resolvedOutput, "index.html"),
    slideCount: finalization.packageRecord?.deck.slides.length ?? 0,
    attemptCount: attempts.length,
    screenshotCount: finalization.qaReport.summary.screenshotCount,
    protocol: finalization.packageRecord ? `${finalization.packageRecord.protocol}@${finalization.packageRecord.version}` : null
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseOptions(argv);
  if (positional.length !== 2) {
    const error = new Error("usage: run-pipeline.mjs <presentation-plan.json> <output-dir> [--mode quality|balanced|draft] [--max-attempts 3] [--timeout-ms 90000]");
    error.code = "E_USAGE";
    throw error;
  }
  const result = await runPipeline(positional[0], positional[1], {
    maxAttempts: options["max-attempts"],
    timeoutMs: options["timeout-ms"],
    mode: options.mode
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
