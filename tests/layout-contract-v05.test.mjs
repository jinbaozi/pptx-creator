import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { preflightLayout } from "../scripts/lib/check-layout-safety.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";
import { applyTextFitAdjustments, buildTextFitReport, maximumTextHeight } from "../scripts/lib/text-fit.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const node = process.execPath;

function manifest(elements, metadata = { mode: "creative", inputType: "html", qualityProfile: "creative" }) {
  return {
    version: "0.2.0",
    metadata,
    designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral" },
    deck: { title: "Regression", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides: [{ id: "slide-001", background: { type: "solid", color: "#F3F0E9" }, elements }]
  };
}

describe("0.5.0 layout and evidence contract", () => {
  it("blocks a 2.5in long price metric instead of shrinking it", () => {
    const result = preflightLayout(manifest([{
      type: "text", id: "price-metric", role: "metric", x: 1, y: 1, w: 2.5, h: 1,
      text: "$0.30 / $3 / $15", style: { fontSize: 27, lineHeight: 1.05, margin: 0 }
    }]), { strict: true, measureText: (text, size) => String(text).length * size * 0.55 });

    expect(result.checks).toContainEqual(expect.objectContaining({ type: "metric-wrap", severity: "critical", target: "price-metric" }));
    expect(result.checks.find((check) => check.type === "metric-wrap")?.suggestion).toMatchObject({ automaticTextSplit: false });
  });

  it("uses semantic parent and footer as the maximum text-height boundary", () => {
    const slide = { elements: [
      { type: "shape", id: "card", role: "card", x: 1, y: 1, w: 4, h: 3, shape: "rect", style: { padding: [0, 0, 18, 0] } },
      { type: "text", id: "copy", semanticParentId: "card", x: 1.2, y: 2, w: 3.6, h: 0.5, text: "copy", style: { fontSize: 16 } },
      { type: "line", id: "footer-rule", role: "footer-decoration", layoutRegion: "footer", x: 0.7, y: 3.5, w: 12, h: 0.01, style: {} }
    ] };
    expect(maximumTextHeight(slide, slide.elements[1], 7.5)).toBeCloseTo(1.5, 6);
  });

  it("allows a text resize to overlap its own semantic parent surface but not siblings", () => {
    const source = manifest([
      { type: "shape", id: "card", role: "card", x: 1, y: 1, w: 4, h: 3, shape: "rect" },
      { type: "text", id: "copy", semanticParentId: "card", x: 1.2, y: 1.2, w: 3.6, h: 0.4, text: "Copy", style: { fontSize: 16 } }
    ]);
    const result = applyTextFitAdjustments(source, { slides: [{ slideId: "slide-001", elements: [{
      elementId: "copy", status: "resize-required", suggestion: { operation: "resize", changes: { h: 1.2 } }, minimumFontSize: 16
    }] }] });
    expect(result.adjustments).toContainEqual(expect.objectContaining({ elementId: "copy", operation: "resize" }));
    expect(result.manifest.slides[0].elements[1].h).toBe(1.2);
  });

  it("enforces Creative font floors during text fitting", async () => {
    const result = await buildTextFitReport(manifest([{
      type: "text", id: "body-copy", role: "body", x: 1, y: 1, w: 1, h: 0.25,
      text: "This body copy cannot fit.", style: { fontSize: 16, lineHeight: 1.4, margin: 0 }
    }, {
      type: "line", id: "footer-rule", role: "footer-decoration", layoutRegion: "footer",
      x: 0.7, y: 1.25, w: 12, h: 0.01, style: {}
    }]), { measureText: (text, size) => String(text).length * size * 0.55 });
    expect(result.slides[0].elements[0].minimumFontSize).toBe(16);
    expect(result.slides[0].elements[0].status).toBe("content-reflow-required");
  });

  it("normalizes oversized single-line table headers in Creative mode and preserves them in Replica mode", () => {
    const html = `<section class="pptx-slide"><table><thead><tr><th data-pptx-kind="text" data-pptx-id="th-a">Header</th></tr></thead></table></section>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [{ id: "th-a", kind: "text", tagName: "th", x: 1, y: 1, w: 4, h: 0.6, text: "Header", style: {
        color: "#FFFFFF", fontFamily: "Arial", fontSize: 11.25, fontWeight: 600, lineHeight: 31.5,
        paddingTop: 12, paddingRight: 6, paddingBottom: 0, paddingLeft: 6, verticalAlign: "top"
      } }]
    };
    const creative = convertHtmlToManifest(html, { measurements, designMode: "balanced" });
    expect(creative.slides[0].elements[0]).toMatchObject({ role: "table-header", style: { lineHeight: 1.2, valign: "middle" } });
    const replica = convertHtmlToManifest(html, { measurements, designMode: "replica" });
    const header = replica.slides[0].elements.find((element) => element.id === "th-a");
    expect(header.style.lineHeight).toBe(2.8);
    expect(header.style.valign).toBe("top");
  });

  it("preserves independent list-item height, order, parent, and layout region", () => {
    const html = `<section class="pptx-slide"><ul data-pptx-id="list-a" data-layout-region="list-region"><li>第一项有足够多的文字形成多行</li><li>第二项</li><li>第三项</li></ul></section>`;
    const result = convertHtmlToManifest(html);
    const items = result.slides[0].elements.filter((element) => element.listParentId === "list-a");
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.listIndex)).toEqual([0, 1, 2]);
    expect(items.every((item) => item.layoutRegion === "list-region")).toBe(true);
    expect(items[1].y).toBeGreaterThanOrEqual(items[0].y + items[0].h);
  });

  it("blocks list collisions, loose headers, missing source links, and unlabeled evidence", () => {
    const result = preflightLayout(manifest([
      { type: "text", id: "li-1", role: "list-item", listParentId: "list", listIndex: 0, x: 1, y: 1, w: 3, h: 0.8, text: "First item", style: { fontSize: 16, lineHeight: 1.4 } },
      { type: "text", id: "li-2", role: "list-item", listParentId: "list", listIndex: 1, x: 1, y: 1.5, w: 3, h: 0.4, text: "Second", style: { fontSize: 16, lineHeight: 1.4 } },
      { type: "text", id: "table-header", role: "table-header", x: 5, y: 1, w: 3, h: 0.7, text: "Header", style: { fontSize: 11.25, lineHeight: 2.8 } },
      { type: "text", id: "source-url", role: "source", x: 1, y: 3, w: 5, h: 0.4, text: "https://example.com/source", style: { fontSize: 9 } },
      { type: "text", id: "vendor", x: 1, y: 4, w: 5, h: 0.5, text: "Performance is higher", style: { fontSize: 16 }, evidence: { kind: "vendor-claim", sourceIds: ["vendor-doc"] } }
    ]), { strict: true });
    for (const type of ["list-item-collision", "line-height-too-loose", "source-link-missing", "evidence-label-missing"]) {
      expect(result.checks.find((check) => check.type === type)?.severity).toBe("critical");
    }
  });

  it("hard-blocks authoritative HTML text bounds but keeps OCR replica bounds diagnostic", () => {
    const element = {
      type: "text", id: "replica-copy", x: 1, y: 1, w: 2, h: 0.15,
      text: "Measured text", style: { fontSize: 16, lineHeight: 1.4, margin: 0 }
    };
    const htmlResult = preflightLayout(manifest([element], {
      mode: "replica", inputType: "html", qualityProfile: "replica"
    }), { strict: true, mode: "replica" });
    expect(htmlResult.checks.find((check) => check.type === "text-required-bounds")?.severity).toBe("critical");

    const imageResult = preflightLayout(manifest([element], {
      mode: "replica", inputType: "image", qualityProfile: "replica"
    }), { strict: true, mode: "replica" });
    expect(imageResult.checks.find((check) => check.type === "text-required-bounds")?.severity).toBe("warning");
    expect(imageResult.summary.blocked).toBe(false);
  });

  it("writes HTML evidence bindings and a clickable PPTX relationship", async () => {
    const html = `<section class="pptx-slide"><p data-pptx-kind="text" data-pptx-id="source-link" data-layout-role="source" data-evidence-kind="vendor-claim" data-source-ids="vendor-doc" data-as-of="2026-07-17"><a data-source-id="vendor-doc" href="https://example.com/vendor" title="Open source">厂商声明：https://example.com/vendor</a></p></section>`;
    const measurements = { viewport: { width: 1280, height: 720 }, elements: [{
      id: "source-link", kind: "text", tagName: "p", x: 1, y: 1, w: 8, h: 0.6,
      text: "厂商声明：https://example.com/vendor", href: "https://example.com/vendor", hyperlinkTooltip: "Open source",
      semantics: { role: "source", evidenceKind: "vendor-claim", sourceIds: ["vendor-doc"], asOf: "2026-07-17" },
      style: { color: "#1B2A4A", fontFamily: "Arial", fontSize: 16, fontWeight: 400, lineHeight: 22.4, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 }
    }] };
    const compiled = convertHtmlToManifest(html, { measurements, designMode: "balanced" });
    expect(compiled.metadata.sources).toEqual([{ id: "vendor-doc", url: "https://example.com/vendor", title: "厂商声明：https://example.com/vendor" }]);
    expect(compiled.slides[0].elements[0]).toMatchObject({
      hyperlink: { url: "https://example.com/vendor", tooltip: "Open source" },
      evidence: { kind: "vendor-claim", sourceIds: ["vendor-doc"], asOf: "2026-07-17" }
    });

    compiled.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-hyperlink-"));
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifestPath, JSON.stringify(compiled, null, 2), "utf8");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root });
    const zip = await JSZip.loadAsync(await readFile(pptxPath));
    const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
    const relsXml = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
    expect(slideXml).toContain("a:hlinkClick");
    expect(relsXml).toContain("https://example.com/vendor");
  });
});
