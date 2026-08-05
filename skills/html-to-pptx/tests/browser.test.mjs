import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "node-html-parser";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  auditHtmlFile,
  withSettledHtmlPage,
  withTemporarilyVisibleSlide
} from "../scripts/lib/html-layout-audit.mjs";
import { measureHtmlFile } from "../scripts/measure-html.mjs";
import { applyLocalizedFallbacks } from "../scripts/convert.mjs";
import { convertHtmlToManifest, reconcileExplicitGroups } from "../scripts/lib/html-to-manifest-core.mjs";
import { auditStructureFidelity } from "../scripts/lib/structure-fidelity.mjs";

const browserIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;
const example = resolve("examples/minimal/index.html");
const execFileAsync = promisify(execFile);

describe("real Chromium source validation", () => {
  browserIt("renders, screenshots, and measures every slide with a 90s timeout", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "html-to-pptx-browser-"));
    const audit = await auditHtmlFile(example, {
      viewportWidth: 1280,
      viewportHeight: 720,
      totalTimeoutMs: 90_000,
      profile: "replica",
      outputDir
    });
    expect(audit.summary).toMatchObject({
      slideCount: 1,
      criticalCount: 0,
      blocked: false
    });
    expect(audit.slides[0].screenshot).toMatch(/\.png$/);
    const measured = await measureHtmlFile(example, {
      replica: true,
      totalTimeoutMs: 90_000
    });
    expect(measured.elements.length).toBeGreaterThanOrEqual(4);
    expect(measured.viewport).toEqual({ width: 1280, height: 720 });
  });

  browserIt("preserves callback failures while closing Chromium", async () => {
    await expect(withSettledHtmlPage(example, {
      viewportWidth: 1280,
      viewportHeight: 720,
      totalTimeoutMs: 90_000,
      networkEnabled: false
    }, async () => {
      throw new Error("callback failure sentinel");
    })).rejects.toThrow("callback failure sentinel");

    await expect(withSettledHtmlPage(example, {
      viewportWidth: 1280,
      viewportHeight: 720,
      totalTimeoutMs: 90_000,
      networkEnabled: false
    }, async (page) => page.title())).resolves.toBe("最小可编辑演示");
  });

  browserIt("assigns unmarked inline claim fragments to their semantic text parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-inline-claim-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { display: block; padding: 120px; font: 24px/1.35 Arial, sans-serif; }
      .status-label { color: #2457E6; font-weight: 700; }
    </style></head><body>
      <section class="pptx-slide" data-slide-id="slide-001">
        <p data-pptx-id="claim-001" data-pptx-kind="text"><span class="status-label">假设</span><span>试点可由现有项目管理员兼任内容负责人。</span></p>
      </section>
    </body></html>`);
    try {
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const fragments = measured.elements.filter((element) => /^html-/.test(element.id) && element.kind === "text");
      expect(fragments.map((element) => element.semantics.semanticParentId)).toEqual(["claim-001", "claim-001"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("preserves CSS white-space modes, tab size, and measured heading lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-browser-whitespace-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; overflow: hidden; background: white; }
      [data-pptx-kind="text"] { position: absolute; left: 40px; width: 500px; font-family: Arial, sans-serif; }
      #normal { top: 20px; white-space: normal; }
      #pre { top: 70px; white-space: pre; tab-size: 4; }
      #pre-wrap { top: 120px; white-space: pre-wrap; tab-size: 2; }
      #pre-line { top: 190px; white-space: pre-line; }
      #break-spaces { top: 250px; white-space: break-spaces; tab-size: 6; }
      #heading { top: 320px; width: 220px; font-size: 32px; line-height: 1.1; white-space: normal; }
      #radius { top: 380px; width: 200px; height: 100px; border-radius: 50% / 30%; background: white; }
      #mixed { top: 500px; width: 180px; font-size: 32px; line-height: 1.1; white-space: normal; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <div id="normal" data-pptx-id="normal" data-pptx-kind="text">  alpha   beta\n gamma  </div>
      <pre id="pre" data-pptx-id="pre" data-pptx-kind="text">  alpha\t beta\r\n    gamma  </pre>
      <div id="pre-wrap" data-pptx-id="pre-wrap" data-pptx-kind="text">  alpha\t beta\n    gamma  </div>
      <div id="pre-line" data-pptx-id="pre-line" data-pptx-kind="text">  alpha   beta\n    gamma  </div>
      <div id="break-spaces" data-pptx-id="break-spaces" data-pptx-kind="text">  alpha   beta\n    gamma  </div>
      <h1 id="heading" data-pptx-id="heading" data-pptx-kind="text">A measured heading that wraps across lines</h1>
      <div id="radius" data-pptx-id="radius" data-pptx-kind="shape"></div>
      <h1 id="mixed" data-pptx-id="mixed" data-pptx-kind="text">Alpha <span>beta</span> gamma delta</h1>
    </section></body></html>`);
    try {
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const byId = new Map(measured.elements.map((element) => [element.id, element]));
      expect(byId.get("normal")).toMatchObject({ text: "alpha beta gamma", style: { whiteSpace: "normal", preserveWhitespace: false, tabSize: 8 } });
      expect(byId.get("pre")).toMatchObject({ text: "  alpha\t beta\n    gamma  ", style: { whiteSpace: "pre", preserveWhitespace: true, tabSize: 4 } });
      expect(byId.get("pre-wrap")).toMatchObject({ text: "  alpha\t beta\n    gamma  ", style: { whiteSpace: "pre-wrap", preserveWhitespace: true, tabSize: 2 } });
      expect(byId.get("pre-line")).toMatchObject({ text: "alpha beta\ngamma", style: { whiteSpace: "pre-line", preserveWhitespace: false } });
      expect(byId.get("break-spaces")).toMatchObject({ text: "  alpha   beta\n    gamma  ", style: { whiteSpace: "break-spaces", preserveWhitespace: true, tabSize: 6 } });
      expect(byId.get("heading")).toMatchObject({
        renderedLines: expect.arrayContaining([expect.any(String)]),
        lineBreakOffsets: expect.any(Array),
        renderedLineCount: expect.any(Number)
      });
      expect(byId.get("heading").renderedLineCount).toBeGreaterThan(1);
      expect(byId.get("heading").lineBreakOffsets.length).toBeGreaterThan(0);
      expect(byId.get("radius").style.cornerRadii[0]).toMatchObject({ rx: 100, ry: 30 });
      expect(byId.get("mixed")).toMatchObject({
        text: "Alpha beta gamma delta",
        renderedLines: ["Alpha beta", "gamma", "delta"],
        lineBreakOffsets: [10, 16],
        renderedLineCount: 3
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("captures stacking, inline lines, native 2D transforms, ancestor opacity, and local compositing fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-browser-semantics-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; overflow: hidden; background: white; isolation: isolate; }
      .stack-root { position: absolute; left: 40px; top: 32px; width: 460px; height: 150px; z-index: 2; }
      .stack-back, .stack-front { position: absolute; width: 180px; height: 80px; }
      .stack-back { left: 0; top: 0; z-index: 1; background: #91A7FF; }
      .stack-front { left: 30px; top: 20px; z-index: 3; background: #FF9F1C; }
      .ancestor { position: absolute; left: 40px; top: 220px; opacity: .5; }
      .opaque-child { width: 180px; height: 60px; opacity: .4; background: #2457E6; }
      .multiline { position: absolute; left: 300px; top: 220px; width: 170px; font: 18px/1.25 Arial, sans-serif; }
      .native-transform { position: absolute; left: 600px; top: 120px; width: 120px; height: 80px; background: #34D399; transform: translate(12px, 8px) rotate(30deg) scale(-1, .8); transform-origin: 18px 10px; }
      .unsupported-transform { position: absolute; left: 800px; top: 120px; width: 120px; height: 80px; background: #EF4444; transform: skewX(12deg); }
      .unsupported-compositing { position: absolute; left: 1000px; top: 120px; width: 120px; height: 80px; background: #A855F7; isolation: isolate; }
    </style></head><body>
      <section class="pptx-slide" data-slide-id="slide-001">
        <div id="stack-root" class="stack-root">
          <div id="stack-back" class="stack-back" data-pptx-kind="shape"></div>
          <div id="stack-front" class="stack-front" data-pptx-kind="shape"></div>
        </div>
        <div class="ancestor"><div id="opaque-child" class="opaque-child" data-pptx-kind="shape"></div></div>
        <p id="claim" data-pptx-kind="text" class="multiline"><span>line one wraps across the inline fragment boundary and line two remains visible.</span></p>
        <div id="native-transform" class="native-transform" data-pptx-kind="shape"></div>
        <div id="unsupported-transform" class="unsupported-transform" data-pptx-kind="shape"></div>
        <div id="unsupported-compositing" class="unsupported-compositing" data-pptx-kind="shape"></div>
      </section>
    </body></html>`);
    try {
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const byId = new Map(measured.elements.map((element) => [element.id, element]));
      expect(measured.slides[0].replica).toMatchObject({ hasUnsupportedEffects: false });
      expect(measured.slides[0].replica.unsupportedCompositing).toBeUndefined();
      const back = byId.get("stack-back");
      const front = byId.get("stack-front");
      expect(back?.paintOrder).toEqual(expect.any(Number));
      expect(front?.paintOrder).toEqual(expect.any(Number));
      expect(front.paintOrder).toBeGreaterThan(back.paintOrder);
      expect(front.stackingContextPath).toEqual(expect.arrayContaining(["stack-root"]));

      const lines = measured.elements.filter((element) => element.semantics?.semanticParentId === "claim");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(new Set(lines.map((element) => element.text)).size).toBe(lines.length);
      expect(lines.every((element) => /-line-\d+$/.test(element.id))).toBe(true);

      const opaque = byId.get("opaque-child");
      expect(opaque.style.effectiveOpacity).toBeCloseTo(.2, 3);
      expect(opaque.replica.effectiveOpacity).toBeCloseTo(.2, 3);

      const nativeTransform = byId.get("native-transform");
      expect(nativeTransform.style.transformData).toMatchObject({
        supported: true,
        matrix: expect.arrayContaining([expect.any(Number)]),
        transformOrigin: { raw: expect.any(String) }
      });
      expect(nativeTransform.style.transformData.flipV).toBe(true);

      const unsupportedTransform = byId.get("unsupported-transform");
      expect(unsupportedTransform.replica).toMatchObject({
        hasUnsupportedEffects: true,
        unsupportedCompositing: { transformFallback: "skew-transform" }
      });
      expect(byId.get("unsupported-compositing")?.replica).toMatchObject({
        hasUnsupportedEffects: true,
        unsupportedCompositing: { isolation: "isolate" }
      });

      const manifest = convertHtmlToManifest(await readFile(input, "utf8"), {
        measurements: measured,
        designMode: "replica"
      });
      const ids = manifest.slides[0].elements.map((element) => element.id);
      expect(ids.indexOf("stack-back")).toBeLessThan(ids.indexOf("stack-front"));
      expect(manifest.slides[0].elements.find((element) => element.id === "native-transform")).toMatchObject({
        transform: { supported: true, flipV: true }
      });
      expect(manifest.slides[0].replicaUnsupportedEffects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          elementId: "unsupported-compositing",
          isolation: "isolate"
        }),
        expect.objectContaining({
          elementId: "unsupported-transform",
          transformFallback: "skew-transform"
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("activates, captures, measures, and restores generic hidden slides", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-hidden-slides-"));
    const input = join(root, "index.html");
    const outputDir = join(root, "audit");
    await writeFile(input, `<!doctype html>
      <html><head><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
        .pptx-slide {
          position: absolute; inset: 0; display: none;
          width: 1280px; height: 720px; background: white;
        }
        .pptx-slide[data-current="yes"] { display: grid; }
        h1 { margin: 64px; font: 700 42px/1.2 Arial, sans-serif; }
        .overlay { position: fixed; z-index: 20; bottom: 10px; left: 10px; }
      </style></head><body>
        <section class="pptx-slide" data-current="yes" data-slide-id="slide-001" aria-hidden="false">
          <h1 data-pptx-id="title-001" data-pptx-kind="text">Slide one</h1>
        </section>
        <section class="pptx-slide" data-current="no" data-slide-id="slide-002" aria-hidden="true">
          <h1 data-pptx-id="title-002" data-pptx-kind="text">Slide two</h1>
        </section>
        <section class="pptx-slide" data-current="no" data-slide-id="slide-003" aria-hidden="true">
          <h1 data-pptx-id="title-003" data-pptx-kind="text">Slide three</h1>
        </section>
        <nav class="overlay">viewer controls</nav>
      </body></html>`);

    await withSettledHtmlPage(input, {
      viewportWidth: 1280,
      viewportHeight: 720,
      totalTimeoutMs: 90_000,
      networkEnabled: false
    }, async (page) => {
      const before = await page.evaluate(() =>
        [...document.querySelectorAll(".pptx-slide")].map((slide) => ({
          className: slide.getAttribute("class"),
          style: slide.getAttribute("style"),
          ariaHidden: slide.getAttribute("aria-hidden"),
          hidden: slide.getAttribute("hidden")
        })));
      await withTemporarilyVisibleSlide(page, 1, async (state) => {
        expect(state.display).toBe("grid");
        expect(await page.locator("[data-slide-id='slide-002']").isVisible()).toBe(true);
        expect(await page.locator(".overlay").isVisible()).toBe(false);
      });
      const after = await page.evaluate(() =>
        [...document.querySelectorAll(".pptx-slide")].map((slide) => ({
          className: slide.getAttribute("class"),
          style: slide.getAttribute("style"),
          ariaHidden: slide.getAttribute("aria-hidden"),
          hidden: slide.getAttribute("hidden")
        })));
      expect(after).toEqual(before);
    });

    const audit = await auditHtmlFile(input, {
      viewportWidth: 1280,
      viewportHeight: 720,
      totalTimeoutMs: 90_000,
      profile: "replica",
      outputDir
    });
    expect(audit.summary).toMatchObject({
      slideCount: 3,
      criticalCount: 0,
      blocked: false
    });
    for (const slide of audit.slides) {
      expect(slide).toMatchObject({ width: 1280, height: 720 });
      await access(join(outputDir, slide.screenshot));
    }

    const measured = await measureHtmlFile(input, {
      replica: true,
      totalTimeoutMs: 90_000
    });
    expect(measured.slides.map((slide) => ({
      id: slide.slideId,
      index: slide.slideIndex,
      display: slide.style.display
    }))).toEqual([
      { id: "slide-001", index: 0, display: "grid" },
      { id: "slide-002", index: 1, display: "grid" },
      { id: "slide-003", index: 2, display: "grid" }
    ]);
    expect(new Set(measured.elements.map((element) => element.slideIndex)))
      .toEqual(new Set([0, 1, 2]));
  });

  browserIt("captures localized fallbacks after activating a hidden fifth slide", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-hidden-fallback-"));
    const input = join(root, "index.html");
    const outputDir = join(root, "output");
    const slides = Array.from({ length: 5 }, (_, index) => `
      <section class="pptx-slide" data-slide-id="slide-${String(index + 1).padStart(3, "0")}" data-current="${index === 0 ? "yes" : "no"}">
        ${index === 4 ? "<div data-pptx-id=\"effect-005\" data-pptx-kind=\"shape\" class=\"effect\"></div>" : ""}
      </section>`).join("\n");
    await writeFile(input, `<!doctype html>
      <html><head><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
        .pptx-slide { position: absolute; inset: 0; display: none; width: 1280px; height: 720px; background: white; }
        .pptx-slide[data-current="yes"] { display: block; }
        .effect { position: absolute; left: 120px; top: 160px; width: 240px; height: 120px; background: #2457E6; filter: blur(1px); }
      </style></head><body>${slides}</body></html>`);
    const manifest = {
      deck: { size: { width: 13.333, height: 7.5 } },
      slides: Array.from({ length: 5 }, (_, index) => ({
        id: `slide-${String(index + 1).padStart(3, "0")}`,
        elements: index === 4 ? [{
          type: "shape",
          id: "effect-005",
          x: 1.25,
          y: 1.6667,
          w: 2.5,
          h: 1.25
        }] : [],
        replicaUnsupportedEffects: index === 4 ? [{
          elementId: "effect-005",
          filter: "blur(1px)",
          reason: "unsupported-filter"
        }] : []
      }))
    };
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [{
        id: "effect-005",
        slideIndex: 4,
        x: 1.25,
        y: 1.6667,
        w: 2.5,
        h: 1.25,
        px: { x: 120, y: 160, w: 240, h: 120 }
      }]
    };

    try {
      const fallbacks = await applyLocalizedFallbacks(input, manifest, measurements, outputDir, 90_000);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]).toMatchObject({
        slideId: "slide-005",
        componentId: "effect-005-localized-fallback",
        path: "assets/fallback-001.png"
      });
      await access(join(outputDir, fallbacks[0].path));
      expect(manifest.slides[4].elements).toEqual([expect.objectContaining({
        id: "effect-005-localized-fallback",
        type: "cropped-asset"
      })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("localizes unsupported pseudo paint to pseudo bounds and preserves explicit group ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-pseudo-group-fallback-"));
    const input = join(root, "index.html");
    const outputDir = join(root, "output");
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "deck.pptx");
    const html = `<!doctype html><html><head><style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; overflow: hidden; background: #FFFFFF; }
      #pseudo-group { position: absolute; left: 70px; top: 60px; width: 360px; height: 220px; }
      #pseudo-owner { position: absolute; left: 30px; top: 30px; width: 260px; height: 140px; background: #F8FAFC; }
      #pseudo-owner::before { content: "BLUR"; position: absolute; left: 18px; top: 16px; background: #EF4444; font: 16px/20px Arial, sans-serif; filter: blur(3px); }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <div id="pseudo-group" data-pptx-id="pseudo-group" data-pptx-kind="group">
        <div id="pseudo-owner" data-pptx-id="pseudo-owner" data-pptx-kind="shape"></div>
      </div>
    </section></body></html>`;
    await writeFile(input, html, "utf8");
    try {
      const measurements = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const owner = measurements.elements.find((element) => element.id === "pseudo-owner");
      const pseudo = measurements.elements.find((element) => element.id === "pseudo-owner-before");
      expect(pseudo).toMatchObject({ generated: true, pseudoOwnerId: "pseudo-owner", replica: { unsupportedVisual: "pseudo-unsupported-filter" } });
      expect(pseudo.px.w).toBeLessThan(owner.px.w);
      const manifest = convertHtmlToManifest(html, {
        measurements,
        designMode: "replica",
        designSystemSource: resolve("design-systems/business-neutral/DESIGN.md")
      });
      const initialGroup = manifest.slides[0].elements.find((element) => element.id === "pseudo-group");
      expect(initialGroup.children).toEqual(expect.arrayContaining(["pseudo-owner", "pseudo-owner-before"]));
      const fallbacks = await applyLocalizedFallbacks(input, manifest, measurements, outputDir, 90_000);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0].box.w).toBeLessThan(owner.w);
      expect(fallbacks[0].box.h).toBeLessThan(owner.h);
      reconcileExplicitGroups(parse(html), manifest, measurements);
      const group = manifest.slides[0].elements.find((element) => element.id === "pseudo-group");
      expect(group.children).toEqual(["pseudo-owner", "pseudo-owner-before-localized-fallback"]);
      expect(manifest.slides[0].elements.find((element) => element.id === "pseudo-owner-before-localized-fallback")).toMatchObject({ semanticParentId: "pseudo-owner" });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await execFileAsync(process.execPath, [resolve("scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: resolve(".") });
      const structure = await auditStructureFidelity({ manifest, manifestPath, pptxPath });
      expect(structure.summary.blocked).toBe(false);
      expect(structure.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "pseudo-group", passed: true })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
