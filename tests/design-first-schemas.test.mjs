import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  assertDesignDirection,
  assertSlideDesignSpecs,
  assertStoryboard
} from "../scripts/lib/schema-utils.mjs";

const root = path.resolve(".");
const exampleDir = path.join(root, "examples", "design-first", "compiler-roadshow");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(exampleDir, file), "utf8"));
}

describe("design-first schemas", () => {
  it("accepts the compiler sample storyboard example", () => {
    expect(() => assertStoryboard(readJson("deck.storyboard.json"))).not.toThrow();
  });

  it("accepts the compiler sample design direction example", () => {
    expect(() => assertDesignDirection(readJson("deck.design-direction.json"))).not.toThrow();
  });

  it("accepts the compiler sample slide design specs example", () => {
    expect(() => assertSlideDesignSpecs(readJson("slide-design-specs.json"))).not.toThrow();
  });

  it("rejects a slide design spec without layoutType", () => {
    const spec = readJson("slide-design-specs.json");
    delete spec.slides[0].layoutType;
    expect(() => assertSlideDesignSpecs(spec)).toThrow(/layoutType/);
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

