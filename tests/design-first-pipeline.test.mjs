import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("creative deck-plan pipeline", () => {
  it("preserves the creative plan when input and output directories are the same", () => {
    const dir = fs.mkdtempSync(path.join("/private/tmp", "pptx-design-first-in-place-"));
    fs.copyFileSync(path.join("examples/text-input/creative/deck.plan.json"), path.join(dir, "deck.plan.json"));

    execFileSync("node", ["scripts/pptx.mjs", "text", dir, dir, "--creative"], { stdio: "pipe" });

    expect(fs.existsSync(path.join(dir, "deck.plan.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "final.pptx"))).toBe(true);
  }, 60000);

  it("compiles, renders, and writes quality evidence for a deck plan", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-first-pipeline-"));
    execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      "examples/text-input/creative/deck.plan.json",
      outputDir,
      "--design-system",
      "design-systems/product-roadshow/DESIGN.md",
      "--design-system-name",
      "Product Roadshow",
      "--mode",
      "creative"
    ], { stdio: "pipe" });

    expect(fs.existsSync(path.join(outputDir, "deck.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "final.pptx"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "visual-review.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "quality-report.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "deck.plan.json"))).toBe(true);
    const review = JSON.parse(fs.readFileSync(path.join(outputDir, "visual-review.json"), "utf8"));
    expect(review.deckScore).toBeGreaterThan(0);
    const outputManifest = JSON.parse(fs.readFileSync(path.join(outputDir, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).toContain("deck.plan.json");
  });
});
