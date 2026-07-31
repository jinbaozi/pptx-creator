#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { analyzeNarrative } from "./lib/narrative.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { writeJson } from "./lib/utils.mjs";

export async function analyzeNarrativeFile(planPath) {
  const validated = await validatePlanFile(planPath);
  return {
    planPath: validated.planPath,
    report: analyzeNarrative(validated.plan)
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length < 1 || argv.length > 2) {
    const error = new Error("usage: analyze-narrative.mjs <presentation-plan.json> [narrative-report.json]");
    error.code = "E_USAGE";
    throw error;
  }
  const { report } = await analyzeNarrativeFile(argv[0]);
  if (argv[1]) await writeJson(resolve(argv[1]), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
