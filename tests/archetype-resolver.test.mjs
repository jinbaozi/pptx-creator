import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
