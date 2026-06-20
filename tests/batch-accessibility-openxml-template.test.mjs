import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { analyzeAccessibility } from "../scripts/analyze-accessibility.mjs";
import { runBatchPipeline } from "../scripts/run-batch-pipeline.mjs";
import { inspectOpenXml } from "../scripts/openxml-repair.mjs";
import { importTemplate } from "../scripts/import-template.mjs";

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));

describe("batch, accessibility, template import, and OpenXML repair", () => {
  it("runs a batch manifest list and writes per-job summaries", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-batch-"));
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const batchFile = join(outputDir, "batch.json");
    await writeFile(
      batchFile,
      `\uFEFF${JSON.stringify({ jobs: [{ id: "text", manifest, outputDir: join(outputDir, "text") }] }, null, 2)}`,
      "utf8"
    );

    const report = await runBatchPipeline(batchFile, outputDir);

    expect(report.status).toBe("passed");
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].status).toBe("passed");
    await access(join(outputDir, "batch-report.json"));
    await access(join(outputDir, "text", "final.pptx"));
  }, 60000);

  it("emits a batch-level consistency-report aggregating per-deck reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-batch-consistency-"));
    const textManifest = join(root, "examples/text-input/deck.manifest.json");
    const htmlManifest = join(root, "examples/html-input/deck.manifest.json");
    const batchFile = join(outputDir, "batch.json");
    await writeFile(
      batchFile,
      `\uFEFF${JSON.stringify(
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
    // Each job's per-deck report must exist.
    await access(join(outputDir, "text", "consistency-report.json"));
    await access(join(outputDir, "html", "consistency-report.json"));
    // The batch aggregate must exist and validate against the schema.
    const aggregatePath = join(outputDir, "consistency-report.batch.json");
    await access(aggregatePath);
    const aggregate = JSON.parse(await readFile(aggregatePath, "utf8"));
    expect(aggregate).toMatchObject({
      version: expect.any(String),
      createdAt: expect.any(String),
      batch: {
        totalDecks: 2,
        passedDecks: expect.any(Number),
        failedDecks: expect.any(Number)
      },
      editabilityDistribution: expect.objectContaining({
        "1": expect.any(Number),
        "2": expect.any(Number),
        "3": expect.any(Number),
        "4": expect.any(Number),
        "5": expect.any(Number)
      }),
      averageCoordinateDriftPx: expect.any(Number),
      fontFallbackRate: expect.any(Number),
      paletteMatch: expect.any(Number)
    });
    expect(aggregate.perDeckReports).toHaveLength(2);
    expect(aggregate.perDeckReports.every((p) => typeof p === "string" && p.length > 0)).toBe(true);
  }, 90000);

  it("continues processing remaining jobs when one job throws", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-batch-resilience-"));
    const goodManifest = join(root, "examples/text-input/deck.manifest.json");
    const batchFile = join(outputDir, "batch.json");
    await writeFile(
      batchFile,
      `\uFEFF${JSON.stringify(
        {
          jobs: [
            { id: "good", manifest: goodManifest, outputDir: join(outputDir, "good") },
            { id: "bad", manifest: join(outputDir, "does-not-exist.json"), outputDir: join(outputDir, "bad") }
          ]
        },
        null,
        2
      )}`,
      "utf8"
    );

    const report = await runBatchPipeline(batchFile, outputDir);

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.status).toBe("failed");
    // The good job's per-deck report is still present.
    await access(join(outputDir, "good", "consistency-report.json"));
  }, 60000);

  it("reports accessibility risks from a deck manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-a11y-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.slides[0].elements.push({
      type: "image",
      id: "missing-alt",
      src: "../image-input/business-slide.png",
      x: 0.2,
      y: 0.2,
      w: 2,
      h: 1
    });
    const manifest = join(outputDir, "deck.manifest.json");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    const report = await analyzeAccessibility(manifest, join(outputDir, "accessibility-report.md"));

    expect(report.status).toBe("review");
    expect(report.issues.some((issue) => issue.rule === "image-alt")).toBe(true);
    expect(await readFile(join(outputDir, "accessibility-report.md"), "utf8")).toContain("Accessibility Report");
  });

  it("inspects PPTX OpenXML and classifies healthy generated decks", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-openxml-"));
    await execFileAsync(node, [
      join(root, "scripts/render-pptx.mjs"),
      join(root, "examples/text-input/deck.manifest.json"),
      join(outputDir, "final.pptx")
    ]);

    const report = await inspectOpenXml(join(outputDir, "final.pptx"), join(outputDir, "openxml-repair-report.json"));

    expect(report.status).toBe("ok");
    expect(report.slideCount).toBeGreaterThan(0);
    expect(report.requiredParts.every((part) => part.present)).toBe(true);
  }, 60000);

  it("imports a PPTX template summary for design constraints", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-template-"));
    const pptxPath = join(outputDir, "template.pptx");
    await execFileAsync(node, [
      join(root, "scripts/render-pptx.mjs"),
      join(root, "examples/text-input/deck.manifest.json"),
      pptxPath
    ]);

    const summary = await importTemplate(pptxPath, join(outputDir, "template-summary.json"));

    expect(summary.status).toBe("ok");
    expect(summary.slideCount).toBeGreaterThan(0);
    expect(summary.layoutCount).toBeGreaterThan(0);
    expect(summary.masterCount).toBeGreaterThan(0);
  }, 60000);
});
