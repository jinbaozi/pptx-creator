import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import { validateDeckPlan } from "../scripts/lib/deck-plan.mjs";

describe("creative deck plan schema", () => {
  const load = () => JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
  const schema = JSON.parse(fs.readFileSync("schemas/deck-plan.schema.json", "utf8"));

  it("accepts the canonical coordinate-free plan", () => {
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    const schema = JSON.parse(fs.readFileSync("schemas/deck-plan.schema.json", "utf8"));
    expect(validateJsonSchema(plan, schema)).toEqual({ valid: true, errors: [] });
    expect(validateDeckPlan(plan)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a plan without the contextual dials", () => {
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    delete plan.dials.visualEnergy;
    expect(validateDeckPlan(plan).valid).toBe(false);
  });

  it("direct consumers reject coordinate keys recursively from the public schema", () => {
    for (const key of ["x", "y", "w", "h", "left", "top", "right", "bottom", "width", "height"]) {
      const plan = load();
      plan.intentOverride = { nested: { deeper: [{ [key]: 1 }] } };
      expect(validateJsonSchema(plan, schema).valid, key).toBe(false);
    }
  });

  it("direct consumers enforce every advertised family content contract", () => {
    const invalidContent = {
      cover: { headline: "Missing subtitle" },
      architecture: { headline: "Missing layers" },
      comparison: { headline: "Missing choices" },
      process: { headline: "Missing steps" },
      dashboard: { headline: "Missing metrics" },
      quote: { quote: "Missing attribution" },
      matrix: { headline: "Missing axes and quadrants" },
      closing: { headline: "Missing action" }
    };
    for (const [family, content] of Object.entries(invalidContent)) {
      const plan = load();
      plan.slides.find((slide) => slide.layoutFamily === family).content = content;
      expect(validateJsonSchema(plan, schema).valid, family).toBe(false);
    }
  });

  it("applies sibling constraints beside local refs and fails safely on cyclic refs", () => {
    expect(validateJsonSchema("ok", { $defs: { value: { type: "string" } }, $ref: "#/$defs/value", minLength: 3 }).valid).toBe(false);
    const cyclic = { $ref: "#" };
    const result = validateJsonSchema({}, cyclic);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => /depth|cyclic/i.test(error.message))).toBe(true);
  });
});

describe("visual review and repair schemas", () => {
  it("ships visual review and repair patch schemas", () => {
    expect(fs.existsSync("schemas/visual-review.schema.json")).toBe(true);
    expect(fs.existsSync("schemas/repair-patch.schema.json")).toBe(true);
    expect(fs.existsSync("references/visual-critic-rubric.md")).toBe(true);
    expect(fs.existsSync("references/repair-patch-spec.md")).toBe(true);
  });
});
