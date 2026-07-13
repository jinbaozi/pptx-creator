import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const loadResolver = async () => import("../scripts/lib/design-system-resolver.mjs");

function copyDesign(sourceName, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, "design-systems", sourceName, "DESIGN.md"), target);
}

describe("creative design-system resolver", () => {
  it("resolves a built-in name and derives the display name from DESIGN.md", async () => {
    const { resolveDesignSystem } = await loadResolver();
    const resolved = await resolveDesignSystem({
      request: "dark-tech",
      inputPath: path.join(root, "examples/text-input/creative/deck.plan.json"),
      projectRoot: root
    });

    expect(resolved.request).toBe("dark-tech");
    expect(resolved.resolvedSource).toBe(path.join(root, "design-systems/dark-tech/DESIGN.md"));
    expect(resolved.design).toMatchObject({ name: "Dark Tech", source: resolved.resolvedSource });
  });

  it("prefers explicit files and directories before built-in names", async () => {
    const { resolveDesignSystem } = await loadResolver();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-explicit-"));
    const designDir = path.join(temp, "dark-tech");
    const designFile = path.join(designDir, "DESIGN.md");
    copyDesign("dark-tech", designFile);

    const fromFile = await resolveDesignSystem({ request: designFile, inputPath: path.join(temp, "deck.plan.json"), projectRoot: root });
    const fromDirectory = await resolveDesignSystem({ request: designDir, inputPath: path.join(temp, "deck.plan.json"), projectRoot: root });

    expect(fromFile.resolvedSource).toBe(designFile);
    expect(fromDirectory.resolvedSource).toBe(designFile);
    expect(fromDirectory.design.name).toBe("Dark Tech");
  });

  it("uses root DESIGN.md, then input-adjacent DESIGN.md, then business-neutral by default", async () => {
    const { resolveDesignSystem } = await loadResolver();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-default-"));
    const projectRoot = path.join(temp, "project");
    const inputDir = path.join(temp, "input");
    const inputPath = path.join(inputDir, "deck.plan.json");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(inputPath, "{}\n", "utf8");
    copyDesign("dark-tech", path.join(projectRoot, "DESIGN.md"));
    copyDesign("warm-editorial", path.join(inputDir, "DESIGN.md"));

    const rootDefault = await resolveDesignSystem({ inputPath, projectRoot });
    expect(rootDefault.design.name).toBe("Dark Tech");

    fs.rmSync(path.join(projectRoot, "DESIGN.md"));
    const adjacentDefault = await resolveDesignSystem({ inputPath, projectRoot });
    expect(adjacentDefault.design.name).toBe("Warm Editorial");

    fs.rmSync(path.join(inputDir, "DESIGN.md"));
    const fallback = await resolveDesignSystem({ inputPath, projectRoot: root });
    expect(fallback).toMatchObject({
      request: null,
      resolvedSource: path.join(root, "design-systems/business-neutral/DESIGN.md"),
      design: { name: "Business Neutral" }
    });
  });

  it("rejects URLs and unknown local requests", async () => {
    const { resolveDesignSystem } = await loadResolver();
    const inputPath = path.join(root, "examples/text-input/creative/deck.plan.json");
    await expect(resolveDesignSystem({ request: "https://example.com/DESIGN.md", inputPath, projectRoot: root })).rejects.toThrow(/URL|remote/i);
    await expect(resolveDesignSystem({ request: "missing-system", inputPath, projectRoot: root })).rejects.toThrow(/unknown design system|not found/i);
  });
});
