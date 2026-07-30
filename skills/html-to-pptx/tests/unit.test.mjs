import { describe, expect, it } from "vitest";
import { parse } from "node-html-parser";
import { mergeSlideAuditResults } from "../scripts/lib/html-layout-audit.mjs";
import {
  measureContentCoverage,
  planReplicaSlideBackground
} from "../scripts/lib/html-to-manifest-core.mjs";
import {
  HtmlToPptxError,
  applyAutomaticRepairs,
  assertNoFullSlideRaster,
  injectNativeCharts,
  parseArgs,
  suppressDuplicateNestedTextElements,
  suppressNativeTableDescendants,
  validateManifestContract
} from "../scripts/convert.mjs";

function manifest() {
  return {
    version: "0.2.0",
    deck: { title: "Test", language: "en-US", size: { width: 13.333, height: 7.5 } },
    slides: [{
      id: "slide-001",
      title: "Test",
      background: { type: "solid", color: "#FFFFFF" },
      elements: [{
        type: "text",
        id: "title-001",
        text: "Test",
        x: 0.5,
        y: 0.5,
        w: 4,
        h: 0.5,
        style: { fontSize: 24 }
      }]
    }]
  };
}

describe("public argument and safety contracts", () => {
  it("maps layered slide gradients to native background and accent shapes", () => {
    const plan = planReplicaSlideBackground(
      "radial-gradient(circle at 88% 13%, rgba(36, 87, 230, 0.1), transparent 24%), linear-gradient(135deg, #F6F7FB, #E8EEFF)",
      "#F6F7FB",
      { width: 13.333, height: 7.5 }
    );
    expect(plan.unsupported).toEqual([]);
    expect(plan.background).toMatchObject({
      type: "gradient",
      gradient: { type: "linear" }
    });
    expect(plan.overlays).toHaveLength(1);
    expect(plan.overlays[0]).toMatchObject({
      type: "shape",
      shape: "ellipse",
      role: "background"
    });
    expect(plan.overlays[0].style.gradient.stops.at(-1).transparency).toBe(100);
  });

  it("measures semantic content without double-counting containers or notes", () => {
    const root = parse(`<main>
      <section class="pptx-slide" data-slide-id="slide-001">
        <div class="eyebrow">decorative label</div>
        <li data-pptx-id="point-card" data-pptx-kind="shape">
          <span data-pptx-id="point-number" data-pptx-kind="text">1</span>
          <p data-pptx-id="point-text" data-pptx-kind="text">Covered fact</p>
        </li>
        <aside class="speaker-notes" aria-hidden="true">private note</aside>
      </section>
      <section class="pptx-slide" data-slide-id="slide-002" aria-hidden="true">
        <p data-pptx-id="second-page" data-pptx-kind="text">Second page fact</p>
      </section>
    </main>`);
    const coverage = measureContentCoverage(
      root.querySelectorAll(".pptx-slide"),
      [
        {
          elements: [
            { type: "text", text: "1" },
            { type: "text", text: "Covered fact" }
          ]
        },
        {
          elements: [{ type: "text", text: "Second page fact" }]
        }
      ]
    );
    expect(coverage).toEqual({
      sourceBlocks: 3,
      coveredBlocks: 3,
      ratio: 1,
      missing: []
    });
  });

  it("merges ordered per-slide browser audits without dropping checks", () => {
    expect(mergeSlideAuditResults([
      {
        slides: [{ slideId: "slide-001" }],
        checks: [{ slideId: "slide-001", kind: "warning" }]
      },
      {
        slides: [{ slideId: "slide-002" }],
        checks: [{ slideId: "slide-002", kind: "bounds" }]
      }
    ])).toEqual({
      slides: [{ slideId: "slide-001" }, { slideId: "slide-002" }],
      checks: [
        { slideId: "slide-001", kind: "warning" },
        { slideId: "slide-002", kind: "bounds" }
      ]
    });
  });

  it("enforces the browser timeout and bounded repair limit", () => {
    expect(() => parseArgs(["a.html", "out", "--browser-timeout-ms", "89999"]))
      .toThrow(/at least 90000/);
    expect(() => parseArgs(["a.html", "out", "--max-repair-attempts", "4"]))
      .toThrow(/0 to 3/);
    expect(parseArgs(["a.html", "out"]).options).toMatchObject({
      browserTimeoutMs: 90000,
      maxRepairAttempts: 3
    });
  });

  it("rejects a full-slide raster-only deck", () => {
    const value = manifest();
    value.slides[0].elements = [{
      type: "cropped-asset",
      id: "page-shot",
      src: "assets/page.png",
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
      replicaFallback: { fullSlide: true }
    }];
    expect(() => assertNoFullSlideRaster(value)).toThrow(HtmlToPptxError);
  });

  it("repairs bounds and browser-proven text height deterministically", () => {
    const value = manifest();
    value.slides[0].elements[0].x = -0.4;
    const result = applyAutomaticRepairs(value, [
      { slideId: "slide-001", severity: "critical", type: "bounds", target: "title-001" },
      {
        slideId: "slide-001",
        severity: "critical",
        type: "text-required-bounds",
        target: "title-001",
        suggestion: { h: 0.8 }
      }
    ]);
    expect(result.manifest.slides[0].elements[0]).toMatchObject({ x: 0, h: 0.8 });
    expect(result.repairs).toHaveLength(2);
  });

  it("injects only supported native chart primitives", () => {
    const value = manifest();
    const html = `<section><div data-pptx-id="chart-001" data-pptx-chart='{"kind":"horizontalBar","data":[{"label":"A","value":1}]}'></div></section>`;
    const conversions = injectNativeCharts(html, value, {
      elements: [{ id: "chart-001", slideIndex: 0, x: 1, y: 1, w: 4, h: 3 }]
    });
    expect(conversions).toEqual([
      { slideId: "slide-001", elementId: "chart-001", kind: "horizontalBar" }
    ]);
    expect(value.slides[0].elements.at(-1)).toMatchObject({
      type: "chart",
      kind: "horizontalBar",
      x: 1,
      w: 4
    });
  });

  it("suppresses duplicate cell objects after a native table is emitted", () => {
    const value = manifest();
    value.slides[0].elements.push(
      { type: "table", id: "table-001", x: 1, y: 1, w: 6, h: 3 },
      { type: "shape", id: "cell-001-box", x: 1, y: 1, w: 2, h: 1 },
      { type: "text", id: "cell-001", text: "Header", x: 1, y: 1, w: 2, h: 1 },
      { type: "text", id: "outside-001", text: "Outside", x: 8, y: 1, w: 2, h: 1 }
    );
    const suppressions = suppressNativeTableDescendants(value, {
      elements: [
        {
          slideIndex: 0,
          id: "table-001",
          kind: "table",
          tagName: "table",
          x: 1,
          y: 1,
          w: 6,
          h: 3
        },
        {
          slideIndex: 0,
          id: "cell-001",
          kind: "text",
          tagName: "th",
          x: 1,
          y: 1,
          w: 2,
          h: 1
        },
        {
          slideIndex: 0,
          id: "outside-001",
          kind: "text",
          tagName: "p",
          x: 8,
          y: 1,
          w: 2,
          h: 1
        }
      ]
    });
    expect(value.slides[0].elements.map((element) => element.id))
      .toEqual(["title-001", "table-001", "outside-001"]);
    expect(suppressions).toEqual([{
      slideId: "slide-001",
      tableId: "table-001",
      elementIds: ["cell-001", "cell-001-box"]
    }]);
  });

  it("suppresses only generated nested text covered by a stable semantic text object", () => {
    const value = manifest();
    value.slides[0].elements.push(
      { type: "text", id: "point-001", text: "Covered fact", x: 1, y: 1, w: 4, h: 1 },
      { type: "text", id: "html-001-002", text: "Covered fact", x: 1.1, y: 1.1, w: 3.8, h: 0.8 },
      { type: "text", id: "html-001-003", text: "Different fact", x: 1.1, y: 2, w: 3.8, h: 0.8 }
    );
    const suppressions = suppressDuplicateNestedTextElements(value, {
      elements: [
        {
          slideIndex: 0,
          id: "point-001",
          kind: "text",
          text: "Covered fact",
          x: 1,
          y: 1,
          w: 4,
          h: 1
        },
        {
          slideIndex: 0,
          id: "html-001-002",
          kind: "text",
          text: "Covered fact",
          x: 1.1,
          y: 1.1,
          w: 3.8,
          h: 0.8
        },
        {
          slideIndex: 0,
          id: "html-001-003",
          kind: "text",
          text: "Different fact",
          x: 1.1,
          y: 2,
          w: 3.8,
          h: 0.8
        }
      ]
    });
    expect(value.slides[0].elements.map((element) => element.id))
      .toContain("html-001-003");
    expect(value.slides[0].elements.map((element) => element.id))
      .not.toContain("html-001-002");
    expect(suppressions).toEqual([{
      slideId: "slide-001",
      elementId: "html-001-002",
      coveredBy: "point-001",
      reason: "generated nested text duplicates a stable semantic text object"
    }]);
  });

  it("validates the stable manifest contract", () => {
    expect(validateManifestContract(manifest(), "/tmp/out")).toMatchObject({
      status: "passed",
      slideCount: 1,
      elementCount: 1
    });
  });
});
