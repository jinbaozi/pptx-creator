import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { reviewManifest } from "../scripts/lib/visual-critic.mjs";

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

  it("writes visual review through the CLI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-review-"));
    const manifestPath = path.join(dir, "deck.manifest.json");
    const reviewPath = path.join(dir, "visual-review.json");
    fs.writeFileSync(manifestPath, JSON.stringify(sampleManifest(), null, 2), "utf8");
    execFileSync("node", ["scripts/run-visual-critic.mjs", manifestPath, reviewPath], { stdio: "pipe" });
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    expect(review.slides[0].issues.length).toBeGreaterThan(0);
  });
});
