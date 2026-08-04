import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runConversion } from "../scripts/convert.mjs";

const visualIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;
const execFileAsync = promisify(execFile);
const PYTHON = process.env.PPTX_CREATOR_PYTHON || "python3";
const RED_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const RED_2X1 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP8z8DAwMAAAAYIAQHLR3Z1AAAAAElFTkSuQmCC";
const RED_2X2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
const NEAR_RED_2X2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDA8JuBAQAQDgH+GoAFCQAAAABJRU5ErkJggg==";
const BLUE_2X2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAALHwEDmIWXfgAAAABJRU5ErkJggg==";

async function runComparator(root, sourceBytes, renderBytes) {
  const sourceDir = join(root, "source");
  const renderDir = join(root, "render");
  const reportPath = join(root, "visual-comparison.json");
  await Promise.all([mkdir(sourceDir), mkdir(renderDir)]);
  await Promise.all([
    writeFile(join(sourceDir, "slide-001.png"), Buffer.from(sourceBytes, "base64")),
    writeFile(join(renderDir, "slide-1.png"), Buffer.from(renderBytes, "base64"))
  ]);
  try {
    await execFileAsync(PYTHON, [
      resolve("scripts/compare-deck.py"),
      sourceDir,
      renderDir,
      reportPath
    ], { cwd: resolve(".") });
  } catch {
    // The comparator exits 2 for an intentionally rejected visual gate while
    // still writing its deterministic report.
  }
  return JSON.parse(await readFile(reportPath, "utf8"));
}

describe("self-contained visual metrics", () => {
  it("reports SSIM, normalized MAE, and a near-threshold local tile", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-visual-metrics-"));
    try {
      const report = await runComparator(root, RED_2X2, NEAR_RED_2X2);
      expect(report.summary).toMatchObject({ sizeMatch: true, passed: true });
      expect(report.summary.minimumSsim).toBeGreaterThan(0.85);
      expect(report.summary.maximumNormalizedMae).toBeLessThan(12 / 255);
      expect(report.summary.worstTile).toMatchObject({ slideIndex: 0 });
      expect(report.slides[0].worstTileMae).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hard-fails image dimensions instead of resizing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-visual-size-"));
    try {
      const report = await runComparator(root, RED_1X1, RED_2X1);
      expect(report.summary).toMatchObject({ sizeMatch: false, passed: false });
      expect(report.slides[0]).toMatchObject({
        sizeMatch: false,
        meanAbsChannelDiff: null,
        normalizedMae: null,
        diff: null
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a deliberately wrong local region", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-visual-wrong-"));
    try {
      const report = await runComparator(root, RED_2X2, BLUE_2X2);
      expect(report.summary.passed).toBe(false);
      expect(report.summary.maximumNormalizedMae).toBeGreaterThan(12 / 255);
      expect(report.summary.catastrophicWorstTile).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("HTML -> editable PPTX visual proof", () => {
  visualIt.each([
    { fixture: "minimal", slides: 1, minimumLevel: 5, minimumCoverage: 1 },
    { fixture: "complex", slides: 2, minimumLevel: 4, minimumCoverage: 0.95 }
  ])("runs the full generation, render, compare, and gate loop for $fixture", async ({ fixture, slides, minimumLevel, minimumCoverage }) => {
    const output = await mkdtemp(join(tmpdir(), `html-to-pptx-visual-${fixture}-`));
    const result = await runConversion(
      resolve(`examples/${fixture}/index.html`),
      output,
      { overwrite: true, browserTimeoutMs: 90_000, maxRepairAttempts: 3 }
    );
    expect(result).toMatchObject({
      status: "passed",
      slides,
      editabilityLevel: minimumLevel
    });
    expect(result.nativeCoverage).toBeGreaterThanOrEqual(minimumCoverage);
    await access(join(output, "final.pptx"));
    const qa = JSON.parse(await readFile(join(output, "qa-report.json"), "utf8"));
    expect(qa.gates.pptxGeometry.criticalCount).toBe(0);
    expect(qa.gates.visual).toMatchObject({ passed: true, sizeMatch: true });
    expect(qa.gates.visual.minimumSsim).toBeGreaterThan(0.85);
    expect(qa.gates.editability.perSlide).toHaveLength(slides);
    expect(qa.gates.editability.perSlide.every((slide) => slide.passed)).toBe(true);
    expect(qa.gates.fullSlideRaster.violations).toBe(0);
  });
});
