import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadDesignFirstArtifacts } from "../scripts/lib/design-first-loader.mjs";
import { resolveArchetypeForSlide } from "../scripts/lib/archetype-resolver.mjs";

const archetypes = [
  "cover",
  "executive-summary",
  "problem-solution",
  "architecture-layered",
  "process-flow",
  "comparison-matrix",
  "metrics-dashboard",
  "roadmap"
];

describe("layout archetype packages", () => {
  it("ships the first-wave archetype packages", () => {
    for (const name of archetypes) {
      const dir = path.join("layout-archetypes", name);
      expect(fs.existsSync(path.join(dir, "archetype.md")), `${name} archetype.md`).toBe(true);
      expect(fs.existsSync(path.join(dir, "rules.md")), `${name} rules.md`).toBe(true);
      expect(fs.existsSync(path.join(dir, "schema.json")), `${name} schema.json`).toBe(true);
      expect(fs.existsSync(path.join(dir, "example.design-spec.json")), `${name} example design spec`).toBe(true);
      expect(fs.existsSync(path.join(dir, "example.manifest.json")), `${name} example manifest`).toBe(true);
    }
  });

  it("each package defines requiredSlots and constraints", () => {
    for (const name of archetypes) {
      const schema = JSON.parse(fs.readFileSync(path.join("layout-archetypes", name, "schema.json"), "utf8"));
      expect(Array.isArray(schema.requiredSlots), `${name} requiredSlots`).toBe(true);
      expect(schema.requiredSlots.length, `${name} requiredSlots count`).toBeGreaterThan(0);
      expect(schema.constraints, `${name} constraints`).toBeTruthy();
    }
  });
});

describe("archetype resolver", () => {
  it("loads design-first artifacts from a directory", () => {
    const artifacts = loadDesignFirstArtifacts("examples/design-first/compiler-roadshow");
    expect(artifacts.storyboard.title).toBe("Compiler Roadshow Deck");
    expect(artifacts.designDirection.style).toBe("business-tech-roadshow");
    expect(artifacts.slideDesignSpecs.slides.length).toBe(3);
  });

  it("resolves a slide layout package", () => {
    const artifacts = loadDesignFirstArtifacts("examples/design-first/compiler-roadshow");
    const resolved = resolveArchetypeForSlide(artifacts.slideDesignSpecs.slides[2], "layout-archetypes");
    expect(resolved.name).toBe("architecture-layered");
    expect(resolved.schema.requiredSlots).toContain("layers");
  });

  it("rejects a slide missing required archetype slots", () => {
    const slide = {
      id: "slide-bad",
      layoutType: "architecture-layered",
      intent: "bad example",
      mainIdea: "missing layers",
      visualPlan: {
        focalPoint: "headline",
        density: "medium",
        visualWeight: { headline: 100 }
      },
      contentSlots: [{ slot: "headline", role: "claim", content: "Only headline" }],
      editableTarget: 5
    };
    expect(() => resolveArchetypeForSlide(slide, "layout-archetypes")).toThrow(/layers/);
  });
});

