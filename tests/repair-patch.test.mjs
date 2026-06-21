import { describe, expect, it } from "vitest";
import { applyRepairPatch, SUPPORTED } from "../scripts/lib/repair-patch.mjs";

function sampleManifest() {
  return {
    version: "0.1.1",
    designSystem: { source: "design-systems/business-neutral/DESIGN.md", name: "Business Neutral", mode: "creative" },
    deck: { title: "Sample", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides: [
      {
        id: "slide-001",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          { type: "text", id: "title", x: 0.5, y: 0.5, w: 4, h: 0.5, text: "Title", style: { fontSize: 24, color: "#111" } },
          { type: "text", id: "body", x: 0.5, y: 1.5, w: 6, h: 0.4, text: "Body", style: { fontSize: 12 } },
          { type: "shape", id: "card", x: 1, y: 3, w: 3, h: 2, shape: "rect", style: { fill: "#F5F5F5" } }
        ]
      }
    ]
  };
}

describe("applyRepairPatch", () => {
  it("moves and resizes elements", () => {
    const next = applyRepairPatch(sampleManifest(), {
      attempt: 1,
      patches: [
        { operation: "move", slideId: "slide-001", targetElementId: "title", changes: { x: 2, y: 3 } },
        { operation: "resize", slideId: "slide-001", targetElementId: "title", changes: { w: 5, h: 1 } }
      ]
    });
    expect(next.slides[0].elements[0].x).toBe(2);
    expect(next.slides[0].elements[0].w).toBe(5);
  });

  it("increases spacing on an element", () => {
    const next = applyRepairPatch(sampleManifest(), {
      attempt: 1,
      patches: [
        { operation: "increaseSpacing", slideId: "slide-001", targetElementId: "card", changes: { padding: "spacing.md" } }
      ]
    });
    const card = next.slides[0].elements.find((el) => el.id === "card");
    expect(card.style.padding).toBe(0.5);
  });

  it("reduceDensity is a best-effort no-op (no children list)", () => {
    const next = applyRepairPatch(sampleManifest(), {
      attempt: 1,
      patches: [
        { operation: "reduceDensity", slideId: "slide-001", targetElementId: "body", changes: {} }
      ]
    });
    // Manifest unchanged for reduceDensity; just ensure no crash and element still present.
    const body = next.slides[0].elements.find((el) => el.id === "body");
    expect(body).toBeDefined();
    expect(body.text).toBe("Body");
  });

  it("adjustStyle applies lineHeight to the element style", () => {
    const next = applyRepairPatch(sampleManifest(), {
      attempt: 1,
      patches: [
        {
          operation: "adjustStyle",
          slideId: "slide-001",
          targetElementId: "title",
          changes: { style: { lineHeight: 1.4, letterSpacing: 0 } }
        }
      ]
    });
    const title = next.slides[0].elements.find((el) => el.id === "title");
    expect(title.style.lineHeight).toBe(1.4);
    expect(title.style.letterSpacing).toBe(0);
    // Existing style fields must be preserved.
    expect(title.style.fontSize).toBe(24);
    expect(title.style.color).toBe("#111");
  });

  it("SUPPORTED exposes 8 operations", () => {
    expect(SUPPORTED.size).toBe(8);
    expect(SUPPORTED.has("move")).toBe(true);
    expect(SUPPORTED.has("resize")).toBe(true);
    expect(SUPPORTED.has("updateStyle")).toBe(true);
    expect(SUPPORTED.has("updateText")).toBe(true);
    expect(SUPPORTED.has("removeElement")).toBe(true);
    expect(SUPPORTED.has("increaseSpacing")).toBe(true);
    expect(SUPPORTED.has("reduceDensity")).toBe(true);
    expect(SUPPORTED.has("adjustStyle")).toBe(true);
  });
});