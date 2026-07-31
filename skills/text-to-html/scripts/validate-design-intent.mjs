#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { validateDesignIntent } from "./lib/report-validation.mjs";

export async function validateDesignIntentFile(planPath) {
  const result = await validatePlanFile(planPath);
  validateDesignIntent(result.plan.designIntent);
  return {
    schemaVersion: "1.0.0",
    command: "validate-design-intent",
    status: "passed",
    stage: "design-intent",
    errors: [],
    warnings: [],
    artifacts: {
      plan: resolve(planPath),
      themeId: result.plan.designIntent.themeId,
      lock: result.plan.designIntent.lock
    },
    nextActions: []
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    const error = new Error("usage: validate-design-intent.mjs <presentation-plan.json>");
    error.code = "E_USAGE";
    throw error;
  }
  process.stdout.write(`${JSON.stringify(await validateDesignIntentFile(argv[0]), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
