#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { analyzePagination } from "./lib/pagination.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { writeJson } from "./lib/utils.mjs";

export async function analyzePaginationFile(planPath) {
  const validated = await validatePlanFile(planPath);
  return {
    planPath: validated.planPath,
    report: analyzePagination(validated.plan)
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length < 1 || argv.length > 2) {
    const error = new Error("usage: plan-pagination.mjs <presentation-plan.json> [pagination-report.json]");
    error.code = "E_USAGE";
    throw error;
  }
  const { report } = await analyzePaginationFile(argv[0]);
  if (argv[1]) await writeJson(resolve(argv[1]), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
