import { describe, expect, it } from "vitest";
import {
  runMockVisionReview,
  runVisionReview
} from "../scripts/lib/vision-review.mjs";

const sampleScreenshots = [
  {
    id: "slide-001",
    path: "/tmp/slide-001.png",
    width: 1280,
    height: 720,
    fileSize: 12345,
    capturedAt: "2026-06-08T10:00:00+08:00"
  },
  {
    id: "slide-002",
    path: "/tmp/slide-002.png",
    width: 1280,
    height: 720,
    fileSize: 22345,
    capturedAt: "2026-06-08T10:00:05+08:00"
  }
];

const sampleManifest = {
  slides: [
    { id: "slide-001", title: "Cover", intent: "cover" },
    { id: "slide-002", title: "Agenda", intent: "agenda" }
  ]
};

describe("vision review provider interface", () => {
  it("defaults to the mock provider when none is supplied", async () => {
    const result = await runVisionReview({ screenshots: sampleScreenshots, manifest: sampleManifest });
    expect(result.reviewer.provider).toBe("mock");
    expect(result.reviewer.type).toBe("vision-model");
  });

  it("returns overallScore, issues, and recommendedPatches in the contract", async () => {
    const result = await runVisionReview({
      screenshots: sampleScreenshots,
      manifest: sampleManifest,
      provider: "mock"
    });
    expect(typeof result.overallScore).toBe("number");
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(Array.isArray(result.recommendedPatches)).toBe(true);
  });

  it("throws a clear error for an unknown provider", async () => {
    await expect(
      runVisionReview({
        screenshots: sampleScreenshots,
        manifest: sampleManifest,
        provider: "openai-vision"
      })
    ).rejects.toThrow(/Unsupported vision review provider/);
  });

  it("reviews screenshot metadata without requiring network access", async () => {
    const result = await runMockVisionReview({
      screenshots: sampleScreenshots,
      manifest: sampleManifest
    });
    const slideIds = result.slides.map((slide) => slide.slideId);
    expect(slideIds).toEqual(["slide-001", "slide-002"]);
    // The mock provider should record metadata it observed from each screenshot
    // without touching the network; assertions above are the only side effect.
    expect(result.slides[0].findings[0].message).toContain("slide-001");
    expect(result.reviewer.model).toBe("mock-vlm");
  });
});
