import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { buildConsistencyBatch } from "./lib/consistency-report-writer.mjs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

export async function runBatchPipeline(batchPath, defaultOutputDir = "output/batch") {
  const resolvedBatch = resolve(batchPath);
  const batch = JSON.parse((await readFile(resolvedBatch, "utf8")).replace(/^﻿/, ""));
  const jobs = Array.isArray(batch.jobs) ? batch.jobs : [];
  if (jobs.length === 0) {
    throw new Error("batch.jobs must contain at least one job");
  }
  const reportDir = resolve(defaultOutputDir);
  await mkdir(reportDir, { recursive: true });

  const results = [];
  const consistencyEntries = [];
  for (const [index, job] of jobs.entries()) {
    const id = job.id ?? `job-${index + 1}`;
    const manifest = resolve(dirname(resolvedBatch), job.manifest);
    const outputDir = resolve(dirname(resolvedBatch), job.outputDir ?? `${id}`);
    try {
      const summary = await runDeckPipeline(manifest, outputDir);
      results.push({ id, manifest, outputDir, status: summary.status, steps: summary.steps });
    } catch (error) {
      results.push({
        id,
        manifest,
        outputDir,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    // Try to read the per-deck consistency report (best-effort; never
    // abort the batch on a single job failure).
    try {
      const reportPath = resolve(outputDir, "consistency-report.json");
      const raw = await readFile(reportPath, "utf8");
      const parsed = JSON.parse(raw);
      const rel = relative(reportDir, reportPath).replace(/\\/g, "/");
      consistencyEntries.push({ path: rel, report: parsed });
    } catch {
      // No consistency report available for this job — skip silently.
    }
  }

  const report = {
    version: "0.1.0",
    batch: resolvedBatch,
    total: results.length,
    passed: results.filter((job) => job.status === "passed").length,
    failed: results.filter((job) => job.status === "failed").length,
    jobs: results,
    status: results.every((job) => job.status === "passed") ? "passed" : "failed"
  };
  await writeFile(resolve(reportDir, "batch-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  // Batch-level consistency aggregate. Validate against schema; if the
  // aggregate is empty (no per-deck reports), skip the write so we never
  // emit a schema-invalid envelope.
  if (consistencyEntries.length > 0) {
    const batchReport = buildConsistencyBatch(consistencyEntries, {
      createdAt: new Date().toISOString()
    });
    await writeFile(
      resolve(reportDir, "consistency-report.batch.json"),
      JSON.stringify(batchReport, null, 2) + "\n",
      "utf8"
    );
  }

  return report;
}

async function main() {
  const [, , batchArg, outputArg] = process.argv;
  if (!batchArg) fail("usage: run-batch-pipeline.mjs <batch.json> [report-output-dir]");
  const report = await runBatchPipeline(batchArg, outputArg);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
