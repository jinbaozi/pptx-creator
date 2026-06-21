import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadDesignFirstArtifacts } from "../scripts/lib/design-first-loader.mjs";
import { loadArchetype, loadFromBothRoots, resolveArchetypeForSlide } from "../scripts/lib/archetype-resolver.mjs";

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

const slideArchetypes = [
  "toc",
  "bullets-list",
  "quote",
  "two-column",
  "stat-callout",
  "icon-grid",
  "section-divider"
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

describe("slide archetype packages (U8)", () => {
  it("ships the new archetype packages with the U8 file shape", () => {
    for (const name of slideArchetypes) {
      const dir = path.join("slide-archetypes", name);
      expect(fs.existsSync(path.join(dir, "archetype.md")), `${name} archetype.md`).toBe(true);
      expect(fs.existsSync(path.join(dir, "schema.json")), `${name} schema.json`).toBe(true);
      expect(fs.existsSync(path.join(dir, "rules.md")), `${name} rules.md`).toBe(true);
      expect(fs.existsSync(path.join(dir, "example.manifest.json")), `${name} example manifest`).toBe(true);
      const fixturesDir = path.join(dir, "fixtures");
      for (const fixture of ["bad", "good", "borderline"]) {
        expect(
          fs.existsSync(path.join(fixturesDir, `${fixture}.html`)),
          `${name} fixtures/${fixture}.html`
        ).toBe(true);
      }
    }
  });

  it("each slide archetype defines requiredSlots, constraints, and a slot-bearing rules.md", () => {
    for (const name of slideArchetypes) {
      const schema = JSON.parse(
        fs.readFileSync(path.join("slide-archetypes", name, "schema.json"), "utf8")
      );
      expect(Array.isArray(schema.requiredSlots), `${name} requiredSlots`).toBe(true);
      expect(schema.requiredSlots.length, `${name} requiredSlots count`).toBeGreaterThan(0);
      expect(schema.constraints, `${name} constraints`).toBeTruthy();

      const rules = fs.readFileSync(path.join("slide-archetypes", name, "rules.md"), "utf8");
      // The U7 backfill pattern requires at least 8 role-aware rules per
      // archetype; the new archetypes must follow the same discipline.
      const ruleLines = rules.split("\n").filter((line) => line.startsWith("- **"));
      expect(ruleLines.length, `${name} role-aware rule count`).toBeGreaterThanOrEqual(8);
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

describe("loadFromBothRoots (U8)", () => {
  it("returns the new slide-archetypes/toc metadata when the name lives in slide-archetypes/", () => {
    const loaded = loadFromBothRoots("toc");
    expect(loaded.name).toBe("toc");
    expect(loaded.root).toBe("slide-archetypes");
    expect(loaded.schema.requiredSlots).toEqual(["title", "entries"]);
    expect(loaded.rulesMd).toContain("TOC archetype");
    expect(loaded.archetypeMd).toContain("table-of-contents");
  });

  it("returns the new slide-archetypes/stat-callout metadata when the name lives in slide-archetypes/", () => {
    const loaded = loadFromBothRoots("stat-callout");
    expect(loaded.name).toBe("stat-callout");
    expect(loaded.root).toBe("slide-archetypes");
    expect(loaded.schema.requiredSlots).toEqual(["metric", "supportingText"]);
    expect(loaded.schema.constraints.metricCount).toBe(1);
  });

  it("falls back to layout-archetypes/cover/ when the name only lives in layout-archetypes/", () => {
    const loaded = loadFromBothRoots("cover");
    expect(loaded.name).toBe("cover");
    expect(loaded.root).toBe("layout-archetypes");
    expect(loaded.schema.requiredSlots).toEqual(["headline", "subtitle"]);
  });

  it("falls back to layout-archetypes/executive-summary/ for any other legacy name", () => {
    const loaded = loadFromBothRoots("executive-summary");
    expect(loaded.name).toBe("executive-summary");
    expect(loaded.root).toBe("layout-archetypes");
  });

  it("throws when the name exists in neither root", () => {
    expect(() => loadFromBothRoots("does-not-exist-archetype")).toThrow(/Unknown layout archetype/);
  });

  it("loadArchetype still works as a back-compat single-root lookup", () => {
    const loaded = loadArchetype("cover", "layout-archetypes");
    expect(loaded.name).toBe("cover");
    expect(loaded.schema.requiredSlots).toEqual(["headline", "subtitle"]);
  });
});

