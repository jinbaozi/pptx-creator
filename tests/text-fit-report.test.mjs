import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { applyTextFitAdjustments, buildTextFitReport, materializeTextFonts, measureTextElement } from "../scripts/lib/text-fit.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const monospaceMeasure = (text, fontSize) => [...String(text)].length * fontSize * 0.5;

describe("text-fit evidence", () => {
  it("measures explicit lines, margins, and proportional line height deterministically", () => {
    const result = measureTextElement({
      type: "text",
      id: "copy",
      x: 1,
      y: 1,
      w: 2,
      h: 1,
      text: "中文 AB\nsecond",
      style: { fontSize: 20, lineHeight: 1.5, margin: [6, 8, 6, 8] }
    }, { measureText: monospaceMeasure, maxHeight: 2 });

    expect(result.lineCount).toBe(2);
    expect(result.requiredHeight).toBeCloseTo((2 * 20 * 1.5 + 12) / 72, 6);
    expect(result.availableWidth).toBeCloseTo(2 - 16 / 72, 6);
    expect(result.status).toBe("fits");
  });

  it("requires content reflow when neither resizing nor readable font reduction can fit", () => {
    const result = measureTextElement({
      type: "text",
      id: "dense-copy",
      role: "body",
      x: 1,
      y: 1,
      w: 1.2,
      h: 0.3,
      text: "This content is intentionally far too long for the available text box.",
      style: { fontSize: 16, lineHeight: 1.4, margin: 4 }
    }, { measureText: monospaceMeasure, maxHeight: 0.3, minimumFontSize: 11 });

    expect(result.status).toBe("content-reflow-required");
    expect(result.overflowBy).toBeGreaterThan(0);
    expect(result.suggestedFontSize).toBeLessThan(11);
  });

  it("wraps long unbroken tokens and accounts for character and bullet spacing", () => {
    const result = measureTextElement({
      type: "text", id: "token", role: "body", x: 1, y: 1, w: 1, h: 0.3,
      text: "SUPERCALIFRAGILISTIC", style: {
        fontSize: 16, lineHeight: 1.2, margin: 0, charSpacing: 2,
        bullet: { indent: 18 }
      }
    }, { measureText: monospaceMeasure, maxHeight: 0.3, minimumFontSize: 11 });

    expect(result.lineCount).toBeGreaterThan(1);
    expect(result.availableWidth).toBeCloseTo(0.75, 6);
    expect(result.status).toBe("content-reflow-required");
  });

  it("builds a schema-valid report and fails when any element does not fit", async () => {
    const manifest = {
      deck: { size: { width: 13.333, height: 7.5 } },
      slides: [{
        id: "slide-1",
        elements: [
          { type: "text", id: "ok", x: 1, y: 1, w: 4, h: 1, text: "Short", style: { fontSize: 16 } },
          { type: "text", id: "bad", x: 1, y: 2, w: 1, h: 0.2, text: "Overflow overflow overflow", style: { fontSize: 18 } }
        ]
      }]
    };
    const report = await buildTextFitReport(manifest, {
      source: "fontkit",
      measureText: monospaceMeasure,
      designTokens: {}
    });
    const schema = JSON.parse(await readFile(new URL("../schemas/text-fit-report.schema.json", import.meta.url), "utf8"));

    expect(report.status).toBe("failed");
    expect(report.summary).toEqual({ checked: 2, overflowCount: 1 });
    expect(report.slides[0].elements.find((item) => item.elementId === "bad")?.status).not.toBe("fits");
    expect(validateJsonSchema(report, schema)).toEqual({ valid: true, errors: [] });
  });

  it("uses the resolved typography face from a fontkit catalog", async () => {
    const measuredFonts = [];
    const report = await buildTextFitReport({
      deck: { size: { width: 13.333, height: 7.5 } },
      slides: [{ id: "slide-1", elements: [{
        type: "text", id: "copy", x: 1, y: 1, w: 4, h: 1,
        text: "Measured", style: { typography: "{typography.body}" }
      }] }]
    }, {
      designTokens: { typography: { body: { fontFamily: "Metric Sans", fontSize: 18, lineHeight: 1.4 } } },
      fontCatalog: {
        source: "fontkit",
        measureText(text, fontSize, font) {
          measuredFonts.push(font);
          return monospaceMeasure(text, fontSize);
        }
      }
    });

    expect(report.source).toBe("fontkit");
    expect(measuredFonts).toEqual(expect.arrayContaining([expect.objectContaining({ fontFamily: "Metric Sans" })]));
  });

  it("applies only concrete resize and readable font suggestions without changing authored text", () => {
    const manifest = { slides: [{ id: "slide-1", elements: [
      { type: "text", id: "resize", x: 1, y: 1, w: 3, h: 0.4, text: "Keep me", style: { fontSize: 16 } },
      { type: "text", id: "shrink", x: 1, y: 2, w: 3, h: 0.4, text: "Keep me too", style: { fontSize: 16 } },
      { type: "text", id: "reflow", x: 1, y: 3, w: 3, h: 0.4, text: "Do not rewrite", style: { fontSize: 16 } }
    ] }] };
    const report = { slides: [{ slideId: "slide-1", elements: [
      { elementId: "resize", status: "resize-required", suggestion: { operation: "resize", changes: { h: 0.8 } } },
      { elementId: "shrink", status: "font-reduction-required", suggestion: { operation: "updateStyle", changes: { fontSize: 13 } } },
      { elementId: "reflow", status: "content-reflow-required" }
    ] }] };

    const result = applyTextFitAdjustments(manifest, report);
    expect(result.manifest.slides[0].elements.find((item) => item.id === "resize")?.h).toBe(0.8);
    expect(result.manifest.slides[0].elements.find((item) => item.id === "shrink")?.style.fontSize).toBe(13);
    expect(result.manifest.slides[0].elements.map((item) => item.text)).toEqual(["Keep me", "Keep me too", "Do not rewrite"]);
    expect(result.unresolved).toEqual([{ slideId: "slide-1", elementId: "reflow", status: "content-reflow-required" }]);
  });

  it("materializes the measured fallback font into the manifest", () => {
    const manifest = { slides: [{ id: "slide-1", elements: [{
      type: "text", id: "copy", x: 1, y: 1, w: 3, h: 1,
      text: "中文", style: { typography: "{typography.body}" }
    }] }] };
    const result = materializeTextFonts(manifest, {
      typography: { body: { fontFamily: "Missing CJK", fontSize: 16 } }
    }, {
      resolveFontFamily: (requested, text) => requested === "Missing CJK" && text === "中文" ? "Installed CJK" : null
    });

    expect(result.manifest.slides[0].elements[0].style.fontFamily).toBe("Installed CJK");
    expect(result.manifest.slides[0].elements[0].text).toBe("中文");
    expect(result.substitutions).toEqual([{ slideId: "slide-1", elementId: "copy", requested: "Missing CJK", resolved: "Installed CJK" }]);
  });
});
