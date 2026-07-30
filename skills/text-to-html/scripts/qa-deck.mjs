#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SkillError, runCli } from "./lib/errors.mjs";
import { runBrowserQa } from "./lib/qa.mjs";
import { parseOptions, writeJson } from "./lib/utils.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseOptions(argv);
  if (positional.length !== 1) {
    const error = new Error("usage: qa-deck.mjs <output-dir> [--timeout-ms 90000]");
    error.code = "E_USAGE";
    throw error;
  }
  const timeoutMs = Number(options["timeout-ms"] ?? 90_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 90_000) {
    const error = new Error("--timeout-ms must be at least 90000");
    error.code = "E_USAGE";
    throw error;
  }
  const outputDir = resolve(positional[0]);
  await readFile(join(outputDir, "index.html"), "utf8");
  const report = await runBrowserQa(outputDir, { timeoutMs });
  await writeJson(join(outputDir, "qa-report.json"), report);
  process.stdout.write(`${JSON.stringify({ status: report.status, summary: report.summary }, null, 2)}\n`);
  if (report.status !== "passed") throw new SkillError("E_QA_FAILED", `${report.findings.length} blocking browser finding(s) remain`, { details: report.findings });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
