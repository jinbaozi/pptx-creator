import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateCreativeVisualProof } from "../scripts/lib/creative-visual-proof.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const quality = (passed = true) => ({
  deckScore: passed ? 92 : 65,
  slideFloor: passed ? 88 : 60,
  slopRisk: passed ? 5 : 35,
  criticalFindings: passed ? 0 : 1,
  editabilityLevel: 5,
  gate: { passed, reasons: passed ? [] : ["deck score 65 must be >= 80"] }
});

const repair = { attempts: 0, stopReason: "initial-proof-passed", history: [] };

describe("creative rendered visual proof", () => {
  it("accepts a complete render with no blocking findings", () => {
    const proof = evaluateCreativeVisualProof({
      manifest: { slides: [{ id: "s1", elements: [{ type: "line", role: "decorative", id: "grid-h" }] }, { id: "s2", elements: [{ type: "line", role: "decorative", id: "grid-v" }] }] },
      preview: { status: "ok", previewCount: 2, previews: ["slide-1.png", "slide-2.png"], contactSheet: { path: "contact-sheet.png", slideCount: 2, width: 1000, height: 600 } },
      review: { slides: [{ id: "s1", issues: [] }, { id: "s2", issues: [] }] },
      textFit: { status: "passed", source: "fontkit", summary: { checked: 4, overflowCount: 0 } },
      quality: quality(),
      repair
    });
    expect(proof).toMatchObject({ accepted: true, p0: [], p1: [], renderedSlides: 2, expectedSlides: 2, decorativeBackgroundLines: 2 });
    const schema = JSON.parse(readFileSync("schemas/creative-proof.schema.json", "utf8"));
    expect(validateJsonSchema(proof, schema)).toEqual({ valid: true, errors: [] });
  });

  it("blocks missing or overflowing text-fit evidence as P1", () => {
    const base = {
      manifest: { slides: [{ id: "s1" }] },
      preview: { status: "ok", previewCount: 1, previews: ["slide-1.png"], contactSheet: { path: "contact-sheet.png", slideCount: 1, width: 500, height: 300 } },
      review: { slides: [{ id: "s1", issues: [] }] },
      quality: quality(),
      repair
    };
    const missing = evaluateCreativeVisualProof(base);
    const overflowing = evaluateCreativeVisualProof({
      ...base,
      textFit: { status: "failed", source: "fontkit", summary: { checked: 2, overflowCount: 1 } }
    });

    expect(missing.p1).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text-fit-unavailable" })]));
    expect(overflowing.p1).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text-overflow" })]));
  });

  it("blocks missing rendered pages as P0 and visual slop as P1", () => {
    const proof = evaluateCreativeVisualProof({
      manifest: { slides: [{ id: "s1" }, { id: "s2" }] },
      preview: { status: "ok", previewCount: 1, previews: ["slide-1.png"], contactSheet: { path: "contact-sheet.png", slideCount: 1, width: 500, height: 300 } },
      review: { slides: [{ id: "s1", issues: [{ severity: "high", type: "layout-repetition", message: "Repeated composition" }] }] },
      quality: quality(false),
      repair
    });
    expect(proof.accepted).toBe(false);
    expect(proof.p0).toEqual(expect.arrayContaining([expect.objectContaining({ type: "render-page-count" })]));
    expect(proof.p1).toEqual(expect.arrayContaining([expect.objectContaining({ type: "layout-repetition" })]));
  });

  it("fails closed when LibreOffice evidence is unavailable", () => {
    const proof = evaluateCreativeVisualProof({ manifest: { slides: [{ id: "s1" }] }, preview: { status: "deferred", previews: [] }, review: { slides: [] }, quality: quality(false), repair });
    expect(proof.accepted).toBe(false);
    expect(proof.p0[0].type).toBe("render-unavailable");
  });

  it("treats a failed post-render quality gate as refinement rejection", () => {
    const proof = evaluateCreativeVisualProof({
      manifest: { slides: [{ id: "s1" }] },
      preview: { status: "ok", previewCount: 1, previews: ["slide-1.png"], contactSheet: { path: "contact-sheet.png", slideCount: 1, width: 500, height: 300 } },
      review: { slides: [{ id: "s1", issues: [] }] },
      textFit: { status: "passed", source: "fontkit", summary: { checked: 1, overflowCount: 0 } },
      quality: quality(false),
      repair: { attempts: 1, stopReason: "no-improvement", history: [{ iteration: 1, outcome: "no-improvement", comparison: 0 }] }
    });

    expect(proof.accepted).toBe(false);
    expect(proof.quality.gate.passed).toBe(false);
    const schema = JSON.parse(readFileSync("schemas/creative-proof.schema.json", "utf8"));
    expect(validateJsonSchema(proof, schema)).toEqual({ valid: true, errors: [] });
  });
});
