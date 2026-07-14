import { createHash } from "node:crypto";
import JSZip from "jszip";
import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { validateJsonSchema } from "./schema-utils.mjs";
import { INITIAL_COMPOSITION_BLOCK_IDS } from "./composition-blocks.mjs";

const REQUEST_SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/creative-direction-request.schema.json", import.meta.url),
  "utf8"
));
const CANDIDATES_SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/creative-candidates.schema.json", import.meta.url),
  "utf8"
));
const SELECTION_SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/creative-selection.schema.json", import.meta.url),
  "utf8"
));

export const MATERIAL_AXES = Object.freeze([
  "layout-topology",
  "hierarchy",
  "typography",
  "density",
  "color-material",
  "asset-strategy",
  "diagram-strategy",
  "deck-rhythm"
]);

const MATERIAL_AXIS_SET = new Set(MATERIAL_AXES);
const COMPLEX_FAMILIES = new Set(["architecture", "process", "dashboard", "matrix"]);
const VISUAL_ASSET_KINDS = new Set(["photo", "illustration", "icon", "logo", "texture"]);
const REMOTE_OR_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function contentHash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function planContentHash(plan) {
  return contentHash(plan);
}

export function candidateBudget(profile) {
  if (profile === "standard") return 1;
  if (profile === "premium") return 3;
  if (profile === "flagship") return 4;
  throw new Error(`unknown quality profile: ${String(profile)}`);
}

export function shouldExploreDirections(plan) {
  const profile = plan?.context?.qualityProfile;
  const maxCandidates = candidateBudget(profile);
  const visualAssets = (plan?.assets ?? []).filter((asset) => VISUAL_ASSET_KINDS.has(asset?.kind)).length;
  const complexSlides = (plan?.slides ?? []).filter((slide) => COMPLEX_FAMILIES.has(slide?.contentModel?.kind)).length;
  const signals = {
    visualAmbition: Number(plan?.context?.visualAmbition) >= 80,
    compositionVariance: Number(plan?.designIntent?.dials?.compositionVariance) >= 75,
    brand: (plan?.context?.brand?.references ?? []).length > 0 || plan?.designIntent?.locks?.brandLocked === true,
    assetIntensity: Number(plan?.context?.assetIntensity) >= 60 || visualAssets >= 2,
    complexSlides: complexSlides >= 3
  };
  const reasonBySignal = {
    visualAmbition: "visual-ambition",
    compositionVariance: "composition-variance",
    brand: "brand-importance",
    assetIntensity: "asset-intensity",
    complexSlides: "complex-slide-count"
  };
  const activeReasons = Object.entries(signals)
    .filter(([, active]) => active)
    .map(([name]) => reasonBySignal[name]);
  const activeCount = activeReasons.length;
  if (profile === "standard") return { explore: false, reasons: activeReasons, signals, maxCandidates };
  if (profile === "flagship") return { explore: true, reasons: ["flagship-profile", ...activeReasons], signals, maxCandidates };
  return { explore: activeCount >= 2, reasons: activeReasons, signals, maxCandidates };
}

function semanticItemCount(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + semanticItemCount(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + semanticItemCount(item), 0);
  return value === null || value === undefined ? 0 : 1;
}

function slideComplexity(slide, assetsById) {
  const kind = slide?.contentModel?.kind;
  const data = slide?.contentModel?.data ?? {};
  const metricWeight = Array.isArray(data.metrics) ? data.metrics.length * 3 : 0;
  const diagramWeight = Array.isArray(data.layers) ? data.layers.length * 2
    : Array.isArray(data.steps) ? data.steps.length * 2
      : Array.isArray(data.quadrants) ? data.quadrants.length * 2 : 0;
  const referencedVisuals = (slide?.assetIds ?? []).filter((id) => VISUAL_ASSET_KINDS.has(assetsById.get(id)?.kind)).length;
  const contentWeight = semanticItemCount(data);
  const familyWeight = COMPLEX_FAMILIES.has(kind) ? 8 : 0;
  return metricWeight + diagramWeight + (referencedVisuals * 4) + contentWeight + familyWeight;
}

export function selectProbeSlides(plan) {
  const slides = plan?.slides ?? [];
  if (slides.length <= 2) return slides.map((slide) => slide.id);
  const cover = slides.find((slide) => slide.pageRole === "cover") ?? slides[0];
  const content = slides.filter((slide) => slide.id !== cover.id && slide.pageRole !== "closing");
  const familyCounts = new Map();
  for (const slide of content) {
    const family = slide?.contentModel?.kind ?? "unknown";
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }
  let modalFamily = null;
  let modalCount = -1;
  for (const slide of content) {
    const family = slide?.contentModel?.kind ?? "unknown";
    const count = familyCounts.get(family) ?? 0;
    if (count > modalCount) {
      modalFamily = family;
      modalCount = count;
    }
  }
  const representative = content.find((slide) => slide?.contentModel?.kind === modalFamily) ?? content[0];
  const selected = [cover, representative].filter(Boolean);
  const selectedIds = new Set(selected.map((slide) => slide.id));
  const assetsById = new Map((plan?.assets ?? []).map((asset) => [asset.id, asset]));
  let complex = null;
  let complexScore = -Infinity;
  for (const slide of slides) {
    if (selectedIds.has(slide.id)) continue;
    const score = slideComplexity(slide, assetsById);
    if (score > complexScore) {
      complex = slide;
      complexScore = score;
    }
  }
  if (complex) selected.push(complex);
  return selected.slice(0, 3).map((slide) => slide.id);
}

function semanticProbeSlide(slide) {
  return {
    id: slide.id,
    pageRole: slide.pageRole,
    message: slide.message,
    contentModel: structuredClone(slide.contentModel),
    attentionTarget: structuredClone(slide.attentionTarget),
    assetIds: [...(slide.assetIds ?? [])],
    routePolicy: structuredClone(slide.routePolicy)
  };
}

export function probeSemanticContentHash(plan, probeSlideIds) {
  const slides = new Map((plan?.slides ?? []).map((slide) => [slide.id, slide]));
  const selected = probeSlideIds.map((id) => {
    const slide = slides.get(id);
    if (!slide) throw new Error(`probe references unknown slide ${id}`);
    return semanticProbeSlide(slide);
  });
  return contentHash(selected);
}

export function filterProbeManifest(manifest, probeSlideIds) {
  if (new Set(probeSlideIds).size !== probeSlideIds.length || probeSlideIds.length < 1 || probeSlideIds.length > 3) {
    throw new Error("probe slide IDs must contain one to three unique values");
  }
  const slides = new Map((manifest?.slides ?? []).map((slide) => [slide.id, slide]));
  const selected = probeSlideIds.map((id) => {
    const slide = slides.get(id);
    if (!slide) throw new Error(`probe manifest is missing slide ${id}`);
    return structuredClone(slide);
  });
  return { ...structuredClone(manifest), slides: selected };
}

function elementSignature(element) {
  return {
    type: element?.type,
    role: element?.role ?? null,
    fontFamily: element?.fontFamily ?? element?.style?.fontFamily ?? null,
    fontSize: element?.fontSize ?? element?.style?.fontSize ?? null,
    fill: element?.fill ?? element?.style?.fill ?? null,
    color: element?.color ?? element?.style?.color ?? null,
    assetId: element?.assetId ?? null
  };
}

export function materializedCandidateSignature({ plan, ir, manifest, designSystemName }) {
  const irSlides = new Map((ir?.slides ?? []).map((slide) => [slide.id, slide]));
  const manifestSlides = manifest?.slides ?? [];
  const topology = manifestSlides.map((slide) => ({
    slideId: slide.id,
    blockId: irSlides.get(slide.id)?.composition?.resolvedBlockId
      ?? irSlides.get(slide.id)?.compositionIntent?.blockId
      ?? plan?.slides?.find((entry) => entry.id === slide.id)?.compositionIntent?.blockId
      ?? null,
    strategy: plan?.slides?.find((entry) => entry.id === slide.id)?.compositionIntent?.strategy ?? null,
    elementTypes: (slide.elements ?? []).map((element) => element.type)
  }));
  const elements = manifestSlides.flatMap((slide) => (slide.elements ?? []).map(elementSignature));
  const text = elements.filter((element) => element.type === "text");
  const visuals = elements.filter((element) => ["image", "icon", "chart", "diagram"].includes(element.type));
  return {
    "layout-topology": contentHash(topology),
    hierarchy: contentHash(text.map((element) => ({ role: element.role, fontSize: element.fontSize }))),
    typography: contentHash({ designSystemName, fonts: text.map((element) => element.fontFamily) }),
    density: contentHash({ dial: plan?.designIntent?.dials?.visualDensity, counts: manifestSlides.map((slide) => slide.elements?.length ?? 0) }),
    "color-material": contentHash({ designSystemName, material: plan?.designIntent?.material, palette: plan?.designIntent?.palette, colors: elements.map((element) => [element.fill, element.color]) }),
    "asset-strategy": contentHash({ intensity: plan?.context?.assetIntensity, visuals: visuals.map((element) => [element.type, element.assetId]) }),
    "diagram-strategy": contentHash(manifestSlides.map((slide) => (slide.elements ?? []).filter((element) => ["chart", "diagram"].includes(element.type)).map((element) => element.type))),
    "deck-rhythm": contentHash(topology.map((entry) => [entry.blockId, entry.strategy, entry.elementTypes.length]))
  };
}

export const DIAGNOSTIC_WEIGHTS = Object.freeze({
  narrative: 15,
  hierarchy: 15,
  "composition-whitespace": 12,
  typography: 10,
  "color-material": 8,
  "deck-rhythm": 10,
  consistency: 8,
  "asset-specificity": 8,
  "data-diagram-readability": 6,
  "brand-distinctiveness": 8
});

function average(values, fallback = 0) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : fallback;
}

export function buildDiagnosticEvidence({ manifest, review }) {
  const slides = review?.slides ?? [];
  const score = (key, fallback) => Math.round(average(slides.map((slide) => slide?.scores?.[key]), fallback));
  const dimensions = {
    narrative: Math.round(Number(review?.deckScore ?? 0)),
    hierarchy: score("hierarchy", 0),
    "composition-whitespace": Math.round(average([score("alignment", 0), score("variety", 0)])),
    typography: score("designSystemFit", 0),
    "color-material": score("contrast", 0),
    "deck-rhythm": score("variety", 0),
    consistency: score("designSystemFit", 0),
    "asset-specificity": Math.min(100, 60 + ((manifest?.assets ?? []).length * 8)),
    "data-diagram-readability": Math.round(average([score("density", 0), score("compatibility", 0)])),
    "brand-distinctiveness": Math.round(average([score("designSystemFit", 0), score("variety", 0)]))
  };
  const weightedScore = Math.round(Object.entries(DIAGNOSTIC_WEIGHTS)
    .reduce((sum, [name, weight]) => sum + (Number(dimensions[name] ?? 0) * weight), 0) / 100);
  return {
    weights: { ...DIAGNOSTIC_WEIGHTS },
    dimensions,
    weightedScore,
    slopRisk: Math.round(Number(review?.slopRisk ?? 100))
  };
}

function requireBuffer(value, label) {
  if (!Buffer.isBuffer(value) || value.length === 0) throw new Error(`${label} must be non-empty rendered bytes`);
  return value;
}

/**
 * Deterministically assembles candidates from materialized artifacts. The
 * callback may produce artifacts, but it cannot provide trusted hashes,
 * signatures, diagnostics, or editability claims: all of those are derived
 * here from returned bytes and reports.
 */
export async function prepareBlindExploration({ plan, baseIr, request, materializeCandidate, trigger = shouldExploreDirections(plan) }) {
  if (!trigger.explore) throw new Error("creative direction exploration is not eligible for this plan");
  const requestValidation = validateCreativeDirectionRequest(request, { plan, maxCandidates: trigger.maxCandidates });
  if (!requestValidation.valid) throw new Error(`creative direction request invalid: ${requestValidation.errors.join("; ")}`);
  if (typeof materializeCandidate !== "function") throw new TypeError("materializeCandidate callback is required");
  const baseIrHash = contentHash(baseIr);
  const probeSlideIds = selectProbeSlides(plan);
  const probeContentHash = probeSemanticContentHash(plan, probeSlideIds);
  const explorationId = deriveExplorationId(baseIrHash, request);
  const candidates = [];
  const screenshotBytesByCandidate = new Map();
  for (const direction of request.directions) {
    const projectedPlan = applyCreativeDirection(plan, direction);
    const materialized = await materializeCandidate({
      direction: structuredClone(direction),
      projectedPlan: structuredClone(projectedPlan),
      probeSlideIds: [...probeSlideIds],
      baseIrHash,
      probeContentHash,
      explorationId
    });
    if (!materialized?.ir || !materialized?.manifest || !materialized?.probeManifest) {
      throw new Error(`candidate ${direction.id} did not return IR and full/probe manifests`);
    }
    const expectedProbe = filterProbeManifest(materialized.manifest, probeSlideIds);
    if (!deepEqual(expectedProbe, materialized.probeManifest)) {
      throw new Error(`candidate ${direction.id} probe manifest does not match the selected full-manifest slides`);
    }
    if (materialized.proof?.acceptance?.status !== "evidence-ready" || materialized.proof?.accepted !== false || materialized.quality?.gate?.passed !== true) {
      throw new Error(`candidate ${direction.id} did not pass independent render/proof gates`);
    }
    const editabilityLevel = Number(materialized.quality?.editabilityLevel ?? materialized.proof?.quality?.editabilityLevel);
    const probePptxBytes = requireBuffer(materialized.probePptxBytes, `candidate ${direction.id} probe PPTX`);
    const screenshots = (materialized.screenshots ?? []).map((entry, index) => {
      const bytes = requireBuffer(entry?.bytes, `candidate ${direction.id} screenshot ${index + 1}`);
      return { hash: contentHashBytes(bytes) };
    });
    if (screenshots.length === 0) throw new Error(`candidate ${direction.id} requires rendered screenshot evidence`);
    screenshotBytesByCandidate.set(direction.id, (materialized.screenshots ?? []).map((entry) => Buffer.from(entry.bytes)));
    const observed = materializedCandidateSignature({
      plan: projectedPlan,
      ir: materialized.ir,
      manifest: materialized.manifest,
      designSystemName: materialized.designSystemName
    });
    const diagnostic = buildDiagnosticEvidence({ manifest: materialized.probeManifest, review: materialized.review });
    candidates.push({
      id: direction.id,
      label: direction.label,
      rationale: direction.rationale,
      direction: structuredClone(direction),
      declaredAxes: [...direction.declaredAxes],
      observed,
      baseIrHash,
      fullIrHash: contentHash(materialized.ir),
      probeContentHash,
      artifacts: {
        probeManifestHash: contentHash(materialized.probeManifest),
        probePptxHash: await stablePptxContentHash(probePptxBytes),
        screenshotHashes: screenshots.map((entry) => entry.hash)
      },
      editabilityLevel,
      route: "native",
      status: "available",
      diagnostic,
      renderingEnvironment: structuredClone(materialized.renderingEnvironment),
      screenshots
    });
  }
  const differences = validateSubstantiveDifferences(candidates, { editabilityFloor: plan.context.editabilityFloor });
  if (!differences.valid) throw new Error(`creative candidates are not substantively different: ${differences.errors.join("; ")}`);
  const environments = candidates.map((candidate) => candidate.renderingEnvironment).filter(Boolean);
  if (environments.length !== candidates.length || environments.some((value) => !deepEqual(value, environments[0]))) {
    throw new Error("creative candidates must share one verified rendering environment");
  }
  const packet = buildBlindPacket({
    explorationId,
    probeSlideIds,
    candidates,
    renderingEnvironment: environments[0]
  });
  return {
    explorationId,
    baseIrHash,
    probeSlideIds,
    probeContentHash,
    trigger: structuredClone(trigger),
    candidates,
    differences: differences.evidence,
    packet,
    screenshotBytesByCandidate
  };
}

export function contentHashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function stablePptxContentHash(bytes) {
  try {
    const archive = await JSZip.loadAsync(bytes);
    const digest = createHash("sha256");
    for (const name of Object.keys(archive.files).filter((entry) => !archive.files[entry].dir).sort()) {
      let payload = await archive.files[name].async("nodebuffer");
      if (name === "docProps/core.xml") {
        payload = Buffer.from(payload.toString("utf8").replace(
          /(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
          "$1TIMESTAMP-NORMALIZED$2"
        ), "utf8");
      }
      digest.update(Buffer.from(name, "utf8"));
      digest.update(Buffer.from([0]));
      digest.update(payload);
      digest.update(Buffer.from([0]));
    }
    return `sha256:${digest.digest("hex")}`;
  } catch {
    return contentHashBytes(bytes);
  }
}

function schemaResult(value, schema, label) {
  const result = validateJsonSchema(value, schema);
  return {
    valid: result.valid,
    errors: result.errors.map((entry) => `${label} ${entry.path}: ${entry.message}`)
  };
}

export function validateCandidateSetDocument(value) {
  const structural = schemaResult(value, CANDIDATES_SCHEMA, "creative candidates");
  const errors = [...structural.errors];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const unsigned = structuredClone(value);
    delete unsigned.candidateSetHash;
    if (value.candidateSetHash !== contentHash(unsigned)) errors.push("creative candidates candidateSetHash does not match canonical content");
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    if (!unique(candidates.map((candidate) => candidate?.id))) errors.push("creative candidate IDs must be unique");
    const candidateById = new Map(candidates.map((candidate) => [candidate?.id, candidate]));
    for (const candidate of candidates) {
      if (candidate?.direction?.id !== candidate?.id) errors.push(`creative candidate ${candidate?.id ?? "unknown"} direction ID is inconsistent`);
      if (!deepEqual(candidate?.direction?.declaredAxes, candidate?.declaredAxes)) errors.push(`creative candidate ${candidate?.id ?? "unknown"} declared axes are inconsistent`);
      if (candidate?.baseIrHash !== value.baseIrHash) errors.push(`creative candidate ${candidate?.id ?? "unknown"} baseIrHash is inconsistent`);
      if (candidate?.probeContentHash !== value.probeContentHash) errors.push(`creative candidate ${candidate?.id ?? "unknown"} probeContentHash is inconsistent`);
      if (candidate?.artifacts?.blindScreenshots?.length !== candidate?.artifacts?.screenshotHashes?.length) {
        errors.push(`creative candidate ${candidate?.id ?? "unknown"} screenshot paths and hashes are inconsistent`);
      }
    }
    const expectedPairKeys = new Set();
    const candidateIds = candidates.map((candidate) => candidate?.id);
    for (let left = 0; left < candidateIds.length; left += 1) {
      for (let right = left + 1; right < candidateIds.length; right += 1) expectedPairKeys.add(pairKey(candidateIds[left], candidateIds[right]));
    }
    const seenPairKeys = new Set();
    const observedSpannedAxes = new Set();
    for (const pair of value.differenceEvidence?.pairs ?? []) {
      const key = pairKey(pair?.left, pair?.right);
      if (!expectedPairKeys.has(key) || seenPairKeys.has(key)) errors.push("creative candidate difference pairs are incomplete or duplicated");
      seenPairKeys.add(key);
      const left = candidateById.get(pair?.left);
      const right = candidateById.get(pair?.right);
      const observedAxes = MATERIAL_AXES.filter((axis) => !deepEqual(left?.observed?.[axis], right?.observed?.[axis]));
      if (!isDeepSetEqual(pair?.axes ?? [], observedAxes)) errors.push(`creative candidate difference axes are stale for ${pair?.left}/${pair?.right}`);
      for (const axis of observedAxes) observedSpannedAxes.add(axis);
    }
    if (!isDeepSetEqual([...seenPairKeys], [...expectedPairKeys])) errors.push("creative candidate difference evidence does not cover every pair");
    if (!isDeepSetEqual(value.differenceEvidence?.spannedAxes ?? [], [...observedSpannedAxes])) {
      errors.push("creative candidate spanned axes are stale");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateCreativeSelectionDocument(value, { candidateSet = null, packet = null } = {}) {
  const structural = schemaResult(value, SELECTION_SCHEMA, "creative selection");
  const errors = [...structural.errors];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.reveal?.[value.selectedBlindId] !== value.selectedCandidateId) errors.push("creative selection winner does not match reveal mapping");
    if (candidateSet) {
      if (value.candidateSetHash !== candidateSet.candidateSetHash) errors.push("creative selection candidateSetHash is stale");
      if (!(candidateSet.candidates ?? []).some((candidate) => candidate.id === value.selectedCandidateId)) errors.push("creative selection winner is absent from candidate set");
      if (!isDeepSetEqual(Object.values(value.reveal ?? {}), (candidateSet.candidates ?? []).map((candidate) => candidate.id))) {
        errors.push("creative selection reveal mapping does not cover the candidate set");
      }
    }
    if (packet) {
      if (value.packetHash !== packet.packetHash) errors.push("creative selection packetHash is stale");
      if (value.explorationId !== packet.explorationId) errors.push("creative selection explorationId is stale");
      if (!isDeepSetEqual(Object.keys(value.reveal ?? {}), packet.blindIds ?? [])) errors.push("creative selection reveal mapping does not cover the blind packet");
      if (!isDeepSetEqual(Object.keys(value.diagnosticEvidence ?? {}), packet.blindIds ?? [])) errors.push("creative selection diagnostics do not cover the blind packet");
      if (!deepEqual(value.pairwise, value.hostReview?.pairs)) errors.push("creative selection pairwise evidence is inconsistent with Host review");
      const hostValidation = validateHostReview(packet, value.hostReview);
      if (!hostValidation.valid) errors.push(...hostValidation.errors.map((error) => `creative selection ${error}`));
    }
  }
  return { valid: errors.length === 0, errors };
}

function isDeepSetEqual(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function localDesignReference(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && !REMOTE_OR_SCHEME.test(value) && !value.startsWith("//") && !isAbsolute(value)
    && !value.includes("\\") && !value.split("/").includes("..");
}

function unique(values) {
  return new Set(values).size === values.length;
}

export function validateCreativeDirectionRequest(request, {
  plan,
  maxCandidates = candidateBudget(plan?.context?.qualityProfile),
  lockedDesignSystem = null
} = {}) {
  const structural = validateJsonSchema(request, REQUEST_SCHEMA);
  const errors = structural.errors.map((entry) => `${entry.path}: ${entry.message}`);
  if (!request || typeof request !== "object" || Array.isArray(request)) return { valid: false, errors };
  if (request.planHash !== planContentHash(plan)) errors.push("planHash does not match the validated plan");
  const directions = Array.isArray(request.directions) ? request.directions : [];
  if (directions.length < 2) errors.push("direction request requires at least two Host directions");
  if (directions.length > maxCandidates) errors.push(`direction count exceeds profile cap of at most ${maxCandidates}`);
  if (!unique(directions.map((entry) => entry?.id))) errors.push("direction IDs must be unique");
  const slideIds = new Set((plan?.slides ?? []).map((slide) => slide.id));
  const blockIds = new Set(INITIAL_COMPOSITION_BLOCK_IDS);
  const designSystems = new Set(directions.map((direction) => direction?.projection?.designSystem).filter(Boolean));
  if (plan?.designIntent?.locks?.sourceLocked || plan?.designIntent?.locks?.brandLocked) {
    if (lockedDesignSystem && [...designSystems].some((value) => value !== lockedDesignSystem)) {
      errors.push(`design-system projection violates the locked design system ${lockedDesignSystem}`);
    } else if (!lockedDesignSystem && designSystems.size > 1) {
      errors.push("locked plan directions must share one design system");
    }
  }
  for (const direction of directions) {
    const axes = direction?.declaredAxes ?? [];
    if (!unique(axes)) errors.push(`direction ${direction?.id ?? "unknown"} declaredAxes must be unique`);
    for (const axis of axes) if (!MATERIAL_AXIS_SET.has(axis)) errors.push(`direction ${direction?.id ?? "unknown"} declares unknown axis ${axis}`);
    const projection = direction?.projection ?? {};
    if (!localDesignReference(projection.designSystem)) errors.push(`direction ${direction?.id ?? "unknown"} designSystem must be local or built-in`);
    if (projection.route && projection.route !== "native") errors.push(`direction ${direction?.id ?? "unknown"} canonical route must remain native`);
    for (const dial of Object.keys(projection.dials ?? {})) {
      if (protectedDial(plan, dial)) errors.push(`direction ${direction?.id ?? "unknown"} changes protected dial ${dial}`);
    }
    const projectedSlideIds = (projection.slides ?? []).map((slide) => slide.slideId);
    if (!unique(projectedSlideIds)) errors.push(`direction ${direction?.id ?? "unknown"} slide overrides must be unique`);
    for (const slide of projection.slides ?? []) {
      if (!slideIds.has(slide.slideId)) errors.push(`direction ${direction?.id ?? "unknown"} references unknown slide ${slide.slideId}`);
      if (!blockIds.has(slide.blockId)) errors.push(`direction ${direction?.id ?? "unknown"} references unknown composition block ${slide.blockId}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function protectedDial(plan, dial) {
  const protectedTokens = plan?.designIntent?.locks?.protectedTokens ?? [];
  return protectedTokens.includes(`designIntent.dials.${dial}`)
    || protectedTokens.includes(`dials.${dial}`)
    || protectedTokens.includes(dial);
}

export function applyCreativeDirection(plan, direction) {
  if (!plan || !direction) throw new TypeError("plan and direction are required");
  const projected = structuredClone(plan);
  const projection = direction.projection ?? {};
  for (const [dial, value] of Object.entries(projection.dials ?? {})) {
    if (protectedDial(plan, dial)) throw new Error(`design dial ${dial} is locked by protectedTokens`);
    projected.designIntent.dials[dial] = value;
  }
  const slides = new Map(projected.slides.map((slide) => [slide.id, slide]));
  for (const override of projection.slides ?? []) {
    const slide = slides.get(override.slideId);
    if (!slide) throw new Error(`direction references unknown slide ${override.slideId}`);
    slide.compositionIntent.blockId = override.blockId;
  }
  return projected;
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateSubstantiveDifferences(candidates, { editabilityFloor = 4 } = {}) {
  const errors = [];
  const values = Array.isArray(candidates) ? candidates : [];
  if (values.length < 2) errors.push("at least two materialized candidates are required");
  if (!unique(values.map((entry) => entry?.id))) errors.push("candidate IDs must be unique");
  const baseHashes = new Set(values.map((entry) => entry?.baseIrHash));
  const probeHashes = new Set(values.map((entry) => entry?.probeContentHash));
  if (baseHashes.size > 1) errors.push("all candidates must share the same base IR hash");
  if (probeHashes.size > 1) errors.push("all candidates must share the same probe semantic content hash");
  for (const candidate of values) {
    if (candidate?.route !== "native") errors.push(`candidate ${candidate?.id ?? "unknown"} must remain native-first and cannot be raster-only`);
    if (!Number.isInteger(candidate?.editabilityLevel) || candidate.editabilityLevel < editabilityFloor) {
      errors.push(`candidate ${candidate?.id ?? "unknown"} is below editability floor ${editabilityFloor}`);
    }
    for (const axis of candidate?.declaredAxes ?? []) {
      if (!MATERIAL_AXIS_SET.has(axis)) {
        errors.push(`candidate ${candidate?.id ?? "unknown"} declares unknown material axis ${axis}`);
        continue;
      }
      const materialized = values.some((other) => other !== candidate
        && !deepEqual(candidate?.observed?.[axis], other?.observed?.[axis]));
      if (!materialized) errors.push(`candidate ${candidate?.id ?? "unknown"} declared axis ${axis} did not materialize`);
    }
  }
  const pairs = [];
  const spannedAxes = new Set();
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
      const left = values[leftIndex];
      const right = values[rightIndex];
      const axes = MATERIAL_AXES.filter((axis) => !deepEqual(left?.observed?.[axis], right?.observed?.[axis]));
      for (const axis of axes) spannedAxes.add(axis);
      pairs.push({ left: left?.id, right: right?.id, axes });
      if (axes.length < 2) errors.push(`candidate pair ${left?.id}/${right?.id} differs on fewer than two observed material axes`);
    }
  }
  if (values.length > 2 && spannedAxes.size < 3) errors.push("candidate set larger than two must span at least three observed material axes");
  return { valid: errors.length === 0, errors, evidence: { pairs, spannedAxes: [...spannedAxes] } };
}

export function deriveExplorationId(baseIrHash, directionRequest) {
  if (!HASH_PATTERN.test(String(baseIrHash))) throw new Error("base IR hash must be a full sha256 digest");
  return `explore-${contentHash({ baseIrHash, directionRequest }).slice("sha256:".length, "sha256:".length + 24)}`;
}

export function candidateSetHash(candidates) {
  return contentHash(candidates);
}

export function buildCreativeCandidateSet(exploration) {
  const packet = exploration.packet;
  const reveal = revealMapping(packet, { candidates: exploration.candidates });
  const blindByCandidate = new Map(Object.entries(reveal).map(([blindId, candidateId]) => [candidateId, blindId]));
  const packetCandidateById = new Map((packet.candidates ?? []).map((entry) => [entry.blindId, entry]));
  const candidates = exploration.candidates.map((candidate) => {
    const blindId = blindByCandidate.get(candidate.id);
    const publicBlind = packetCandidateById.get(blindId);
    return {
      id: candidate.id,
      label: candidate.label,
      rationale: candidate.rationale,
      direction: structuredClone(candidate.direction),
      declaredAxes: [...candidate.declaredAxes],
      observed: structuredClone(candidate.observed),
      baseIrHash: candidate.baseIrHash,
      fullIrHash: candidate.fullIrHash,
      probeContentHash: candidate.probeContentHash,
      artifacts: {
        blindScreenshots: (publicBlind?.screenshots ?? []).map((entry) => entry.path),
        probeManifestHash: candidate.artifacts.probeManifestHash,
        probePptxHash: candidate.artifacts.probePptxHash,
        screenshotHashes: [...candidate.artifacts.screenshotHashes]
      },
      diagnostic: structuredClone(candidate.diagnostic),
      editabilityLevel: candidate.editabilityLevel,
      route: candidate.route,
      status: candidate.status
    };
  });
  const unsigned = {
    version: "0.1.0",
    explorationId: exploration.explorationId,
    baseIrHash: exploration.baseIrHash,
    probeSlideIds: [...exploration.probeSlideIds],
    probeContentHash: exploration.probeContentHash,
    trigger: structuredClone(exploration.trigger),
    blindPacketHash: packet.packetHash,
    differenceEvidence: structuredClone(exploration.differences),
    candidates
  };
  const document = { ...unsigned, candidateSetHash: contentHash(unsigned) };
  const validation = validateCandidateSetDocument(document);
  if (!validation.valid) throw new Error(`creative candidate set invalid: ${validation.errors.join("; ")}`);
  return document;
}

function candidateOrder(explorationId, candidates) {
  return [...candidates].sort((left, right) => {
    const leftHash = contentHash({ explorationId, candidateId: left.id });
    const rightHash = contentHash({ explorationId, candidateId: right.id });
    return leftHash.localeCompare(rightHash) || String(left.id).localeCompare(String(right.id));
  });
}

export function buildRequiredBlindPairs(blindIds) {
  const pairs = [];
  for (let left = 0; left < blindIds.length; left += 1) {
    for (let right = left + 1; right < blindIds.length; right += 1) pairs.push([blindIds[left], blindIds[right]]);
  }
  return pairs;
}

export function buildBlindPacket({ explorationId, probeSlideIds, candidates, renderingEnvironment }) {
  const ordered = candidateOrder(explorationId, candidates ?? []);
  const reveal = {};
  const publicCandidates = ordered.map((candidate, index) => {
    const blindId = `blind-${String(index + 1).padStart(2, "0")}`;
    reveal[blindId] = candidate.id;
    return {
      blindId,
      screenshots: (candidate.screenshots ?? []).map((screenshot, screenshotIndex) => ({
        path: `creative-direction-blind/${blindId}/${String(screenshotIndex + 1).padStart(2, "0")}.png`,
        hash: screenshot.hash
      }))
    };
  });
  const blindIds = publicCandidates.map((entry) => entry.blindId);
  const unsigned = {
    version: "0.1.0",
    explorationId,
    probeSlideIds: [...probeSlideIds],
    blindIds,
    candidates: publicCandidates,
    requiredPairs: buildRequiredBlindPairs(blindIds),
    renderingEnvironment: structuredClone(renderingEnvironment)
  };
  const packet = { ...unsigned, packetHash: contentHash(unsigned) };
  Object.defineProperty(packet, "_privateReveal", { value: Object.freeze(reveal), enumerable: false });
  Object.defineProperty(packet, "_privateForbiddenTokens", {
    value: Object.freeze([...new Set((candidates ?? []).flatMap((candidate) => [
      candidate.id,
      candidate.label,
      candidate.direction?.projection?.designSystem
    ]).filter((value) => typeof value === "string" && value.trim().length > 0))]),
    enumerable: false
  });
  return packet;
}

function blindScreenshotHash(packet, blindId) {
  const entry = packet?.candidates?.find((candidate) => candidate.blindId === blindId);
  return entry?.screenshots?.[0]?.hash ?? null;
}

function pairKey(left, right) {
  return [left, right].sort().join("\u0000");
}

export function validateHostReview(packet, review) {
  const errors = [];
  const allowedRoot = new Set(["version", "explorationId", "packetHash", "available", "pairs", "adjudication"]);
  const allowedPair = new Set(["left", "right", "leftScreenshotHash", "rightScreenshotHash", "preference", "reason"]);
  if (!review || typeof review !== "object" || Array.isArray(review)) return { valid: false, errors: ["Host review must be an object"] };
  for (const key of Object.keys(review)) if (!allowedRoot.has(key)) errors.push(`Host review contains forbidden field ${key}`);
  const reviewText = [
    ...(review.pairs ?? []).map((pair) => pair?.reason),
    review.adjudication?.reason
  ].filter((value) => typeof value === "string").join("\n").toLowerCase();
  for (const token of packet?._privateForbiddenTokens ?? []) {
    const normalized = String(token).trim().toLowerCase();
    if (normalized.length < 4) continue;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(reviewText)) {
      errors.push("Host review leaks a private candidate identifier, label, or design-system name");
    }
  }
  if (/weightedscore|sloprisk/.test(reviewText)) errors.push("Host review leaks deterministic score fields");
  if (review.version !== "0.1.0") errors.push("Host review version must be 0.1.0");
  if (review.explorationId !== packet?.explorationId) errors.push("Host review explorationId is stale");
  if (review.packetHash !== packet?.packetHash) errors.push("Host review packetHash is stale");
  if (review.available !== true) errors.push("Host visual review is unavailable");
  const blindIds = new Set(packet?.blindIds ?? []);
  const required = new Set((packet?.requiredPairs ?? []).map(([left, right]) => pairKey(left, right)));
  const seen = new Set();
  for (const pair of review.pairs ?? []) {
    for (const key of Object.keys(pair ?? {})) if (!allowedPair.has(key)) errors.push(`Host pair contains forbidden field ${key}`);
    if (!blindIds.has(pair?.left) || !blindIds.has(pair?.right) || pair?.left === pair?.right) errors.push("Host pair must reference two distinct blind IDs");
    const key = pairKey(pair?.left, pair?.right);
    if (!required.has(key)) errors.push(`Host pair ${pair?.left}/${pair?.right} is not required`);
    if (seen.has(key)) errors.push(`Host pair ${pair?.left}/${pair?.right} is duplicated`);
    seen.add(key);
    if (!["left", "right", "tie"].includes(pair?.preference)) errors.push(`Host pair ${pair?.left}/${pair?.right} has invalid preference`);
    if (typeof pair?.reason !== "string" || pair.reason.trim().length === 0) errors.push(`Host pair ${pair?.left}/${pair?.right} requires an evidence reason`);
    if (pair?.leftScreenshotHash !== blindScreenshotHash(packet, pair?.left)) errors.push(`Host pair ${pair?.left}/${pair?.right} left screenshot hash is stale`);
    if (pair?.rightScreenshotHash !== blindScreenshotHash(packet, pair?.right)) errors.push(`Host pair ${pair?.left}/${pair?.right} right screenshot hash is stale`);
  }
  for (const key of required) if (!seen.has(key)) errors.push("Host review is missing a required blind pair");
  if (review.adjudication !== undefined) {
    const allowedAdjudication = new Set(["blindId", "reason"]);
    for (const key of Object.keys(review.adjudication ?? {})) if (!allowedAdjudication.has(key)) errors.push(`Host adjudication contains forbidden field ${key}`);
    if (!blindIds.has(review.adjudication?.blindId)) errors.push("Host adjudication must select a blind ID");
    if (typeof review.adjudication?.reason !== "string" || review.adjudication.reason.trim().length === 0) errors.push("Host adjudication requires a reason");
  }
  return { valid: errors.length === 0, errors };
}

function revealMapping(packet, candidateSet) {
  if (packet?._privateReveal) return { ...packet._privateReveal };
  const ordered = candidateOrder(packet.explorationId, candidateSet?.candidates ?? []);
  return Object.fromEntries((packet.blindIds ?? []).map((blindId, index) => [blindId, ordered[index]?.id]));
}

export function recordBlindSelection({ packet, review, candidateSet, evidenceReview }) {
  const validation = validateHostReview(packet, review);
  if (!validation.valid) throw new Error(`Host visual review invalid: ${validation.errors.join("; ")}`);
  const wins = Object.fromEntries(packet.blindIds.map((blindId) => [blindId, 0]));
  for (const pair of review.pairs) {
    if (pair.preference === "left") wins[pair.left] += 1;
    if (pair.preference === "right") wins[pair.right] += 1;
  }
  const highest = Math.max(...Object.values(wins));
  const leaders = Object.entries(wins).filter(([, count]) => count === highest).map(([blindId]) => blindId);
  let selectedBlindId;
  if (leaders.length === 1) selectedBlindId = leaders[0];
  else {
    if (!review.adjudication?.blindId || !leaders.includes(review.adjudication.blindId)
      || typeof review.adjudication.reason !== "string" || review.adjudication.reason.trim().length === 0) {
      throw new Error("blind preference tie or cycle requires explicit Host adjudication");
    }
    selectedBlindId = review.adjudication.blindId;
  }
  const reveal = revealMapping(packet, candidateSet);
  const selectedCandidateId = reveal[selectedBlindId];
  if (!selectedCandidateId) throw new Error("blind winner has no candidate reveal mapping");
  return {
    version: "0.1.0",
    explorationId: packet.explorationId,
    packetHash: packet.packetHash,
    candidateSetHash: candidateSet?.candidateSetHash ?? candidateSetHash(candidateSet?.candidates ?? []),
    selectedBlindId,
    selectedCandidateId,
    reveal,
    pairwise: structuredClone(review.pairs),
    hostReview: structuredClone(review),
    diagnosticEvidence: structuredClone(evidenceReview ?? {}),
    acceptance: { status: "selected", primaryBasis: "host-blind-pairwise" }
  };
}
