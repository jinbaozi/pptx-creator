#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { scaffoldPlanFromSource, validatePlan } from "./lib/plan.mjs";
import { writeJson } from "./lib/utils.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    const error = new Error("usage: scaffold-plan.mjs <source.md|source.txt> <draft-plan.json>");
    error.code = "E_USAGE";
    throw error;
  }
  const plan = await scaffoldPlanFromSource(argv[0]);
  await validatePlan(plan, { allowUnreviewed: true });
  await writeJson(resolve(argv[1]), plan);
  process.stdout.write(`${JSON.stringify({
    status: "draft-created",
    output: resolve(argv[1]),
    slideCount: plan.slides.length,
    reviewRequired: true
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
