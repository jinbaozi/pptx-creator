import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSemanticConnectors } from "./connector-resolver.mjs";
import { validateJsonSchema } from "./schema-utils.mjs";

const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/composition-block.schema.json", import.meta.url), "utf8"));
const SLOT_NAMES = Object.freeze(["headline", "primary", "supporting", "metric", "media", "accent"]);
const SLOT_SET = new Set(SLOT_NAMES);
const DIAL_NAMES = Object.freeze(["compositionVariance", "visualDensity", "visualEnergy"]);
const SPACING_REFERENCE = /^\{spacing\.([A-Za-z0-9_-]+)\}$/;
const DEFINITION_VERSION = "0.1.0";
const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const POINTS_PER_INCH = 72;
const BANNED_TOPOLOGY_KEYS = new Set([
  "x", "y", "w", "h", "left", "top", "right", "bottom", "width", "height", "elements",
  "color", "fill", "stroke", "fontFamily", "font-family", "fontSize", "font-size", "shadow", "material"
]);

export const INITIAL_COMPOSITION_BLOCK_IDS = Object.freeze([
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
]);

export const CANONICAL_COMPOSITION_BLOCK_HASHES = Object.freeze({
  "editorial-poster": "sha256:a26b86228a5956cc1638ac688004de0ee938a093b36f038cd415fc211d8cd388",
  "asymmetric-split": "sha256:4b7661d598955f0fc9ce2c3f6a2a52380d32dc3e50e742109dd53c91a881cbb2",
  "full-bleed-media": "sha256:dbadeca1f57d3574006262b8aaf4e53ea5894b57916175f25e9f99f465bc3fcb",
  "anchored-sidebar": "sha256:1fe44cde7606b4a05e98a16e7991328fba63cbafbca1a740976c936d217774e5",
  "hero-number": "sha256:abefc61386557103d2ebdaa7f967d62b5f258d8d9a89401c47c99e8d34892156",
  "evidence-first": "sha256:1356e23a827eebf0f1c434e2a02d617e8d18653316139b16338f19f562481ae8",
  "chart-dominant": "sha256:6d6ad552bdec2cbc0f6d260de54013aba467ecfcbcc47c41bae966826cb71b2b",
  "annotated-media": "sha256:7be0b4349359947836ae444043f0eff9bba1b34b670baaaf01b0fba5aed82018",
  "layered-depth": "sha256:39a1be0350705141547bb6383a9e74188e02c48dfdb0004cf6e24fabce7648d3",
  "radial-system": "sha256:69ef7db52289779e85337d56b8d7cbd62e0436b21118bc6675d92e133eff5679",
  "timeline": "sha256:ac0a872c9d13a48caf3b0f3ca6006944f79095d9fe9009ec67782df5d268b1df",
  "matrix": "sha256:664494bf64418f27157d14dac523fa243e2ebc49daa6380c824ab26ada3b183f",
  "masonry": "sha256:cb9ab5196f8b1300f7866d087ad1bca263d534a7f98fbcddcd34f316a7043b0e",
  "bento-asymmetric": "sha256:9f6c40f74e467c4b9e4449586d70c0802ae3aec7f4f4b0879da7998d54b79082",
  "minimal-statement": "sha256:1b25cd26f6c394729aa90821d2d6d8a0f2bc54e15bc6bc9569282d5957b21872"
});

export const CANONICAL_COMPOSITION_BLOCK_DEFINITION_HASHES = Object.freeze({
  "anchored-sidebar": "sha256:f71678ad75e5c18daf8ee714164d9ab7249532528ba0d0a7ba911f768d797c56",
  "annotated-media": "sha256:d9948243a7a7c4f434770859615ae4e861e084c95e6e67f7272906afb95a3b12",
  "asymmetric-split": "sha256:add43f0371c789b2d77950e2ae0d8d3fa247750871244f14aad55e74f340c1a6",
  "bento-asymmetric": "sha256:90bbcaa69368c2da2ab41346ae39be9a194018ee0eae89e434336249a9c8fbaf",
  "chart-dominant": "sha256:ce9065b81a1c8788de60b9507d771b6b5e11a42902027f0695bc901703865621",
  "editorial-poster": "sha256:e16812dac207b5b6d4496ddadbe51da292e16520ee9c612c63ff838fabfa4bfd",
  "evidence-first": "sha256:86894a0e5908b1029722b3e7642653a4125d70b134fed61d3cbe68e235ef9046",
  "full-bleed-media": "sha256:a74558cd1808a5e0b1cad8b965a1b31a6ddf01a0be3bba61fb4df0222c025d2c",
  "hero-number": "sha256:c02cad120bfd4f2444bd50ec1ba0975ca2e666baa26cdfbad91917135279d191",
  "layered-depth": "sha256:3ffd8031016d76a36b095a6a1f01a344babd78fa84d8fd4c4c4183a4b112a0b2",
  "masonry": "sha256:6ec65851e390c72185043318c6376c9eb06c8e9565ebf479b7024b729fea9778",
  "matrix": "sha256:d2a932dacceac90ab5fbe4a7c1ddbfdd1bd06c2757fb2bbf7cb3472b21222816",
  "minimal-statement": "sha256:e80aa7d635cd95eb97911d35c399bce3fa8a67f99945e2dd2dca9aa8a74b0cf4",
  "radial-system": "sha256:691d18f3ab7df0c5baee287fe75d7abdad076795260bf95f4e43c2dfdf375d8a",
  "timeline": "sha256:02c6dd65093a22f7b108dd7660f2faed6e3be38a834ecd206e5bca7ebe7b1ea1"
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalContract(pageRoles, ranges, requiredSlots, required, kinds, min, max, fallback) {
  return {
    pageRoles,
    dialRange: {
      compositionVariance: { min: ranges[0][0], max: ranges[0][1] },
      visualDensity: { min: ranges[1][0], max: ranges[1][1] },
      visualEnergy: { min: ranges[2][0], max: ranges[2][1] }
    },
    requiredSlots,
    assetRequirements: { required, kinds, min, max },
    fallback
  };
}

const nativeFallback = () => ({ mode: "native-family", when: ["content-overflow", "unsupported-content"] });

export const CANONICAL_COMPOSITION_BLOCK_CONTRACTS = deepFreeze({
  "editorial-poster": canonicalContract(["cover", "section", "single-point", "closing"], [[0.45, 1], [0.1, 0.7], [0.35, 1]], ["headline", "primary", "accent"], false, [], 0, 0, nativeFallback()),
  "asymmetric-split": canonicalContract(["single-point", "evidence", "comparison", "decision"], [[0.35, 1], [0.25, 0.85], [0.2, 0.85]], ["headline", "primary", "supporting"], false, [], 0, 0, nativeFallback()),
  "full-bleed-media": canonicalContract(["cover", "section", "evidence", "case-study", "closing"], [[0.4, 1], [0.05, 0.65], [0.4, 1]], ["headline", "media", "accent"], true, ["photo", "illustration", "texture"], 1, 1, { mode: "block", blockId: "minimal-statement", when: ["missing-assets", "unsupported-content"] }),
  "anchored-sidebar": canonicalContract(["section", "evidence", "architecture", "appendix"], [[0.25, 0.85], [0.35, 1], [0.1, 0.7]], ["headline", "primary", "supporting"], false, [], 0, 0, nativeFallback()),
  "hero-number": canonicalContract(["single-point", "evidence", "data", "decision"], [[0.3, 0.9], [0.1, 0.65], [0.35, 1]], ["headline", "metric", "supporting"], false, ["chart-data"], 0, 1, nativeFallback()),
  "evidence-first": canonicalContract(["evidence", "data", "comparison", "case-study", "decision"], [[0.2, 0.9], [0.35, 1], [0.1, 0.8]], ["headline", "primary", "supporting"], false, ["chart-data", "diagram-source", "photo"], 0, 2, nativeFallback()),
  "chart-dominant": canonicalContract(["evidence", "data", "decision"], [[0.2, 0.85], [0.45, 1], [0.15, 0.85]], ["headline", "primary", "metric"], false, ["chart-data"], 0, 1, nativeFallback()),
  "annotated-media": canonicalContract(["cover", "evidence", "case-study", "appendix"], [[0.35, 1], [0.2, 0.85], [0.25, 0.95]], ["headline", "media", "supporting"], true, ["photo", "illustration"], 1, 1, { mode: "block", blockId: "minimal-statement", when: ["missing-assets", "unsupported-content"] }),
  "layered-depth": canonicalContract(["single-point", "evidence", "architecture", "case-study"], [[0.45, 1], [0.25, 0.85], [0.3, 0.95]], ["headline", "primary", "accent"], false, ["diagram-source", "illustration"], 0, 1, nativeFallback()),
  "radial-system": canonicalContract(["evidence", "process", "architecture"], [[0.5, 1], [0.25, 0.8], [0.35, 1]], ["headline", "primary", "accent"], false, ["diagram-source"], 0, 1, nativeFallback()),
  "timeline": canonicalContract(["section", "evidence", "process", "case-study"], [[0.2, 0.85], [0.3, 0.9], [0.2, 0.85]], ["headline", "primary", "accent"], false, ["diagram-source"], 0, 1, nativeFallback()),
  "matrix": canonicalContract(["data", "comparison", "decision", "appendix"], [[0.15, 0.75], [0.4, 1], [0.1, 0.7]], ["headline", "primary", "supporting", "accent"], false, ["chart-data", "diagram-source"], 0, 1, nativeFallback()),
  "masonry": canonicalContract(["evidence", "case-study", "appendix"], [[0.55, 1], [0.35, 0.9], [0.25, 0.9]], ["headline", "primary", "supporting", "accent"], false, ["photo", "illustration", "chart-data"], 0, 3, nativeFallback()),
  "bento-asymmetric": canonicalContract(["evidence", "data", "comparison", "architecture"], [[0.4, 1], [0.45, 1], [0.2, 0.9]], ["headline", "primary", "supporting", "accent"], false, ["chart-data", "diagram-source", "icon"], 0, 3, nativeFallback()),
  "minimal-statement": canonicalContract(["cover", "section", "single-point", "evidence", "data", "comparison", "process", "architecture", "case-study", "quote", "decision", "closing", "appendix"], [[0, 1], [0, 1], [0, 1]], ["headline"], false, [], 0, 0, { mode: "native-family", when: ["missing-assets", "content-overflow", "unsupported-content"] })
});

function definitionPayload(id, version, topology) {
  return { version, id, topology: canonical(topology) };
}

export function canonicalCompositionBlockHash(block) {
  if (!block || typeof block !== "object") throw new TypeError("composition block must be an object");
  const payload = definitionPayload(block.id, block.version, block.topology);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}`;
}

export function canonicalCompositionBlockDefinitionHash(block) {
  if (!block || typeof block !== "object") throw new TypeError("composition block must be an object");
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(block))).digest("hex")}`;
}

export function canonicalCompositionSnapshotHash(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("composition snapshot must be an object");
  return canonicalCompositionBlockHash({
    id: snapshot.resolvedId,
    version: snapshot.version,
    topology: snapshot.topology
  });
}

function topologyErrors(topology) {
  const errors = [];
  const slots = [];
  function visit(node, location = "topology") {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`${location} must be an object`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (BANNED_TOPOLOGY_KEYS.has(key)) errors.push(`${location}.${key} is a forbidden visual or coordinate property`);
      if (typeof value === "string" && /^(?:#|rgb\(|rgba\()/i.test(value)) errors.push(`${location}.${key} contains a raw color`);
    }
    if (Object.hasOwn(node, "slot")) {
      if (!SLOT_SET.has(node.slot)) errors.push(`${location}.slot is unknown: ${node.slot}`);
      else slots.push(node.slot);
      return;
    }
    const spacingKeys = node.primitive === "safe-area"
      ? Object.entries(node.insets ?? {})
      : ["gap", "columnGap", "rowGap", "inset"].filter((key) => Object.hasOwn(node, key)).map((key) => [key, node[key]]);
    for (const [key, value] of spacingKeys) {
      if (!SPACING_REFERENCE.test(String(value ?? ""))) errors.push(`${location}.${key} must be a {spacing.*} token`);
    }
    if (node.primitive === "stack" && node.weights && node.weights.length !== (node.children ?? []).length) {
      errors.push(`${location}.weights must match children length`);
    }
    if (node.primitive === "split" && (node.children?.length !== 2 || node.ratios?.length !== 2)) {
      errors.push(`${location} split requires exactly two children and ratios`);
    }
    if (node.primitive === "grid" && (!Number.isInteger(node.columns) || node.columns < 1 || node.columns > 4)) {
      errors.push(`${location}.columns must be an integer from 1 to 4`);
    }
    if (node.child) visit(node.child, `${location}.child`);
    for (const [index, child] of (node.children ?? []).entries()) visit(child, `${location}.children[${index}]`);
  }
  visit(topology);
  return { errors, slots };
}

export function validateCompositionTopology(topology) {
  const structural = validateJsonSchema(topology, { $defs: SCHEMA.$defs, $ref: "#/$defs/safeArea" });
  const inspected = topologyErrors(topology);
  const errors = [
    ...structural.errors.map((entry) => `${entry.path}: ${entry.message}`),
    ...inspected.errors
  ];
  for (const slot of duplicateValues(inspected.slots)) errors.push(`topology contains duplicate slot ${slot}`);
  return { valid: errors.length === 0, errors, slots: inspected.slots };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function validateCompositionBlock(block) {
  const structural = validateJsonSchema(block, SCHEMA);
  const errors = structural.errors.map((entry) => `${entry.path}: ${entry.message}`);
  if (!block || typeof block !== "object" || Array.isArray(block)) return { valid: false, errors };

  const required = block.contentShape?.requiredSlots ?? [];
  const optional = block.contentShape?.optionalSlots ?? [];
  for (const slot of required.filter((entry) => optional.includes(entry))) errors.push(`contentShape slot ${slot} cannot be both required and optional`);
  for (const name of DIAL_NAMES) {
    const range = block.dialRange?.[name];
    if (range && Number(range.min) > Number(range.max)) errors.push(`dialRange.${name} min must not exceed max`);
  }
  const assets = block.assetRequirements;
  if (assets) {
    if (Number(assets.min) > Number(assets.max)) errors.push("assetRequirements min must not exceed max");
    if (assets.required === true && Number(assets.min) < 1) errors.push("required assetRequirements must have min >= 1");
    const kinds = Array.isArray(assets.kinds) ? assets.kinds : [];
    if ((assets.required === true || Number(assets.min) > 0) && kinds.length === 0) {
      errors.push("assetRequirements kinds must be non-empty when assets are required or min is positive");
    }
    if (kinds.length === 0 && (assets.required !== false || Number(assets.min) !== 0 || Number(assets.max) !== 0)) {
      errors.push("empty assetRequirements kinds require required=false and min=max=0");
    }
    if (Number(assets.min) > 0 && assets.required !== true) {
      errors.push("assetRequirements min > 0 requires required=true");
    }
  }
  if (block.fallback?.mode === "block" && block.fallback.blockId === block.id) errors.push(`fallback cycle: ${block.id} targets itself`);

  const topology = topologyErrors(block.topology);
  errors.push(...topology.errors);
  for (const slot of duplicateValues(topology.slots)) errors.push(`topology contains duplicate slot ${slot}`);
  for (const slot of required) {
    if (topology.slots.filter((entry) => entry === slot).length !== 1) errors.push(`topology must contain required slot ${slot} exactly once`);
  }
  for (const slot of topology.slots) {
    if (!required.includes(slot) && !optional.includes(slot)) errors.push(`topology slot ${slot} is not declared by contentShape`);
  }
  for (const fixture of block.fixtures ?? []) {
    const fixtureSlots = Object.keys(fixture?.slots ?? {});
    for (const slot of required) if (!fixtureSlots.includes(slot)) errors.push(`fixture ${fixture?.id ?? "(unknown)"} missing required slot ${slot}`);
    for (const slot of fixtureSlots) {
      if (!required.includes(slot) && !optional.includes(slot)) errors.push(`fixture ${fixture?.id ?? "(unknown)"} uses undeclared slot ${slot}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function assertValidBlock(block, label) {
  const validation = validateCompositionBlock(block);
  if (!validation.valid) throw new Error(`${label} invalid: ${validation.errors.join("; ")}`);
}

function compositionBlockContract(block) {
  return {
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
  };
}

function assertCanonicalBuiltInBlock(block, label) {
  const canonicalHash = CANONICAL_COMPOSITION_BLOCK_HASHES[block.id];
  if (!canonicalHash) return;
  if (canonicalCompositionBlockHash(block) !== canonicalHash) {
    throw new Error(`${label} canonical identity hash does not match built-in ${block.id}`);
  }
  const expectedContract = CANONICAL_COMPOSITION_BLOCK_CONTRACTS[block.id];
  if (JSON.stringify(canonical(compositionBlockContract(block))) !== JSON.stringify(canonical(expectedContract))) {
    throw new Error(`${label} canonical contract metadata does not match built-in ${block.id}`);
  }
  const canonicalDefinitionHash = CANONICAL_COMPOSITION_BLOCK_DEFINITION_HASHES[block.id];
  if (canonicalCompositionBlockDefinitionHash(block) !== canonicalDefinitionHash) {
    throw new Error(`${label} canonical full-definition hash does not match built-in ${block.id}`);
  }
}

function validateFallbackGraph(registry) {
  for (const [id, block] of registry) {
    if (block.fallback.mode === "block" && !registry.has(block.fallback.blockId)) {
      throw new Error(`composition block ${id} has unknown fallback ${block.fallback.blockId}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail = []) {
    if (visiting.has(id)) throw new Error(`composition fallback cycle: ${[...trail, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const block = registry.get(id);
    if (block?.fallback.mode === "block") visit(block.fallback.blockId, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of registry.keys()) visit(id);
}

export function loadCompositionBlockRegistry(root) {
  const directory = path.resolve(root);
  const registry = new Map();
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const fileName of files) {
    const filePath = path.join(directory, fileName);
    const block = JSON.parse(readFileSync(filePath, "utf8"));
    const stem = path.basename(fileName, ".json");
    if (stem !== block.id) throw new Error(`composition block filename ${stem} must equal id ${block.id ?? "(missing)"}`);
    assertValidBlock(block, `composition block ${block.id}`);
    if (registry.has(block.id)) throw new Error(`duplicate composition block id ${block.id}`);
    registry.set(block.id, deepFreeze(structuredClone(block)));
  }
  validateFallbackGraph(registry);
  return registry;
}

function normalizedDial(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) throw new Error(`composition dial ${name} must be in 0..100`);
  return numeric / 100;
}

function assetsMatching(block, assets) {
  const kinds = new Set(block.assetRequirements.kinds);
  if (kinds.size === 0) return [];
  return (assets ?? []).filter((asset) => kinds.has(asset.kind));
}

function assertBlockCompatibility(block, context, { checkSlots = true } = {}) {
  if (!(block.pageRoles ?? []).includes(context.pageRole)) {
    throw new Error(`composition block ${block.id} is incompatible with page role ${context.pageRole}`);
  }
  for (const name of DIAL_NAMES) {
    const normalized = normalizedDial(context.dials?.[name], name);
    const range = block.dialRange[name];
    if (normalized < range.min || normalized > range.max) {
      throw new Error(`composition block ${block.id} is incompatible with ${name} ${normalized}; expected ${range.min}..${range.max}`);
    }
  }
  if (checkSlots && Array.isArray(context.availableSlots)) {
    const available = new Set(context.availableSlots);
    for (const slot of block.contentShape.requiredSlots) {
      if (!available.has(slot)) throw new Error(`composition block ${block.id} requires unavailable slot ${slot}`);
    }
  }
}

export function resolveCompositionBlock(registry, requestedId, context = {}) {
  if (!(registry instanceof Map)) throw new TypeError("composition block registry must be a Map");
  const requested = registry.get(requestedId);
  if (!requested) throw new Error(`unknown composition block ${requestedId}`);
  if (requested.id !== requestedId) {
    throw new Error(`composition block registry key ${requestedId} must equal block id ${requested.id ?? "(missing)"}`);
  }
  assertValidBlock(requested, `requested composition block ${requestedId}`);
  assertCanonicalBuiltInBlock(requested, `requested composition block ${requestedId}`);
  const matchingAssets = assetsMatching(requested, context.assets);
  assertBlockCompatibility(requested, context, { checkSlots: false });
  if (matchingAssets.length > requested.assetRequirements.max) {
    throw new Error(`composition block ${requested.id} accepts at most ${requested.assetRequirements.max} matching assets`);
  }
  const missingAssets = requested.assetRequirements.required && matchingAssets.length < requested.assetRequirements.min;
  let block = requested;
  let fallbackApplied = false;
  let fallbackReason = null;
  if (missingAssets) {
    if (requested.fallback.mode !== "block" || !requested.fallback.when.includes("missing-assets")) {
      throw new Error(`composition block ${requested.id} requires ${requested.assetRequirements.min} matching assets`);
    }
    block = registry.get(requested.fallback.blockId);
    if (!block) throw new Error(`composition block ${requested.id} has unknown fallback ${requested.fallback.blockId}`);
    if (block.id !== requested.fallback.blockId) {
      throw new Error(`composition fallback registry key ${requested.fallback.blockId} must equal block id ${block.id ?? "(missing)"}`);
    }
    assertValidBlock(block, `fallback composition block ${requested.fallback.blockId}`);
    assertCanonicalBuiltInBlock(block, `fallback composition block ${requested.fallback.blockId}`);
    fallbackApplied = true;
    fallbackReason = "missing-assets";
  }
  assertBlockCompatibility(block, context);
  return {
    requestedId,
    resolvedId: block.id,
    block,
    fallbackApplied,
    fallbackReason
  };
}

function spacingInches(reference, tokens) {
  const match = typeof reference === "string" && reference.match(SPACING_REFERENCE);
  if (!match) throw new Error(`spacing value must be a {spacing.*} token: ${reference}`);
  const value = tokens?.spacing?.[match[1]];
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`missing or invalid spacing token ${reference}`);
  return Number(value) / POINTS_PER_INCH;
}

function rounded(value) {
  return Number(Number(value).toFixed(6));
}

function roundedBox(box) {
  return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, rounded(value)]));
}

function positiveBox(box, label) {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) {
    throw new Error(`${label} resolved to a malformed or non-positive box`);
  }
  return box;
}

function solveChildren(children, weights, gap, box, direction, solve, label) {
  const totalGap = gap * Math.max(0, children.length - 1);
  const span = direction === "horizontal" ? box.w : box.h;
  const available = span - totalGap;
  if (available <= 0) throw new Error(`${label} gaps exceed available ${direction} span`);
  const resolvedWeights = weights ?? children.map(() => 1);
  if (resolvedWeights.length !== children.length || resolvedWeights.some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0)) {
    throw new Error(`${label} weights must be positive and match children`);
  }
  const sum = resolvedWeights.reduce((total, value) => total + Number(value), 0);
  let cursor = direction === "horizontal" ? box.x : box.y;
  children.forEach((child, index) => {
    const childSpan = index === children.length - 1
      ? (direction === "horizontal" ? box.x + box.w : box.y + box.h) - cursor
      : available * Number(resolvedWeights[index]) / sum;
    const childBox = direction === "horizontal"
      ? { x: cursor, y: box.y, w: childSpan, h: box.h }
      : { x: box.x, y: cursor, w: box.w, h: childSpan };
    solve(child, positiveBox(childBox, `${label}[${index}]`), `${label}[${index}]`);
    cursor += childSpan + gap;
  });
}

export function solveCompositionTopology(topology, { width, height, tokens } = {}) {
  const validation = validateCompositionTopology(topology);
  if (!validation.valid) throw new Error(`composition topology invalid: ${validation.errors.join("; ")}`);
  const deckWidth = Number(width);
  const deckHeight = Number(height);
  if (!Number.isFinite(deckWidth) || deckWidth <= 0 || !Number.isFinite(deckHeight) || deckHeight <= 0) {
    throw new Error("composition topology requires positive slide width and height");
  }
  if (topology?.primitive !== "safe-area") throw new Error("composition topology root must be safe-area");
  const slots = new Map();
  function solve(node, box, label) {
    if (Object.hasOwn(node, "slot")) {
      if (slots.has(node.slot)) throw new Error(`duplicate composition slot ${node.slot}`);
      slots.set(node.slot, roundedBox(positiveBox(box, label)));
      return;
    }
    switch (node.primitive) {
      case "safe-area": {
        const top = spacingInches(node.insets.blockStart, tokens);
        const right = spacingInches(node.insets.inlineEnd, tokens);
        const bottom = spacingInches(node.insets.blockEnd, tokens);
        const left = spacingInches(node.insets.inlineStart, tokens);
        solve(node.child, positiveBox({
          x: box.x + left,
          y: box.y + top,
          w: box.w - left - right,
          h: box.h - top - bottom
        }, `${label}.safe-area`), `${label}.child`);
        return;
      }
      case "stack": {
        solveChildren(node.children, node.weights, spacingInches(node.gap, tokens), box, node.direction, solve, label);
        return;
      }
      case "split": {
        solveChildren(node.children, node.ratios, spacingInches(node.gap, tokens), box, node.direction, solve, label);
        return;
      }
      case "grid": {
        const columns = Number(node.columns);
        if (!Number.isInteger(columns) || columns < 1 || columns > 4) throw new Error(`${label}.columns must be 1..4`);
        const rows = Math.ceil(node.children.length / columns);
        const columnGap = spacingInches(node.columnGap, tokens);
        const rowGap = spacingInches(node.rowGap, tokens);
        const cellWidth = (box.w - columnGap * (columns - 1)) / columns;
        const cellHeight = (box.h - rowGap * (rows - 1)) / rows;
        if (cellWidth <= 0 || cellHeight <= 0) throw new Error(`${label} grid gaps exceed available space`);
        node.children.forEach((child, index) => solve(child, {
          x: box.x + (index % columns) * (cellWidth + columnGap),
          y: box.y + Math.floor(index / columns) * (cellHeight + rowGap),
          w: cellWidth,
          h: cellHeight
        }, `${label}[${index}]`));
        return;
      }
      case "overlay":
        node.children.forEach((child, index) => solve(child, { ...box }, `${label}[${index}]`));
        return;
      case "anchor": {
        const inset = spacingInches(node.inset, tokens);
        const available = positiveBox({ x: box.x + inset, y: box.y + inset, w: box.w - inset * 2, h: box.h - inset * 2 }, `${label}.anchor`);
        const scale = { compact: 0.36, medium: 0.62, full: 1 }[node.size];
        if (!scale) throw new Error(`${label}.size is unsupported: ${node.size}`);
        const w = available.w * scale;
        const h = available.h * scale;
        const horizontal = node.anchor.endsWith("left") || node.anchor === "left" ? 0
          : node.anchor.endsWith("right") || node.anchor === "right" ? 1 : 0.5;
        const vertical = node.anchor.startsWith("top") || node.anchor === "top" ? 0
          : node.anchor.startsWith("bottom") || node.anchor === "bottom" ? 1 : 0.5;
        solve(node.child, {
          x: available.x + (available.w - w) * horizontal,
          y: available.y + (available.h - h) * vertical,
          w,
          h
        }, `${label}.child`);
        return;
      }
      default: throw new Error(`${label} uses unsupported topology primitive ${node.primitive}`);
    }
  }
  solve(topology, { x: 0, y: 0, w: deckWidth, h: deckHeight }, "topology");
  for (const [slot, box] of slots) {
    if (box.x < 0 || box.y < 0 || box.x + box.w > deckWidth + 1e-6 || box.y + box.h > deckHeight + 1e-6) {
      throw new Error(`composition slot ${slot} resolves outside slide bounds`);
    }
  }
  return slots;
}

function typographyForSlot(tokens, slot) {
  if (slot === "headline") return tokens.typography?.title ?? tokens.typography?.heading;
  if (slot === "metric") return tokens.typography?.metric ?? tokens.typography?.title;
  if (slot === "supporting" || slot === "accent") return tokens.typography?.caption ?? tokens.typography?.body;
  return tokens.typography?.body;
}

function fixtureText(value) {
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

function fixtureSlide(block, fixture, design, index, assetSource = null) {
  const tokens = design.tokens;
  const boxes = solveCompositionTopology(block.topology, { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, tokens });
  const elements = [];
  let z = 0;
  for (const [slot, box] of boxes) {
    const content = fixture.slots[slot];
    if (content === undefined) continue;
    if (slot === "media" && assetSource) {
      elements.push({
        type: "image",
        id: "media-image",
        assetId: fixture.assetId,
        src: assetSource,
        altText: `Localized fixture asset for ${block.id}`,
        ...box,
        sizing: { type: "cover", w: box.w, h: box.h }
      });
      z += 1;
      continue;
    }
    const surface = z % 2 === 0 ? tokens.colors.surfaceAlt : tokens.colors.surface;
    elements.push({
      type: "shape",
      id: `${slot}-panel`,
      ...(slot === "media" ? { role: "fixture-media-placeholder" } : {}),
      shape: slot === "accent" ? "ellipse" : "roundRect",
      ...box,
      style: {
        fill: slot === "media" ? tokens.colors.surface : surface,
        line: slot === "headline" || slot === "metric" ? tokens.colors.primary : tokens.colors.border,
        lineWidth: 1
      }
    });
    const typography = typographyForSlot(tokens, slot);
    const pad = Math.min(0.08, box.w / 12, box.h / 12);
    elements.push({
      type: "text",
      id: `${slot}-text`,
      ...(slot === "media" ? { role: "fixture-media-placeholder" } : {}),
      x: rounded(box.x + pad),
      y: rounded(box.y + pad),
      w: rounded(box.w - pad * 2),
      h: rounded(box.h - pad * 2),
      text: fixtureText(content),
      style: {
        fontFamily: typography.fontFamily,
        fontFace: typography.fontFamily,
        fontSize: Number(typography.fontSize),
        fontWeight: Number(typography.fontWeight),
        lineHeight: Number(typography.lineHeight),
        bold: Number(typography.fontWeight) >= 600,
        color: slot === "headline" || slot === "metric" ? tokens.colors.primary : tokens.colors.text,
        valign: "mid"
      }
    });
    z += 1;
  }
  return {
    id: `slide-${block.id}-${index + 1}`,
    type: "composition-block-fixture",
    semanticPageRole: block.pageRoles[0],
    title: `${block.id}: ${fixture.id}`,
    notes: assetSource
      ? `Native topology fixture for ${block.id}; localized fixture asset ${fixture.assetId}`
      : boxes.has("media")
        ? `Native topology fixture for ${block.id}; fixture media placeholder: no local source supplied`
        : `Native topology fixture for ${block.id}`,
    background: { type: "solid", color: tokens.colors.background },
    elements
  };
}

function fixtureAssetSource(assetSourceById, assetId) {
  if (!assetId || assetSourceById === undefined) return null;
  let supplied = false;
  let source;
  if (assetSourceById instanceof Map) {
    supplied = assetSourceById.has(assetId);
    source = assetSourceById.get(assetId);
  } else if (assetSourceById && typeof assetSourceById === "object" && !Array.isArray(assetSourceById)) {
    supplied = Object.hasOwn(assetSourceById, assetId);
    source = assetSourceById[assetId];
  } else {
    throw new TypeError("composition fixture assetSourceById must be a Map or object");
  }
  if (!supplied) return null;
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error(`composition fixture asset ${assetId} requires a non-empty local source`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)
    || /^[/\\]{2}/.test(source)
    || source.includes("\\")
    || source.includes("\0")) {
    throw new Error(`non-local fixture asset source ${assetId} must be a filesystem path`);
  }
  const localPath = path.resolve(source);
  let stats;
  try {
    stats = statSync(localPath);
  } catch {
    throw new Error(`composition fixture asset source ${assetId} does not exist as a regular file: ${localPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`composition fixture asset source ${assetId} must be a regular file: ${localPath}`);
  }
  return localPath;
}

export function compileCompositionBlockFixture(block, { design, assetSourceById, compositionBlockRegistry } = {}) {
  assertValidBlock(block, `composition block ${block?.id ?? "(unknown)"}`);
  assertCanonicalBuiltInBlock(block, `composition fixture block ${block?.id ?? "(unknown)"}`);
  if (!design?.tokens) throw new Error("composition fixture compilation requires design tokens");
  if (compositionBlockRegistry !== undefined && !(compositionBlockRegistry instanceof Map)) {
    throw new TypeError("composition fixture compositionBlockRegistry must be a Map");
  }
  const fixtures = block.fixtures.map((fixture) => ({
    fixture,
    assetSource: fixtureAssetSource(assetSourceById, fixture.assetId)
  }));
  const localizedAssetCount = fixtures.filter(({ assetSource }) => assetSource).length;
  const missingRequiredAssets = block.assetRequirements.required
    && localizedAssetCount < block.assetRequirements.min;
  if (missingRequiredAssets && !compositionBlockRegistry) {
    throw new Error(`required-media composition fixture ${block.id} requires compositionBlockRegistry to execute its missing-assets fallback`);
  }
  if (missingRequiredAssets && compositionBlockRegistry) {
    if (block.fallback.mode !== "block" || !block.fallback.when.includes("missing-assets")) {
      throw new Error(`composition fixture ${block.id} has no declared missing-assets block fallback`);
    }
    const fallbackBlock = compositionBlockRegistry.get(block.fallback.blockId);
    if (!fallbackBlock) throw new Error(`composition fixture ${block.id} has unknown fallback ${block.fallback.blockId}`);
    if (fallbackBlock.id !== block.fallback.blockId) {
      throw new Error(`composition fixture fallback registry key ${block.fallback.blockId} must equal block id ${fallbackBlock.id ?? "(missing)"}`);
    }
    assertValidBlock(fallbackBlock, `composition fixture fallback block ${block.fallback.blockId}`);
    assertCanonicalBuiltInBlock(fallbackBlock, `composition fixture fallback block ${block.fallback.blockId}`);
    const manifest = compileCompositionBlockFixture(fallbackBlock, {
      design,
      assetSourceById,
      compositionBlockRegistry
    });
    manifest.metadata.generator.fixtureResolution = {
      requestedId: block.id,
      resolvedId: fallbackBlock.id,
      fallbackReason: "missing-assets"
    };
    manifest.deck.title = `Composition block fixture: ${block.id} -> ${fallbackBlock.id}`;
    manifest.slides = manifest.slides.map((slide) => ({
      ...slide,
      notes: `${slide.notes}; requestedId=${block.id}; resolvedId=${fallbackBlock.id}; fallbackReason=missing-assets`
    }));
    return manifest;
  }
  return {
    version: "0.2.0",
    metadata: {
      mode: "creative",
      inputType: "text",
      qualityProfile: "creative",
      designIntent: { visibleGrid: false },
      generator: {
        name: "composition-blocks.mjs",
        version: DEFINITION_VERSION,
        fixtureResolution: { requestedId: block.id, resolvedId: block.id, fallbackReason: null }
      }
    },
    designSystem: { source: design.source, name: design.name },
    deck: {
      title: `Composition block: ${block.id}`,
      language: "en-US",
      editabilityFloor: block.editability.minimumLevel,
      size: { preset: "wide", width: SLIDE_WIDTH, height: SLIDE_HEIGHT, unit: "in" }
    },
    assets: fixtures
      .filter(({ assetSource }) => assetSource)
      .map(({ fixture, assetSource }) => ({ id: fixture.assetId, src: assetSource })),
    slides: fixtures.map(({ fixture, assetSource }, index) => fixtureSlide(block, fixture, design, index, assetSource))
  };
}

function sourceNodeForElement(element, nodesById) {
  return nodesById.get(element.semanticParentId) ?? nodesById.get(element.id) ?? null;
}

function preferredSlot(element, node) {
  const id = String(element.id ?? "");
  if (node?.role === "headline" || node?.role === "quotation" || node?.kind === "quote" || id === "headline" || id === "quote") return "headline";
  if (node?.kind === "media" || element.type === "image") return "media";
  if (/^value-\d+$/.test(id)) return "metric";
  if (/^(?:label|kpi-card)-\d+$/.test(id)) return "supporting";
  if (node?.kind === "metric") return "metric";
  if (node?.kind === "divider" || element.connector || /accent|marker|eyebrow/.test(id)) return "accent";
  if (["subtitle", "section-marker", "decision-marker", "comparison-secondary"].includes(node?.role) || /subtitle|attribution|caption/.test(id)) return "supporting";
  return "primary";
}

function targetSlot(preferred, boxes) {
  if (boxes.has(preferred)) return preferred;
  const fallbackOrder = {
    headline: ["primary", "supporting", "accent", "metric", "media"],
    primary: ["supporting", "headline", "metric", "media", "accent"],
    supporting: ["primary", "headline", "accent", "metric", "media"],
    metric: ["primary", "headline", "supporting", "accent", "media"],
    media: ["primary", "supporting", "headline", "accent", "metric"],
    accent: ["primary", "supporting", "headline", "metric", "media"]
  };
  return fallbackOrder[preferred].find((candidate) => boxes.has(candidate)) ?? null;
}

function elementBounds(elements) {
  const nonConnectors = elements.filter((element) => !element.connector);
  const source = nonConnectors.length ? nonConnectors : elements;
  if (!source.length) return null;
  const left = Math.min(...source.map((element) => Math.min(element.x, element.x + element.w)));
  const right = Math.max(...source.map((element) => Math.max(element.x, element.x + element.w)));
  const top = Math.min(...source.map((element) => Math.min(element.y, element.y + element.h)));
  const bottom = Math.max(...source.map((element) => Math.max(element.y, element.y + element.h)));
  return { x: left, y: top, w: Math.max(0.001, right - left), h: Math.max(0.001, bottom - top) };
}

function transformElement(element, source, target) {
  if (element.connector) return structuredClone(element);
  const scaleX = target.w / source.w;
  const scaleY = target.h / source.h;
  const startX = target.x + (element.x - source.x) * scaleX;
  const endX = target.x + (element.x + element.w - source.x) * scaleX;
  const startY = target.y + (element.y - source.y) * scaleY;
  const endY = target.y + (element.y + element.h - source.y) * scaleY;
  return {
    ...structuredClone(element),
    x: rounded(startX),
    y: rounded(startY),
    w: rounded(endX - startX),
    h: rounded(endY - startY)
  };
}

function assertCompositionSelectionIdentity(selection) {
  if (typeof selection.requestedId !== "string" || typeof selection.resolvedId !== "string") {
    throw new Error("composition selection identity requires requestedId and resolvedId");
  }
  if (selection.block) {
    assertValidBlock(selection.block, `composition block ${selection.block.id ?? "(unknown)"}`);
    if (selection.block.id !== selection.resolvedId) {
      throw new Error(`composition block id ${selection.block.id} must equal resolvedId ${selection.resolvedId}`);
    }
    assertCanonicalBuiltInBlock(selection.block, `composition block ${selection.resolvedId}`);
    const blockHash = canonicalCompositionBlockHash(selection.block);
    if (selection.definitionHash !== undefined && selection.definitionHash !== blockHash) {
      throw new Error(`composition block definition hash does not match block identity ${selection.resolvedId}`);
    }
    return;
  }
  if (typeof selection.version !== "string"
    || typeof selection.definitionHash !== "string"
    || !selection.topology) {
    throw new Error("composition snapshot identity requires version, definitionHash, and topology");
  }
  const canonicalHash = CANONICAL_COMPOSITION_BLOCK_HASHES[selection.resolvedId];
  if (!canonicalHash) throw new Error(`unknown canonical composition block identity ${selection.resolvedId}`);
  const recomputedHash = canonicalCompositionSnapshotHash(selection);
  if (selection.definitionHash !== recomputedHash || recomputedHash !== canonicalHash) {
    throw new Error(`composition snapshot canonical identity hash does not match resolvedId ${selection.resolvedId}`);
  }
}

export function applyCompositionBlockToSlide(manifestSlide, irSlide, selection, { design, width = SLIDE_WIDTH, height = SLIDE_HEIGHT } = {}) {
  if (!manifestSlide || !irSlide || !selection) return structuredClone(manifestSlide);
  if (!design?.tokens) throw new Error("composition block application requires design tokens");
  assertCompositionSelectionIdentity(selection);
  const topology = selection.block?.topology ?? selection.topology ?? irSlide.compositionBlock?.topology;
  if (!topology) throw new Error("composition block application requires a topology snapshot");
  const boxes = solveCompositionTopology(topology, { width, height, tokens: design.tokens });
  const nodesById = new Map((irSlide.nodes ?? []).map((node) => [node.id, node]));
  const groups = new Map([...boxes.keys()].map((slot) => [slot, []]));
  for (const element of manifestSlide.elements ?? []) {
    const slot = targetSlot(preferredSlot(element, sourceNodeForElement(element, nodesById)), boxes);
    if (!slot) throw new Error(`composition block cannot classify element ${element.id}`);
    groups.get(slot).push(element);
  }
  const requiredSlots = CANONICAL_COMPOSITION_BLOCK_CONTRACTS[selection.resolvedId]?.requiredSlots
    ?? selection.block?.contentShape?.requiredSlots
    ?? [];
  for (const slot of requiredSlots) {
    if ((groups.get(slot) ?? []).length === 0) throw new Error(`composition block required slot ${slot} has no native elements`);
  }
  if (![...groups.values()].some((elements) => elements.length > 0)) {
    throw new Error("composition block did not classify any native elements");
  }
  const transformed = new Map();
  for (const [slot, elements] of groups) {
    const source = elementBounds(elements);
    if (!source) continue;
    const target = boxes.get(slot);
    for (const element of elements) transformed.set(element.id, transformElement(element, source, target));
  }
  const next = structuredClone(manifestSlide);
  next.elements = (manifestSlide.elements ?? []).map((element) => transformed.get(element.id) ?? structuredClone(element));
  next.elements = resolveSemanticConnectors(next.elements);
  for (const element of next.elements) {
    const left = Math.min(element.x, element.x + element.w);
    const right = Math.max(element.x, element.x + element.w);
    const top = Math.min(element.y, element.y + element.h);
    const bottom = Math.max(element.y, element.y + element.h);
    if (left < -1e-6 || top < -1e-6 || right > width + 1e-6 || bottom > height + 1e-6) {
      throw new Error(`composition transform placed ${element.id} outside slide bounds`);
    }
  }
  return next;
}
