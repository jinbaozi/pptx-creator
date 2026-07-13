import { describe, expect, it } from "vitest";
import {
  buildCreativeRepairPatch,
  compareCreativeProof,
  creativeRepairVector
} from "../scripts/lib/creative-repair.mjs";
import { applyRepairPatch } from "../scripts/lib/repair-patch.mjs";

function proof({
  accepted = false,
  p0 = 0,
  p1 = 0,
  overflowCount = 0,
  gateFailures = 0,
  slopRisk = 20,
  deckScore = 80,
  editabilityLevel = 4
} = {}) {
  return {
    accepted,
    p0: Array.from({ length: p0 }, (_, index) => ({ type: `p0-${index}` })),
    p1: Array.from({ length: p1 }, (_, index) => ({ type: `p1-${index}` })),
    textFit: { summary: { overflowCount } },
    quality: {
      gate: { reasons: Array.from({ length: gateFailures }, (_, index) => `gate-${index}`) },
      slopRisk,
      deckScore,
      editabilityLevel
    }
  };
}

function sampleManifest() {
  return {
    slides: [
      {
        id: "slide-001",
        elements: [
          { id: "title", type: "text", style: { fontSize: 8, color: "#111111" } },
          { id: "card", type: "shape", w: 2, h: 1, style: { fill: "#FFFFFF" } },
          { id: "empty-frame", type: "shape", w: 10, h: 6, style: { fill: "#F8FAFC" } }
        ]
      }
    ]
  };
}

describe("creative proof repair ordering", () => {
  it("orders blocking defects before slop risk and visual score", () => {
    const candidate = proof({ slopRisk: 9, deckScore: 18 });
    const current = proof({ p1: 1, slopRisk: 0, deckScore: 100 });

    expect(creativeRepairVector(candidate)).toEqual([0, 0, 0, 0, 9, -18]);
    expect(compareCreativeProof(candidate, current)).toBeGreaterThan(0);
  });

  it("rejects an editability regression regardless of later metric gains", () => {
    const candidate = proof({ accepted: true, slopRisk: 0, deckScore: 100, editabilityLevel: 3 });
    const current = proof({ p0: 1, p1: 2, overflowCount: 3, gateFailures: 4, slopRisk: 100, deckScore: 0, editabilityLevel: 4 });

    expect(compareCreativeProof(candidate, current)).toBeLessThan(0);
  });
});

describe("creative critic repair patch adapter", () => {
  it("emits only safe critic recommendations that the real patch applier can consume", () => {
    const manifest = sampleManifest();
    const review = {
      slides: [
        {
          id: "slide-001",
          recommendedRepairs: [
            { action: "updateStyle", target: "title", params: { fontSize: 16 } },
            { action: "resize", target: "card", params: { w: 3.5, h: 1.5 } },
            { action: "removeElement", target: "empty-frame", params: { reason: "oversized empty decorative container" } },
            { action: "resize", target: "card", params: { fitToSlide: true } },
            { action: "move", target: "card", params: { x: 1, y: 1 } }
          ]
        }
      ]
    };

    const repairPatch = buildCreativeRepairPatch(review, 2);

    expect(repairPatch).toMatchObject({
      attempt: 2,
      reason: "visual-critic-deterministic-recommendations",
      evidence: [
        { source: "visual-review", path: "/slides/0/recommendedRepairs/0" },
        { source: "visual-review", path: "/slides/0/recommendedRepairs/1" },
        { source: "visual-review", path: "/slides/0/recommendedRepairs/2" }
      ]
    });
    expect(repairPatch.patches.map((patch) => patch.operation)).toEqual(["updateStyle", "resize", "removeElement"]);
    expect(repairPatch.patches.every((patch) => {
      const slide = manifest.slides.find((item) => item.id === patch.slideId);
      return slide?.elements.some((element) => element.id === patch.targetElementId);
    })).toBe(true);

    const repaired = applyRepairPatch(manifest, repairPatch);
    const title = repaired.slides[0].elements.find((element) => element.id === "title");
    const card = repaired.slides[0].elements.find((element) => element.id === "card");

    expect(title.style.fontSize).toBe(16);
    expect(title.style.style).toBeUndefined();
    expect(card).toMatchObject({ w: 3.5, h: 1.5 });
    expect(repaired.slides[0].elements.some((element) => element.id === "empty-frame")).toBe(false);
  });

  it("returns an empty patch when the review has no safe recommendation", () => {
    expect(buildCreativeRepairPatch({
      slides: [{
        id: "slide-001",
        recommendedRepairs: [
          { action: "resize", target: "card", params: { fitToSlide: true } },
          { action: "move", target: "card", params: { x: 1 } }
        ]
      }]
    }, 1)).toEqual({
      attempt: 1,
      reason: "visual-critic-deterministic-recommendations",
      evidence: [],
      patches: []
    });
  });
});
