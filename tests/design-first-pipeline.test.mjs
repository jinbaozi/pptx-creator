import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("design-first pipeline", () => {
  it("compiles, renders, and writes visual review for a design-first example", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-first-pipeline-"));
    execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      "examples/design-first/kycc-roadshow",
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
    const review = JSON.parse(fs.readFileSync(path.join(outputDir, "visual-review.json"), "utf8"));
    expect(review.deckScore).toBeGreaterThan(0);
  });
});
