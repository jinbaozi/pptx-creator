import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.mjs";

const CATALOG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../layout-archetypes");
const CATALOG_VERSION = "1.0.0";
const ARCHETYPE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEGACY_TYPES = Object.freeze([
  "cover",
  "statement",
  "bullets",
  "comparison",
  "metrics",
  "process",
  "timeline",
  "quote",
  "image",
  "closing"
]);
const REQUIRED_IDS = Object.freeze([
  "closing-action",
  "comparison-matrix",
  "cover",
  "dashboard",
  "editorial-split",
  "evidence-image",
  "executive-summary",
  "hero-statement",
  "metric-focus",
  "process-flow",
  "quote-story",
  "section-break",
  "table-chart-diagram",
  "timeline-roadmap"
]);
const SLOT_KINDS = new Set(["string", "claim", "claims", "group", "metrics", "steps", "milestones", "assetId"]);

function registryFail(message, path, details) {
  fail("E_ARCHETYPE_REGISTRY", message, { path, ...(details === undefined ? {} : { details }) });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, path, code = "E_LAYOUT_CONTENT") {
  if (!plainObject(value)) fail(code, `${path} must be an object`, { path });
  return value;
}

function requireNonEmptyString(value, path, code = "E_LAYOUT_CONTENT", maxLength) {
  if (typeof value !== "string" || !value.trim()) fail(code, `${path} must be a non-empty string`, { path });
  if (maxLength !== undefined && value.length > maxLength) fail(code, `${path} exceeds ${maxLength} characters`, { path });
  return value;
}

function requireArray(value, path, rule = {}) {
  if (!Array.isArray(value)) fail("E_LAYOUT_CONTENT", `${path} must be an array`, { path });
  if (rule.minItems !== undefined && value.length < rule.minItems) {
    fail("E_LAYOUT_CONTENT", `${path} must contain at least ${rule.minItems} item(s)`, { path });
  }
  if (rule.maxItems !== undefined && value.length > rule.maxItems) {
    fail("E_LAYOUT_CONTENT", `${path} must contain at most ${rule.maxItems} item(s)`, { path });
  }
  return value;
}

function inside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeCatalogPath(value, path) {
  if (typeof value !== "string" || !value || value.includes("\0") || value !== value.trim() || value.includes("\\")) {
    registryFail(`${path} must be a normalized package-local JSON path`, path);
  }
  if (isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.split("/").includes("..")) {
    registryFail(`${path} escapes the layout-archetypes catalog`, path);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || !normalized.startsWith("definitions/") || !normalized.endsWith(".json")) {
    registryFail(`${path} must name a JSON definition below definitions/`, path);
  }
  const candidate = resolve(CATALOG_ROOT, normalized);
  if (!inside(CATALOG_ROOT, candidate)) registryFail(`${path} escapes the layout-archetypes catalog`, path);
  return candidate;
}

function readStaticJson(filePath, path) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    registryFail(`Cannot read static catalog file ${filePath}: ${error.message}`, path);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) registryFail(`${path} must resolve to a regular file`, path);

  let catalogRoot;
  let canonicalFile;
  try {
    catalogRoot = realpathSync(CATALOG_ROOT);
    canonicalFile = realpathSync(filePath);
  } catch (error) {
    registryFail(`Cannot resolve static catalog file ${filePath}: ${error.message}`, path);
  }
  if (!inside(catalogRoot, canonicalFile)) registryFail(`${path} resolves outside the layout-archetypes catalog`, path);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(canonicalFile, "utf8"));
  } catch (error) {
    registryFail(`Invalid static JSON at ${path}: ${error.message}`, path);
  }
  if (!plainObject(parsed)) registryFail(`${path} must contain a JSON object`, path);
  return parsed;
}

function assertExactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) registryFail(`${path}.${key} is not supported by the static archetype schema`, `${path}.${key}`);
  }
}

function assertString(value, path, options = {}) {
  if (typeof value !== "string" || !value.trim()) registryFail(`${path} must be a non-empty string`, path);
  if (options.pattern && !options.pattern.test(value)) registryFail(`${path} has an unsupported format`, path);
  if (options.maxLength !== undefined && value.length > options.maxLength) registryFail(`${path} exceeds ${options.maxLength} characters`, path);
  return value;
}

function assertStringArray(value, path) {
  if (!Array.isArray(value)) registryFail(`${path} must be an array`, path);
  const values = new Set();
  for (const [index, item] of value.entries()) {
    assertString(item, `${path}[${index}]`, { pattern: /^[a-z][A-Za-z0-9]*$/ });
    if (values.has(item)) registryFail(`${path} contains duplicate slot ${item}`, `${path}[${index}]`);
    values.add(item);
  }
  return values;
}

function assertBound(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 12) registryFail(`${path} must be an integer from 0 to 12`, path);
  return value;
}

function assertMaxLength(value, path) {
  if (!Number.isInteger(value) || value < 1 || value > 2000) registryFail(`${path} must be an integer from 1 to 2000`, path);
  return value;
}

function validateRule(slot, rule, path) {
  if (!plainObject(rule)) registryFail(`${path} must be an object`, path);
  assertExactKeys(rule, new Set(["kind", "minItems", "maxItems", "minPoints", "maxPoints", "maxLength"]), path);
  const kind = assertString(rule.kind, `${path}.kind`);
  if (!SLOT_KINDS.has(kind)) registryFail(`${path}.kind must be a supported slot kind`, `${path}.kind`);
  const itemKinds = new Set(["claims", "metrics", "steps", "milestones"]);
  if (itemKinds.has(kind)) {
    const minItems = assertBound(rule.minItems, `${path}.minItems`);
    const maxItems = assertBound(rule.maxItems, `${path}.maxItems`);
    if (minItems > maxItems) registryFail(`${path}.minItems cannot exceed ${path}.maxItems`, path);
  } else if (rule.minItems !== undefined || rule.maxItems !== undefined) {
    registryFail(`${path} cannot define item bounds for ${kind}`, path);
  }
  if (kind === "group") {
    const minPoints = assertBound(rule.minPoints, `${path}.minPoints`);
    const maxPoints = assertBound(rule.maxPoints, `${path}.maxPoints`);
    if (minPoints > maxPoints) registryFail(`${path}.minPoints cannot exceed ${path}.maxPoints`, path);
  } else if (rule.minPoints !== undefined || rule.maxPoints !== undefined) {
    registryFail(`${path} cannot define point bounds for ${kind}`, path);
  }
  if (kind === "string") {
    if (rule.maxLength !== undefined) assertMaxLength(rule.maxLength, `${path}.maxLength`);
  } else if (rule.maxLength !== undefined) {
    registryFail(`${path} cannot define maxLength for ${kind}`, path);
  }
  return { slot, kind, ...rule };
}

function validateDefinition(value, manifestEntry, path) {
  assertExactKeys(value, new Set(["id", "label", "legacyType", "description", "slots"]), path);
  const id = assertString(value.id, `${path}.id`, { pattern: ARCHETYPE_ID });
  if (id !== manifestEntry.id) registryFail(`${path}.id must match its manifest id`, `${path}.id`);
  const label = assertString(value.label, `${path}.label`, { maxLength: 120 });
  const legacyType = assertString(value.legacyType, `${path}.legacyType`);
  if (!LEGACY_TYPES.includes(legacyType)) registryFail(`${path}.legacyType must be a renderer-supported legacy type`, `${path}.legacyType`);
  const description = assertString(value.description, `${path}.description`, { maxLength: 240 });
  if (!plainObject(value.slots)) registryFail(`${path}.slots must be an object`, `${path}.slots`);
  assertExactKeys(value.slots, new Set(["required", "optional", "rules"]), `${path}.slots`);
  const required = assertStringArray(value.slots.required, `${path}.slots.required`);
  const optional = assertStringArray(value.slots.optional, `${path}.slots.optional`);
  for (const slot of required) {
    if (optional.has(slot)) registryFail(`${path}.slots.${slot} cannot be both required and optional`, `${path}.slots`);
  }
  if (!plainObject(value.slots.rules)) registryFail(`${path}.slots.rules must be an object`, `${path}.slots.rules`);
  const allowedSlots = new Set([...required, ...optional]);
  const rules = {};
  for (const [slot, rule] of Object.entries(value.slots.rules)) {
    if (!allowedSlots.has(slot)) registryFail(`${path}.slots.rules.${slot} does not correspond to an allowed slot`, `${path}.slots.rules.${slot}`);
    rules[slot] = validateRule(slot, rule, `${path}.slots.rules.${slot}`);
  }
  for (const slot of allowedSlots) {
    if (!Object.hasOwn(rules, slot)) registryFail(`${path}.slots.rules.${slot} is required`, `${path}.slots.rules`);
  }
  return { id, label, legacyType, description, slots: { required: [...required], optional: [...optional], rules } };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function loadRegistry() {
  const manifest = readStaticJson(resolve(CATALOG_ROOT, "registry.json"), "$.registry");
  assertExactKeys(manifest, new Set(["version", "definitions"]), "$.registry");
  if (manifest.version !== CATALOG_VERSION) registryFail(`$.registry.version must be ${CATALOG_VERSION}`, "$.registry.version");
  if (!Array.isArray(manifest.definitions)) registryFail("$.registry.definitions must be an array", "$.registry.definitions");
  if (manifest.definitions.length !== REQUIRED_IDS.length) registryFail("$.registry.definitions must include the complete required archetype set", "$.registry.definitions");

  const entries = [];
  const seen = new Set();
  for (const [index, entry] of manifest.definitions.entries()) {
    const path = `$.registry.definitions[${index}]`;
    if (!plainObject(entry)) registryFail(`${path} must be an object`, path);
    assertExactKeys(entry, new Set(["id", "path"]), path);
    const id = assertString(entry.id, `${path}.id`, { pattern: ARCHETYPE_ID });
    if (seen.has(id)) registryFail(`${path}.id duplicates ${id}`, `${path}.id`);
    seen.add(id);
    const definitionPath = safeCatalogPath(entry.path, `${path}.path`);
    const definition = validateDefinition(readStaticJson(definitionPath, `${path}.path`), { id }, `${path}.definition`);
    entries.push({ id, path: entry.path, definition });
  }

  if (JSON.stringify([...seen].sort()) !== JSON.stringify(REQUIRED_IDS)) {
    registryFail("$.registry.definitions must include each required archetype exactly once", "$.registry.definitions");
  }
  if (JSON.stringify(entries.map((entry) => entry.id)) !== JSON.stringify(REQUIRED_IDS)) {
    registryFail("$.registry.definitions must be sorted by canonical archetype id", "$.registry.definitions");
  }

  const registry = Object.fromEntries(entries.map(({ definition }) => [definition.id, definition]));
  const fingerprint = sha256({ version: manifest.version, definitions: entries });
  return deepFreeze({ version: manifest.version, entries, registry, fingerprint });
}

const loaded = loadRegistry();

export const LAYOUT_ARCHETYPE_CATALOG_VERSION = loaded.version;
export const LAYOUT_ARCHETYPE_IDS = Object.freeze([...REQUIRED_IDS]);
export const LAYOUT_ARCHETYPE_REGISTRY = loaded.registry;
export const LAYOUT_ARCHETYPE_REGISTRY_SHA256 = loaded.fingerprint;

export const LEGACY_LAYOUT_ADAPTERS = Object.freeze({
  cover: "cover",
  statement: "hero-statement",
  bullets: "executive-summary",
  comparison: "comparison-matrix",
  metrics: "metric-focus",
  process: "process-flow",
  timeline: "timeline-roadmap",
  quote: "quote-story",
  image: "evidence-image",
  closing: "closing-action"
});

for (const legacyType of LEGACY_TYPES) {
  const canonicalId = LEGACY_LAYOUT_ADAPTERS[legacyType];
  if (!canonicalId || !LAYOUT_ARCHETYPE_REGISTRY[canonicalId]) {
    registryFail(`Legacy adapter ${legacyType} must resolve to a registered archetype`, "$.legacyAdapters");
  }
}

const canonicalResolutions = Object.freeze(Object.fromEntries(LAYOUT_ARCHETYPE_IDS.map((id) => [
  id,
  Object.freeze({ id, legacyType: LAYOUT_ARCHETYPE_REGISTRY[id].legacyType })
])));
const legacyResolutions = Object.freeze(Object.fromEntries(Object.entries(LEGACY_LAYOUT_ADAPTERS).map(([legacyType, id]) => [
  legacyType,
  Object.freeze({ id, legacyType: LAYOUT_ARCHETYPE_REGISTRY[id].legacyType, adaptedFrom: legacyType })
])));

export function getLayoutArchetype(id) {
  return typeof id === "string" ? LAYOUT_ARCHETYPE_REGISTRY[id] : undefined;
}

export function resolveLayoutArchetype(id) {
  if (typeof id !== "string") return undefined;
  return canonicalResolutions[id] ?? legacyResolutions[id];
}

function validateClaim(value, path) {
  requirePlainObject(value, path);
  requireNonEmptyString(value.text, `${path}.text`);
}

function validateGroup(value, path, rule) {
  requirePlainObject(value, path);
  requireNonEmptyString(value.label, `${path}.label`);
  const points = requireArray(value.points, `${path}.points`, {
    minItems: rule.minPoints,
    maxItems: rule.maxPoints
  });
  for (const [index, point] of points.entries()) validateClaim(point, `${path}.points[${index}]`);
}

function validateMetrics(value, path, rule) {
  const metrics = requireArray(value, path, rule);
  for (const [index, metric] of metrics.entries()) {
    const itemPath = `${path}[${index}]`;
    requirePlainObject(metric, itemPath);
    requireNonEmptyString(metric.value, `${itemPath}.value`);
    requireNonEmptyString(metric.label, `${itemPath}.label`);
    validateClaim(metric.claim, `${itemPath}.claim`);
  }
}

function validateSteps(value, path, rule) {
  const steps = requireArray(value, path, rule);
  for (const [index, step] of steps.entries()) {
    const itemPath = `${path}[${index}]`;
    requirePlainObject(step, itemPath);
    requireNonEmptyString(step.label, `${itemPath}.label`);
    validateClaim(step.claim, `${itemPath}.claim`);
  }
}

function validateMilestones(value, path, rule) {
  const milestones = requireArray(value, path, rule);
  for (const [index, milestone] of milestones.entries()) {
    const itemPath = `${path}[${index}]`;
    requirePlainObject(milestone, itemPath);
    requireNonEmptyString(milestone.when, `${itemPath}.when`);
    requireNonEmptyString(milestone.label, `${itemPath}.label`);
    validateClaim(milestone.claim, `${itemPath}.claim`);
  }
}

function validateSlot(value, path, rule) {
  if (rule.kind === "string") return requireNonEmptyString(value, path, "E_LAYOUT_CONTENT", rule.maxLength);
  if (rule.kind === "claim") return validateClaim(value, path);
  if (rule.kind === "claims") {
    const claims = requireArray(value, path, rule);
    for (const [index, claim] of claims.entries()) validateClaim(claim, `${path}[${index}]`);
    return claims;
  }
  if (rule.kind === "group") return validateGroup(value, path, rule);
  if (rule.kind === "metrics") return validateMetrics(value, path, rule);
  if (rule.kind === "steps") return validateSteps(value, path, rule);
  if (rule.kind === "milestones") return validateMilestones(value, path, rule);
  if (rule.kind === "assetId") {
    const assetId = requireNonEmptyString(value, path);
    if (!ASSET_ID.test(assetId)) fail("E_LAYOUT_CONTENT", `${path} must be a stable asset identifier`, { path });
    return assetId;
  }
  registryFail(`Unsupported static slot kind ${rule.kind}`, path);
}

function defaultArchetypePath(slotPath) {
  return slotPath.endsWith(".slots") ? `${slotPath.slice(0, -".slots".length)}.layoutArchetype` : "$.layoutArchetype";
}

export function validateLayoutArchetypeSlots(id, slots, options = {}) {
  const slotPath = typeof options.path === "string" && options.path ? options.path : "$.slots";
  const archetypePath = typeof options.archetypePath === "string" && options.archetypePath
    ? options.archetypePath
    : defaultArchetypePath(slotPath);
  const resolved = resolveLayoutArchetype(id);
  if (!resolved) fail("E_LAYOUT_CONTENT", `Unsupported layout archetype ${String(id)}`, { path: archetypePath });

  const definition = getLayoutArchetype(resolved.id);
  requirePlainObject(slots, slotPath);
  const allowedSlots = new Set([...definition.slots.required, ...definition.slots.optional]);
  for (const slot of Object.keys(slots)) {
    if (!allowedSlots.has(slot)) fail("E_LAYOUT_CONTENT", `${slotPath}.${slot} is not supported by ${resolved.id}`, { path: `${slotPath}.${slot}` });
  }
  for (const slot of definition.slots.required) {
    if (!Object.hasOwn(slots, slot)) fail("E_LAYOUT_CONTENT", `${slotPath}.${slot} is required by ${resolved.id}`, { path: `${slotPath}.${slot}` });
  }
  for (const slot of allowedSlots) {
    if (Object.hasOwn(slots, slot)) validateSlot(slots[slot], `${slotPath}.${slot}`, definition.slots.rules[slot]);
  }
  return resolved;
}

export function validateLayoutArchetypeRegistry() {
  return Object.freeze({
    version: LAYOUT_ARCHETYPE_CATALOG_VERSION,
    ids: [...LAYOUT_ARCHETYPE_IDS],
    sha256: LAYOUT_ARCHETYPE_REGISTRY_SHA256
  });
}
