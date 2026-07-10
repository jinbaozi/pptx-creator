import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import { validateDeckPlan } from "../scripts/lib/deck-plan.mjs";

describe("creative deck plan schema", () => {
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
});

describe("visual review and repair schemas", () => {
  it("ships visual review and repair patch schemas", () => {
    expect(fs.existsSync("schemas/visual-review.schema.json")).toBe(true);
    expect(fs.existsSync("schemas/repair-patch.schema.json")).toBe(true);
    expect(fs.existsSync("references/visual-critic-rubric.md")).toBe(true);
    expect(fs.existsSync("references/repair-patch-spec.md")).toBe(true);
  });
});
