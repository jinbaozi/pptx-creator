import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDeckPipeline } from "../scripts/run-deck-pipeline.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("run-deck-pipeline", () => {
  it("validates, renders, and packages text-input example", async () => {
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const summary = await runDeckPipeline(manifest, outputDir);

    expect(summary.status).toBe("passed");
    expect(summary.steps.every((step) => step.ok)).toBe(true);

    await access(join(outputDir, "final.pptx"));
    await access(join(outputDir, "editable-report.md"));
    await access(join(outputDir, "qa-report.md"));
    await access(join(outputDir, "output-manifest.json"));
    await access(join(outputDir, "deck.manifest.json"));

    const pptx = await stat(join(outputDir, "final.pptx"));
    expect(pptx.size).toBeGreaterThan(1000);

    const qa = await readFile(join(outputDir, "qa-report.md"), "utf8");
    expect(qa).toContain("PPTX render: passed");
  }, 60000);
});
