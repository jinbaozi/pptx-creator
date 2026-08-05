import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "node-html-parser";
import { mergeSlideAuditResults } from "../scripts/lib/html-layout-audit.mjs";
import {
  convertHtmlToManifest,
  measureContentCoverage,
  planReplicaElementBackgroundLayers,
  planReplicaSlideBackground
} from "../scripts/lib/html-to-manifest-core.mjs";
import {
  HtmlToPptxError,
  applyAutomaticRepairs,
  assertNoFullSlideRaster,
  buildOutputProtocol,
  injectNativeCharts,
  normalizePresentationTokens,
  parseArgs,
  suppressDuplicateNestedTextElements,
  suppressNativeChartDescendants,
  suppressNativeTableDescendants,
  validateManifestContract
} from "../scripts/convert.mjs";
import { connectorMetadata } from "../scripts/lib/connector-resolver.mjs";
import { expandChartElement, nativeChartSpec } from "../scripts/lib/chart-renderer.mjs";
import { materializeLineBreaks } from "../scripts/render-pptx.mjs";
import { validateGroupManifest } from "../scripts/lib/group-renderer.mjs";
import { preflightLayout } from "../scripts/lib/check-layout-safety.mjs";
import { validatePresentationPackage } from "../scripts/validate-presentation-package.mjs";
import { calculateEditabilityCoverage, unionArea } from "../scripts/lib/editability-coverage.mjs";
import { buildComponentRegions } from "../scripts/lib/component-regions.mjs";

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
  it("calculates clipped fallback union and z-ordered semantic coverage without group double counting", () => {
    const manifest = {
      deck: { size: { width: 10, height: 10 } },
      slides: [{
        id: "slide-001",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "group", id: "group", x: 0, y: 0, w: 5, h: 5, children: ["group-shape"] },
          { type: "shape", id: "group-shape", x: 0, y: 0, w: 5, h: 5 },
          { type: "image", id: "chart-svg", x: 2, y: 2, w: 2, h: 2, mediaKind: "svg", vectorPreserved: true, svgSemantic: { classification: "chart", source: "dom-marker" } }
        ]
      }]
    };
    const fallbacks = [
      { id: "fallback-a", slideId: "slide-001", box: { x: 8, y: 8, w: 4, h: 4 } },
      { id: "fallback-b", slideId: "slide-001", box: { x: 7, y: 7, w: 2, h: 2 } }
    ];
    expect(unionArea([{ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 }])).toBe(28);
    const report = calculateEditabilityCoverage({ manifest, fallbacks });
    expect(report.nativeObjectCoverage).toBe(0.93);
    expect(report.nativeCoverage).toBe(report.nativeObjectCoverage);
    const evidence = report.perSlide[0].semanticEvidence;
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "slide-001-background", classification: "native-slide-background", weight: 1 }),
      expect.objectContaining({ id: "group", classification: "structured-native-group", weight: 0.95 }),
      expect.objectContaining({ id: "chart-svg", classification: "chart-svg", weight: 0.2 }),
      expect.objectContaining({ classification: "cropped-local-raster-fallback", weight: 0 })
    ]));
    expect(evidence.some((entry) => entry.id === "group-shape")).toBe(false);
    expect(report.semanticEditabilityCoverage).toBeLessThan(1);
  });

  it("emits one canonical fallback evidence record when ledger and manifest overlap", () => {
    const manifest = {
      deck: { size: { width: 10, height: 10 } },
      slides: [{
        id: "slide-001",
        elements: [{ type: "cropped-asset", id: "x-localized-fallback", x: 2, y: 2, w: 3, h: 3 }]
      }]
    };
    const report = calculateEditabilityCoverage({ manifest, fallbacks: [{
      componentId: "x-localized-fallback",
      sourceElementId: "x",
      slideId: "slide-001",
      box: { x: 2, y: 2, w: 3, h: 3 },
      path: "assets/fallback-001.png"
    }] });
    const evidence = report.perSlide[0].semanticEvidence;
    expect(new Set(evidence.map((entry) => entry.id)).size).toBe(evidence.length);
    const fallbackEvidence = evidence.filter((entry) => entry.classification === "cropped-local-raster-fallback");
    expect(fallbackEvidence).toHaveLength(1);
    expect(fallbackEvidence[0]).toMatchObject({ id: "x-localized-fallback", visibleArea: 9, visibleContribution: 0 });
  });

  it("keeps a native blank slide fully covered while a top SVG lowers only its visible region", () => {
    const base = {
      deck: { size: { width: 10, height: 10 } },
      slides: [{ id: "slide-001", background: { type: "solid", color: "#FFFFFF" }, elements: [] }]
    };
    expect(calculateEditabilityCoverage({ manifest: base }).semanticEditabilityCoverage).toBe(1);
    const chart = {
      ...base,
      slides: [{ ...base.slides[0], elements: [{ type: "image", id: "chart", x: 0, y: 0, w: 10, h: 10, mediaKind: "svg", vectorPreserved: true, svgSemantic: { classification: "chart" } }] }]
    };
    expect(calculateEditabilityCoverage({ manifest: chart }).semanticEditabilityCoverage).toBe(0.2);
    const overlap = calculateEditabilityCoverage({ manifest: base, fallbacks: [
      { id: "one", slideId: "slide-001", box: { x: 0, y: 0, w: 6, h: 6 } },
      { id: "two", slideId: "slide-001", box: { x: 3, y: 3, w: 6, h: 6 } }
    ] });
    expect(overlap.nativeObjectCoverage).toBe(0.37);
    expect(overlap.semanticEditabilityCoverage).toBe(0.37);
  });

  it("assigns every semantic weight and excludes group children from area", () => {
    const elements = [
      { type: "text", id: "text", x: 0, y: 0, w: 1, h: 1 },
      { type: "shape", id: "shape", x: 1, y: 0, w: 1, h: 1 },
      { type: "line", id: "line", x: 2, y: 0, w: 1, h: 1 },
      { type: "table", id: "table", x: 3, y: 0, w: 1, h: 1 },
      { type: "chart", id: "chart", x: 4, y: 0, w: 1, h: 1 },
      { type: "image", id: "photo", x: 5, y: 0, w: 1, h: 1 },
      { type: "group", id: "group", x: 6, y: 0, w: 1, h: 1, children: ["group-child"] },
      { type: "shape", id: "group-child", x: 6, y: 0, w: 1, h: 1 },
      { type: "image", id: "decorative-svg", x: 7, y: 0, w: 1, h: 1, mediaKind: "svg", vectorPreserved: true, svgSemantic: { classification: "decorative" } },
      { type: "image", id: "text-bearing-svg", x: 8, y: 0, w: 1, h: 1, mediaKind: "svg", vectorPreserved: true, svgSemantic: { classification: "text-bearing" } },
      { type: "image", id: "chart-svg", x: 9, y: 0, w: 1, h: 1, mediaKind: "svg", vectorPreserved: true, svgSemantic: { classification: "chart" } },
      { type: "image", id: "architecture-svg", x: 10, y: 0, w: 1, h: 1, mediaKind: "svg", vectorPreserved: true, svgSemantic: { classification: "architecture" } },
      { type: "cropped-asset", id: "cropped", x: 11, y: 0, w: 1, h: 1 }
    ];
    const report = calculateEditabilityCoverage({
      manifest: { deck: { size: { width: 12, height: 1 } }, slides: [{ id: "slide-001", elements }] }
    });
    const byId = new Map(report.perSlide[0].semanticEvidence.map((entry) => [entry.id, entry]));
    expect(byId.get("text").weight).toBe(1);
    expect(byId.get("shape").weight).toBe(1);
    expect(byId.get("line").weight).toBe(1);
    expect(byId.get("table").weight).toBe(1);
    expect(byId.get("chart").weight).toBe(1);
    expect(byId.get("photo").weight).toBe(1);
    expect(byId.get("group").weight).toBe(0.95);
    expect(byId.has("group-child")).toBe(false);
    expect(byId.get("decorative-svg").weight).toBe(0.8);
    expect(byId.get("text-bearing-svg").weight).toBe(0.4);
    expect(byId.get("chart-svg").weight).toBe(0.2);
    expect(byId.get("architecture-svg").weight).toBe(0.2);
    expect(byId.get("cropped").weight).toBe(0);
    expect(byId.get("group").visibleArea).toBe(1);
    expect(byId.get("group").visibleContribution).toBe(0.95);
  });

  it("accepts only the documented quality profiles and preserves the default profile", () => {
    expect(parseArgs(["input.html", "output"])).toMatchObject({ options: { qualityProfile: "default" } });
    expect(parseArgs(["input.html", "output", "--quality-profile", "replica-strict"]).options.qualityProfile).toBe("replica-strict");
    expect(() => parseArgs(["input.html", "output", "--quality-profile", "unknown"])).toThrow(/quality profile/);
    expect(() => parseArgs(["input.html", "output", "--quality-profile"])).toThrow(/requires default\|replica-strict/);
  });

  it("builds deterministic component regions from key markers and native group/chart candidates", () => {
    const html = `<section class="pptx-slide" data-slide-id="slide-001">
      <div data-pptx-visual-key="true" data-pptx-id="key-z"></div>
      <pre id="pre-id">pre</pre><code id="code-id">code</code>
      <div data-pptx-visual-key="true">without-id</div>
    </section>`;
    const measurements = {
      elements: [
        { id: "key-z", slideIndex: 0, kind: "shape", px: { x: 30, y: 20, w: 120, h: 40 } },
        { id: "pre-id", slideIndex: 0, kind: "text", px: { x: 10, y: 100, w: 80, h: 30 } },
        { id: "code-id", slideIndex: 0, kind: "text", px: { x: 100, y: 100, w: 80, h: 30 } },
        { id: "group-id", slideIndex: 0, kind: "group", px: { x: 200, y: 100, w: 160, h: 60 } },
        { id: "chart-id", slideIndex: 0, kind: "chart", px: { x: 400, y: 100, w: 160, h: 60 } }
      ]
    };
    const manifest = {
      slides: [{ id: "slide-001", elements: [
        { id: "group-id", type: "group" },
        { id: "chart-id", type: "chart" }
      ] }]
    };
    const regions = buildComponentRegions({ html, measurements, manifest });
    expect(regions).toMatchObject({ version: "1.0.0" });
    expect(regions.components.map((component) => component.id)).toEqual(["chart-id", "code-id", "group-id", "key-z", "pre-id"]);
    expect(regions.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chart-id", slideIndex: 0, kind: "chart", source: "chart", box: { x: 400, y: 100, w: 160, h: 60 } }),
      expect.objectContaining({ id: "group-id", kind: "group", source: "group", box: { x: 200, y: 100, w: 160, h: 60 } }),
      expect.objectContaining({ id: "key-z", source: "data-pptx-visual-key", box: { x: 30, y: 20, w: 120, h: 40 } }),
      expect.objectContaining({ id: "pre-id", source: "pre", box: { x: 10, y: 100, w: 80, h: 30 } })
    ]));
    expect(regions.components.some((component) => component.id === "code-id")).toBe(true);
    expect(regions.components.some((component) => component.id === "without-id")).toBe(false);
  });

  it("materializes only explicitly marked groups and preserves stable child paint order", () => {
    const html = `<section class="pptx-slide" data-slide-id="slide-001">
      <div data-pptx-kind="group" data-pptx-id="background-grid" data-pptx-background="grid" data-x="0" data-y="0" data-w="13.333" data-h="7.5">
        <div data-pptx-kind="line" data-pptx-id="grid-a" data-x="0" data-y="1" data-w="13.333" data-h="0.01"></div>
        <div data-pptx-kind="line" data-pptx-id="grid-b" data-x="0" data-y="2" data-w="13.333" data-h="0.01"></div>
      </div>
    </section>`;
    const grouped = convertHtmlToManifest(html, { forceMeasured: true });
    expect(grouped.slides[0].elements.map((element) => element.id)).toEqual(["background-grid", "grid-a", "grid-b"]);
    expect(grouped.slides[0].elements[0]).toMatchObject({ type: "group", children: ["grid-a", "grid-b"], role: "background", backgroundKind: "grid" });

    const unmarked = convertHtmlToManifest(`<section class="pptx-slide"><div data-pptx-kind="line" data-pptx-id="line-a" data-x="0" data-y="1" data-w="13.333" data-h="0.01"></div></section>`, { forceMeasured: true });
    expect(unmarked.slides[0].elements.some((element) => element.type === "group")).toBe(false);
  });

  it("rejects invalid, overlapping, and nested group declarations deterministically", () => {
    expect(() => validateGroupManifest({ slides: [{ id: "slide-001", elements: [{ type: "group", id: "outer", x: 0, y: 0, w: 1, h: 1, children: ["inner"] }, { type: "group", id: "inner", x: 0, y: 0, w: 1, h: 1, children: ["shape"] }, { type: "shape", id: "shape", x: 0, y: 0, w: 1, h: 1 }] }] })).toThrow(/nested/);
    expect(() => validateGroupManifest({ slides: [{ id: "slide-001", elements: [{ type: "group", id: "missing", x: 0, y: 0, w: 1, h: 1, children: ["unknown"] }] }] })).toThrow(/missing child/);
    expect(() => validateGroupManifest({ slides: [{ id: "slide-001", elements: [{ type: "group", id: "empty", x: 0, y: 0, w: 1, h: 1, children: [] }] }] })).toThrow(/non-empty/);
    expect(() => validateGroupManifest({ slides: [{ id: "slide-001", elements: [
      { type: "group", id: "legacy-group", x: 0, y: 0, w: 1, h: 1, children: ["legacy-chart"] },
      { type: "chart", id: "legacy-chart", kind: "groupedBar", x: 0, y: 0, w: 1, h: 1 }
    ] }] })).toThrow(/non-native expanding chart/);
  });

  it("preflights explicit grid groups as one background and blocks unmarked repeated lines", () => {
    const lines = [1, 2, 3, 4].map((y, index) => ({ type: "line", id: `grid-${index + 1}`, x: 0, y, w: 13.333, h: 0, role: "decoration", style: { width: 1 } }));
    const grouped = {
      ...manifest(),
      slides: [{ ...manifest().slides[0], elements: [{ type: "group", id: "grid-group", children: lines.map((line) => line.id), x: 0, y: 0, w: 13.333, h: 7.5, role: "background", backgroundKind: "grid" }, ...lines] }]
    };
    const groupedChecks = preflightLayout(grouped, { strict: true }).checks;
    expect(groupedChecks.some((check) => check.type === "decorative-grid")).toBe(false);

    const unmarked = { ...grouped, slides: [{ ...grouped.slides[0], elements: lines }] };
    const unmarkedChecks = preflightLayout(unmarked, { strict: true }).checks;
    expect(unmarkedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "decorative-grid", severity: "critical" })
    ]));
  });

  it("materializes measured heading line breaks without trimming indentation", () => {
    expect(materializeLineBreaks("Long heading text", {
      renderedLines: ["Long heading", "text"],
      lineBreakOffsets: [12]
    })).toBe("Long heading\ntext");
    expect(materializeLineBreaks("  code\n    line", {
      renderedLines: ["  code", "    line"],
      lineBreakOffsets: [6]
    })).toBe("  code\n    line");
  });

  it("classifies round corners without mistaking pills for ellipses and layers asymmetric borders", () => {
    const html = `<section class="pptx-slide" data-slide-id="slide-001">
      <div id="pill" data-pptx-id="pill" data-pptx-kind="shape"></div>
      <div id="card" data-pptx-id="card" data-pptx-kind="shape"></div>
      <div id="explicit" data-pptx-id="explicit" data-pptx-kind="shape" data-pptx-shape="ellipse"></div>
    </section>`;
    const style = {
      backgroundColor: "#FFFFFF",
      borderColor: "#111111",
      borderWidth: 2,
      borderStyle: "solid",
      borderTopWidth: 2,
      borderRightWidth: 0,
      borderBottomWidth: 0,
      borderLeftWidth: 0,
      borderTopColor: "#111111",
      borderRightColor: "#111111",
      borderBottomColor: "#111111",
      borderLeftColor: "#111111",
      borderTopStyle: "solid",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderBottomRightRadius: 28,
      borderBottomLeftRadius: 28,
      cornerRadii: [{ rx: 28, ry: 28 }, { rx: 28, ry: 28 }, { rx: 28, ry: 28 }, { rx: 28, ry: 28 }]
    };
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [{ slideId: "slide-001", slideIndex: 0 }],
      elements: [
        { id: "pill", slideIndex: 0, kind: "shape", x: 1, y: 1, w: 3.333, h: 0.583, px: { x: 96, y: 96, w: 320, h: 56 }, style, replica: {} },
        { id: "vertical-pill", slideIndex: 0, kind: "shape", x: 5, y: 1, w: 0.583, h: 3.333, px: { x: 480, y: 96, w: 56, h: 320 }, style, replica: {} },
        { id: "card", slideIndex: 0, kind: "shape", x: 1, y: 2, w: 3, h: 1, px: { x: 96, y: 192, w: 288, h: 96 }, style: { ...style, cornerRadii: [{ rx: 12, ry: 12 }, { rx: 10, ry: 10 }, { rx: 12, ry: 12 }, { rx: 10, ry: 10 }] }, replica: {} },
        { id: "explicit", slideIndex: 0, kind: "shape", shapeOverride: "ellipse", x: 5, y: 1, w: 2, h: 1, px: { x: 480, y: 96, w: 192, h: 96 }, style: { ...style, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0 }, replica: {} }
      ]
    };
    const manifest = convertHtmlToManifest(html, { measurements, designMode: "replica" });
    const elements = manifest.slides[0].elements;
    expect(elements.find((element) => element.id === "pill")).toMatchObject({ shape: "pill", shapeFidelity: { status: "native" } });
    expect(elements.find((element) => element.id === "vertical-pill")).toMatchObject({ shape: "pill", shapeFidelity: { status: "native" } });
    expect(elements.filter((element) => element.id?.startsWith("pill-")).map((element) => element.type)).toContain("line");
    const pillBorder = elements.find((element) => element.id === "pill-top-border");
    expect(pillBorder).toMatchObject({ type: "line" });
    expect(pillBorder.x).toBeCloseTo(1 + 28 / 96, 6);
    expect(pillBorder.w).toBeCloseTo(3.333 - (2 * 28) / 96, 6);
    expect(elements.find((element) => element.id === "card")).toMatchObject({ shapeFidelity: { status: "unsupported" } });
    expect(elements.find((element) => element.id === "explicit")).toMatchObject({ shape: "ellipse", shapeOverride: "ellipse" });
  });
  it("normalizes text-to-html design tokens into the editable PPTX token surface", () => {
    const tokens = normalizePresentationTokens({
      fonts: { display: "Display Sans", body: "Body Sans" },
      colors: { primary: "#112233", muted: "#445566", primarySoft: "#EEF2FF" },
      type: { title: 44, body: 20, source: 11 },
      space: { gap: 18, small: 10 },
      radius: { card: 16, pill: 999 }
    });
    expect(tokens.colors).toMatchObject({ primary: "#112233", textMuted: "#445566", surfaceAlt: "#EEF2FF" });
    expect(tokens.typography.title).toMatchObject({ fontFamily: "Display Sans", fontSize: 44 });
    expect(tokens.typography.body).toMatchObject({ fontFamily: "Body Sans", fontSize: 20 });
    expect(tokens.spacing).toMatchObject({ md: 18, sm: 10 });
    expect(tokens.rounded).toMatchObject({ lg: 16, xl: 999 });
    expect(tokens.components["table-header"]).toMatchObject({ backgroundColor: "{colors.surfaceAlt}" });
  });

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

    const defaultDirection = planReplicaSlideBackground(
      "linear-gradient(rgb(232, 238, 255), rgb(255, 255, 255) 46%)",
      "#FFFFFF",
      { width: 13.333, height: 7.5 }
    );
    expect(defaultDirection).toMatchObject({
      background: {
        type: "gradient",
        gradient: {
          type: "linear",
          stops: [
            { color: "#E8EEFF", position: 0 },
            { color: "#FFFFFF", position: 46 }
          ]
        }
      },
      unsupported: []
    });
  });

  it("plans element background stacks without collapsing supported layers", () => {
    const measurement = {
      id: "stacked-card",
      kind: "shape",
      x: 1,
      y: 1,
      w: 4,
      h: 2,
      px: { x: 96, y: 96, w: 384, h: 192 },
      style: {
        backgroundColor: "#112233",
        backgroundImage: "radial-gradient(circle at 82% 18%, rgba(36, 87, 230, 0.55), transparent 90%), linear-gradient(135deg, #F6F7FB, rgba(232, 238, 255, 0.5)), linear-gradient(180deg, #FFFFFF, #DDEAFE)",
        borderColor: "#2457E6",
        borderWidth: 1,
        borderStyle: "solid",
        borderTopWidth: 2,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 1,
        borderTopStyle: "solid",
        borderRightStyle: "solid",
        borderBottomStyle: "solid",
        borderLeftStyle: "solid",
        borderTopColor: "#2457E6",
        borderRightColor: "#2457E6",
        borderBottomColor: "#2457E6",
        borderLeftColor: "#2457E6",
        boxShadow: "rgba(0, 0, 0, 0.25) 2px 4px 6px",
        cornerRadii: [{ rx: 12, ry: 12 }, { rx: 12, ry: 12 }, { rx: 12, ry: 12 }, { rx: 12, ry: 12 }]
      },
      replica: { hasUnsupportedEffects: true, backgroundImage: "radial-gradient(circle at 82% 18%, rgba(36, 87, 230, 0.55), transparent 90%), linear-gradient(135deg, #F6F7FB, rgba(232, 238, 255, 0.5)), linear-gradient(180deg, #FFFFFF, #DDEAFE)" }
    };
    const layers = planReplicaElementBackgroundLayers("stacked-card", measurement);
    expect(layers.map((layer) => layer.id)).toEqual([
      "stacked-card",
      "stacked-card-background-gradient-001",
      "stacked-card-background-gradient-002",
      "stacked-card-radial-glow-001",
      "stacked-card-top-border",
      "stacked-card-right-border",
      "stacked-card-bottom-border",
      "stacked-card-left-border"
    ]);
    expect(layers[0]).toMatchObject({ type: "shape", style: { backgroundColor: "#112233", shadow: { type: "outer" } } });
    expect(layers[1].style.gradient.type).toBe("linear");
    expect(layers[2].style.gradient.stops.at(-1)).toMatchObject({ transparency: 50 });
    expect(layers[3]).toMatchObject({ shape: "ellipse", style: { gradient: { type: "radial" } } });
    expect(layers[3].x).toBeGreaterThan(1);
    expect(layers[3].y).toBeLessThan(1.5);
  });

  it("keeps a supported background image above its solid color base", () => {
    const layers = planReplicaElementBackgroundLayers("image-card", {
      id: "image-card",
      kind: "shape",
      x: 1,
      y: 1,
      w: 2,
      h: 1,
      px: { x: 96, y: 96, w: 192, h: 96 },
      style: {
        backgroundColor: "#112233",
        backgroundImage: "url(assets/texture.png)",
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
        borderWidth: 0,
        cornerRadii: [{ rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }]
      },
      replica: { hasUnsupportedEffects: true, backgroundImage: "url(assets/texture.png)" }
    });
    expect(layers.map((layer) => layer.id)).toEqual(["image-card", "image-card-background-image"]);
    expect(layers[0]).toMatchObject({ type: "shape", style: { backgroundColor: "#112233" } });
    expect(layers[1]).toMatchObject({ type: "image", src: "assets/texture.png" });
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

  it("preserves visible metric status labels with claim-level source refs", async () => {
    const html = `<section class="pptx-slide" data-slide-id="slide-001" data-title="Metrics">
      <div data-pptx-id="metric-001" data-pptx-kind="text" data-fact-status="inferred" data-source-ids="source-brief">
        <span class="status-label">假设</span><span>72%</span>
      </div>
    </section>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [{ slideId: "slide-001", slideIndex: 0 }],
      elements: [{
        id: "metric-001",
        slideId: "slide-001",
        slideIndex: 0,
        kind: "text",
        tagName: "div",
        x: 1,
        y: 1,
        w: 2,
        h: 0.75,
        px: { x: 96, y: 96, w: 192, h: 72 },
        text: "假设 72%",
        visibleText: null,
        semantics: { sourceIds: ["source-brief"] },
        style: {
          color: "#1A1A1A",
          fontFamily: "Arial",
          fontSize: 24,
          fontWeight: 700,
          fontStyle: "normal",
          lineHeight: 28,
          textAlign: "left",
          verticalAlign: "middle",
          whiteSpace: "normal"
        },
        replica: {}
      }]
    };
    const manifest = convertHtmlToManifest(html, {
      measurements,
      forceMeasured: true,
      designMode: "replica"
    });
    const metric = manifest.slides[0].elements.find((element) => element.id === "metric-001");
    expect(metric).toMatchObject({
      type: "text",
      text: expect.stringContaining("假设"),
      sourceRefs: ["source-brief"]
    });
    expect(measureContentCoverage(parse(html).querySelectorAll(".pptx-slide"), manifest.slides)).toMatchObject({
      ratio: 1,
      missing: []
    });

    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-claim-sources-"));
    const inputPath = join(root, "index.html");
    await writeFile(inputPath, html);
    try {
      const output = await buildOutputProtocol({
        input: {
          htmlPath: inputPath,
          packageManifest: {
            deck: { id: "deck-001", slides: [{ id: "slide-001", sourceRefs: ["source-brief"] }] },
            sources: [{
              id: "source-brief",
              kind: "user-input",
              label: "Brief",
              factStatus: "inferred"
            }]
          }
        },
        manifest,
        outputDir: root,
        fallbacks: [],
        reportPaths: ["qa-report.json"],
        designTokens: undefined
      });
      const component = output.deck.slides[0].components.find((entry) => entry.id === "metric-001");
      expect(component?.sourceRefs).toEqual(["source-brief"]);
      expect(output.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "source-brief", factStatus: "inferred" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports explicit manifest groups as protocol group components", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-protocol-group-"));
    const inputPath = join(root, "index.html");
    await writeFile(inputPath, "<section class=\"pptx-slide\"><div>Group</div></section>");
    try {
      const value = manifest();
      value.slides[0].elements = [
        { type: "group", id: "group-001", children: ["shape-001"], x: 1, y: 1, w: 3, h: 2 },
        { type: "shape", id: "shape-001", shape: "rect", x: 1, y: 1, w: 2, h: 1 }
      ];
      const output = await buildOutputProtocol({
        input: {
          htmlPath: inputPath,
          packageManifest: {
            deck: { id: "deck-001", slides: [{ id: "slide-001" }] },
            sources: []
          }
        },
        manifest: value,
        outputDir: root,
        fallbacks: [],
        reportPaths: ["qa-report.json"],
        designTokens: undefined
      });
      expect(output.deck.slides[0].components.find((component) => component.id === "group-001")).toMatchObject({
        type: "group"
      });
      expect(() => validatePresentationPackage(output)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses generated text fragments owned by a stable semantic text object", () => {
    const value = {
      slides: [{
        id: "slide-001",
        elements: [
          { id: "claim-001", type: "text", text: "假设 试点可由现有项目管理员兼任内容负责人。" },
          { id: "html-001-001", type: "text", text: "假设" },
          { id: "html-001-002", type: "text", text: "试点可由现有项目管理员兼任内容负责人。" }
        ]
      }]
    };
    const suppressions = suppressDuplicateNestedTextElements(value, {
      elements: [
        { id: "claim-001", slideIndex: 0, kind: "text", text: "假设 试点可由现有项目管理员兼任内容负责人。", x: 7, y: 4, w: 5, h: 1 },
        { id: "html-001-001", slideIndex: 0, kind: "text", text: "假设", x: 7, y: 4, w: 0.5, h: 0.4, semantics: { semanticParentId: "claim-001" } },
        { id: "html-001-002", slideIndex: 0, kind: "text", text: "试点可由现有项目管理员兼任内容负责人。", x: 8, y: 5, w: 4, h: 0.7, semantics: { semanticParentId: "claim-001" } }
      ]
    });
    expect(value.slides[0].elements.map((element) => element.id)).toEqual(["claim-001"]);
    expect(suppressions.map((entry) => entry.coveredBy)).toEqual(["claim-001", "claim-001"]);
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
    const html = `<section><div data-pptx-id="chart-001" data-pptx-chart='{"kind":"horizontalBar","renderMode":"native","data":[{"label":"A","value":1}]}'></div></section>`;
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

  it("rejects new native chart kinds without an explicit semantic render mode", () => {
    const value = manifest();
    const html = `<section><div data-pptx-id="chart-no-mode" data-pptx-chart='{"kind":"line","data":[{"label":"A","value":1}]}'></div></section>`;
    expect(() => injectNativeCharts(html, value, {
      elements: [{ id: "chart-no-mode", slideIndex: 0, x: 1, y: 1, w: 4, h: 3 }]
    })).toThrow(/renderMode|native|semantic/);
  });

  it("keeps legacy chart markers fidelity-first when renderMode is omitted", () => {
    const value = manifest();
    const html = `<section><div data-pptx-id="chart-primitive" data-pptx-chart='{"kind":"groupedBar","data":[{"label":"A","series":{"first":1}}]}'></div></section>`;
    expect(injectNativeCharts(html, value, {
      elements: [{ id: "chart-primitive", slideIndex: 0, x: 1, y: 1, w: 4, h: 3 }]
    })).toEqual([{ slideId: "slide-001", elementId: "chart-primitive", kind: "groupedBar" }]);
    expect(value.slides[0].elements.at(-1)).toMatchObject({ type: "chart", id: "chart-primitive", kind: "groupedBar" });
    expect(value.slides[0].elements.at(-1)).not.toHaveProperty("renderMode");
  });

  it("does not infer native charts from preview SVG without a data-pptx-chart marker", () => {
    const value = manifest();
    const html = `<section><svg data-pptx-id="svg-chart" viewBox="0 0 100 50"><path d="M0 50 L100 0" /></svg></section>`;
    expect(injectNativeCharts(html, value, {
      elements: [{ id: "svg-chart", slideIndex: 0, x: 1, y: 1, w: 4, h: 3 }]
    })).toEqual([]);
    expect(value.slides[0].elements.some((element) => element.id === "svg-chart")).toBe(false);
  });

  it("builds strict native line, area, and lineArea specs from single-value data", () => {
    const data = [{ label: "A", value: 1 }, { label: "B", value: 2 }];
    expect(nativeChartSpec({ type: "chart", id: "line", kind: "line", renderMode: "native", x: 1, y: 1, w: 4, h: 3, data })).toMatchObject({ type: "line", data: [{ labels: ["A", "B"], values: [1, 2] }] });
    expect(nativeChartSpec({ type: "chart", id: "area", kind: "area", renderMode: "semantic", x: 1, y: 1, w: 4, h: 3, data })).toMatchObject({ type: "area", data: [{ labels: ["A", "B"], values: [1, 2] }] });
    const combo = nativeChartSpec({ type: "chart", id: "combo", kind: "lineArea", renderMode: "native", x: 1, y: 1, w: 4, h: 3, data });
    expect(combo.type.map((entry) => entry.type)).toEqual(["area", "line"]);
    expect(combo.type.every((entry) => entry.data.length === 1 && entry.data[0].values.join(",") === "1,2")).toBe(true);
  });

  it("rejects empty, non-finite, and inconsistent native chart data", () => {
    const base = { type: "chart", id: "invalid", kind: "line", renderMode: "native", x: 1, y: 1, w: 4, h: 3 };
    expect(() => nativeChartSpec({ ...base, data: [] })).toThrow(/non-empty/);
    expect(() => nativeChartSpec({ ...base, data: [{ label: "A", value: "oops" }] })).toThrow(/finite|numeric|value/);
    expect(() => nativeChartSpec({ ...base, data: [{ label: "A", series: { first: 1 } }, { label: "B", series: { second: 2 } }] })).toThrow(/series|consistent|inconsistent/);
  });

  it("resolves protocol color tokens before creating native chart options", () => {
    const spec = nativeChartSpec({
      type: "chart",
      id: "chart-token",
      kind: "horizontalBar",
      x: 1,
      y: 1,
      w: 4,
      h: 3,
      data: [{ label: "A", value: 1 }],
      style: { renderMode: "native", palette: ["{colors.primary}"] }
    }, { colors: { primary: "#123456" } });
    expect(spec.options.chartColors).toEqual(["123456"]);
  });

  it("suppresses HTML chart preview descendants after native chart injection", () => {
    const value = manifest();
    value.slides[0].elements.push(
      { type: "chart", id: "chart-001", kind: "horizontalBar", x: 1, y: 1, w: 4, h: 3, data: [{ label: "A", value: 1 }] },
      { type: "text", id: "chart-001-label", text: "A", x: 1, y: 2, w: 1, h: 0.2 }
    );
    const html = `<section><div data-pptx-id="chart-001" data-pptx-chart='{"kind":"horizontalBar","renderMode":"native","data":[{"label":"A","value":1}]}'><span data-pptx-id="chart-001-label">A</span></div></section>`;
    const suppressions = suppressNativeChartDescendants(html, value, {
      elements: [{ id: "chart-001", slideIndex: 0, x: 1, y: 1, w: 4, h: 3 }, { id: "chart-001-label", slideIndex: 0, x: 1, y: 2, w: 1, h: 0.2 }]
    });
    expect(suppressions).toEqual([{ slideId: "slide-001", chartId: "chart-001", elementIds: ["chart-001-label"] }]);
    expect(value.slides[0].elements.map((element) => element.id)).not.toContain("chart-001-label");
  });

  it("suppresses preview descendants for legacy fidelity-first chart markers", () => {
    const value = manifest();
    value.slides[0].elements.push(
      { type: "chart", id: "chart-legacy", kind: "groupedBar", x: 1, y: 1, w: 4, h: 3, data: [{ label: "A", series: { first: 1 } }] },
      { type: "text", id: "chart-legacy-label", text: "A", x: 1, y: 2, w: 1, h: 0.2 }
    );
    const html = `<section><div data-pptx-id="chart-legacy" data-pptx-chart='{"kind":"groupedBar","data":[{"label":"A","series":{"first":1}}]}'><span data-pptx-id="chart-legacy-label">A</span></div></section>`;
    expect(suppressNativeChartDescendants(html, value, {
      elements: [{ id: "chart-legacy", slideIndex: 0, x: 1, y: 1, w: 4, h: 3 }, { id: "chart-legacy-label", slideIndex: 0, x: 1, y: 2, w: 1, h: 0.2 }]
    })).toEqual([{ slideId: "slide-001", chartId: "chart-legacy", elementIds: ["chart-legacy-label"] }]);
    expect(value.slides[0].elements.map((element) => element.id)).not.toContain("chart-legacy-label");
  });

  it("keeps grouped bars side by side while stacked bars share each point x", () => {
    const base = {
      type: "chart",
      id: "chart-001",
      x: 1,
      y: 1,
      w: 6,
      h: 4,
      data: [
        { label: "A", series: { first: 2, second: 4 } },
        { label: "B", series: { first: 3, second: 1 } }
      ],
      style: { showLegend: false }
    };
    const grouped = expandChartElement({ ...base, kind: "groupedBar" });
    const stacked = expandChartElement({ ...base, kind: "stackedBar" });
    const groupedBars = grouped.filter((entry) => entry.type === "shape");
    const stackedBars = stacked.filter((entry) => entry.type === "shape");

    expect(groupedBars).toHaveLength(4);
    expect(stackedBars).toHaveLength(4);
    expect(groupedBars[0].x).toBeLessThan(groupedBars[1].x);
    expect(groupedBars[0].y + groupedBars[0].h).toBeCloseTo(groupedBars[1].y + groupedBars[1].h);
    expect(stackedBars[0].x).toBeCloseTo(stackedBars[1].x);
    expect(groupedBars[0].w).toBeLessThan(stackedBars[0].w);
    expect(groupedBars[2].x).toBeGreaterThan(groupedBars[1].x);
  });

  it("keeps grouped geometry finite for empty, zero, and malformed series values", () => {
    const elements = expandChartElement({
      type: "chart",
      kind: "groupedBar",
      id: "chart-edge",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      data: [
        { label: "A", series: { first: 0, second: "not-a-number" } },
        { label: "B", series: null }
      ],
      style: { showLegend: false }
    });

    expect(elements.length).toBeGreaterThan(0);
    expect(elements.every((entry) => [entry.x, entry.y, entry.w, entry.h].every(Number.isFinite))).toBe(true);
  });

  it("requires V2 connector metadata on the connector object", () => {
    expect(connectorMetadata({
      type: "line",
      connector: {
        sourceId: "source-001",
        targetId: "target-001",
        route: "orthogonal"
      }
    })).toEqual({
      sourceId: "source-001",
      targetId: "target-001",
      sourceAnchor: "auto",
      targetAnchor: "auto",
      route: "orthogonal"
    });
    expect(connectorMetadata({
      type: "line",
      style: {
        sourceId: "source-001",
        targetId: "target-001"
      }
    })).toBeNull();
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
