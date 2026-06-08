import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = resolve(import.meta.dirname, "..");

async function loadJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

describe("visual roadmap next schemas", () => {
  it("validates the example run index", async () => {
    const schema = await loadJson("schemas/run.schema.json");
    const data = await loadJson("examples/visual-roadmap-next/run.json");
    expect(validateJsonSchema(data, schema).valid).toBe(true);
  });

  it("validates source and asset registries", async () => {
    const sourceSchema = await loadJson("schemas/source-registry.schema.json");
    const assetSchema = await loadJson("schemas/asset-registry.schema.json");
    const sources = await loadJson("examples/visual-roadmap-next/sources.json");
    const assets = await loadJson("examples/visual-roadmap-next/assets/asset-registry.json");
    expect(validateJsonSchema(sources, sourceSchema).valid).toBe(true);
    expect(validateJsonSchema(assets, assetSchema).valid).toBe(true);
  });

  it("validates direction, scorecard, and vision review examples", async () => {
    const directionSchema = await loadJson("schemas/direction-candidate.schema.json");
    const scorecardSchema = await loadJson("schemas/direction-scorecard.schema.json");
    const visionSchema = await loadJson("schemas/vision-review.schema.json");
    expect(validateJsonSchema(await loadJson("examples/visual-roadmap-next/directions/direction-001/direction.json"), directionSchema).valid).toBe(true);
    expect(validateJsonSchema(await loadJson("examples/visual-roadmap-next/directions/direction-001/scorecard.json"), scorecardSchema).valid).toBe(true);
    expect(validateJsonSchema(await loadJson("examples/visual-roadmap-next/vision-review.json"), visionSchema).valid).toBe(true);
  });
});
