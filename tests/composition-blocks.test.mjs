import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  INITIAL_COMPOSITION_BLOCK_IDS,
  applyCompositionBlockToSlide,
  canonicalCompositionBlockHash,
  canonicalCompositionSnapshotHash,
  compileCompositionBlockFixture,
  loadCompositionBlockRegistry,
  resolveCompositionBlock,
  solveCompositionTopology,
  validateCompositionBlock
} from "../scripts/lib/composition-blocks.mjs";
import {
  compileDeckPlan,
  compileDeckPlanArtifacts,
  geometrySignature
} from "../scripts/lib/deck-plan.mjs";
import {
  compileDeckPlanToIr,
  compileSemanticDeckIr,
  validateSemanticDeckIr
} from "../scripts/lib/semantic-slide-ir.mjs";
import { editableLevel } from "../scripts/render-pptx.mjs";
import { parseDesignFile } from "../scripts/parse-design-md.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = process.cwd();
const blockRoot = path.join(root, "composition-blocks");
const planPath = path.join(root, "examples/text-input/creative/deck.plan.json");
const manifestSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas/deck.schema.json"), "utf8"));
const expectedIds = [
  "editorial-poster",
  "asymmetric-split",
  "full-bleed-media",
  "anchored-sidebar",
  "hero-number",
  "evidence-first",
  "chart-dominant",
  "annotated-media",
  "layered-depth",
  "radial-system",
  "timeline",
  "matrix",
  "masonry",
  "bento-asymmetric",
  "minimal-statement"
];
const sortedIds = [...expectedIds].sort();
const loadPlan = () => JSON.parse(fs.readFileSync(planPath, "utf8"));
const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());
const geometry = (manifest) => manifest.slides.map((slide) => geometrySignature(slide));
const elementGeometry = (slide) => slide.elements.map(({ id, type, x, y, w, h, semanticParentId }) => ({
  id, type, x, y, w, h, ...(semanticParentId ? { semanticParentId } : {})
}));
const elementIdentity = (slide) => slide.elements.map(({ id, type, text, semanticParentId, connector }) => ({
  id, type, ...(text !== undefined ? { text } : {}), ...(semanticParentId ? { semanticParentId } : {}),
  ...(connector ? { connector } : {})
}));
const visualKinds = new Set(["shape", "line", "table", "chart", "diagram", "icon", "image"]);
let business;
let dark;

function options(design = business, extra = {}) {
  return {
    design,
    designSystemName: design.name,
    designSystemSource: design.source,
    ...extra
  };
}

function inBounds(element, width = 13.333, height = 7.5) {
  const left = Math.min(element.x, element.x + element.w);
  const right = Math.max(element.x, element.x + element.w);
  const top = Math.min(element.y, element.y + element.h);
  const bottom = Math.max(element.y, element.y + element.h);
  return left >= -1e-6 && top >= -1e-6 && right <= width + 1e-6 && bottom <= height + 1e-6;
}

function writeBlockDirectory(blocks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composition-blocks-"));
  for (const [fileName, block] of blocks) {
    fs.writeFileSync(path.join(dir, fileName), `${JSON.stringify(block, null, 2)}\n`, "utf8");
  }
  return dir;
}

function driftCanonicalMinimal(block, kind) {
  const drifted = structuredClone(block);
  if (kind === "topology hash") drifted.topology.child.weights = [2, 3];
  else drifted.dialRange.compositionVariance.max = 0.9;
  expect(validateCompositionBlock(drifted), kind).toEqual({ valid: true, errors: [] });
  return drifted;
}

function driftBuiltInFullDefinition(block, kind) {
  const drifted = structuredClone(block);
  if (kind === "optional slots") drifted.contentShape.optionalSlots.push("accent");
  else if (kind === "fixture content") drifted.fixtures[0].slots.headline = "FORGED";
  else drifted.editability.minimumLevel = 4;
  expect(validateCompositionBlock(drifted), kind).toEqual({ valid: true, errors: [] });
  expect(canonicalCompositionBlockHash(drifted), kind).toBe(canonicalCompositionBlockHash(block));
  return drifted;
}

function photoAsset(id) {
  return {
    id,
    kind: "photo",
    role: "hero evidence",
    description: "A localized evidence image",
    provenance: {
      origin: "project",
      sourceRef: `source/${id}.png`,
      license: "project-owned",
      contentHash: `sha256:${id}`
    },
    focalPoint: "top-right",
    cropPolicy: "cover",
    altText: "Team reviewing the evidence",
    fallback: { strategy: "placeholder", description: "Use a native placeholder" }
  };
}

beforeAll(async () => {
  [business, dark] = await Promise.all([
    parseDesignFile(path.join(root, "design-systems/business-neutral/DESIGN.md")),
    parseDesignFile(path.join(root, "design-systems/dark-tech/DESIGN.md"))
  ]);
});

describe("data-driven composition block registry", () => {
  it("loads the exact closed 15-block registry in deterministic lexical order", () => {
    const first = loadCompositionBlockRegistry(blockRoot);
    const second = loadCompositionBlockRegistry(blockRoot);
    expect(INITIAL_COMPOSITION_BLOCK_IDS).toEqual(expectedIds);
    expect([...first.keys()]).toEqual(sortedIds);
    expect([...second.keys()]).toEqual(sortedIds);
    expect([...first.values()]).toEqual([...second.values()]);
    for (const [id, block] of first) {
      expect(block.id).toBe(id);
      expect(validateCompositionBlock(block)).toEqual({ valid: true, errors: [] });
      expect(Object.keys(block).sort()).toEqual([
        "antiPatterns", "assetRequirements", "contentLimits", "contentShape", "dialRange",
        "editability", "fallback", "fixtures", "id", "notFor", "pageRoles", "pptSafeEffects",
        "topology", "version", "whenToUse"
      ].sort());
    }
  });

  it("gives every initial block a distinct immutable topology definition hash", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const hashes = [...registry.values()].map(canonicalCompositionBlockHash);
    const signatures = [...registry.values()].map((block) => JSON.stringify(block.topology));
    expect(new Set(hashes).size).toBe(15);
    expect(new Set(signatures).size).toBe(15);
    for (const [id, block] of registry) {
      expect(canonicalCompositionBlockHash(block)).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(() => { block.id = "mutated"; }, id).toThrow();
    }
  });

  it("exports an immutable canonical hash map matching all 15 built-in definitions", async () => {
    const api = await import("../scripts/lib/composition-blocks.mjs");
    const hashes = api.CANONICAL_COMPOSITION_BLOCK_HASHES;
    const registry = loadCompositionBlockRegistry(blockRoot);
    expect(hashes).toBeDefined();
    expect(Object.isFrozen(hashes)).toBe(true);
    expect(Object.keys(hashes).sort()).toEqual(sortedIds);
    expect(new Set(Object.values(hashes)).size).toBe(15);
    for (const [id, block] of registry) expect(hashes[id], id).toBe(canonicalCompositionBlockHash(block));
    expect(() => { hashes[sortedIds[0]] = "sha256:forged"; }).toThrow();
  });

  it("exports an immutable full-definition hash map matching all 15 built-ins", async () => {
    const api = await import("../scripts/lib/composition-blocks.mjs");
    const hashes = api.CANONICAL_COMPOSITION_BLOCK_DEFINITION_HASHES;
    const registry = loadCompositionBlockRegistry(blockRoot);
    expect(typeof api.canonicalCompositionBlockDefinitionHash).toBe("function");
    expect(hashes).toBeDefined();
    expect(Object.isFrozen(hashes)).toBe(true);
    expect(Object.keys(hashes).sort()).toEqual(sortedIds);
    expect(new Set(Object.values(hashes)).size).toBe(15);
    for (const [id, block] of registry) {
      expect(hashes[id], id).toBe(api.canonicalCompositionBlockDefinitionHash(block));
    }
    expect(() => { hashes[sortedIds[0]] = "sha256:forged"; }).toThrow();
  });

  it("exports immutable trusted compatibility contracts matching all 15 built-ins", async () => {
    const api = await import("../scripts/lib/composition-blocks.mjs");
    const contracts = api.CANONICAL_COMPOSITION_BLOCK_CONTRACTS;
    const registry = loadCompositionBlockRegistry(blockRoot);
    expect(contracts).toBeDefined();
    expect(Object.isFrozen(contracts)).toBe(true);
    expect(Object.keys(contracts).sort()).toEqual(sortedIds);
    for (const [id, block] of registry) {
      expect(contracts[id], id).toEqual({
        pageRoles: block.pageRoles,
        dialRange: block.dialRange,
        requiredSlots: block.contentShape.requiredSlots,
        assetRequirements: {
          required: block.assetRequirements.required,
          kinds: block.assetRequirements.kinds,
          min: block.assetRequirements.min,
          max: block.assetRequirements.max
        },
        fallback: block.fallback
      });
      expect(Object.isFrozen(contracts[id]), id).toBe(true);
    }
  });

  it("declares the exact self-contained asset kinds required by each media block", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    expect(registry.get("full-bleed-media").assetRequirements.kinds).toEqual(["photo", "illustration", "texture"]);
    expect(registry.get("annotated-media").assetRequirements.kinds).toEqual(["photo", "illustration"]);
  });

  it.each(["full-bleed-media", "annotated-media"])("declares a deterministic fixture assetId for %s", (blockId) => {
    const block = loadCompositionBlockRegistry(blockRoot).get(blockId);
    expect(block.fixtures).toHaveLength(1);
    expect(block.fixtures[0].slots).toHaveProperty("media");
    expect(block.fixtures[0].assetId).toMatch(/^fixture-[a-z0-9-]+$/);
  });

  it("rejects incoherent required, kind, and cardinality asset contracts", () => {
    const base = structuredClone(loadCompositionBlockRegistry(blockRoot).get("minimal-statement"));
    const invalid = [
      ["required without kinds", { required: true, kinds: [], role: "Impossible", min: 1, max: 1 }, /kinds.*non-empty|required.*kind/i],
      ["positive min without required", { required: false, kinds: ["photo"], role: "Contradiction", min: 1, max: 1 }, /min.*required|required.*true/i],
      ["empty kinds with positive max", { required: false, kinds: [], role: "Impossible", min: 0, max: 1 }, /empty.*kinds|kinds.*max|max.*0/i]
    ];
    for (const [label, assetRequirements, pattern] of invalid) {
      const block = structuredClone(base);
      block.assetRequirements = assetRequirements;
      const validation = validateCompositionBlock(block);
      expect(validation.valid, label).toBe(false);
      expect(validation.errors.join("; "), label).toMatch(pattern);
    }
  });

  it("fails closed for malformed contracts, raw visuals, coordinates, tokens, slots, files, and fallback graphs", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const base = structuredClone(registry.get("minimal-statement"));
    const invalid = [
      ["missing field", (block) => { delete block.whenToUse; }, /whenToUse|required/i],
      ["unknown field", (block) => { block.coordinates = true; }, /unexpected|coordinates/i],
      ["dial range", (block) => { block.dialRange.visualEnergy = { min: 0.8, max: 0.2 }; }, /visualEnergy|range|min/i],
      ["asset range", (block) => { block.assetRequirements.min = 2; block.assetRequirements.max = 1; }, /asset.*range|min|max/i],
      ["coordinate", (block) => { block.topology.x = 1; }, /topology|unexpected|coordinate/i],
      ["raw color", (block) => { block.topology.child.gap = "#ffffff"; }, /spacing|token|topology/i],
      ["raw spacing", (block) => { block.topology.child.gap = 12; }, /spacing|token|topology/i],
      ["missing required slot", (block) => { block.contentShape.requiredSlots.push("media"); }, /required slot|media/i],
      ["duplicate slot", (block) => {
        block.topology.child.children.push({ slot: "headline" });
      }, /duplicate.*slot|headline/i]
    ];
    for (const [label, mutate, pattern] of invalid) {
      const block = structuredClone(base);
      mutate(block);
      const result = validateCompositionBlock(block);
      expect(result.valid, label).toBe(false);
      expect(result.errors.join("; "), label).toMatch(pattern);
    }

    const filenameDir = writeBlockDirectory([["wrong-name.json", base]]);
    expect(() => loadCompositionBlockRegistry(filenameDir)).toThrow(/filename|wrong-name|minimal-statement/i);
    fs.rmSync(filenameDir, { recursive: true, force: true });

    const unknownFallback = structuredClone(base);
    unknownFallback.id = "unknown-fallback";
    unknownFallback.fallback = { mode: "block", blockId: "does-not-exist", when: ["content-overflow"] };
    const unknownDir = writeBlockDirectory([["unknown-fallback.json", unknownFallback]]);
    expect(() => loadCompositionBlockRegistry(unknownDir)).toThrow(/fallback.*does-not-exist|unknown fallback/i);
    fs.rmSync(unknownDir, { recursive: true, force: true });

    const left = structuredClone(base);
    left.id = "left";
    left.fallback = { mode: "block", blockId: "right", when: ["content-overflow"] };
    const right = structuredClone(base);
    right.id = "right";
    right.fallback = { mode: "block", blockId: "left", when: ["content-overflow"] };
    const cycleDir = writeBlockDirectory([["left.json", left], ["right.json", right]]);
    expect(() => loadCompositionBlockRegistry(cycleDir)).toThrow(/fallback.*cycle|cycle/i);
    fs.rmSync(cycleDir, { recursive: true, force: true });
  });

  it("solves all coordinate-free topology trees deterministically inside the slide", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    for (const [id, block] of registry) {
      const first = solveCompositionTopology(block.topology, { width: 13.333, height: 7.5, tokens: business.tokens });
      const second = solveCompositionTopology(block.topology, { width: 13.333, height: 7.5, tokens: business.tokens });
      expect([...first], id).toEqual([...second]);
      expect([...first.keys()].sort(), id).toEqual([...block.contentShape.requiredSlots, ...block.contentShape.optionalSlots]
        .filter((slot) => first.has(slot)).sort());
      for (const [slot, box] of first) {
        expect(box.w, `${id}/${slot}`).toBeGreaterThan(0);
        expect(box.h, `${id}/${slot}`).toBeGreaterThan(0);
        expect(inBounds({ ...box, x: box.x, y: box.y, w: box.w, h: box.h }), `${id}/${slot}`).toBe(true);
      }
    }
    const topology = loadCompositionBlockRegistry(blockRoot).get("minimal-statement").topology;
    expect(() => solveCompositionTopology(topology, {
      width: 13.333,
      height: 7.5,
      tokens: { ...business.tokens, spacing: { ...business.tokens.spacing, md: undefined } }
    })).toThrow(/spacing\.md|missing.*token/i);
  });

  it("makes the public topology solver reject validator-forbidden fields", () => {
    const topology = structuredClone(loadCompositionBlockRegistry(blockRoot).get("minimal-statement").topology);
    topology.x = 999;
    expect(validateCompositionBlock({
      ...structuredClone(loadCompositionBlockRegistry(blockRoot).get("minimal-statement")),
      topology
    }).valid).toBe(false);
    expect(() => solveCompositionTopology(topology, {
      width: 13.333,
      height: 7.5,
      tokens: business.tokens
    })).toThrow(/invalid|forbidden|unexpected|topology\.x/i);
  });

  it("normalizes deck-plan 0..100 dials to block 0..1 ranges and rejects true incompatibility", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    expect(resolveCompositionBlock(registry, "minimal-statement", {
      pageRole: "cover",
      dials: { compositionVariance: 72, visualDensity: 54, visualEnergy: 62 },
      assets: [],
      availableSlots: ["headline", "primary", "accent"]
    }).resolvedId).toBe("minimal-statement");
    expect(resolveCompositionBlock(registry, "minimal-statement", {
      pageRole: "cover",
      dials: { compositionVariance: 72, visualDensity: 54, visualEnergy: 62 },
      assets: [{ id: "unrelated-photo", kind: "photo" }],
      availableSlots: ["headline", "primary", "media", "accent"]
    }).resolvedId).toBe("minimal-statement");

    const narrow = structuredClone(registry.get("minimal-statement"));
    narrow.id = "narrow-minimal";
    narrow.dialRange.compositionVariance = { min: 0, max: 0.5 };
    const narrowRegistry = new Map([[narrow.id, narrow]]);
    expect(() => resolveCompositionBlock(narrowRegistry, narrow.id, {
      pageRole: "cover",
      dials: { compositionVariance: 72, visualDensity: 54, visualEnergy: 62 },
      assets: [],
      availableSlots: ["headline", "primary", "accent"]
    })).toThrow(/compositionVariance|dial.*range|incompatible/i);
  });

  it("validates requested and resolved blocks supplied through an arbitrary Map", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const dials = loadPlan().designIntent.dials;
    const context = {
      pageRole: "cover",
      dials,
      assets: [],
      availableSlots: ["headline", "primary", "accent"]
    };

    const invalidRequested = structuredClone(registry.get("minimal-statement"));
    invalidRequested.coordinates = true;
    expect(() => resolveCompositionBlock(new Map([[invalidRequested.id, invalidRequested]]), invalidRequested.id, context))
      .toThrow(/requested.*invalid|composition block.*invalid|coordinates|unexpected/i);

    const requested = structuredClone(registry.get("full-bleed-media"));
    const invalidFallback = structuredClone(registry.get("minimal-statement"));
    invalidFallback.coordinates = true;
    expect(() => resolveCompositionBlock(new Map([
      [requested.id, requested],
      [invalidFallback.id, invalidFallback]
    ]), requested.id, context)).toThrow(/fallback.*invalid|composition block.*invalid|coordinates|unexpected/i);

    const canonicalMinimal = structuredClone(registry.get("minimal-statement"));
    expect(() => resolveCompositionBlock(new Map([["alias", canonicalMinimal]]), "alias", context))
      .toThrow(/registry.*key|alias.*id|key.*minimal-statement|identity/i);

    const aliasedRequest = structuredClone(registry.get("full-bleed-media"));
    aliasedRequest.id = "custom-media-request";
    aliasedRequest.fallback.blockId = "fallback-alias";
    expect(() => resolveCompositionBlock(new Map([
      [aliasedRequest.id, aliasedRequest],
      ["fallback-alias", canonicalMinimal]
    ]), aliasedRequest.id, context)).toThrow(/fallback.*key|fallback-alias.*id|key.*minimal-statement|identity/i);
  });

  it.each(["topology hash", "contract metadata"])("rejects canonical built-in %s drift in an arbitrary resolver Map requested block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const drifted = driftCanonicalMinimal(registry.get("minimal-statement"), kind);
    expect(() => resolveCompositionBlock(new Map([[drifted.id, drifted]]), drifted.id, {
      pageRole: "cover",
      dials: loadPlan().designIntent.dials,
      assets: [],
      availableSlots: ["headline"]
    })).toThrow(/canonical|identity|contract|hash/i);
  });

  it.each(["topology hash", "contract metadata"])("rejects canonical built-in %s drift in an arbitrary resolver Map fallback block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const requested = structuredClone(registry.get("full-bleed-media"));
    const driftedFallback = driftCanonicalMinimal(registry.get("minimal-statement"), kind);
    expect(() => resolveCompositionBlock(new Map([
      [requested.id, requested],
      [driftedFallback.id, driftedFallback]
    ]), requested.id, {
      pageRole: "cover",
      dials: loadPlan().designIntent.dials,
      assets: [],
      availableSlots: ["headline", "media", "accent"]
    })).toThrow(/canonical|identity|contract|hash/i);
  });

  it.each(["optional slots", "fixture content", "editability"])("rejects built-in full-definition %s drift in an arbitrary resolver Map requested block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const drifted = driftBuiltInFullDefinition(registry.get("minimal-statement"), kind);
    expect(() => resolveCompositionBlock(new Map([[drifted.id, drifted]]), drifted.id, {
      pageRole: "cover",
      dials: loadPlan().designIntent.dials,
      assets: [],
      availableSlots: ["headline"]
    })).toThrow(/canonical|identity|definition|hash/i);
  });

  it.each(["optional slots", "fixture content", "editability"])("rejects built-in full-definition %s drift in an arbitrary resolver Map fallback block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const requested = structuredClone(registry.get("full-bleed-media"));
    const driftedFallback = driftBuiltInFullDefinition(registry.get("minimal-statement"), kind);
    expect(() => resolveCompositionBlock(new Map([
      [requested.id, requested],
      [driftedFallback.id, driftedFallback]
    ]), requested.id, {
      pageRole: "cover",
      dials: loadPlan().designIntent.dials,
      assets: [],
      availableSlots: ["headline", "media", "accent"]
    })).toThrow(/canonical|identity|definition|hash/i);
  });
});

describe("composition fixture compiler", () => {
  it("compiles every fixture deterministically to valid bounded native L4+ slides and renders the combined deck once", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const fixtureOptions = { design: business, compositionBlockRegistry: registry };
    const manifests = [...registry.values()].map((block) => compileCompositionBlockFixture(block, fixtureOptions));
    for (const [index, manifest] of manifests.entries()) {
      const id = [...registry.keys()][index];
      expect(compileCompositionBlockFixture([...registry.values()][index], fixtureOptions), id).toEqual(manifest);
      expect(validateJsonSchema(manifest, manifestSchema), id).toEqual({ valid: true, errors: [] });
      for (const slide of manifest.slides) {
        expect(slide.elements.some((element) => element.type === "text"), id).toBe(true);
        expect(slide.elements.some((element) => visualKinds.has(element.type)), id).toBe(true);
        expect(slide.elements.every((element) => inBounds(element)), id).toBe(true);
        expect(slide.elements).not.toEqual([
          expect.objectContaining({ type: "image", x: 0, y: 0, w: 13.333, h: 7.5 })
        ]);
      }
    }

    const combined = structuredClone(manifests[0]);
    combined.deck.title = "Composition Block Native Proof";
    combined.slides = manifests.flatMap((manifest) => manifest.slides);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composition-render-"));
    const manifestPath = path.join(dir, "deck.manifest.json");
    const pptxPath = path.join(dir, "final.pptx");
    fs.writeFileSync(manifestPath, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
    const output = execFileSync(process.execPath, [path.join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], {
      cwd: root,
      encoding: "utf8"
    });
    const render = JSON.parse(output);
    expect(fs.statSync(pptxPath).size).toBeGreaterThan(0);
    expect(render.intermediate.countersBySlide).toHaveLength(combined.slides.length);
    for (const counters of render.intermediate.countersBySlide) {
      expect(editableLevel(counters)).toBeGreaterThanOrEqual(4);
      expect(counters.text).toBeGreaterThan(0);
      expect(counters.shape + counters.table).toBeGreaterThan(0);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps geometry fixed while design tokens change resolved typography and colors", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    for (const [id, block] of registry) {
      const businessManifest = compileCompositionBlockFixture(block, { design: business, compositionBlockRegistry: registry });
      const darkManifest = compileCompositionBlockFixture(block, { design: dark, compositionBlockRegistry: registry });
      expect(geometry(darkManifest), id).toEqual(geometry(businessManifest));
      expect(darkManifest.slides.map((slide) => slide.background), id)
        .not.toEqual(businessManifest.slides.map((slide) => slide.background));
      expect(darkManifest.slides.flatMap((slide) => slide.elements.map((element) => element.style)), id)
        .not.toEqual(businessManifest.slides.flatMap((slide) => slide.elements.map((element) => element.style)));
    }
  });

  it("allows a declared optional topology slot to remain empty during a native transform", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const block = structuredClone(registry.get("minimal-statement"));
    block.id = "optional-accent";
    block.contentShape.optionalSlots = ["primary", "accent"];
    block.topology.child.children.push({ "slot": "accent" });
    block.topology.child.weights.push(0.4);
    block.fixtures[0].id = "optional-accent-fixture";
    expect(validateCompositionBlock(block)).toEqual({ valid: true, errors: [] });
    const manifest = compileCompositionBlockFixture(block, { design: business });
    const slide = manifest.slides[0];
    const irSlide = {
      id: slide.id,
      nodes: slide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      }))
    };
    expect(() => applyCompositionBlockToSlide(slide, irSlide, {
      requestedId: block.id,
      resolvedId: block.id,
      block
    }, { design: business })).not.toThrow();
  });

  it.each(["full-bleed-media", "annotated-media"])("fails closed for no-source required-media fixture %s without a fallback registry", (blockId) => {
    const block = loadCompositionBlockRegistry(blockRoot).get(blockId);
    expect(() => compileCompositionBlockFixture(block, { design: business }))
      .toThrow(/required-media|missing-assets|fallback.*registry|compositionBlockRegistry/i);
  });

  it.each(["full-bleed-media", "annotated-media"])("compiles the declared minimal-statement fixture fallback for no-source %s when a registry is supplied", (blockId) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const block = registry.get(blockId);
    const fallback = compileCompositionBlockFixture(registry.get("minimal-statement"), {
      design: business,
      compositionBlockRegistry: registry
    });
    const manifest = compileCompositionBlockFixture(block, {
      design: business,
      compositionBlockRegistry: registry
    });
    expect(manifest.metadata.generator.fixtureResolution).toEqual({
      requestedId: blockId,
      resolvedId: "minimal-statement",
      fallbackReason: "missing-assets"
    });
    expect(geometry(manifest)).toEqual(geometry(fallback));
    expect(manifest.slides.every((slide) => slide.notes.includes(`requestedId=${blockId}`))).toBe(true);
    expect(manifest.slides.every((slide) => slide.notes.includes("resolvedId=minimal-statement"))).toBe(true);
    expect(manifest.slides.every((slide) => slide.notes.includes("fallbackReason=missing-assets"))).toBe(true);
    expect(manifest.slides.flatMap((slide) => slide.elements).some((element) => element.role === "fixture-media-placeholder")).toBe(false);
  });

  it("rejects a fixture fallback registry key that aliases a differently identified block", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const requested = structuredClone(registry.get("full-bleed-media"));
    requested.id = "custom-media-request";
    requested.fallback.blockId = "fallback-alias";
    const fallback = structuredClone(registry.get("minimal-statement"));
    expect(() => compileCompositionBlockFixture(requested, {
      design: business,
      compositionBlockRegistry: new Map([
        [requested.id, requested],
        ["fallback-alias", fallback]
      ])
    })).toThrow(/fallback.*key|fallback-alias.*id|key.*minimal-statement|identity/i);
  });

  it.each(["topology hash", "contract metadata"])("rejects canonical built-in %s drift in a direct fixture block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const drifted = driftCanonicalMinimal(registry.get("minimal-statement"), kind);
    expect(() => compileCompositionBlockFixture(drifted, {
      design: business,
      compositionBlockRegistry: new Map([[drifted.id, drifted]])
    })).toThrow(/canonical|identity|contract|hash/i);
  });

  it.each(["topology hash", "contract metadata"])("rejects canonical built-in %s drift in a fixture fallback block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const requested = structuredClone(registry.get("full-bleed-media"));
    const driftedFallback = driftCanonicalMinimal(registry.get("minimal-statement"), kind);
    expect(() => compileCompositionBlockFixture(requested, {
      design: business,
      compositionBlockRegistry: new Map([
        [requested.id, requested],
        [driftedFallback.id, driftedFallback]
      ])
    })).toThrow(/canonical|identity|contract|hash/i);
  });

  it.each(["optional slots", "fixture content", "editability"])("rejects built-in full-definition %s drift in a direct fixture block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const drifted = driftBuiltInFullDefinition(registry.get("minimal-statement"), kind);
    expect(() => compileCompositionBlockFixture(drifted, {
      design: business,
      compositionBlockRegistry: new Map([[drifted.id, drifted]])
    })).toThrow(/canonical|identity|definition|hash/i);
  });

  it.each(["optional slots", "fixture content", "editability"])("rejects built-in full-definition %s drift in a fixture fallback block", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const requested = structuredClone(registry.get("full-bleed-media"));
    const driftedFallback = driftBuiltInFullDefinition(registry.get("minimal-statement"), kind);
    expect(() => compileCompositionBlockFixture(requested, {
      design: business,
      compositionBlockRegistry: new Map([
        [requested.id, requested],
        [driftedFallback.id, driftedFallback]
      ])
    })).toThrow(/canonical|identity|definition|hash/i);
  });

  it.each([
    "https://example.com/hero.png",
    "ftp://example.com/hero.png",
    "s3://bucket/hero.png",
    "file:///tmp/hero.png",
    "//example.com/hero.png",
    "folder\\hero.png"
  ])("rejects non-filesystem fixture asset source %s instead of passing it to the renderer", (source) => {
    const block = loadCompositionBlockRegistry(blockRoot).get("full-bleed-media");
    expect(() => compileCompositionBlockFixture(block, {
      design: business,
      compositionBlockRegistry: loadCompositionBlockRegistry(blockRoot),
      assetSourceById: { [block.fixtures[0].assetId]: source }
    })).toThrow(/remote.*fixture|fixture.*remote|local.*source/i);
  });

  it("uses a deterministic local fixture asset source as a renderable native image", () => {
    const block = loadCompositionBlockRegistry(blockRoot).get("full-bleed-media");
    const assetId = block.fixtures[0].assetId;
    const source = path.join(root, "examples/image-input/business-slide.png");
    const manifest = compileCompositionBlockFixture(block, {
      design: business,
      compositionBlockRegistry: loadCompositionBlockRegistry(blockRoot),
      assetSourceById: new Map([[assetId, source]])
    });
    expect(manifest.assets).toEqual([{ id: assetId, src: source }]);
    expect(manifest.metadata.generator.fixtureResolution).toEqual({
      requestedId: block.id,
      resolvedId: block.id,
      fallbackReason: null
    });
    expect(manifest.slides[0].notes).toMatch(/localized fixture asset/i);
    expect(manifest.slides[0].elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "image",
        id: "media-image",
        assetId,
        src: source,
        altText: "Localized fixture asset for full-bleed-media",
        sizing: expect.objectContaining({ type: "cover" })
      })
    ]));
    expect(manifest.slides[0].elements.some((element) => element.role === "fixture-media-placeholder")).toBe(false);
    expect(validateJsonSchema(manifest, manifestSchema)).toEqual({ valid: true, errors: [] });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composition-local-image-"));
    const manifestPath = path.join(dir, "deck.manifest.json");
    const pptxPath = path.join(dir, "final.pptx");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    execFileSync(process.execPath, [path.join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], {
      cwd: root,
      encoding: "utf8"
    });
    expect(fs.statSync(pptxPath).size).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    path.join(os.tmpdir(), "definitely-missing-task6a.png"),
    path.join(root, "examples/image-input")
  ])("rejects fixture asset source %s unless it exists as a regular file", (source) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const block = registry.get("full-bleed-media");
    expect(() => compileCompositionBlockFixture(block, {
      design: business,
      compositionBlockRegistry: registry,
      assetSourceById: { [block.fixtures[0].assetId]: source }
    })).toThrow(/regular file|does not exist|missing.*source|local.*file/i);
  });
});

describe("explicit Semantic IR composition integration", () => {
  it("loads the built-in registry in the public creative CLI before lowering a selected block", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composition-cli-"));
    const plan = loadPlan();
    plan.slides[0].compositionIntent.blockId = "unknown-block";
    const inputPath = path.join(dir, "deck.plan.json");
    const outputPath = path.join(dir, "output");
    fs.writeFileSync(inputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    try {
      expect(() => execFileSync(process.execPath, [
        path.join(root, "scripts/pptx.mjs"),
        "text",
        inputPath,
        outputPath,
        "--design-system",
        "business-neutral"
      ], { cwd: root, encoding: "utf8", stdio: "pipe" })).toThrow(/unknown composition block unknown-block/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshots an explicit block, round-trips without registry access, and materially transforms native geometry", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    plan.slides[0].compositionIntent.blockId = "minimal-statement";
    const baseline = compileDeckPlan(loadPlan(), options());
    const { ir, manifest } = compileDeckPlanArtifacts(plan, options(business, { compositionBlockRegistry: registry }));
    const selected = ir.slides[0].compositionBlock;
    expect(selected).toMatchObject({
      requestedId: "minimal-statement",
      resolvedId: "minimal-statement",
      version: "0.1.0",
      fallbackApplied: false,
      fallbackReason: null
    });
    expect(selected.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(selected.topology).toEqual(registry.get("minimal-statement").topology);
    expect(validateSemanticDeckIr(ir, { design: business })).toEqual({ valid: true, errors: [] });
    expect(compileSemanticDeckIr(structuredClone(ir), { design: business })).toEqual(manifest);
    expect(elementIdentity(manifest.slides[0])).toEqual(elementIdentity(baseline.slides[0]));
    expect(elementGeometry(manifest.slides[0])).not.toEqual(elementGeometry(baseline.slides[0]));
    expect(manifest.slides[0].elements.every((element) => inBounds(element))).toBe(true);
  });

  it("does nothing when no block is selected and preserves all eight existing family geometries", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    const withoutRegistry = compileDeckPlanArtifacts(plan, options());
    const withRegistry = compileDeckPlanArtifacts(plan, options(business, { compositionBlockRegistry: registry }));
    expect(withRegistry).toEqual(withoutRegistry);
    expect(withRegistry.ir.slides.every((slide) => !Object.hasOwn(slide, "compositionBlock"))).toBe(true);
    expect(new Set(withRegistry.manifest.slides.map((slide) => slide.type)).size).toBe(8);
    expect(geometry(withRegistry.manifest)).toEqual(geometry(withoutRegistry.manifest));
  });

  it("preserves process connector membership and semantic lineage while changing its group geometry", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    const processIndex = plan.slides.findIndex((slide) => slide.contentModel.kind === "process");
    plan.slides[processIndex].compositionIntent.blockId = "minimal-statement";
    const baseline = compileDeckPlan(loadPlan(), options()).slides[processIndex];
    const transformed = compileDeckPlan(plan, options(business, { compositionBlockRegistry: registry })).slides[processIndex];
    const baselineConnectors = baseline.elements.filter((element) => element.connector).map((element) => ({
      id: element.id,
      connector: element.connector
    }));
    const transformedConnectors = transformed.elements.filter((element) => element.connector).map((element) => ({
      id: element.id,
      connector: element.connector
    }));
    expect(transformedConnectors).toEqual(baselineConnectors);
    expect(transformed.elements.filter((element) => element.semanticParentId).map((element) => ({
      id: element.id,
      semanticParentId: element.semanticParentId
    }))).toEqual(baseline.elements.filter((element) => element.semanticParentId).map((element) => ({
      id: element.id,
      semanticParentId: element.semanticParentId
    })));
    expect(elementGeometry(transformed)).not.toEqual(elementGeometry(baseline));
    expect(transformed.elements.every((element) => inBounds(element))).toBe(true);
  });

  it("treats a quotation as the headline statement so minimal composition remains universal", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    const quoteIndex = plan.slides.findIndex((slide) => slide.contentModel.kind === "quote");
    plan.slides[quoteIndex].compositionIntent.blockId = "minimal-statement";
    const { ir, manifest } = compileDeckPlanArtifacts(plan, options(business, { compositionBlockRegistry: registry }));
    expect(ir.slides[quoteIndex].compositionBlock).toMatchObject({
      requestedId: "minimal-statement",
      resolvedId: "minimal-statement",
      fallbackApplied: false
    });
    expect(compileSemanticDeckIr(ir, { design: business })).toEqual(manifest);
    expect(manifest.slides[quoteIndex].elements.some((element) => element.id === "quote")).toBe(true);
    expect(manifest.slides[quoteIndex].elements.every((element) => inBounds(element))).toBe(true);
  });

  it("materially distinguishes two explicit comparison topologies without changing native identity", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const comparisonIndex = loadPlan().slides.findIndex((slide) => slide.contentModel.kind === "comparison");
    const compileWith = (blockId) => {
      const plan = loadPlan();
      plan.slides[comparisonIndex].compositionIntent.blockId = blockId;
      return compileDeckPlanArtifacts(plan, options(business, { compositionBlockRegistry: registry }));
    };
    const asymmetric = compileWith("asymmetric-split");
    const evidence = compileWith("evidence-first");
    expect(asymmetric.ir.slides[comparisonIndex].compositionBlock.resolvedId).toBe("asymmetric-split");
    expect(evidence.ir.slides[comparisonIndex].compositionBlock.resolvedId).toBe("evidence-first");
    expect(elementIdentity(asymmetric.manifest.slides[comparisonIndex]))
      .toEqual(elementIdentity(evidence.manifest.slides[comparisonIndex]));
    expect(elementGeometry(asymmetric.manifest.slides[comparisonIndex]))
      .not.toEqual(elementGeometry(evidence.manifest.slides[comparisonIndex]));
    const boxes = solveCompositionTopology(registry.get("asymmetric-split").topology, {
      width: 13.333,
      height: 7.5,
      tokens: business.tokens
    });
    const contains = (box, element) => element.x >= box.x - 1e-6
      && element.y >= box.y - 1e-6
      && element.x + element.w <= box.x + box.w + 1e-6
      && element.y + element.h <= box.y + box.h + 1e-6;
    const asymmetricSlide = asymmetric.manifest.slides[comparisonIndex];
    expect(contains(boxes.get("primary"), asymmetricSlide.elements.find((element) => element.id === "left-panel"))).toBe(true);
    expect(contains(boxes.get("supporting"), asymmetricSlide.elements.find((element) => element.id === "right-panel"))).toBe(true);
    expect(asymmetric.manifest.slides[comparisonIndex].elements.every((element) => inBounds(element))).toBe(true);
    expect(evidence.manifest.slides[comparisonIndex].elements.every((element) => inBounds(element))).toBe(true);
  });

  it("separates a dashboard metric value from its supporting label in hero-number topology", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    const dashboardIndex = plan.slides.findIndex((slide) => slide.contentModel.kind === "dashboard");
    plan.slides[dashboardIndex].compositionIntent.blockId = "hero-number";
    const { ir, manifest } = compileDeckPlanArtifacts(plan, options(business, { compositionBlockRegistry: registry }));
    expect(ir.slides[dashboardIndex].compositionBlock.resolvedId).toBe("hero-number");
    const boxes = solveCompositionTopology(registry.get("hero-number").topology, {
      width: 13.333,
      height: 7.5,
      tokens: business.tokens
    });
    const contains = (box, element) => element.x >= box.x - 1e-6
      && element.y >= box.y - 1e-6
      && element.x + element.w <= box.x + box.w + 1e-6
      && element.y + element.h <= box.y + box.h + 1e-6;
    const slide = manifest.slides[dashboardIndex];
    expect(contains(boxes.get("metric"), slide.elements.find((element) => element.id === "value-0"))).toBe(true);
    expect(contains(boxes.get("supporting"), slide.elements.find((element) => element.id === "label-0"))).toBe(true);
    expect(slide.elements.every((element) => inBounds(element))).toBe(true);
  });

  it("fails closed for unknown or incompatible choices and records the declared missing-media fallback", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const unknown = loadPlan();
    unknown.slides[0].compositionIntent.blockId = "unknown-block";
    expect(() => compileDeckPlanToIr(unknown, options(business, { compositionBlockRegistry: registry })))
      .toThrow(/unknown.*composition|unknown-block/i);

    const incompatible = loadPlan();
    incompatible.slides[0].compositionIntent.blockId = "hero-number";
    expect(() => compileDeckPlanToIr(incompatible, options(business, { compositionBlockRegistry: registry })))
      .toThrow(/hero-number.*(?:page role|required slot|incompatible)|incompatible.*hero-number/i);

    const fallbackPlan = loadPlan();
    fallbackPlan.slides[0].compositionIntent.blockId = "full-bleed-media";
    const fallbackIr = compileDeckPlanToIr(fallbackPlan, options(business, { compositionBlockRegistry: registry }));
    expect(fallbackIr.slides[0].compositionBlock).toMatchObject({
      requestedId: "full-bleed-media",
      resolvedId: "minimal-statement",
      fallbackApplied: true,
      fallbackReason: "missing-assets"
    });
    expect(compileSemanticDeckIr(fallbackIr, { design: business }).slides[0].elements.every((element) => inBounds(element))).toBe(true);

    const resolution = resolveCompositionBlock(registry, "full-bleed-media", {
      pageRole: "cover",
      dials: fallbackPlan.designIntent.dials,
      assets: [],
      availableSlots: ["headline", "primary", "accent"]
    });
    expect(resolution).toMatchObject({ requestedId: "full-bleed-media", resolvedId: "minimal-statement", fallbackReason: "missing-assets" });
  });

  it.each(["full-bleed-media", "annotated-media"])("rejects a forged %s missing-assets fallback when a matching slide asset exists", (blockId) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const fallback = registry.get("minimal-statement");
    const plan = loadPlan();
    const asset = photoAsset(`asset-${blockId}`);
    plan.assets.push(asset);
    plan.slides[0].assetIds = [asset.id];
    plan.slides[0].attentionTarget = { kind: "asset", ref: asset.id };
    plan.slides[0].compositionIntent.emphasis = "asset";
    plan.slides[0].compositionIntent.blockId = blockId;
    const ir = compileDeckPlanToIr(plan, options(business, { compositionBlockRegistry: registry }));
    expect(ir.slides[0].compositionBlock.fallbackApplied, blockId).toBe(false);

    const forged = structuredClone(ir);
    const originalAssetRefs = [...forged.slides[0].assetRefs];
    forged.slides[0].compositionBlock = {
      requestedId: blockId,
      resolvedId: fallback.id,
      version: fallback.version,
      definitionHash: canonicalCompositionBlockHash(fallback),
      fallbackApplied: true,
      fallbackReason: "missing-assets",
      topology: structuredClone(fallback.topology)
    };
    const validation = validateSemanticDeckIr(forged, { design: business });
    expect(validation.valid, blockId).toBe(false);
    expect(validation.errors.join("; "), blockId).toMatch(/missing-assets.*matching|fallback.*asset/i);
    expect(forged.slides[0].assetRefs, blockId).toEqual(originalAssetRefs);
  });

  it.each(["full-bleed-media", "annotated-media"])("rejects a forged non-fallback %s snapshot when matching slide assets are absent", (blockId) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    plan.slides[0].compositionIntent.blockId = blockId;
    const ir = compileDeckPlanToIr(plan, options(business, { compositionBlockRegistry: registry }));
    expect(ir.slides[0].compositionBlock).toMatchObject({
      requestedId: blockId,
      resolvedId: "minimal-statement",
      fallbackApplied: true,
      fallbackReason: "missing-assets"
    });

    const forged = structuredClone(ir);
    const block = registry.get(blockId);
    const originalAssetRefs = [...forged.slides[0].assetRefs];
    forged.slides[0].compositionBlock = {
      requestedId: blockId,
      resolvedId: blockId,
      version: block.version,
      definitionHash: canonicalCompositionBlockHash(block),
      fallbackApplied: false,
      fallbackReason: null,
      topology: structuredClone(block.topology)
    };
    const validation = validateSemanticDeckIr(forged, { design: business });
    expect(validation.valid, blockId).toBe(false);
    expect(validation.errors.join("; "), blockId).toMatch(/missing-assets.*fallback|non-fallback.*matching.*asset/i);
    expect(forged.slides[0].assetRefs, blockId).toEqual(originalAssetRefs);
  });

  it.each(["full-bleed-media", "annotated-media"])("rejects a forged non-fallback %s snapshot with more matching slide assets than allowed", (blockId) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    const assets = [photoAsset(`${blockId}-first`), photoAsset(`${blockId}-second`)];
    plan.assets.push(...assets);
    plan.slides[0].assetIds = assets.map((asset) => asset.id);
    plan.slides[0].attentionTarget = { kind: "asset", ref: assets[0].id };
    plan.slides[0].compositionIntent.emphasis = "asset";
    const forged = compileDeckPlanToIr(plan, options(business));
    const block = registry.get(blockId);
    forged.slides[0].compositionIntent.blockId = blockId;
    forged.slides[0].compositionBlock = {
      requestedId: blockId,
      resolvedId: blockId,
      version: block.version,
      definitionHash: canonicalCompositionBlockHash(block),
      fallbackApplied: false,
      fallbackReason: null,
      topology: structuredClone(block.topology)
    };

    const originalAssetRefs = [...forged.slides[0].assetRefs];
    const validation = validateSemanticDeckIr(forged, { design: business });
    expect(validation.valid, blockId).toBe(false);
    expect(validation.errors.join("; "), blockId).toMatch(/matching slide assets.*(?:max|at most|1)|asset.*range/i);
    expect(forged.slides[0].assetRefs, blockId).toEqual(originalAssetRefs);
  });

  it("rejects drifted, unknown, or mismatched IR snapshots and never emits a raster-only slide", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    plan.slides[0].compositionIntent.blockId = "minimal-statement";
    const ir = compileDeckPlanToIr(plan, options(business, { compositionBlockRegistry: registry }));
    const mutations = [
      ["drifted topology", (copy) => { copy.slides[0].compositionBlock.topology.child.gap = "{spacing.xs}"; }, /hash|drift/i],
      ["unknown snapshot", (copy) => { copy.slides[0].compositionBlock.resolvedId = "unknown-block"; }, /unknown.*block|resolvedId/i],
      ["intent mismatch", (copy) => { copy.slides[0].compositionIntent.blockId = "editorial-poster"; }, /requestedId|blockId|match/i],
      ["forged fallback pair", (copy) => {
        copy.slides[0].compositionIntent.blockId = "editorial-poster";
        copy.slides[0].compositionBlock.requestedId = "editorial-poster";
        copy.slides[0].compositionBlock.fallbackApplied = true;
        copy.slides[0].compositionBlock.fallbackReason = "missing-assets";
      }, /fallback.*(?:pair|declared|editorial-poster)|editorial-poster.*fallback/i]
    ];
    for (const [label, mutate, pattern] of mutations) {
      const copy = structuredClone(ir);
      mutate(copy);
      const validation = validateSemanticDeckIr(copy, { design: business });
      expect(validation.valid, label).toBe(false);
      expect(validation.errors.join("; "), label).toMatch(pattern);
    }

    const manifest = compileSemanticDeckIr(ir, { design: business });
    for (const slide of manifest.slides) {
      expect(slide.elements.some((element) => element.type === "text")).toBe(true);
      expect(slide.elements).not.toEqual([
        expect.objectContaining({ type: "image", x: 0, y: 0, w: 13.333, h: 7.5 })
      ]);
    }

    const block = registry.get("minimal-statement");
    const fixtureManifest = compileCompositionBlockFixture(block, { design: business });
    const fixtureSlide = structuredClone(fixtureManifest.slides[0]);
    const result = applyCompositionBlockToSlide(fixtureSlide, {
      id: fixtureSlide.id,
      nodes: fixtureSlide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      })),
      compositionBlock: {
        requestedId: block.id,
        resolvedId: block.id,
        version: block.version,
        definitionHash: canonicalCompositionBlockHash(block),
        fallbackApplied: false,
        fallbackReason: null,
        topology: structuredClone(block.topology)
      }
    }, {
      requestedId: block.id,
      resolvedId: block.id,
      block
    }, { design: business });
    expect(result.elements.every((element) => inBounds(element))).toBe(true);
  });

  it("rejects canonical ID-to-topology substitution even when the snapshot hash is recomputed", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const plan = loadPlan();
    plan.slides[0].compositionIntent.blockId = "editorial-poster";
    const forged = compileDeckPlanToIr(plan, options(business, { compositionBlockRegistry: registry }));
    const minimal = registry.get("minimal-statement");
    forged.slides[0].compositionBlock.version = minimal.version;
    forged.slides[0].compositionBlock.topology = structuredClone(minimal.topology);
    forged.slides[0].compositionBlock.definitionHash = canonicalCompositionSnapshotHash(forged.slides[0].compositionBlock);
    expect(canonicalCompositionSnapshotHash(forged.slides[0].compositionBlock))
      .toBe(forged.slides[0].compositionBlock.definitionHash);

    const validation = validateSemanticDeckIr(forged, { design: business });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("; ")).toMatch(/canonical|identity|registered.*hash|resolvedId.*hash/i);
  });

  it("replays trusted requested and resolved compatibility instead of accepting a canonical but incompatible block", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const hero = registry.get("hero-number");
    const forged = compileDeckPlanToIr(loadPlan(), options(business));
    forged.slides[0].compositionIntent.blockId = hero.id;
    forged.slides[0].compositionBlock = {
      requestedId: hero.id,
      resolvedId: hero.id,
      version: hero.version,
      definitionHash: canonicalCompositionBlockHash(hero),
      fallbackApplied: false,
      fallbackReason: null,
      topology: structuredClone(hero.topology)
    };

    const validation = validateSemanticDeckIr(forged, { design: business });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("; ")).toMatch(/hero-number.*(?:page role|cover|required slot|metric)|(?:page role|cover|required slot|metric).*hero-number/i);
    expect(() => compileSemanticDeckIr(forged, { design: business })).toThrow(/hero-number|page role|cover|required slot|metric/i);
  });

  it("replays requested compatibility before accepting a canonical missing-assets fallback", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const requested = registry.get("full-bleed-media");
    const resolved = registry.get("minimal-statement");
    const forged = compileDeckPlanToIr(loadPlan(), options(business));
    const quote = forged.slides.find((slide) => slide.family === "quote");
    quote.compositionIntent.blockId = requested.id;
    quote.compositionBlock = {
      requestedId: requested.id,
      resolvedId: resolved.id,
      version: resolved.version,
      definitionHash: canonicalCompositionBlockHash(resolved),
      fallbackApplied: true,
      fallbackReason: "missing-assets",
      topology: structuredClone(resolved.topology)
    };

    const validation = validateSemanticDeckIr(forged, { design: business });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("; ")).toMatch(/full-bleed-media.*(?:page role|quote)|(?:page role|quote).*full-bleed-media/i);
  });

  it("enforces trusted required slots when applying a self-contained snapshot", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const minimal = registry.get("minimal-statement");
    const hero = registry.get("hero-number");
    const slide = compileCompositionBlockFixture(minimal, { design: business }).slides[0];
    const irSlide = {
      id: slide.id,
      nodes: slide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      }))
    };
    const snapshot = {
      requestedId: hero.id,
      resolvedId: hero.id,
      version: hero.version,
      definitionHash: canonicalCompositionBlockHash(hero),
      fallbackApplied: false,
      fallbackReason: null,
      topology: structuredClone(hero.topology)
    };
    expect(() => applyCompositionBlockToSlide(slide, irSlide, snapshot, { design: business }))
      .toThrow(/required slot metric/i);
  });

  it("rejects an invalid caller-supplied block before trusted built-in required slots can be weakened", () => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const minimal = registry.get("minimal-statement");
    const forgedHero = structuredClone(registry.get("hero-number"));
    forgedHero.contentShape.requiredSlots = [];
    forgedHero.contentShape.optionalSlots = ["headline", "metric", "supporting"];
    expect(validateCompositionBlock(forgedHero).valid).toBe(false);
    const slide = compileCompositionBlockFixture(minimal, {
      design: business,
      compositionBlockRegistry: registry
    }).slides[0];
    const irSlide = {
      id: slide.id,
      nodes: slide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      }))
    };
    expect(() => applyCompositionBlockToSlide(slide, irSlide, {
      requestedId: forgedHero.id,
      resolvedId: forgedHero.id,
      block: forgedHero
    }, { design: business })).toThrow(/invalid|required slot metric/i);
  });

  it.each(["id mismatch", "canonical hash drift", "snapshot hash mismatch"])("binds caller-supplied built-in blocks to canonical identity: %s", (scenario) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const minimal = registry.get("minimal-statement");
    const slide = compileCompositionBlockFixture(minimal, {
      design: business,
      compositionBlockRegistry: registry
    }).slides[0];
    const irSlide = {
      id: slide.id,
      nodes: slide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      }))
    };
    let selection;
    if (scenario === "id mismatch") {
      selection = { requestedId: "hero-number", resolvedId: minimal.id, block: structuredClone(registry.get("hero-number")) };
    } else if (scenario === "canonical hash drift") {
      const drifted = structuredClone(minimal);
      drifted.topology.child.weights = [2, 3];
      expect(validateCompositionBlock(drifted)).toEqual({ valid: true, errors: [] });
      expect(canonicalCompositionBlockHash(drifted)).not.toBe(canonicalCompositionBlockHash(minimal));
      selection = { requestedId: minimal.id, resolvedId: minimal.id, block: drifted };
    } else {
      selection = {
        requestedId: minimal.id,
        resolvedId: minimal.id,
        definitionHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        block: structuredClone(minimal)
      };
    }
    expect(() => applyCompositionBlockToSlide(slide, irSlide, selection, { design: business }))
      .toThrow(/canonical|identity|resolvedId|definition hash|block id/i);
  });

  it.each(["optional slots", "fixture content", "editability"])("rejects built-in full-definition %s drift at the public apply block boundary", (kind) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const minimal = registry.get("minimal-statement");
    const drifted = driftBuiltInFullDefinition(minimal, kind);
    const slide = compileCompositionBlockFixture(minimal, {
      design: business,
      compositionBlockRegistry: registry
    }).slides[0];
    const irSlide = {
      id: slide.id,
      nodes: slide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      }))
    };
    expect(() => applyCompositionBlockToSlide(slide, irSlide, {
      requestedId: minimal.id,
      resolvedId: minimal.id,
      block: drifted
    }, { design: business })).toThrow(/canonical|identity|definition|hash/i);
  });

  it.each(["drifted snapshot", "unknown identity", "missing identity"])("validates public apply snapshot identity: %s", (scenario) => {
    const registry = loadCompositionBlockRegistry(blockRoot);
    const minimal = registry.get("minimal-statement");
    const slide = compileCompositionBlockFixture(minimal, {
      design: business,
      compositionBlockRegistry: registry
    }).slides[0];
    const irSlide = {
      id: slide.id,
      nodes: slide.elements.map((element) => ({
        id: element.id,
        role: element.id.startsWith("headline-") ? "headline" : "evidence",
        kind: element.type === "text" ? "text" : "diagram"
      }))
    };
    const snapshot = {
      requestedId: minimal.id,
      resolvedId: minimal.id,
      version: minimal.version,
      definitionHash: canonicalCompositionBlockHash(minimal),
      fallbackApplied: false,
      fallbackReason: null,
      topology: structuredClone(minimal.topology)
    };
    if (scenario === "drifted snapshot") snapshot.topology.child.weights = [2, 3];
    if (scenario === "unknown identity") snapshot.resolvedId = "unknown-block";
    if (scenario === "missing identity") {
      delete snapshot.requestedId;
      delete snapshot.resolvedId;
      delete snapshot.version;
      delete snapshot.definitionHash;
    }
    expect(() => applyCompositionBlockToSlide(slide, irSlide, snapshot, { design: business }))
      .toThrow(/canonical|identity|unknown|definition hash|resolvedId|required/i);
  });
});
