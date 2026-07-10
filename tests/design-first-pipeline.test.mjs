import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("design-first pipeline", () => {
  it("preserves creative source artifacts when input and output directories are the same", () => {
    const dir = fs.mkdtempSync(path.join("/private/tmp", "pptx-design-first-in-place-"));
    for (const name of ["deck.storyboard.json", "deck.design-direction.json", "slide-design-specs.json"]) {
      fs.copyFileSync(path.join("examples/design-first/compiler-roadshow", name), path.join(dir, name));
    }

    execFileSync("node", ["scripts/pptx.mjs", "text", dir, dir, "--creative"], { stdio: "pipe" });

    for (const name of ["deck.storyboard.json", "deck.design-direction.json", "slide-design-specs.json"]) {
      expect(fs.existsSync(path.join(dir, name)), name).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, "final.pptx"))).toBe(true);
  }, 60000);

  it("compiles, renders, and writes visual review for a design-first example", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-first-pipeline-"));
    execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      "examples/design-first/compiler-roadshow",
      outputDir,
      "--design-system",
      "design-systems/product-roadshow/DESIGN.md",
      "--design-system-name",
      "Product Roadshow",
      "--mode",
      "creative",
      "--emit-run-index"
    ], { stdio: "pipe" });

    expect(fs.existsSync(path.join(outputDir, "deck.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "final.pptx"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "visual-review.json"))).toBe(true);
    const review = JSON.parse(fs.readFileSync(path.join(outputDir, "visual-review.json"), "utf8"));
    expect(review.deckScore).toBeGreaterThan(0);
    const outputManifest = JSON.parse(fs.readFileSync(path.join(outputDir, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).toContain("run.json");
  });
});
