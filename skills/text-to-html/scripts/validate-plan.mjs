#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { validatePlanFile } from "./lib/plan.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    const error = new Error("usage: validate-plan.mjs <presentation-plan.json>");
    error.code = "E_USAGE";
    throw error;
  }
  const result = await validatePlanFile(argv[0]);
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result.summary }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
