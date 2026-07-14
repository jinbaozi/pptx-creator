import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAssetRegistryText,
  isSafeAssetRuntimePath,
  summarizeRegistry,
  validateAssetRegistry,
  validateSourceRegistry
} from "../scripts/lib/registry.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const assetSchema = JSON.parse(fs.readFileSync(path.resolve("schemas/asset-registry.schema.json"), "utf8"));

function completeAsset(overrides = {}) {
  return {
    id: "asset-001",
    kind: "photo",
    source: {
      origin: "web",
      sourceRef: "provider-item-42",
      sourceUrl: "https://example.com/items/42"
    },
    localPath: "assets/asset-001-0123456789ab.png",
    contentHash: `sha256:${"a".repeat(64)}`,
    rights: {
      status: "allowed-with-attribution",
      license: "CC BY 4.0",
      attribution: "Example Author"
    },
    altText: "A project team reviewing evidence",
    role: "hero evidence",
    focalPoint: "top-right",
    cropPolicy: "cover",
    fallback: {
      strategy: "placeholder",
      description: "Use a native placeholder"
    },
    usedInSlides: ["slide-001"],
    finalDeckUse: "embedded",
    ...overrides
  };
}

function registryWith(asset = completeAsset()) {
  return { version: "0.2.0", assets: [asset] };
}

describe("asset registry 0.2 validation", () => {
  it("accepts one complete closed evidence record through schema and runtime validation", () => {
    const registry = registryWith();
    expect(validateJsonSchema(registry, assetSchema)).toEqual({ valid: true, errors: [] });
    expect(validateAssetRegistry(registry)).toEqual({ valid: true, issues: [] });
  });

  it.each([
    ["version", (registry) => { delete registry.version; }],
    ["source", (registry) => { delete registry.assets[0].source; }],
    ["sourceRef", (registry) => { delete registry.assets[0].source.sourceRef; }],
    ["localPath", (registry) => { delete registry.assets[0].localPath; }],
    ["contentHash", (registry) => { delete registry.assets[0].contentHash; }],
    ["rights", (registry) => { delete registry.assets[0].rights; }],
    ["altText", (registry) => { delete registry.assets[0].altText; }],
    ["role", (registry) => { delete registry.assets[0].role; }],
    ["focalPoint", (registry) => { delete registry.assets[0].focalPoint; }],
    ["cropPolicy", (registry) => { delete registry.assets[0].cropPolicy; }],
    ["fallback", (registry) => { delete registry.assets[0].fallback; }],
    ["usedInSlides", (registry) => { delete registry.assets[0].usedInSlides; }],
    ["finalDeckUse", (registry) => { delete registry.assets[0].finalDeckUse; }]
  ])("rejects a registry missing %s", (_field, mutate) => {
    const registry = registryWith();
    mutate(registry);
    expect(validateJsonSchema(registry, assetSchema).valid).toBe(false);
    expect(validateAssetRegistry(registry).valid).toBe(false);
  });

  it("rejects unknown fields, enum values, malformed hashes, and duplicate identities", () => {
    const cases = [];
    const unknown = registryWith();
    unknown.assets[0].unexpected = true;
    cases.push(unknown);
    cases.push(registryWith(completeAsset({ kind: "image" })));
    cases.push(registryWith(completeAsset({ rights: { status: "maybe", license: "unknown" } })));
    cases.push(registryWith(completeAsset({ finalDeckUse: "linked" })));
    cases.push(registryWith(completeAsset({ contentHash: "sha256:abc123" })));
    const duplicateIds = { version: "0.2.0", assets: [completeAsset(), completeAsset()] };
    cases.push(duplicateIds);
    cases.push(registryWith(completeAsset({ usedInSlides: ["slide-001", "slide-001"] })));

    for (const registry of cases) expect(validateAssetRegistry(registry).valid).toBe(false);
  });

  it("enforces attribution, embedded-rights, and generation provenance conditions", () => {
    const noAttribution = registryWith(completeAsset({
      rights: { status: "allowed-with-attribution", license: "CC BY 4.0" }
    }));
    expect(validateAssetRegistry(noAttribution).valid).toBe(false);

    const unknownEmbedded = registryWith(completeAsset({
      rights: { status: "unknown", license: "Unknown" }
    }));
    expect(validateAssetRegistry(unknownEmbedded).valid).toBe(false);

    const generatedWithoutEvidence = registryWith(completeAsset({
      source: { origin: "generated", sourceRef: "generation-job-42" },
      rights: { status: "allowed", license: "Provider output terms" }
    }));
    expect(validateAssetRegistry(generatedWithoutEvidence).valid).toBe(false);

    const generated = registryWith(completeAsset({
      source: { origin: "generated", sourceRef: "generation-job-42" },
      rights: { status: "allowed", license: "Provider output terms" },
      generation: { model: "image-model-2", promptSummary: "Editorial infrastructure illustration" }
    }));
    expect(validateAssetRegistry(generated)).toEqual({ valid: true, issues: [] });

    for (const field of ["model", "promptSummary"]) {
      const blank = structuredClone(generated);
      blank.assets[0].generation[field] = "   ";
      expect(validateJsonSchema(blank, assetSchema).valid, field).toBe(false);
      expect(validateAssetRegistry(blank).valid, field).toBe(false);
    }

    const invented = registryWith(completeAsset({
      generation: { model: "image-model-2", promptSummary: "Invented provenance" }
    }));
    expect(validateAssetRegistry(invented).valid).toBe(false);
  });

  it("accepts a remote source URL only as provenance and rejects unsafe runtime paths", () => {
    expect(validateAssetRegistry(registryWith()).valid).toBe(true);
    for (const localPath of [
      "https://example.com/image.png",
      "//example.com/image.png",
      "/tmp/image.png",
      "assets/../image.png",
      "assets\\image.png",
      "assets/./image.png",
      "assets/%2e%2e/image.png",
      "assets/%2Ftmp/image.png",
      "assets∕..\u2215image.png",
      "assets／image.png",
      "data:image/png;base64,AAAA",
      "file:///tmp/image.png",
      "mailto:asset@example.com",
      "C:/assets/image.png",
      "C:\\assets\\image.png",
      "assets/",
      "assets"
    ]) {
      expect(validateAssetRegistry(registryWith(completeAsset({ localPath }))).valid, localPath).toBe(false);
      expect(isSafeAssetRuntimePath(localPath), localPath).toBe(false);
    }
    expect(isSafeAssetRuntimePath("assets/reference/image.png")).toBe(true);
  });

  it("rejects unknown nested evidence fields at both validation boundaries", () => {
    for (const mutate of [
      (registry) => { registry.assets[0].source.unexpected = true; },
      (registry) => { registry.assets[0].rights.unexpected = true; },
      (registry) => { registry.assets[0].fallback.unexpected = true; },
      (registry) => { registry.assets[0].generation = { model: "m", promptSummary: "p", unexpected: true }; registry.assets[0].source.origin = "generated"; }
    ]) {
      const registry = registryWith();
      mutate(registry);
      expect(validateJsonSchema(registry, assetSchema).valid).toBe(false);
      expect(validateAssetRegistry(registry).valid).toBe(false);
    }
  });

  it("publishes the empty registry as schema-valid deterministic canonical bytes", () => {
    const registry = { version: "0.2.0", assets: [] };
    expect(validateJsonSchema(registry, assetSchema)).toEqual({ valid: true, errors: [] });
    expect(validateAssetRegistry(registry)).toEqual({ valid: true, issues: [] });
    const first = canonicalAssetRegistryText(registry);
    const second = canonicalAssetRegistryText(structuredClone(registry));
    expect(first).toBe(`${JSON.stringify(registry, null, 2)}\n`);
    expect(second).toBe(first);
  });

  it("allows recreated-locally only for native data-source kinds and blocks unknown embedded rights", () => {
    expect(validateAssetRegistry(registryWith(completeAsset({
      kind: "chart-data",
      finalDeckUse: "recreated-locally"
    }))).valid).toBe(true);
    expect(validateAssetRegistry(registryWith(completeAsset({
      kind: "photo",
      finalDeckUse: "recreated-locally"
    }))).valid).toBe(false);
    expect(validateAssetRegistry(registryWith(completeAsset({
      rights: { status: "unknown", license: "Unknown" },
      finalDeckUse: "not-embedded"
    }))).valid).toBe(true);
  });

  it("requires actual slide usage for embedded or recreated final-deck use in schema and runtime", () => {
    for (const finalDeckUse of ["embedded", "recreated-locally"]) {
      const kind = finalDeckUse === "recreated-locally" ? "chart-data" : "photo";
      const registry = registryWith(completeAsset({ kind, finalDeckUse, usedInSlides: [] }));
      expect(validateJsonSchema(registry, assetSchema).valid, `${finalDeckUse} schema`).toBe(false);
      expect(validateAssetRegistry(registry).valid, `${finalDeckUse} runtime`).toBe(false);
    }
    const unused = registryWith(completeAsset({ finalDeckUse: "not-embedded", usedInSlides: [] }));
    expect(validateJsonSchema(unused, assetSchema)).toEqual({ valid: true, errors: [] });
    expect(validateAssetRegistry(unused)).toEqual({ valid: true, issues: [] });
  });
});

describe("source registry compatibility and summaries", () => {
  it("accepts primary fact sources", () => {
    const sources = {
      createdAt: "2026-06-08T10:00:00+08:00",
      items: [{ id: "source-001", kind: "fact", title: "Reference", url: "https://example.com" }]
    };
    expect(validateSourceRegistry(sources).valid).toBe(true);
  });

  it("summarizes source and canonical asset counts", () => {
    const summary = summarizeRegistry({
      sources: { items: [{ id: "source-001" }] },
      assets: registryWith()
    });
    expect(summary).toEqual({ sourceCount: 1, assetCount: 1, embeddedAssetCount: 1 });
  });
});
