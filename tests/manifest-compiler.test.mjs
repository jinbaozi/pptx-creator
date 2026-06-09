import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { compileDesignFirstManifest } from "../scripts/lib/manifest-compiler.mjs";
import { loadDesignFirstArtifacts } from "../scripts/lib/design-first-loader.mjs";

describe("manifest compiler", () => {
  it("compiles design-first artifacts into a valid manifest shape", () => {
    const artifacts = loadDesignFirstArtifacts("examples/design-first/compiler-roadshow");
    const manifest = compileDesignFirstManifest(artifacts, {
      designSystemSource: "design-systems/product-roadshow/DESIGN.md",
      designSystemName: "Product Roadshow"
    });
    expect(manifest.version).toBe("0.1.1");
    expect(manifest.designSystem.name).toBe("Product Roadshow");
    expect(manifest.slides.length).toBe(3);
    expect(manifest.slides[0].elements.some((el) => el.type === "text")).toBe(true);
  });

  it("writes a manifest through the CLI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-first-"));
    const output = path.join(dir, "deck.manifest.json");
    execFileSync("node", [
      "scripts/compile-design-first.mjs",
      "examples/design-first/compiler-roadshow",
      output,
      "--design-system",
      "design-systems/product-roadshow/DESIGN.md",
      "--design-system-name",
      "Product Roadshow"
    ], { stdio: "pipe" });
    const manifest = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(manifest.slides.length).toBe(3);
  });
});

