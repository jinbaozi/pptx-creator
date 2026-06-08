import { describe, expect, it } from "vitest";
import { mergeReviews, normalizeVisionReview } from "../scripts/lib/vision-review.mjs";

describe("vision review", () => {
  it("normalizes model findings and preserves slide scores", () => {
    const review = normalizeVisionReview({
      reviewer: { type: "vision-model", provider: "mock", model: "mock-vlm", createdAt: "2026-06-08T10:00:00+08:00" },
      deckScore: 82,
      slides: [{ slideId: "slide-001", score: 80, findings: [{ id: "f1", severity: "warning", category: "hierarchy", message: "Headline is weak." }] }]
    });
    expect(review.deckScore).toBe(82);
    expect(review.slides[0].findings[0]).toMatchObject({ source: "vision-model", severity: "warning" });
  });

  it("keeps deterministic errors ahead of VLM warnings", () => {
    const merged = mergeReviews({
      deterministicReview: {
        findings: [{ id: "d1", severity: "error", category: "bounds", message: "Element is out of bounds." }]
      },
      visionReview: {
        slides: [{ slideId: "slide-001", findings: [{ id: "v1", severity: "warning", category: "polish", message: "Spacing is uneven." }] }]
      }
    });
    expect(merged.findings.map((finding) => finding.id)).toEqual(["d1", "v1"]);
  });

  it("drops repair suggestions that target unknown elements", () => {
    const merged = mergeReviews({
      knownElementIds: new Set(["headline"]),
      deterministicReview: { findings: [] },
      visionReview: {
        slides: [
          {
            slideId: "slide-001",
            findings: [
              { id: "v1", severity: "warning", category: "hierarchy", message: "Bad target.", suggestedRepair: { target: "missing" } }
            ]
          }
        ]
      }
    });
    expect(merged.repairCandidates).toEqual([]);
  });
});
