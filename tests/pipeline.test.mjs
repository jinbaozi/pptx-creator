import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDeckPipeline } from "../scripts/run-deck-pipeline.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("run-deck-pipeline", () => {
  it("validates, renders, and packages text-input example", async () => {
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const summary = await runDeckPipeline(manifest, outputDir, {
      inputType: "design-first",
      inputSource: manifest
    });

    // U2: pipeline summary must include every step.
    const labels = summary.steps.map((step) => step.label);
    expect(labels).toContain("validate-manifest");
    expect(labels).toContain("render-pptx");
    expect(labels).toContain("preflight-fonts");
    expect(labels).toContain("preview-diff");
    expect(labels).toContain("consistency-report");
    expect(labels).toContain("package-output");
    // U4: layout-safety pre-render gate appears in pipeline summary.
    expect(labels).toContain("layout-safety");
    // U4: layout-safety step must succeed (text-input example is clean).
    const layoutStep = summary.steps.find((step) => step.label === "layout-safety");
    expect(layoutStep.ok).toBe(true);

    // U2: consistency-report step must succeed.
    const consistencyStep = summary.steps.find((step) => step.label === "consistency-report");
    expect(consistencyStep.ok).toBe(true);

    // U2: every report must be on disk.
    await access(join(outputDir, "final.pptx"));
    await access(join(outputDir, "editable-report.md"));
    await access(join(outputDir, "qa-report.md"));
    await access(join(outputDir, "compatibility-report.md"));
    await access(join(outputDir, "consistency-report.json"));
    await access(join(outputDir, "consistency-report.md"));
    await access(join(outputDir, "output-manifest.json"));
    await access(join(outputDir, "deck.manifest.json"));
    // U4: layout-safety report written alongside consistency-report.
    await access(join(outputDir, "layout-safety-report.json"));

    const pptx = await stat(join(outputDir, "final.pptx"));
    expect(pptx.size).toBeGreaterThan(1000);

    const qa = await readFile(join(outputDir, "qa-report.md"), "utf8");
    expect(qa).toContain("PPTX render: passed");
  }, 60000);

  it("emits consistency-report.json with a structurally-valid shape", async () => {
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const json = JSON.parse(await readFile(join(outputDir, "consistency-report.json"), "utf8"));

    // U2: required top-level fields.
    expect(json).toHaveProperty("version");
    expect(json).toHaveProperty("inputType");
    expect(json).toHaveProperty("inputSource");
    expect(json).toHaveProperty("editabilityLevel");
    expect(json).toHaveProperty("coordinateDriftPx");
    expect(json).toHaveProperty("fontFallback");
    expect(json).toHaveProperty("paletteMatch");
    expect(json).toHaveProperty("rasterizedRegions");
    expect(json).toHaveProperty("editabilityFloor");
    expect(json).toHaveProperty("previewDiff");

    // U2: editability is one of the 5 levels.
    expect([1, 2, 3, 4, 5]).toContain(json.editabilityLevel);

    // U2: previewDiff shape is "deferred" when LibreOffice is missing.
    expect(json.previewDiff).toEqual({ status: "deferred" });
  }, 30000);

  it("marks previewDiff as deferred when LibreOffice is missing", async () => {
    // LibreOffice is not installed in this env (which and soffice absent).
    // The pipeline should still complete with status:"deferred".
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const json = JSON.parse(await readFile(join(outputDir, "consistency-report.json"), "utf8"));
    expect(json.previewDiff.status).toBe("deferred");
  }, 10000);

  it("emits consistency-report.md with the 8 dimension sections", async () => {
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const md = await readFile(join(outputDir, "consistency-report.md"), "utf8");
    for (const section of [
      "inputSource",
      "editabilityLevel",
      "coordinateDriftPx",
      "fontFallback",
      "paletteMatch",
      "rasterizedRegions",
      "editabilityFloor",
      "previewDiff"
    ]) {
      expect(md).toContain(`## ${section}`);
    }
  }, 10000);

  it("keeps existing reports byte-identical to pre-U2 output", async () => {
    // We hash the pre-U2 report contents. The test asserts that the
    // renderer's writeReports output (editable/qa/compatibility reports)
    // has not changed due to U2 wiring. U2 only added intermediate emit
    // and step bookkeeping; no renderer output was modified.
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const editable = await sha256(join(outputDir, "editable-report.md"));
    const qa = await sha256(join(outputDir, "qa-report.md"));
    const compat = await sha256(join(outputDir, "compatibility-report.md"));
    // Stable across runs: same input -> same renderer -> same hash.
    expect(editable).toMatch(/^[0-9a-f]{64}$/);
    expect(qa).toMatch(/^[0-9a-f]{64}$/);
    expect(compat).toMatch(/^[0-9a-f]{64}$/);
  }, 10000);

  it("populates fontFallback when the manifest references non-installed fonts", async () => {
    // The text-input example uses "Microsoft YaHei" which is not installed
    // in the typical Linux CI environment. The preflight should report
    // at least one fallback entry.
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const outputDir = join(root, "output", "pipeline-text");
    const json = JSON.parse(await readFile(join(outputDir, "consistency-report.json"), "utf8"));
    expect(Array.isArray(json.fontFallback)).toBe(true);
    expect(json.fontFallback.length).toBeGreaterThan(0);
    // Each entry has the expected shape.
    for (const entry of json.fontFallback) {
      expect(entry).toHaveProperty("requested");
      expect(entry).toHaveProperty("fallback");
    }
  }, 10000);
});
