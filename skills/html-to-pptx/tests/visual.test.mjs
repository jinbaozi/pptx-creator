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

  it("compares opted-in component regions and rejects unsafe component IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-component-visual-"));
    try {
      const sourceDir = join(root, "source");
      const renderDir = join(root, "render");
      const componentsDir = join(root, "components-input");
      await Promise.all([mkdir(sourceDir), mkdir(renderDir), mkdir(componentsDir)]);
      await Promise.all([
        writeFile(join(sourceDir, "slide-001.png"), Buffer.from(RED_2X2, "base64")),
        writeFile(join(renderDir, "slide-1.png"), Buffer.from(RED_2X2, "base64"))
      ]);
      const componentPath = join(componentsDir, "regions.json");
      await writeFile(componentPath, JSON.stringify({ components: [{ id: "key-card", slideIndex: 0, box: { x: -1, y: -1, w: 3, h: 3 }, kind: "shape" }] }));
      const reportPath = join(root, "component-comparison.json");
      await execFileAsync(PYTHON, [resolve("scripts/compare-deck.py"), sourceDir, renderDir, reportPath, "--components", componentPath, "--component-ssim-threshold", "0.94", "--component-normalized-mae-threshold", "0.05"], { cwd: resolve(".") });
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report.version).toBe("2.0.0");
      expect(report.components.summary).toMatchObject({ status: "passed", count: 1, passed: true });
      expect(report.components.components[0]).toMatchObject({ id: "key-card", box: { x: 0, y: 0, w: 2, h: 2 }, passed: true });
      await access(join(root, "component-diff", "component-key-card.png"));
      await access(join(root, "components", "summary.json"));

      await writeFile(join(renderDir, "slide-1.png"), Buffer.from(NEAR_RED_2X2, "base64"));
      await writeFile(componentPath, JSON.stringify({ components: [{ id: "key-card", slideIndex: 0, box: { x: 0, y: 0, w: 2, h: 2 } }] }));
      const rejectedLocalComponent = join(root, "component-rejected.json");
      await expect(execFileAsync(PYTHON, [resolve("scripts/compare-deck.py"), sourceDir, renderDir, rejectedLocalComponent, "--components", componentPath, "--component-ssim-threshold", "1"], { cwd: resolve(".") })).rejects.toThrow();
      const rejectedReport = JSON.parse(await readFile(rejectedLocalComponent, "utf8"));
      expect(rejectedReport.summary).toMatchObject({ passed: false });
      expect(rejectedReport.summary.components).toMatchObject({ passed: false });

      await writeFile(componentPath, JSON.stringify({ components: [{ id: "fractional-slide", slideIndex: 0.5, box: { x: 0, y: 0, w: 1, h: 1 } }] }));
      await expect(execFileAsync(PYTHON, [resolve("scripts/compare-deck.py"), sourceDir, renderDir, join(root, "fractional.json"), "--components", componentPath], { cwd: resolve(".") })).rejects.toThrow();

      await writeFile(componentPath, JSON.stringify({ components: [
        { id: "duplicate", slideIndex: 0, box: { x: 0, y: 0, w: 1, h: 1 } },
        { id: "duplicate", slideIndex: 0, box: { x: 1, y: 1, w: 1, h: 1 } }
      ] }));
      await expect(execFileAsync(PYTHON, [resolve("scripts/compare-deck.py"), sourceDir, renderDir, join(root, "duplicate.json"), "--components", componentPath], { cwd: resolve(".") })).rejects.toThrow();

      await writeFile(componentPath, JSON.stringify({ components: [{ id: "../escape", slideIndex: 0, box: { x: 0, y: 0, w: 1, h: 1 } }] }));
      await expect(execFileAsync(PYTHON, [resolve("scripts/compare-deck.py"), sourceDir, renderDir, join(root, "unsafe.json"), "--components", componentPath], { cwd: resolve(".") })).rejects.toThrow();
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
    expect(qa.runtimeEvidence.browser).toMatchObject({
      browser: "chromium",
      chromiumVersion: expect.stringMatching(/^\d+\./),
      nodeVersion: expect.stringMatching(/^v\d+/)
    });
    expect(qa.runtimeEvidence.preview).toMatchObject({
      reportVersion: "0.2.0",
      libreOfficeVersion: expect.stringMatching(/libreoffice/i),
      popplerVersion: expect.stringMatching(/pdftoppm version/i),
      pythonVersion: expect.stringMatching(/^\d+\./),
      libraries: { Pillow: expect.stringMatching(/^\d+\./) }
    });
    const measurements = JSON.parse(await readFile(join(output, "layout-measurements.json"), "utf8"));
    const compatibility = JSON.parse(await readFile(join(output, "compatibility-report.json"), "utf8"));
    expect(measurements.runtime).toEqual(qa.runtimeEvidence.browser);
    expect(compatibility.officeRendering.runtimeEvidence).toEqual(qa.runtimeEvidence);
  });

  visualIt("runs a strict replica profile with an opted-in key component", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-visual-replica-strict-"));
    const output = join(root, "output");
    const input = join(root, "strict-fixture.html");
    await writeFile(input, `<!doctype html><html><head><style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; overflow: hidden; background: #FFFFFF; }
      #key-group { position: absolute; left: 80px; top: 80px; width: 400px; height: 180px; }
      #key-base { position: absolute; left: 0; top: 0; width: 120px; height: 180px; background: #2457E6; }
      #key-accent { position: absolute; left: 140px; top: 0; width: 120px; height: 180px; background: #FFFFFF; }
      #key-rule { position: absolute; left: 280px; top: 0; width: 120px; height: 180px; background: #2457E6; }
      #key-title { position: absolute; left: 80px; top: 290px; color: #2457E6; font: 700 28px/1.2 Arial, sans-serif; }
      #photo { position: absolute; left: 540px; top: 96px; width: 12px; height: 12px; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <div id="key-group" data-pptx-id="key-group" data-pptx-kind="group" data-pptx-visual-key="true">
        <div id="key-base" data-pptx-id="key-base" data-pptx-kind="shape"></div>
        <div id="key-accent" data-pptx-id="key-accent" data-pptx-kind="shape"></div>
        <div id="key-rule" data-pptx-id="key-rule" data-pptx-kind="shape"></div>
      </div>
      <span id="key-title" data-pptx-id="key-title" data-pptx-kind="text">Strict fixture</span>
      <img id="photo" data-pptx-id="photo" data-pptx-kind="image" src="data:image/png;base64,${RED_1X1}" alt="photo" />
    </section></body></html>`, "utf8");
    const result = await runConversion(input, output, {
      overwrite: true,
      browserTimeoutMs: 90_000,
      maxRepairAttempts: 1,
      qualityProfile: "replica-strict"
    });
    expect(result).toMatchObject({ status: "passed", editabilityLevel: expect.any(Number) });
    const qa = JSON.parse(await readFile(join(output, "qa-report.json"), "utf8"));
    const editable = JSON.parse(await readFile(join(output, "editable-report.json"), "utf8"));
    const fallbackLedger = JSON.parse(await readFile(join(output, "fallback-ledger.json"), "utf8"));
    expect(qa.qualityProfile).toBe("replica-strict");
    expect(editable.version).toBe("2.0.0");
    expect(result.nativeCoverage).toBe(result.nativeObjectCoverage);
    expect(qa.gates.editability.nativeCoverage).toBe(qa.gates.editability.nativeObjectCoverage);
    expect(qa.attempts[0].editability.nativeCoverage).toBe(qa.attempts[0].editability.nativeObjectCoverage);
    expect(editable.nativeCoverage).toBe(editable.nativeObjectCoverage);
    expect(fallbackLedger.nativeCoverage).toBe(fallbackLedger.nativeObjectCoverage);
    await expect(readFile(join(output, "editable-report.md"), "utf8")).resolves.toContain("Native coverage");
    expect(qa.gates.editability.level).toBeGreaterThanOrEqual(4);
    expect(qa.gates.editability.nativeObjectCoverage).toBeGreaterThanOrEqual(0.9);
    expect(qa.gates.editability.semanticEditabilityCoverage).toBeGreaterThanOrEqual(0.9);
    expect(qa.gates.structureFidelity.criticalCount).toBe(0);
    expect(qa.gates.visual.minimumSsim).toBeGreaterThanOrEqual(0.9);
    expect(qa.gates.visual.maximumNormalizedMae).toBeLessThanOrEqual(0.05);
    expect(qa.gates.visual.components).toMatchObject({ status: "passed", passed: true });
    const componentReport = JSON.parse(await readFile(join(output, "component-comparison.json"), "utf8"));
    expect(componentReport.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "key-group", passed: true, ssimThreshold: 0.94, normalizedMaeThreshold: 0.05 })
    ]));
    await access(join(output, "component-diff", "component-key-group.png"));
    await access(join(output, "components", "summary.json"));
  });
});
