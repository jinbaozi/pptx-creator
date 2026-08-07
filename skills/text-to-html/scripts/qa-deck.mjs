#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SkillError, runCli } from "./lib/errors.mjs";
import { beginQaFinalization, finalizeQaRun, recordQaFailure } from "./lib/finalization.mjs";
import { runBrowserQa } from "./lib/qa.mjs";
import { assertTestRuntimeOverrides, verifyOutputRuntimeProvenance } from "./lib/runtime-provenance.mjs";
import { assertSafeOutputDir, parseOptions } from "./lib/utils.mjs";

export async function runQaDeck(outputDir, options = {}, runtime = {}) {
  assertTestRuntimeOverrides(runtime, "runQaDeck");
  const timeoutMs = Number(options.timeoutMs ?? 90_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 90_000) {
    const error = new Error("--timeout-ms must be at least 90000");
    error.code = "E_USAGE";
    throw error;
  }
  const resolvedOutput = assertSafeOutputDir(outputDir);
  await readFile(join(resolvedOutput, "index.html"), "utf8");
  const runQa = runtime.runBrowserQa ?? runBrowserQa;
  const finalizationOptions = runtime.finalization ?? {};
  let finalization;
  try {
    const state = await beginQaFinalization(resolvedOutput, finalizationOptions);
    await verifyOutputRuntimeProvenance(resolvedOutput, { packageRecord: state.packageRecord });
    const qaReport = await runQa(resolvedOutput, { timeoutMs });
    finalization = await finalizeQaRun(resolvedOutput, { qaReport }, finalizationOptions);
  } catch (error) {
    await recordQaFailure(resolvedOutput, error, {
      stage: "qa-deck",
      timeoutMs
    }, finalizationOptions);
    throw error;
  }
  if (finalization.status !== "passed") {
    throw new SkillError("E_QA_FAILED", `${finalization.qaReport.findings.length} blocking browser finding(s) remain`, {
      details: finalization.qaReport.findings
    });
  }
  return { status: finalization.status, summary: finalization.qaReport.summary };
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseOptions(argv);
  if (positional.length !== 1) {
    const error = new Error("usage: qa-deck.mjs <output-dir> [--timeout-ms 90000]");
    error.code = "E_USAGE";
    throw error;
  }
  const result = await runQaDeck(positional[0], { timeoutMs: options["timeout-ms"] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
