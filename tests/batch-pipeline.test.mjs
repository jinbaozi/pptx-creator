import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBatchPipeline } from "../scripts/run-batch-pipeline.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("run-batch-pipeline U11 — layoutSafety aggregation", () => {
  it("aggregates layoutSafety distribution + average slopRisk across 2+ decks", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-batch-u11-"));
    const textManifest = join(root, "examples/text-input/deck.manifest.json");
    const htmlManifest = join(root, "examples/html-input/deck.manifest.json");
    const batchFile = join(outputDir, "batch.json");
    await writeFile(
      batchFile,
      `﻿${JSON.stringify(
        {
          jobs: [
            { id: "text", manifest: textManifest, outputDir: join(outputDir, "text") },
            { id: "html", manifest: htmlManifest, outputDir: join(outputDir, "html") }
          ]
        },
        null,
        2
      )}`,
      "utf8"
    );

    const report = await runBatchPipeline(batchFile, outputDir);

    expect(report.status).toBe("passed");
    expect(report.jobs).toHaveLength(2);
    // Each per-deck report must exist.
    await access(join(outputDir, "text", "consistency-report.json"));
    await access(join(outputDir, "html", "consistency-report.json"));

    // The batch aggregate must include the U11 layoutSafety fields.
    const aggregatePath = join(outputDir, "consistency-report.batch.json");
    await access(aggregatePath);
    const aggregate = JSON.parse(await readFile(aggregatePath, "utf8"));

    // U11: per-deck layoutSafety distribution.
    expect(aggregate.layoutSafetyDistribution).toBeDefined();
    expect(aggregate.layoutSafetyDistribution).toEqual(
      expect.objectContaining({
        passed: expect.any(Number),
        "violated-with-flag": expect.any(Number),
        "violated-blocked": expect.any(Number),
        unknown: expect.any(Number)
      })
    );
    const totalDistribution =
      aggregate.layoutSafetyDistribution.passed +
      aggregate.layoutSafetyDistribution["violated-with-flag"] +
      aggregate.layoutSafetyDistribution["violated-blocked"] +
      aggregate.layoutSafetyDistribution.unknown;
    expect(totalDistribution).toBe(2);

    // U11: per-deck slopRisk average across the batch.
    expect(typeof aggregate.averageSlopRisk).toBe("number");
    expect(aggregate.averageSlopRisk).toBeGreaterThanOrEqual(0);
    expect(aggregate.averageSlopRisk).toBeLessThanOrEqual(100);

    // Per-deck consistency reports each include a slopRisk number.
    const textReport = JSON.parse(await readFile(join(outputDir, "text", "consistency-report.json"), "utf8"));
    const htmlReport = JSON.parse(await readFile(join(outputDir, "html", "consistency-report.json"), "utf8"));
    expect(typeof textReport.slopRisk).toBe("number");
    expect(typeof htmlReport.slopRisk).toBe("number");
    // The average across the batch is the simple mean of the two decks.
    const expectedAvg = Number(((textReport.slopRisk + htmlReport.slopRisk) / 2).toFixed(2));
    expect(aggregate.averageSlopRisk).toBe(expectedAvg);
  }, 90000);
});
