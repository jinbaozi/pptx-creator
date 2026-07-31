#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { analyzeNarrative } from "./lib/narrative.mjs";
import { analyzePagination } from "./lib/pagination.mjs";
import { validatePlanFile } from "./lib/plan.mjs";

export async function planCheck(planPath) {
  const result = await validatePlanFile(planPath);
  const narrative = analyzeNarrative(result.plan);
  const pagination = analyzePagination(result.plan);
  const errors = [...narrative.errors, ...pagination.errors];
  const warnings = [...narrative.warnings, ...pagination.warnings];
  return {
    schemaVersion: "1.0.0",
    command: "plan-check",
    status: errors.length > 0 ? "failed" : (warnings.length > 0 ? "attention-required" : "passed"),
    stage: "plan-check",
    errors,
    warnings,
    artifacts: {
      plan: resolve(planPath),
      narrative,
      pagination
    },
    nextActions: errors.length > 0
      ? ["Host must revise the reviewed plan; diagnostics do not change slide semantics."]
      : []
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    const error = new Error("usage: plan-check.mjs <presentation-plan.json>");
    error.code = "E_USAGE";
    throw error;
  }
  process.stdout.write(`${JSON.stringify(await planCheck(argv[0]), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
