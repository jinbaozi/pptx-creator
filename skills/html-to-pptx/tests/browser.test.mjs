import { access, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  auditHtmlFile,
  withSettledHtmlPage,
  withTemporarilyVisibleSlide
} from "../scripts/lib/html-layout-audit.mjs";
import { measureHtmlFile } from "../scripts/measure-html.mjs";

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
});
