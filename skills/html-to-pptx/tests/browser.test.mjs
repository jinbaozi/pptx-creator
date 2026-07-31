import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const browserIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;
const example = resolve("examples/minimal/index.html");

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
});
