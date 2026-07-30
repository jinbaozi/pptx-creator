#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { buildDeck } from "./lib/render.mjs";
import { parseOptions } from "./lib/utils.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseOptions(argv);
  if (positional.length !== 2) {
    const error = new Error("usage: build-deck.mjs <presentation-plan.json> <output-dir> [--repair-level 0|1|2]");
    error.code = "E_USAGE";
    throw error;
  }
  const repairLevel = Number(options["repair-level"] ?? 0);
  if (!Number.isInteger(repairLevel) || repairLevel < 0 || repairLevel > 2) {
    const error = new Error("--repair-level must be 0, 1, or 2");
    error.code = "E_USAGE";
    throw error;
  }
  const { plan, planPath } = await validatePlanFile(positional[0]);
  const built = await buildDeck(plan, planPath, positional[1], { repairLevel });
  process.stdout.write(`${JSON.stringify({
    status: "built-pending-qa",
    outputDir: built.outputDir,
    entrypoint: built.indexPath,
    repairLevel
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
