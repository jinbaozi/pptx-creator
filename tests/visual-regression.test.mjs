import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runVisualRegression } from "../scripts/run-visual-regression.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("runVisualRegression", () => {
  it("returns a deferred report when preview rendering is unavailable", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-visual-deferred-"));
    const manifest = join(root, "examples/text-input/deck.manifest.json");

    const report = await runVisualRegression(manifest, outputDir, {
      renderPreview: async () => ({
        status: "deferred",
        previews: [],
        note: "LibreOffice headless not found."
      })
    });

    expect(report.status).toBe("deferred");
    expect(report.steps.map((step) => step.label)).toEqual(["pipeline", "render-preview"]);
    expect(report.steps.every((step) => step.ok)).toBe(true);

    const saved = JSON.parse(await readFile(join(outputDir, "visual-regression-report.json"), "utf8"));
    expect(saved.status).toBe("deferred");
  }, 60000);

  it("compares previews against a reference directory", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-visual-compare-"));
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const referenceDir = join(root, "examples/image-input");
    const referenceName = "business-slide.png";
    const referencePath = join(referenceDir, referenceName);

    const report = await runVisualRegression(manifest, outputDir, {
      referenceDir,
      renderPreview: async () => ({
        status: "ok",
        previewCount: 1,
        previews: [referencePath]
      }),
      comparePreview: async () => ({
        reference: referenceName,
        candidate: referenceName,
        verdict: "close",
        meanAbsChannelDiff: 0
      })
    });

    expect(report.status).toBe("passed");
    expect(report.comparisons).toHaveLength(1);
    expect(report.comparisons[0].verdict).toBe("close");
  }, 60000);
});
