import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  LAYOUT_ARCHETYPE_IDS,
  LAYOUT_ARCHETYPE_REGISTRY_SHA256,
  LEGACY_LAYOUT_ADAPTERS,
  resolveLayoutArchetype,
  validateLayoutArchetypeSlots
} from "./archetypes.mjs";
import { fail } from "./errors.mjs";
import { compileDesignPolicy } from "./design-policy.mjs";
import { buildReviewArtifactHashes as buildApprovalArtifactHashes } from "./review.mjs";
import {
  DEFAULT_THEME_ID,
  loadTheme,
  materializeThemeTokens,
  themeFingerprints
} from "./themes.mjs";
import {
  assertRegularFileInside,
  normalizeRelativePath,
  readJson,
  sha256File,
  sha256Text,
  slugify
} from "./utils.mjs";

export const PLAN_VERSION = "2.0.0";
export const SLIDE_INTENTS = new Set([...LAYOUT_ARCHETYPE_IDS, ...Object.keys(LEGACY_LAYOUT_ADAPTERS)]);
// Kept as an internal name for renderers that still speak in layout types.
export const SLIDE_TYPES = SLIDE_INTENTS;
export const FACT_STATUSES = new Set(["provided", "verified", "inferred", "unverified", "placeholder"]);

const SOURCE_KINDS = new Set(["user-input", "file", "url", "assumption", "placeholder"]);
const RIGHTS = new Set(["user-provided", "project-owned", "licensed", "public-domain", "unknown"]);
const REVIEW_STAGES = ["content", "design", "rights"];
const schemaPath = fileURLToPath(new URL("../../schemas/presentation-plan.schema.json", import.meta.url));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
addFormats(schemaValidator);
const validatePlanSchema = schemaValidator.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

function pathSegment(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? `.${value}` : `[${JSON.stringify(value)}]`;
}

function schemaErrorPath(issue) {
  let path = "$";
  for (const rawSegment of (issue?.instancePath ?? "").split("/").slice(1)) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    path += /^\d+$/.test(segment) ? `[${segment}]` : pathSegment(segment);
  }
  const property = issue?.params?.missingProperty ?? issue?.params?.additionalProperty;
  return property === undefined ? path : `${path}${pathSegment(property)}`;
}

function schemaErrorCode(issue) {
  const instancePath = issue?.instancePath ?? "";
  if (/^\/assets\/\d+\/(?:selectedLocator|fallback\/selectedLocator)$/.test(instancePath)) return "E_ASSET_PATH";
  if (/^\/slides\/\d+\/(?:intent|layoutArchetype|slots)/.test(instancePath)) return "E_LAYOUT_CONTENT";
  return "E_PLAN_SCHEMA";
}

function validatePlanShape(plan) {
  if (validatePlanSchema(plan)) return;
  const issue = validatePlanSchema.errors?.[0];
  const path = schemaErrorPath(issue);
  fail(schemaErrorCode(issue), `${path} ${issue?.message ?? "does not match the presentation-plan schema"}`, {
    path,
    details: { keyword: issue?.keyword, schemaPath: issue?.schemaPath }
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return sha256Text(JSON.stringify(canonicalize(value)));
}

export function canonicalPlanInput(plan) {
  const input = structuredClone(plan);
  if (input.designIntent?.lock) delete input.designIntent.lock.canonicalPlanSha256;
  delete input.review;
  return input;
}

export function canonicalPlanInputSha256(plan) {
  return stableHash(canonicalPlanInput(plan));
}

export function materializeDesignTokens(overrides = {}) {
  return materializeThemeTokens(loadTheme(DEFAULT_THEME_ID), overrides);
}

function materializePlanTokens(themeId, overrides, path) {
  try {
    return materializeThemeTokens(loadTheme(themeId), overrides);
  } catch (error) {
    if (["E_THEME_CONTRAST", "E_THEME_OVERRIDE", "E_THEME_TOKEN"].includes(error?.code)) {
      fail("E_PLAN_SCHEMA", error.message, {
        path: error.path?.startsWith("$.overrides") ? `${path}${error.path.slice("$.overrides".length)}` : path,
        ...(error?.details === undefined ? {} : { details: error.details })
      });
    }
    throw error;
  }
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("E_PLAN_SCHEMA", `${path} must be an object`, { path });
  return value;
}

function requireArray(value, path, options = {}) {
  if (!Array.isArray(value)) fail("E_PLAN_SCHEMA", `${path} must be an array`, { path });
  if (options.min !== undefined && value.length < options.min) fail("E_PLAN_SCHEMA", `${path} must contain at least ${options.min} item(s)`, { path });
  if (options.max !== undefined && value.length > options.max) fail("E_PLAN_SCHEMA", `${path} must contain at most ${options.max} item(s)`, { path });
  return value;
}

function requireString(value, path, options = {}) {
  if (typeof value !== "string" || value.trim().length < (options.min ?? 1)) fail("E_PLAN_SCHEMA", `${path} must be a non-empty string`, { path });
  if (options.max && value.length > options.max) fail("E_PLAN_SCHEMA", `${path} exceeds ${options.max} characters`, { path });
  return value;
}

function requireUnique(items, select, path) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const value = select(item);
    if (seen.has(value)) fail("E_DUPLICATE_ID", `${path} contains duplicate value ${value}`, { path: `${path}[${index}]` });
    seen.add(value);
  }
}

function validateReferences(refs, knownIds, path, code = "E_SOURCE_REF") {
  for (const [index, ref] of refs.entries()) {
    if (!knownIds.has(ref)) fail(code, `Unknown reference ${ref}`, { path: `${path}[${index}]` });
  }
}

function validateClaim(claim, path, sourceIds) {
  requireObject(claim, path);
  requireString(claim.text, `${path}.text`, { max: 240 });
  if (!FACT_STATUSES.has(claim.factStatus)) fail("E_FACT_LABEL", `${path}.factStatus is not supported`, { path: `${path}.factStatus` });
  const refs = requireArray(claim.sourceRefs, `${path}.sourceRefs`, { max: 8 });
  validateReferences(refs, sourceIds, `${path}.sourceRefs`);
  if (["provided", "verified"].includes(claim.factStatus) && refs.length === 0) {
    fail("E_SOURCE_REF", `${path} requires a source reference for ${claim.factStatus} content`, { path: `${path}.sourceRefs` });
  }
}

function validateClaims(items, path, sourceIds, options = {}) {
  const claims = requireArray(items, path, options);
  for (const [index, claim] of claims.entries()) validateClaim(claim, `${path}[${index}]`, sourceIds);
  return claims;
}

function validateSlideSlots(layoutArchetype, slots, path, sourceIds, assetIds) {
  const content = requireObject(slots, path);
  const resolved = resolveLayoutArchetype(layoutArchetype);
  if (!resolved) fail("E_LAYOUT_CONTENT", `Unsupported layout archetype ${layoutArchetype}`, { path: path.replace(/\.slots$/, ".layoutArchetype") });
  if (!Object.hasOwn(LEGACY_LAYOUT_ADAPTERS, layoutArchetype)) {
    validateLayoutArchetypeSlots(layoutArchetype, content, {
      path,
      archetypePath: path.replace(/\.slots$/, ".layoutArchetype")
    });
  }
  if (resolved.id === "table-chart-diagram") {
    const modes = ["assetId", "table", "chart"].filter((key) => Object.hasOwn(content, key));
    if (modes.length !== 1) {
      fail("E_LAYOUT_CONTENT", `${path} must declare exactly one of assetId, table, or chart`, { path });
    }
    if (content.assetId !== undefined) {
      requireString(content.assetId, `${path}.assetId`);
      if (!assetIds.has(content.assetId)) fail("E_LAYOUT_CONTENT", `Unknown image asset ${content.assetId}`, { path: `${path}.assetId` });
    }
    validateClaim(content.caption, `${path}.caption`, sourceIds);
    if (content.table) {
      for (const [rowIndex, row] of content.table.rows.entries()) {
        for (const [cellIndex, cell] of row.values.entries()) {
          validateClaim(cell, `${path}.table.rows[${rowIndex}].values[${cellIndex}]`, sourceIds);
        }
      }
    }
    if (content.chart) {
      for (const [index, point] of content.chart.data.entries()) {
        validateClaim(point.claim, `${path}.chart.data[${index}].claim`, sourceIds);
      }
    }
    return resolved;
  }
  switch (resolved.legacyType) {
    case "cover":
      if (content.subtitle !== undefined) requireString(content.subtitle, `${path}.subtitle`, { max: 220 });
      break;
    case "statement":
      validateClaim(content.statement, `${path}.statement`, sourceIds);
      break;
    case "bullets":
      validateClaims(content.points, `${path}.points`, sourceIds, { min: 1, max: 3 });
      break;
    case "comparison":
      for (const side of ["left", "right"]) {
        const group = requireObject(content[side], `${path}.${side}`);
        requireString(group.label, `${path}.${side}.label`, { max: 80 });
        validateClaims(group.points, `${path}.${side}.points`, sourceIds, { min: 1, max: 3 });
      }
      break;
    case "metrics": {
      const metrics = requireArray(content.metrics, `${path}.metrics`, { min: 1, max: 3 });
      for (const [index, metric] of metrics.entries()) {
        const metricPath = `${path}.metrics[${index}]`;
        requireObject(metric, metricPath);
        requireString(metric.value, `${metricPath}.value`, { max: 28 });
        requireString(metric.label, `${metricPath}.label`, { max: 70 });
        if (metric.detail !== undefined) requireString(metric.detail, `${metricPath}.detail`, { max: 130 });
        validateClaim(metric.claim, `${metricPath}.claim`, sourceIds);
      }
      break;
    }
    case "process": {
      const steps = requireArray(content.steps, `${path}.steps`, { min: 2, max: 5 });
      for (const [index, step] of steps.entries()) {
        const stepPath = `${path}.steps[${index}]`;
        requireObject(step, stepPath);
        requireString(step.label, `${stepPath}.label`, { max: 50 });
        validateClaim(step.claim, `${stepPath}.claim`, sourceIds);
      }
      break;
    }
    case "timeline": {
      const milestones = requireArray(content.milestones, `${path}.milestones`, { min: 2, max: 5 });
      for (const [index, milestone] of milestones.entries()) {
        const itemPath = `${path}.milestones[${index}]`;
        requireObject(milestone, itemPath);
        requireString(milestone.when, `${itemPath}.when`, { max: 40 });
        requireString(milestone.label, `${itemPath}.label`, { max: 60 });
        validateClaim(milestone.claim, `${itemPath}.claim`, sourceIds);
      }
      break;
    }
    case "quote":
      validateClaim(content.quote, `${path}.quote`, sourceIds);
      requireString(content.attribution, `${path}.attribution`, { max: 120 });
      break;
    case "image":
      requireString(content.assetId, `${path}.assetId`);
      if (!assetIds.has(content.assetId)) fail("E_LAYOUT_CONTENT", `Unknown image asset ${content.assetId}`, { path: `${path}.assetId` });
      validateClaim(content.caption, `${path}.caption`, sourceIds);
      break;
    case "closing":
      validateClaim(content.action, `${path}.action`, sourceIds);
      if (content.summary !== undefined) validateClaims(content.summary, `${path}.summary`, sourceIds, { max: 3 });
      break;
    default:
      fail("E_LAYOUT_CONTENT", `Unsupported layout archetype ${layoutArchetype}`, { path: `${path}.layoutArchetype` });
  }
  return resolved;
}

function collectClaimSourceRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectClaimSourceRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  if (Object.hasOwn(value, "factStatus") && Array.isArray(value.sourceRefs)) {
    for (const ref of value.sourceRefs) refs.add(ref);
  }
  for (const child of Object.values(value)) collectClaimSourceRefs(child, refs);
  return refs;
}

function localLocator(value) {
  return !/^https?:\/\//i.test(value);
}

function validateAssetLocator(locator, path, networkPolicy) {
  if (typeof locator !== "string" || !locator || locator.includes("\0")) fail("E_ASSET_PATH", `${path} must be a non-empty locator`, { path });
  if (localLocator(locator)) return normalizeRelativePath(locator, path);
  if (!locator.startsWith("https://")) fail("E_ASSET_PATH", `${path} must use HTTPS when remote`, { path });
  if (networkPolicy === "offline") fail("E_ASSET_NETWORK", `${path} cannot be remote when $.brief.networkPolicy is offline`, { path });
  return locator;
}

function assetLockPayload(assets) {
  return assets.map((asset) => ({
    id: asset.id,
    selectedLocator: asset.selectedLocator,
    expectedSha256: asset.expectedSha256 ?? null,
    mime: asset.mime,
    rights: asset.rights,
    focalPoint: asset.focalPoint ?? null,
    fallback: asset.fallback ?? null
  }));
}

export function buildDesignLock(plan) {
  const themeId = plan.designIntent?.themeId ?? DEFAULT_THEME_ID;
  const theme = loadTheme(themeId);
  const tokens = materializeThemeTokens(theme, plan.designIntent?.tokenOverrides ?? {});
  const fingerprints = themeFingerprints(theme);
  const base = {
    themeManifestSha256: stableHash({
      themeId,
      registrySha256: fingerprints.registrySha256,
      manifestSha256: fingerprints.manifestSha256,
      previewSha256: fingerprints.previewSha256,
      noticeSha256: fingerprints.noticeSha256
    }),
    tokenSha256: stableHash({ tokenSha256: fingerprints.tokenSha256, tokens }),
    archetypeRegistrySha256: LAYOUT_ARCHETYPE_REGISTRY_SHA256,
    assetLockSha256: stableHash(assetLockPayload(plan.assets ?? [])),
    rendererVersion: "text-to-html@2.0.0-registry"
  };
  return { ...base, canonicalPlanSha256: canonicalPlanInputSha256({ ...plan, designIntent: { ...plan.designIntent, lock: base } }) };
}

export function buildReviewArtifactHashes(plan) {
  return buildApprovalArtifactHashes({
    designIntent: plan.designIntent,
    assetLedger: plan.assets ?? [],
    renderer: plan.designIntent.lock.rendererVersion
  });
}

function validateDesignLock(plan) {
  const path = "$.designIntent.lock";
  const lock = requireObject(plan.designIntent.lock, path);
  const expected = buildDesignLock(plan);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (lock[key] !== expectedValue) {
      fail("E_REVIEW_INVALIDATED", `${path}.${key} does not match the current locked input`, {
        path: `${path}.${key}`,
        details: { expected: expectedValue, actual: lock[key] }
      });
    }
  }
}

function validateReview(plan, options) {
  const review = requireObject(plan.review, "$.review");
  const expected = buildReviewArtifactHashes(plan);
  let approved = true;
  for (const stage of REVIEW_STAGES) {
    const path = `$.review.${stage}`;
    const approval = requireObject(review[stage], path);
    if (approval.status === "rejected") fail("E_REVIEW_REJECTED", `${path}.status is rejected`, { path: `${path}.status` });
    if (approval.status !== "approved") approved = false;
    if (approval.status === "approved") {
      requireString(approval.reviewedAt, `${path}.reviewedAt`);
      if (!Number.isFinite(Date.parse(approval.reviewedAt))) fail("E_PLAN_SCHEMA", `${path}.reviewedAt must be an ISO date-time`, { path: `${path}.reviewedAt` });
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (approval.artifactHashes?.[key] !== expectedValue) {
          fail("E_REVIEW_INVALIDATED", `${path}.artifactHashes.${key} does not bind the current artifact`, {
            path: `${path}.artifactHashes.${key}`,
            details: { expected: expectedValue, actual: approval.artifactHashes?.[key] }
          });
        }
      }
      if ((approval.invalidatedBy ?? []).length > 0) {
        fail("E_REVIEW_INVALIDATED", `${path} cannot be approved while invalidatedBy is non-empty`, { path: `${path}.invalidatedBy` });
      }
    }
  }
  if (!options.allowUnreviewed && !approved) {
    fail("E_HOST_REVIEW_REQUIRED", "$.review.content, $.review.design, and $.review.rights must all be approved", { path: "$.review" });
  }
  return approved;
}

function primarySupportCount(slide) {
  const slots = slide.slots;
  if (Array.isArray(slots.points)) return slots.points.length;
  if (Array.isArray(slots.metrics)) return slots.metrics.length;
  if (Array.isArray(slots.steps)) return slots.steps.length;
  if (Array.isArray(slots.milestones)) return slots.milestones.length;
  if (Array.isArray(slots.summary)) return slots.summary.length;
  if (slots.left || slots.right) return Math.max(slots.left?.points?.length ?? 0, slots.right?.points?.length ?? 0);
  return 0;
}

function validateNarrative(plan, slideIds) {
  const narrative = requireObject(plan.narrative, "$.narrative");
  requireString(narrative.framework, "$.narrative.framework", { max: 100 });
  requireString(narrative.thesis, "$.narrative.thesis", { max: 360 });
  const chapters = requireArray(narrative.chapters, "$.narrative.chapters", { min: 1 });
  const beats = requireArray(narrative.beats, "$.narrative.beats", { min: 1 });
  requireUnique(chapters, (chapter) => chapter.id, "$.narrative.chapters");
  requireUnique(beats, (beat) => beat.id, "$.narrative.beats");
  const beatIds = new Set(beats.map((beat) => beat.id));
  for (const [index, beat] of beats.entries()) {
    const path = `$.narrative.beats[${index}]`;
    requireString(beat.id, `${path}.id`);
    requireString(beat.text, `${path}.text`, { max: 240 });
    const refs = requireArray(beat.slideIds, `${path}.slideIds`, { min: 1 });
    validateReferences(refs, slideIds, `${path}.slideIds`, "E_NARRATIVE_REF");
  }
  for (const [index, chapter] of chapters.entries()) {
    const path = `$.narrative.chapters[${index}]`;
    requireString(chapter.id, `${path}.id`);
    requireString(chapter.title, `${path}.title`, { max: 100 });
    validateReferences(requireArray(chapter.beatIds, `${path}.beatIds`, { min: 1 }), beatIds, `${path}.beatIds`, "E_NARRATIVE_REF");
    validateReferences(requireArray(chapter.slideIds, `${path}.slideIds`, { min: 1 }), slideIds, `${path}.slideIds`, "E_NARRATIVE_REF");
  }
  const orderedSlideIds = [...slideIds];
  for (const [kind, groups] of [["chapters", chapters], ["beats", beats]]) {
    const covered = groups.flatMap((group) => group.slideIds);
    if (covered.length !== orderedSlideIds.length || new Set(covered).size !== orderedSlideIds.length || covered.some((id, index) => id !== orderedSlideIds[index])) {
      fail("E_NARRATIVE_COVERAGE", `$.narrative.${kind} must cover every slide exactly once and preserve slide order`, { path: `$.narrative.${kind}` });
    }
  }
  const titles = plan.slides.map((slide) => slide.title.trim());
  if (narrative.titleChain.length !== titles.length || narrative.titleChain.some((title, index) => title.trim() !== titles[index])) {
    fail("E_NARRATIVE_TITLE_CHAIN", "$.narrative.titleChain must reproduce slide titles in order", { path: "$.narrative.titleChain" });
  }
  const curve = requireArray(narrative.attentionCurve, "$.narrative.attentionCurve", { min: 1 });
  if (curve.length !== orderedSlideIds.length || curve.some((point, index) => point.slideId !== orderedSlideIds[index])) {
    fail("E_NARRATIVE_ATTENTION", "$.narrative.attentionCurve must cover slides in order", { path: "$.narrative.attentionCurve" });
  }
}

function validatePagination(plan, slideIds) {
  const budgets = requireArray(plan.pagination.pageBudgets, "$.pagination.pageBudgets", { min: 1 });
  requireUnique(budgets, (budget) => budget.slideId, "$.pagination.pageBudgets");
  if (budgets.length !== slideIds.size || budgets.some((budget, index) => budget.slideId !== plan.slides[index].id)) {
    fail("E_PAGINATION_COVERAGE", "$.pagination.pageBudgets must cover slides in order", { path: "$.pagination.pageBudgets" });
  }
  const byId = new Map(budgets.map((budget) => [budget.slideId, budget]));
  for (const [index, budget] of budgets.entries()) {
    const path = `$.pagination.pageBudgets[${index}]`;
    const keep = requireArray(budget.mustKeepTogether, `${path}.mustKeepTogether`);
    requireUnique(keep.map((id) => ({ id })), (item) => item.id, `${path}.mustKeepTogether`);
    if (budget.continuationOf !== undefined) {
      const previousIndex = plan.slides.findIndex((slide) => slide.id === budget.continuationOf);
      if (previousIndex < 0 || previousIndex >= index) fail("E_PAGINATION_CONTINUATION", `${path}.continuationOf must reference an earlier slide`, { path: `${path}.continuationOf` });
      const previous = byId.get(budget.continuationOf);
      if (!budget.canSplit || !previous?.canSplit || !budget.semanticBreak) {
        fail("E_PAGINATION_CONTINUATION", `${path} requires canSplit and semanticBreak on both continuation pages`, { path });
      }
    }
    if (budget.canSplit && !budget.semanticBreak) fail("E_PAGINATION_CONTINUATION", `${path}.semanticBreak is required when canSplit is true`, { path: `${path}.semanticBreak` });
    const supportCount = primarySupportCount(plan.slides[index]);
    if (supportCount > budget.maxPrimarySupports) {
      fail("E_PAGINATION_BUDGET", `${path}.maxPrimarySupports is below the declared primary support count`, {
        path: `${path}.maxPrimarySupports`,
        details: { supportCount }
      });
    }
  }
  return budgets.reduce((total, budget) => total + budget.timeSeconds, 0);
}

export async function validatePlan(value, options = {}) {
  const plan = requireObject(value, "$");
  if (plan.version !== PLAN_VERSION) {
    fail("E_PLAN_VERSION", `Unsupported plan version ${plan.version ?? "missing"}; supported=${PLAN_VERSION}`, { path: "$.version" });
  }
  validatePlanShape(plan);
  materializePlanTokens(plan.designIntent.themeId, plan.designIntent.tokenOverrides, "$.designIntent.tokenOverrides");

  const deck = requireObject(plan.deck, "$.deck");
  requireString(deck.id, "$.deck.id", { max: 128 });
  requireString(deck.title, "$.deck.title", { max: 180 });
  requireString(deck.language, "$.deck.language", { max: 20 });
  if (deck.size.width !== 1280 || deck.size.height !== 720 || deck.size.unit !== "px") {
    fail("E_PLAN_SCHEMA", "$.deck.size must be exactly 1280×720 px", { path: "$.deck.size" });
  }

  const brief = requireObject(plan.brief, "$.brief");
  if (!Number.isFinite(brief.durationMinutes) || brief.durationMinutes <= 0) fail("E_PLAN_SCHEMA", "$.brief.durationMinutes must be positive", { path: "$.brief.durationMinutes" });
  if (!["offline", "prefer", "require"].includes(brief.networkPolicy)) fail("E_PLAN_SCHEMA", "$.brief.networkPolicy must be offline|prefer|require", { path: "$.brief.networkPolicy" });

  const assumptions = requireArray(plan.assumptions, "$.assumptions");
  requireUnique(assumptions, (item) => item.id, "$.assumptions");
  for (const [index, assumption] of assumptions.entries()) {
    const path = `$.assumptions[${index}]`;
    if (assumption.status === "rejected" || (assumption.status === "inferred" && assumption.impact === "high")) {
      fail("E_HOST_REVIEW_REQUIRED", `${path} must be resolved before approval`, { path });
    }
  }

  const sources = requireArray(plan.sources, "$.sources", { min: 1 });
  requireUnique(sources, (item) => item.id, "$.sources");
  const sourceIds = new Set();
  for (const [index, source] of sources.entries()) {
    const path = `$.sources[${index}]`;
    if (!SOURCE_KINDS.has(source.kind)) fail("E_PLAN_SCHEMA", `Invalid source kind ${source.kind}`, { path: `${path}.kind` });
    if (!FACT_STATUSES.has(source.factStatus)) fail("E_PLAN_SCHEMA", `Invalid source factStatus ${source.factStatus}`, { path: `${path}.factStatus` });
    sourceIds.add(source.id);
  }

  const assets = requireArray(plan.assets, "$.assets");
  requireUnique(assets, (item) => item.id, "$.assets");
  const assetIds = new Set();
  for (const [index, asset] of assets.entries()) {
    const path = `$.assets[${index}]`;
    const locator = validateAssetLocator(asset.selectedLocator, `${path}.selectedLocator`, brief.networkPolicy);
    if (!RIGHTS.has(asset.rights.status)) fail("E_PLAN_SCHEMA", `Invalid asset rights ${asset.rights.status}`, { path: `${path}.rights.status` });
    if (asset.rights.status === "unknown") fail("E_RIGHTS_UNKNOWN", `${path}.rights.status must be resolved before delivery`, { path: `${path}.rights.status` });
    if (asset.sourceRef !== undefined) validateReferences([asset.sourceRef], sourceIds, `${path}.sourceRef`);
    if (asset.fallback) validateAssetLocator(asset.fallback.selectedLocator, `${path}.fallback.selectedLocator`, brief.networkPolicy);
    if (localLocator(locator) && options.planDirectory) {
      const checked = await assertRegularFileInside(options.planDirectory, locator, `${path}.selectedLocator`);
      if (asset.expectedSha256 && await sha256File(checked.path) !== asset.expectedSha256) {
        fail("E_ASSET_HASH", `${path}.expectedSha256 does not match ${locator}`, { path: `${path}.expectedSha256` });
      }
    }
    assetIds.add(asset.id);
  }
  validateDesignLock(plan);

  const slides = requireArray(plan.slides, "$.slides", { min: 1 });
  requireUnique(slides, (slide) => slide.id, "$.slides");
  requireUnique(slides, (slide) => slide.order, "$.slides");
  const slideIds = new Set(slides.map((slide) => slide.id));
  for (const [index, slide] of slides.entries()) {
    const path = `$.slides[${index}]`;
    if (slide.order !== index + 1) fail("E_SLIDE_ORDER", `${path}.order must be ${index + 1}`, { path: `${path}.order` });
    if (!resolveLayoutArchetype(slide.intent)) fail("E_LAYOUT_CONTENT", `Unsupported slide intent ${slide.intent}`, { path: `${path}.intent` });
    if (!resolveLayoutArchetype(slide.layoutArchetype)) fail("E_LAYOUT_CONTENT", `Unsupported layout archetype ${slide.layoutArchetype}`, { path: `${path}.layoutArchetype` });
    validateReferences(slide.evidence.sourceRefs, sourceIds, `${path}.evidence.sourceRefs`);
    validateReferences(slide.evidence.assetRefs, assetIds, `${path}.evidence.assetRefs`, "E_ASSET_REF");
    validateSlideSlots(slide.layoutArchetype, slide.slots, `${path}.slots`, sourceIds, assetIds);
    const claimRefs = collectClaimSourceRefs(slide.slots);
    for (const ref of claimRefs) {
      if (!slide.evidence.sourceRefs.includes(ref)) {
        fail("E_SOURCE_REF", `${path}.evidence.sourceRefs must include every claim-level source`, { path: `${path}.evidence.sourceRefs`, details: { sourceRef: ref } });
      }
    }
    if (slide.slots.assetId && !slide.evidence.assetRefs.includes(slide.slots.assetId)) {
      fail("E_ASSET_REF", `${path}.evidence.assetRefs must include its selected asset`, { path: `${path}.evidence.assetRefs` });
    }
  }
  const titleSet = new Set(slides.map((slide) => slide.title.trim()));
  const takeawaySet = new Set(slides.map((slide) => slide.takeaway.trim()));
  if (titleSet.size !== slides.length) fail("E_PLAN_SCHEMA", "Slide titles must be unique", { path: "$.slides" });
  if (takeawaySet.size !== slides.length) fail("E_PLAN_SCHEMA", "Each slide must have a unique takeaway", { path: "$.slides" });
  if (!slides.some((slide) => resolveLayoutArchetype(slide.layoutArchetype)?.legacyType === "closing")) {
    fail("E_NARRATIVE_ACTION", "A reviewed plan must include a closing/action archetype", { path: "$.slides" });
  }

  validateNarrative(plan, slideIds);
  const plannedSeconds = validatePagination(plan, slideIds);
  const approved = validateReview(plan, options);
  return {
    version: plan.version,
    deckId: deck.id,
    slideCount: slides.length,
    sourceCount: sources.length,
    assetCount: assets.length,
    plannedSeconds,
    briefSeconds: Math.round(brief.durationMinutes * 60),
    approved
  };
}

export function compilePlanForRender(plan) {
  const allApproved = REVIEW_STAGES.every((stage) => plan.review?.[stage]?.status === "approved");
  return {
    version: "1.0.0-internal",
    deck: structuredClone(plan.deck),
    positioning: {
      statement: plan.narrative.thesis,
      goal: plan.brief.scenario,
      audience: plan.brief.audience.description,
      scenario: plan.brief.scenario,
      coreConclusion: plan.narrative.thesis,
      desiredAction: plan.brief.desiredAction,
      deliveryMode: plan.brief.deliveryMode,
      durationMinutes: plan.brief.durationMinutes,
      targetSlideCount: plan.slides.length
    },
    assumptions: structuredClone(plan.assumptions),
    narrative: {
      framework: plan.narrative.framework,
      chapters: plan.narrative.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, slideIds: [...chapter.slideIds] }))
    },
    design: {
      themeId: plan.designIntent.themeId,
      tokenOverrides: structuredClone(plan.designIntent.tokenOverrides),
      policy: compileDesignPolicy(plan.designIntent)
    },
    sources: structuredClone(plan.sources),
    assets: plan.assets.map((asset) => ({
      id: asset.id,
      path: asset.selectedLocator,
      mime: asset.mime,
      rights: asset.rights.status,
      alt: asset.alt,
      objectFit: asset.objectFit ?? "contain",
      ...(asset.focalPoint ? { focalPoint: structuredClone(asset.focalPoint) } : {}),
      ...(asset.sourceRef ? { sourceRef: asset.sourceRef } : {})
    })),
    slides: plan.slides.map((slide) => {
      const archetype = resolveLayoutArchetype(slide.layoutArchetype);
      return {
        id: slide.id,
        order: slide.order,
        type: archetype.legacyType,
        layoutArchetype: archetype.id,
        title: slide.title,
        coreMessage: slide.takeaway,
        visual: slide.visualRole,
        transition: slide.transitionPurpose,
        notes: slide.speakerNotes,
        sourceRefs: [...slide.evidence.sourceRefs],
        content: structuredClone(slide.slots)
      };
    }),
    hostReview: {
      status: allApproved ? "approved" : "required",
      ...(allApproved ? { reviewedAt: REVIEW_STAGES.map((stage) => plan.review[stage].reviewedAt).sort().at(-1) } : {}),
      checks: {
        positioning: allApproved,
        sourceIntegrity: allApproved,
        narrative: allApproved,
        oneMessagePerSlide: allApproved,
        visualIntent: allApproved
      }
    }
  };
}

export async function validatePlanFile(planPath, options = {}) {
  const resolved = resolve(planPath);
  const plan = await readJson(resolved);
  const summary = await validatePlan(plan, { ...options, planDirectory: dirname(resolved) });
  return { plan, summary, planPath: resolved, planDirectory: dirname(resolved) };
}

function parseMarkdown(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let title = "";
  const sections = [];
  let current = { title: "内容", items: [] };
  const flush = () => {
    if (current.items.length > 0) sections.push(current);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!title && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (/^#{2,3}\s+/.test(line)) {
      flush();
      current = { title: line.replace(/^#{2,3}\s+/, "").trim(), items: [] };
      continue;
    }
    const item = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (item) current.items.push(item);
  }
  flush();
  if (!title) title = "待命名演示";
  if (sections.length === 0) sections.push({ title: "核心内容", items: ["[待确认] 请补充核心内容"] });
  return { title, sections };
}

function planId(value, fallback = "deck") {
  const candidate = slugify(value, fallback)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return candidate || fallback;
}

function draftReview(plan) {
  const artifactHashes = buildReviewArtifactHashes(plan);
  return Object.fromEntries(REVIEW_STAGES.map((stage) => [stage, { status: "required", artifactHashes }]));
}

export async function scaffoldPlanFromSource(inputPath) {
  const resolved = resolve(inputPath);
  const source = await readFile(resolved, "utf8");
  const { title, sections } = parseMarkdown(source);
  const deckId = planId(title);
  const sourceId = "source-input";
  const slides = [{
    id: "slide-cover",
    order: 1,
    intent: "cover",
    layoutArchetype: "cover",
    title,
    takeaway: title,
    focalPoint: "演示主题与受众范围",
    hierarchy: "title-first",
    visualRole: "克制的标题页",
    transitionPurpose: "建立主题",
    speakerNotes: "由 Host 补充开场。",
    evidence: { sourceRefs: [sourceId], assetRefs: [] },
    slots: { subtitle: "[待确认] 补充面向受众的副标题" }
  }];
  for (const section of sections) {
    const chunks = [];
    for (let index = 0; index < section.items.length; index += 3) chunks.push(section.items.slice(index, index + 3));
    for (const [chunkIndex, chunk] of chunks.entries()) {
      slides.push({
        id: `slide-${slides.length + 1}`,
        order: slides.length + 1,
        intent: "bullets",
        layoutArchetype: "bullets",
        title: chunkIndex === 0 ? section.title : `${section.title}（续）`,
        takeaway: chunkIndex === 0 ? section.title : `${section.title}的后续要点 ${chunkIndex + 1}`,
        focalPoint: "原文的三项以内支撑点",
        hierarchy: "evidence-first",
        visualRole: "编号支撑点",
        transitionPurpose: "承接原文顺序",
        speakerNotes: "脚手架仅保留原文结构；Host 必须重写为结论标题并核对一页一观点。",
        evidence: { sourceRefs: [sourceId], assetRefs: [] },
        slots: { points: chunk.map((text) => ({ text, factStatus: "provided", sourceRefs: [sourceId] })) }
      });
    }
  }
  slides.push({
    id: "slide-closing",
    order: slides.length + 1,
    intent: "closing",
    layoutArchetype: "closing",
    title: "下一步",
    takeaway: "[待确认] 明确希望受众采取的行动",
    focalPoint: "待确认的行动",
    hierarchy: "action-first",
    visualRole: "行动号召",
    transitionPurpose: "收束并行动",
    speakerNotes: "Host 必须替换占位行动。",
    evidence: { sourceRefs: [sourceId], assetRefs: [] },
    slots: { action: { text: "[待确认] 明确希望受众采取的行动", factStatus: "placeholder", sourceRefs: [] } }
  });
  for (const key of ["title", "takeaway"]) {
    const counts = new Map();
    for (const slide of slides) {
      const count = (counts.get(slide[key]) ?? 0) + 1;
      counts.set(slide[key], count);
      if (count > 1) slide[key] = `${slide[key]}（${count}）`;
    }
  }
  const plan = {
    version: PLAN_VERSION,
    deck: { id: deckId, title, language: "zh-CN", size: { width: 1280, height: 720, unit: "px" } },
    brief: {
      audience: { description: "待确认受众", familiarity: "mixed", decisionAuthority: "informed" },
      scenario: "待确认场景",
      device: "投影或桌面浏览器",
      deliveryMode: "现场演讲",
      durationMinutes: Math.max(5, slides.length * 2),
      desiredAction: "待确认行动",
      networkPolicy: "prefer",
      quietConstraints: ["待确认"],
      brandConstraints: ["待确认"],
      confidentiality: "internal",
      languageRegion: "zh-CN",
      accessibility: ["待确认无障碍要求"]
    },
    assumptions: [
      { id: "assumption-audience", text: "受众与使用场景尚未明确。", impact: "medium", status: "inferred" },
      { id: "assumption-delivery", text: "暂按现场演讲处理。", impact: "low", status: "inferred" }
    ],
    narrative: {
      framework: "保留原文顺序的待审脚手架",
      thesis: "[待确认] 将原文重组为面向受众的单一结论。",
      chapters: [{ id: "chapter-main", title: "原文结构", beatIds: ["beat-main"], slideIds: slides.map((slide) => slide.id) }],
      beats: [{ id: "beat-main", role: "context", text: "待确认原文叙事结构。", slideIds: slides.map((slide) => slide.id) }],
      titleChain: slides.map((slide) => slide.title),
      attentionCurve: slides.map((slide, index) => ({ slideId: slide.id, level: index === slides.length - 1 ? 5 : 3 }))
    },
    designIntent: {
      proposition: "清晰、有边界、可执行",
      counterProposition: "不以装饰掩盖未确认事实",
      mood: ["克制", "清晰"],
      referenceSignals: [],
      themeId: "legacy-default",
      compositionDiversity: "medium",
      motionIntensity: "subtle",
      informationDensity: "balanced",
      imageryStrategy: "仅使用已批准且本地化的素材",
      allowedTechniques: ["结构化排版", "明确来源标签"],
      forbiddenTechniques: ["未署名的素材", "整页栅格替代"],
      tokenOverrides: {},
      lock: {}
    },
    pagination: {
      pageBudgets: slides.map((slide) => ({
        slideId: slide.id,
        maxWords: 180,
        maxPrimarySupports: Math.max(3, primarySupportCount(slide)),
        timeSeconds: Math.max(30, Math.round((Math.max(5, slides.length * 2) * 60) / slides.length)),
        mustKeepTogether: [],
        canSplit: false,
        notesOnly: []
      }))
    },
    sources: [{
      id: sourceId,
      kind: extname(resolved).toLowerCase() === ".md" ? "file" : "user-input",
      label: basename(resolved),
      locator: basename(resolved),
      sha256: await sha256File(resolved),
      factStatus: "provided"
    }],
    assets: [],
    slides,
    review: {}
  };
  plan.designIntent.lock = buildDesignLock(plan);
  plan.review = draftReview(plan);
  return plan;
}
