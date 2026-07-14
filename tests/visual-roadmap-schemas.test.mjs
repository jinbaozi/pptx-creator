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
    expect(data.artifacts.semanticIr).toBeNull();
    expect(data.artifacts.consistencyReport).toBeNull();
    expect(validateJsonSchema(data, schema).valid).toBe(true);
  });

  it("accepts direct runs only with the complete closed artifact set", async () => {
    const schema = await loadJson("schemas/run.schema.json");
    const data = await loadJson("examples/visual-roadmap-next/run.json");
    const direct = { ...structuredClone(data), mode: "direct" };
    expect(validateJsonSchema(direct, schema).valid).toBe(true);

    for (const field of Object.keys(direct.artifacts)) {
      const incomplete = structuredClone(direct);
      delete incomplete.artifacts[field];
      expect(validateJsonSchema(incomplete, schema).valid, field).toBe(false);
    }
    const unknown = structuredClone(direct);
    unknown.artifacts.unexpected = null;
    expect(validateJsonSchema(unknown, schema).valid).toBe(false);
  });

  it("validates source and asset registries", async () => {
    const sourceSchema = await loadJson("schemas/source-registry.schema.json");
    const assetSchema = await loadJson("schemas/asset-registry.schema.json");
    const sources = await loadJson("examples/visual-roadmap-next/sources.json");
    const assets = await loadJson("examples/visual-roadmap-next/assets/asset-registry.json");
    expect(validateJsonSchema(sources, sourceSchema).valid).toBe(true);
    expect(validateJsonSchema(assets, assetSchema).valid).toBe(true);
  });
});
