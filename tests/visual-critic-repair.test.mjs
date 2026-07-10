import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { reviewManifest } from "../scripts/lib/visual-critic.mjs";
import { applyRepairPatch } from "../scripts/lib/repair-patch.mjs";

function sampleManifest() {
  return {
    version: "0.2.0",
    metadata: { mode: "creative", inputType: "text", qualityProfile: "creative" },
    designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral" },
    deck: { title: "Sample", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides: [
      {
        id: "slide-001",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "text", id: "tiny", x: 0.5, y: 0.5, w: 4, h: 0.3, text: "Tiny", style: { fontSize: 8, color: "#111111" } },
          { type: "shape", id: "bad-bounds", x: 12.9, y: 7.2, w: 1, h: 1, shape: "rect", style: {} }
        ]
      }
    ]
  };
}

describe("visual critic", () => {
  it("scores slides and reports deterministic issues", () => {
    const review = reviewManifest(sampleManifest(), { mode: "creative" });
    expect(review.deckScore).toBeLessThan(100);
    expect(review.slides[0].issues.some((issue) => issue.type === "font-size")).toBe(true);
    expect(review.slides[0].issues.some((issue) => issue.type === "bounds")).toBe(true);
  });

  it("flags oversized empty decorative containers that dominate a slide", () => {
    const manifest = sampleManifest();
    manifest.slides[0].elements = [
      { type: "shape", id: "paper-frame", shape: "roundRect", x: 0.45, y: 0.35, w: 12.45, h: 6.85, style: { fill: "#FFFDF7", line: "#292524" } },
      { type: "text", id: "title", x: 0.9, y: 0.8, w: 6, h: 0.5, text: "Title", style: { fontSize: 24 } }
    ];

    const review = reviewManifest(manifest, { mode: "creative" });
    expect(review.slides[0].issues.some((issue) => issue.type === "dominant-empty-container")).toBe(true);
    expect(review.slides[0].recommendedRepairs).toContainEqual({
      action: "removeElement",
      target: "paper-frame",
      params: { reason: "oversized empty decorative container" }
    });
  });

  it("flags Taste/Impeccable-inspired contrast and repeated-card issues", () => {
    const manifest = sampleManifest();
    manifest.slides[0].background = { type: "solid", color: "#F8FAFC" };
    manifest.slides[0].elements = [
      { type: "text", id: "low-contrast", x: 0.5, y: 0.5, w: 4, h: 0.4, text: "Muted", style: { fontSize: 12, color: "#CBD5E1" } },
      { type: "shape", id: "card-1", shape: "roundRect", x: 0.5, y: 1.4, w: 3, h: 1.2, style: { fill: "#FFFFFF" } },
      { type: "shape", id: "card-2", shape: "roundRect", x: 3.8, y: 1.4, w: 3, h: 1.2, style: { fill: "#FFFFFF" } },
      { type: "shape", id: "card-3", shape: "roundRect", x: 7.1, y: 1.4, w: 3, h: 1.2, style: { fill: "#FFFFFF" } }
    ];

    const review = reviewManifest(manifest, { mode: "creative" });
    expect(review.slides[0].issues.some((issue) => issue.type === "text-contrast")).toBe(true);
    expect(review.slides[0].issues.some((issue) => issue.type === "layout-repetition")).toBe(true);
  });

  it("checks text contrast against the overlapping card background, not only the slide background", () => {
    const manifest = sampleManifest();
    manifest.slides[0].background = { type: "solid", color: "#0F172A" };
    manifest.slides[0].elements = [
      {
        type: "shape",
        id: "metric-card",
        shape: "roundRect",
        x: 0.5,
        y: 1.0,
        w: 5,
        h: 1.4,
        style: { fill: "#FFFFFF", borderColor: "#E2E8F0" }
      },
      {
        type: "text",
        id: "card-label",
        x: 0.8,
        y: 1.25,
        w: 3.5,
        h: 0.4,
        text: "Muted on card",
        style: { fontSize: 12, color: "#CBD5E1" }
      }
    ];

    const review = reviewManifest(manifest, { mode: "creative" });
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "text-contrast",
        target: "card-label"
      })
    );
  });

  it("flags Taste/Impeccable default-font and black-shadow tells in creative mode", () => {
    const manifest = sampleManifest();
    manifest.slides[0].background = { type: "solid", color: "#F8FAFC" };
    manifest.slides[0].elements = [
      {
        type: "text",
        id: "default-font",
        x: 0.5,
        y: 0.5,
        w: 6,
        h: 0.5,
        text: "Default font",
        style: { fontSize: 24, color: "#111827", fontFamily: "Inter, system-ui, sans-serif" }
      },
      {
        type: "shape",
        id: "black-shadow-card",
        shape: "roundRect",
        x: 0.5,
        y: 1.4,
        w: 4,
        h: 1.4,
        style: {
          backgroundColor: "#FFFFFF",
          shadow: { type: "outer", color: "000000", opacity: 0.45, blur: 20, offset: 8, angle: 90 }
        }
      }
    ];

    const review = reviewManifest(manifest, { mode: "creative" });
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "overused-font",
        target: "default-font"
      })
    );
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "black-shadow",
        target: "black-shadow-card"
      })
    );
  });

  it("flags neutral gray text on chromatic backgrounds in creative mode", () => {
    const manifest = sampleManifest();
    manifest.slides[0].background = { type: "solid", color: "#2563EB" };
    manifest.slides[0].elements = [
      {
        type: "text",
        id: "gray-on-brand",
        x: 0.5,
        y: 0.5,
        w: 5,
        h: 0.5,
        text: "Muted on brand",
        style: { fontSize: 22, color: "#64748B" }
      }
    ];

    const review = reviewManifest(manifest, { mode: "creative" });
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "gray-on-color",
        target: "gray-on-brand"
      })
    );
  });

  it("does not flag source gray-on-color tells in replica mode", () => {
    const manifest = sampleManifest();
    manifest.metadata.mode = "replica";
    manifest.slides[0].background = { type: "solid", color: "#2563EB" };
    manifest.slides[0].elements = [
      {
        type: "text",
        id: "source-gray",
        x: 0.5,
        y: 0.5,
        w: 5,
        h: 0.5,
        text: "Source gray",
        style: { fontSize: 22, color: "#64748B" }
      }
    ];

    const review = reviewManifest(manifest, { mode: "replica" });
    expect(review.slides[0].issues.some((issue) => issue.type === "gray-on-color")).toBe(false);
  });

  it("flags nested card containers in creative mode but preserves them in replica mode", () => {
    const manifest = sampleManifest();
    manifest.slides[0].background = { type: "solid", color: "#F8FAFC" };
    manifest.slides[0].elements = [
      {
        type: "shape",
        id: "outer-card",
        shape: "roundRect",
        x: 0.6,
        y: 0.8,
        w: 6.0,
        h: 3.0,
        style: { fill: "#FFFFFF", borderColor: "#E2E8F0" }
      },
      {
        type: "shape",
        id: "inner-card",
        shape: "roundRect",
        x: 0.9,
        y: 1.1,
        w: 5.2,
        h: 2.2,
        style: { fill: "#F8FAFC", borderColor: "#CBD5E1" }
      },
      {
        type: "text",
        id: "card-title",
        x: 1.2,
        y: 1.35,
        w: 3.5,
        h: 0.4,
        text: "Nested content",
        style: { fontSize: 18, color: "#111827" }
      }
    ];

    const creative = reviewManifest(manifest, { mode: "creative" });
    expect(creative.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "nested-card",
        target: "inner-card"
      })
    );

    manifest.metadata.mode = "replica";
    const replica = reviewManifest(manifest, { mode: "replica" });
    expect(replica.slides[0].issues.some((issue) => issue.type === "nested-card")).toBe(false);
  });

  it("does not flag creative anti-default tells in replica mode", () => {
    const manifest = sampleManifest();
    manifest.metadata.mode = "replica";
    manifest.slides[0].background = { type: "solid", color: "#F8FAFC" };
    manifest.slides[0].elements = [
      {
        type: "text",
        id: "source-font",
        x: 0.5,
        y: 0.5,
        w: 6,
        h: 0.5,
        text: "Source font",
        style: { fontSize: 24, color: "#111827", fontFamily: "Inter, system-ui, sans-serif" }
      },
      {
        type: "shape",
        id: "source-shadow",
        shape: "roundRect",
        x: 0.5,
        y: 1.4,
        w: 4,
        h: 1.4,
        style: {
          backgroundColor: "#FFFFFF",
          shadow: { type: "outer", color: "000000", opacity: 0.45, blur: 20, offset: 8, angle: 90 }
        }
      }
    ];

    const review = reviewManifest(manifest, { mode: "replica" });
    expect(review.slides[0].issues.some((issue) => issue.type === "overused-font")).toBe(false);
    expect(review.slides[0].issues.some((issue) => issue.type === "black-shadow")).toBe(false);
  });

  it("flags template-like centered stack layouts in creative mode only", () => {
    const manifest = sampleManifest();
    manifest.slides[0].background = { type: "solid", color: "#FFFFFF" };
    manifest.slides[0].elements = [
      { type: "text", id: "stack-title", x: 3.4, y: 0.75, w: 6.5, h: 0.45, text: "Quarterly Update", style: { fontSize: 26, color: "#111827" } },
      { type: "text", id: "stack-subtitle", x: 3.45, y: 1.45, w: 6.4, h: 0.35, text: "A familiar centered subtitle", style: { fontSize: 16, color: "#374151" } },
      { type: "shape", id: "stack-pill", shape: "roundRect", x: 3.5, y: 2.25, w: 6.3, h: 0.6, style: { fill: "#F3F4F6" } },
      { type: "text", id: "stack-body", x: 3.45, y: 3.15, w: 6.4, h: 0.45, text: "Centered body block", style: { fontSize: 18, color: "#111827" } },
      { type: "text", id: "stack-footer", x: 3.5, y: 4.0, w: 6.3, h: 0.35, text: "Template footer", style: { fontSize: 14, color: "#374151" } }
    ];

    const creative = reviewManifest(manifest, { mode: "creative" });
    expect(creative.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "template-stack-layout",
        target: "slide-001"
      })
    );

    manifest.metadata.mode = "replica";
    const replica = reviewManifest(manifest, { mode: "replica" });
    expect(replica.slides[0].issues.some((issue) => issue.type === "template-stack-layout")).toBe(false);
  });

  it("flags fake-perfect metric numbers in creative mode", () => {
    const manifest = sampleManifest();
    manifest.slides[0].elements = [
      {
        type: "text",
        id: "perfect-uptime",
        x: 0.6,
        y: 0.8,
        w: 3,
        h: 0.6,
        text: "99.99%",
        style: { fontSize: 32, color: "#111827" }
      },
      {
        type: "text",
        id: "template-count",
        x: 0.6,
        y: 1.6,
        w: 3,
        h: 0.6,
        text: "1,234,567",
        style: { fontSize: 32, color: "#111827" }
      }
    ];

    const review = reviewManifest(manifest, { mode: "creative" });
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "fake-perfect-number",
        target: "perfect-uptime"
      })
    );
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "fake-perfect-number",
        target: "template-count"
      })
    );
  });

  it("does not flag fake-perfect metric numbers in replica mode", () => {
    const manifest = sampleManifest();
    manifest.metadata.mode = "replica";
    manifest.slides[0].elements = [
      {
        type: "text",
        id: "source-metric",
        x: 0.6,
        y: 0.8,
        w: 3,
        h: 0.6,
        text: "99.99%",
        style: { fontSize: 32, color: "#111827" }
      }
    ];

    const review = reviewManifest(manifest, { mode: "replica" });
    expect(review.slides[0].issues.some((issue) => issue.type === "fake-perfect-number")).toBe(false);
  });

  it("reports unsupported browser effects in replica manifests", () => {
    const manifest = sampleManifest();
    manifest.metadata.mode = "replica";
    manifest.slides[0].replicaUnsupportedEffects = [
      { elementId: "glass-card", filter: "blur(8px)", backdropFilter: null, clipPath: null }
    ];

    const review = reviewManifest(manifest, { mode: "replica" });
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "replica-unsupported-effect",
        target: "glass-card"
      })
    );
  });

  it("flags incomplete replica measurement coverage", () => {
    const manifest = sampleManifest();
    manifest.metadata.mode = "replica";
    manifest.slides[0].replicaCoverage = {
      measuredElements: 4,
      coveredElements: 3,
      coverage: 0.75,
      droppedElements: [{ elementId: "gradient", kind: "css-gradient", reason: "unsupported-kind" }],
      unsupportedEffects: []
    };

    const review = reviewManifest(manifest, { mode: "replica" });
    expect(review.slides[0].issues).toContainEqual(
      expect.objectContaining({
        type: "replica-coverage",
        target: "slide-001"
      })
    );
  });

  it("writes visual review through the CLI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-review-"));
    const manifestPath = path.join(dir, "deck.manifest.json");
    const reviewPath = path.join(dir, "visual-review.json");
    fs.writeFileSync(manifestPath, JSON.stringify(sampleManifest(), null, 2), "utf8");
    execFileSync("node", ["scripts/run-visual-critic.mjs", manifestPath, reviewPath], { stdio: "pipe" });
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    expect(review.slides[0].issues.length).toBeGreaterThan(0);
  });

  it("accepts an optional consistencyReport as third argument (backward compatible)", () => {
    // No consistencyReport → same as before.
    const baseline = reviewManifest(sampleManifest(), { mode: "creative" });
    expect(baseline.consistencyAdjustments).toBeUndefined();
    expect(baseline.slides[0].scores.alignment).toBe(55); // bounds issue present
  });

  it("reduces alignment score when coordinateDriftPx > 1", () => {
    const baseline = reviewManifest(sampleManifest(), { mode: "creative" });
    const drifted = reviewManifest(
      sampleManifest(),
      { mode: "creative" },
      { coordinateDriftPx: 6, fontFallback: [], paletteMatch: 1.0 }
    );
    expect(drifted.slides[0].scores.alignment).toBeLessThan(baseline.slides[0].scores.alignment);
    expect(drifted.consistencyAdjustments.alignment).toBeGreaterThan(0);
  });

  it("reduces designSystemFit when paletteMatch < 0.85", () => {
    const baseline = reviewManifest(sampleManifest(), { mode: "creative" });
    const mismatched = reviewManifest(
      sampleManifest(),
      { mode: "creative" },
      { coordinateDriftPx: 0, fontFallback: [], paletteMatch: 0.5 }
    );
    expect(mismatched.slides[0].scores.designSystemFit).toBeLessThan(baseline.slides[0].scores.designSystemFit);
    expect(mismatched.consistencyAdjustments.designSystemFit).toBeGreaterThan(0);
  });

  it("reduces compatibility score when fontFallback is non-empty", () => {
    const baseline = reviewManifest(sampleManifest(), { mode: "creative" });
    const fellBack = reviewManifest(
      sampleManifest(),
      { mode: "creative" },
      {
        coordinateDriftPx: 0,
        paletteMatch: 1.0,
        fontFallback: [
          { element: "title", requested: "Inter", fallback: "Arial" },
          { element: "body", requested: "Source Han Sans SC", fallback: "Microsoft YaHei" }
        ]
      }
    );
    expect(fellBack.slides[0].scores.compatibility).toBeLessThan(baseline.slides[0].scores.compatibility);
    expect(fellBack.consistencyAdjustments.compatibility).toBeGreaterThan(0);
  });

  it("leaves scores untouched when consistencyReport values are within thresholds", () => {
    const baseline = reviewManifest(sampleManifest(), { mode: "creative" });
    const safe = reviewManifest(
      sampleManifest(),
      { mode: "creative" },
      { coordinateDriftPx: 0.5, paletteMatch: 0.95, fontFallback: [] }
    );
    expect(safe.slides[0].scores.alignment).toBe(baseline.slides[0].scores.alignment);
    expect(safe.slides[0].scores.designSystemFit).toBe(baseline.slides[0].scores.designSystemFit);
    expect(safe.slides[0].scores.compatibility).toBe(baseline.slides[0].scores.compatibility);
  });

  it("ignores null/undefined consistencyReport (backward compatible)", () => {
    const baseline = reviewManifest(sampleManifest(), { mode: "creative" });
    const fromNull = reviewManifest(sampleManifest(), { mode: "creative" }, null);
    const fromUndef = reviewManifest(sampleManifest(), { mode: "creative" }, undefined);
    expect(fromNull.deckScore).toBe(baseline.deckScore);
    expect(fromUndef.deckScore).toBe(baseline.deckScore);
    expect(fromNull.consistencyAdjustments).toBeUndefined();
  });

  it("emits a 0..100 slopRisk score per slide and at deck level (9th dimension)", () => {
    const review = reviewManifest(sampleManifest(), { mode: "creative" });
    for (const slide of review.slides) {
      expect(slide.scores).toHaveProperty("slopRisk");
      expect(slide.scores.slopRisk).toBeGreaterThanOrEqual(0);
      expect(slide.scores.slopRisk).toBeLessThanOrEqual(100);
    }
    expect(review.slopRisk).toBeGreaterThanOrEqual(0);
    expect(review.slopRisk).toBeLessThanOrEqual(100);
  });

  it("slopRisk does NOT change deckScore (reported alongside, not as a penalty)", () => {
    // Build two manifests that produce the same penalty-based deck score
    // (both fully clean: 100) so we can isolate slopRisk from deckScore.
    // The slop manifest piles on all 9 slop signals; the clean manifest
    // is plain. Both should yield deckScore=100; only slopRisk differs.
    const cleanManifest = {
      version: "0.1.1",
      designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral", mode: "balanced" },
      deck: { title: "Clean", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
      assets: [],
      slides: [{ id: "s1", elements: [{ type: "text", id: "t", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "Hello", style: { fontSize: 16, fontFamily: "Aptos Display, sans-serif" } }] }]
    };
    const slopManifest = {
      version: "0.1.1",
      designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral", mode: "balanced" },
      deck: { title: "Slop", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
      assets: [],
      slides: [
        {
          id: "s1",
          elements: [
            { type: "text", id: "t1", x: 0.5, y: 0.5, w: 2, h: 0.5, text: "POWER", style: { fontFamily: "Aptos Display, Inter, Roboto, Source Serif Pro, JetBrains Mono, sans-serif", fontSize: 16, stroke: "#000", shadow: "1px 1px 1px #000" } },
            { type: "text", id: "t2", x: 0.5, y: 1.5, w: 2, h: 0.5, text: "AI \u{1F600}", style: { fontSize: 16 } },
            { type: "shape", id: "card", shape: "roundRect", x: 0.5, y: 2.5, w: 4, h: 1, style: { borderRadius: "rounded.lg", fill: "linear-gradient(red, blue)" } },
            { type: "shape", id: "card2", shape: "roundRect", x: 4.5, y: 2.5, w: 4, h: 1, style: { borderRadius: "rounded.lg" } },
            { type: "shape", id: "i1", shape: "ellipse", x: 0.5, y: 4, w: 0.5, h: 0.5, style: {} },
            { type: "shape", id: "i2", shape: "ellipse", x: 1.5, y: 4, w: 0.5, h: 0.5, style: {} },
            { type: "shape", id: "i3", shape: "ellipse", x: 2.5, y: 4, w: 0.5, h: 0.5, style: {} },
            { type: "text", id: "m1", role: "metric", x: 0.5, y: 5, w: 1, h: 0.5, text: "1x", style: { fontSize: 32 } },
            { type: "text", id: "m2", role: "metric", x: 1.5, y: 5, w: 1, h: 0.5, text: "2x", style: { fontSize: 32 } },
            { type: "text", id: "m3", role: "metric", x: 2.5, y: 5, w: 1, h: 0.5, text: "3x", style: { fontSize: 32 } }
          ]
        }
      ]
    };
    const cleanReview = reviewManifest(cleanManifest, { mode: "creative" });
    const slopReview = reviewManifest(slopManifest, { mode: "creative" });
    expect(cleanReview.deckScore).toBe(100);
    expect(slopReview.deckScore).toBe(cleanReview.deckScore);
    expect(slopReview.slopRisk).toBeGreaterThan(0);
    expect(cleanReview.slopRisk).toBe(0);
  });

  it("accepts an optional slopRiskReport as fourth argument", () => {
    const report = {
      slides: [{ id: "slide-001", score: 73, signals: [{ id: "font-family-dedup", weight: 20, count: 4 }] }]
    };
    const review = reviewManifest(sampleManifest(), { mode: "creative" }, null, report);
    expect(review.slides[0].scores.slopRisk).toBe(73);
    expect(review.slopRisk).toBe(73);
  });
});

describe("repair patch", () => {
  it("applies move, resize, updateStyle, updateText, and removeElement patches", () => {
    const manifest = sampleManifest();
    const patched = applyRepairPatch(manifest, {
      attempt: 1,
      patches: [
        { slideId: "slide-001", operation: "move", targetElementId: "tiny", changes: { x: 1, y: 1 } },
        { slideId: "slide-001", operation: "resize", targetElementId: "tiny", changes: { w: 5, h: 0.6 } },
        { slideId: "slide-001", operation: "updateStyle", targetElementId: "tiny", changes: { fontSize: 12 } },
        { slideId: "slide-001", operation: "updateText", targetElementId: "tiny", changes: { text: "Readable" } },
        { slideId: "slide-001", operation: "removeElement", targetElementId: "bad-bounds", changes: {} }
      ]
    });
    const el = patched.slides[0].elements.find((item) => item.id === "tiny");
    expect(el.x).toBe(1);
    expect(el.y).toBe(1);
    expect(el.w).toBe(5);
    expect(el.h).toBe(0.6);
    expect(el.style.fontSize).toBe(12);
    expect(el.text).toBe("Readable");
    expect(patched.slides[0].elements.some((item) => item.id === "bad-bounds")).toBe(false);
  });

  it("rejects patches for missing elements", () => {
    const manifest = sampleManifest();
    expect(() => applyRepairPatch(manifest, {
      attempt: 1,
      patches: [
        { slideId: "slide-001", operation: "move", targetElementId: "missing", changes: { x: 1 } }
      ]
    })).toThrow(/missing/);
  });
});
