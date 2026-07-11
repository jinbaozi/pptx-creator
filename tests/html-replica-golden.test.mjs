import { access, mkdtemp, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const enabled = process.env.PLAYWRIGHT_RUN === "1";

describe.skipIf(!enabled)("real HTML replica proof", () => {
  it("measures unannotated visible DOM in replica mode and accepts only real source-to-render metrics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-golden-"));
    await execFileAsync(process.execPath, [join(root, "scripts/pptx.mjs"), "html", join(root, "examples/html-input/replica-golden.html"), dir], { cwd: root, timeout: 120000 });
    const measurements = JSON.parse(await readFile(join(dir, "layout-measurements.json"), "utf8"));
    const evidence = JSON.parse(await readFile(join(dir, "replica-evidence.json"), "utf8"));
    expect(measurements.elements.length).toBeGreaterThanOrEqual(5);
    expect(evidence).toMatchObject({ accepted: true, route: "html", capabilities: { sourceRenderComparison: true } });
    expect(evidence.paths.source.sha256).not.toBe(evidence.paths.render.sha256);
    expect(evidence.aggregate.fidelity.ssim.value).toBeGreaterThanOrEqual(0.97);
    expect(evidence.aggregate.fidelity.normalizedMae.value).toBeLessThanOrEqual(6 / 255);
    expect(evidence.aggregate.fidelity.bboxP95Drift.value).toBeLessThanOrEqual(2);
    expect(evidence.aggregate.fidelity.fontMapping.value).toBe(1);
    expect(evidence.aggregate.fidelity.colorMapping.value).toBe(1);
    for (const file of ["final.pptx", "deck.manifest.json", "quality-report.json", "quality-report.md", "replica-evidence.json", "output-manifest.json", "preview/index.html"]) {
      await expect(access(join(dir, file))).resolves.toBeUndefined();
    }
  }, 180000);

  it("crops only the unsupported region and preserves native siblings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-fallback-"));
    await execFileAsync(process.execPath, [join(root, "scripts/pptx.mjs"), "html", join(root, "examples/html-input/replica-local-fallback.html"), dir], { cwd: root, timeout: 120000 });
    const manifest = JSON.parse(await readFile(join(dir, "deck.manifest.json"), "utf8"));
    const evidence = JSON.parse(await readFile(join(dir, "replica-evidence.json"), "utf8"));
    const fallback = evidence.aggregate.fallbacks.find((item) => /clip|filter/.test(item.reason));
    expect(fallback).toMatchObject({ fullSlide: false, reason: expect.stringMatching(/clip|filter/), nativeAlternativesAttempted: expect.any(Array) });
    expect(fallback.bbox.width).toBeLessThan(manifest.deck.size.width / 2);
    expect(fallback.bbox.height).toBeLessThan(manifest.deck.size.height / 2);
    expect(manifest.slides[0].elements.some((item) => item.type === "cropped-asset")).toBe(true);
    expect(manifest.slides[0].elements.some((item) => item.type === "text" && /Editable title/.test(item.text))).toBe(true);
    expect(manifest.slides[0].elements.findIndex((item) => item.type === "cropped-asset")).toBeLessThan(manifest.slides[0].elements.findIndex((item) => item.id === "later-native"));
    expect(evidence.aggregate.fallbacks.map((item) => item.reason).join(" ")).toMatch(/svg-paint/);
    expect(evidence.aggregate.fallbacks.map((item) => item.reason).join(" ")).toMatch(/pseudo-element-paint/);
    expect(new Set(manifest.slides[0].elements.filter((item) => item.type === "cropped-asset").map((item) => item.id)).size).toBe(3);
    expect(evidence.aggregate.fallbacks).toHaveLength(3);
    expect(manifest.slides[0].replicaUnsupportedEffects).toEqual([]);
    expect(manifest.metadata.replicaSource.coverage.unsupportedEffects).toEqual([]);
    expect(manifest.metadata.replicaSource.coverage.coverage).toBe(1);
    expect(manifest.metadata.replicaSource.coverage.nativeCoverage).toBeLessThan(1);
    expect(evidence.blockingFindings).toEqual([]);
  }, 180000);

  it("binds every page to a distinct real source/render pair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-two-page-"));
    await execFileAsync(process.execPath, [join(root, "scripts/pptx.mjs"), "html", join(root, "examples/html-input/replica-golden-two-page.html"), dir], { cwd: root, timeout: 180000 });
    const evidence = JSON.parse(await readFile(join(dir, "replica-evidence.json"), "utf8"));
    const index = await readFile(join(dir, "preview/index.html"), "utf8");
    expect(evidence.source.pageCount).toBe(2);
    expect(evidence.render.pageCount).toBe(2);
    expect(evidence.perSlide.map((page) => page.slideIndex)).toEqual([0, 1]);
    expect(index).toContain("slide-1.png");
    expect(index).toContain("slide-2.png");
  }, 240000);
});
