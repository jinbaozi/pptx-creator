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
    const secondaryTextManifest = textManifest;
    const batchFile = join(outputDir, "batch.json");
    await writeFile(
      batchFile,
      `﻿${JSON.stringify(
        {
          jobs: [
            { id: "text", manifest: textManifest, outputDir: join(outputDir, "text"), mode: "direct" },
            { id: "text-secondary", manifest: secondaryTextManifest, outputDir: join(outputDir, "text-secondary"), mode: "direct" }
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
    await access(join(outputDir, "text-secondary", "consistency-report.json"));

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

    // Direct manifest jobs do not invent Creative slopRisk evidence.
    const textReport = JSON.parse(await readFile(join(outputDir, "text", "consistency-report.json"), "utf8"));
    const secondaryTextReport = JSON.parse(await readFile(join(outputDir, "text-secondary", "consistency-report.json"), "utf8"));
    expect(textReport.slopRisk).toBeUndefined();
    expect(secondaryTextReport.slopRisk).toBeUndefined();
    expect(aggregate.averageSlopRisk).toBe(0);
  }, 90000);
});
