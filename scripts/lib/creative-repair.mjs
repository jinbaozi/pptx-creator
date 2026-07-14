const PATCH_REASON = "visual-critic-deterministic-recommendations";

function safeProof(proof) {
  return proof && typeof proof === "object" ? proof : {};
}

export function creativeRepairVector(proof = {}) {
  const value = safeProof(proof);
  if (value.version === "0.2.0") {
    const deterministicFailures = (value.hardGates ?? []).filter((gate) =>
      gate.required && gate.id !== "final-host-review" && gate.status !== "passed"
    ).length;
    const p0 = (value.findings ?? []).filter((finding) => finding.severity === "P0" && finding.source !== "host-visual-review").length;
    const p1 = (value.findings ?? []).filter((finding) => finding.severity === "P1" && finding.source !== "host-visual-review").length;
    return [
      p0,
      p1,
      deterministicFailures,
      value.diagnostics?.antiSlop?.risk ?? 100,
      -(value.diagnostics?.quality?.deckScore ?? 0),
      -(value.diagnostics?.quality?.slideFloor ?? 0)
    ];
  }
  return [
    value.p0?.length ?? 0,
    value.p1?.length ?? 0,
    value.textFit?.summary?.overflowCount ?? 0,
    value.quality?.gate?.reasons?.length ?? 0,
    value.quality?.slopRisk ?? 100,
    -(value.quality?.deckScore ?? 0)
  ];
}

export function compareCreativeProof(candidate, current) {
  const candidateProof = safeProof(candidate);
  const currentProof = safeProof(current);
  const candidateEditability = candidateProof.diagnostics?.nativeCoverage?.editabilityLevel ?? candidateProof.quality?.editabilityLevel ?? 0;
  const currentEditability = currentProof.diagnostics?.nativeCoverage?.editabilityLevel ?? currentProof.quality?.editabilityLevel ?? 0;
  if (candidateEditability < currentEditability) return -1;
  const candidateVector = creativeRepairVector(candidateProof);
  const currentVector = creativeRepairVector(currentProof);
  for (let index = 0; index < candidateVector.length; index += 1) {
    if (candidateVector[index] !== currentVector[index]) return candidateVector[index] < currentVector[index] ? 1 : -1;
  }
  return 0;
}

function concreteResize(params) {
  const changes = {};
  if (Number.isFinite(params?.w) && params.w > 0) changes.w = params.w;
  if (Number.isFinite(params?.h) && params.h > 0) changes.h = params.h;
  return Object.keys(changes).length > 0 ? changes : null;
}

function concreteStyle(params) {
  if (!Number.isFinite(params?.fontSize) || params.fontSize <= 0) return null;
  return { fontSize: params.fontSize };
}

function convertRecommendation(slideId, recommendation) {
  if (typeof slideId !== "string" || !slideId || typeof recommendation?.target !== "string" || !recommendation.target) return null;
  if (recommendation.action === "resize") {
    const changes = concreteResize(recommendation.params);
    return changes ? { slideId, operation: "resize", targetElementId: recommendation.target, changes } : null;
  }
  if (recommendation.action === "removeElement") {
    return { slideId, operation: "removeElement", targetElementId: recommendation.target, changes: {} };
  }
  if (recommendation.action === "updateStyle") {
    const changes = concreteStyle(recommendation.params);
    return changes ? { slideId, operation: "updateStyle", targetElementId: recommendation.target, changes } : null;
  }
  return null;
}

function targetIdsBySlide(manifest) {
  const targetIds = new Map();
  for (const slide of manifest?.slides ?? []) {
    if (typeof slide?.id !== "string" || !slide.id) continue;
    targetIds.set(slide.id, new Set((slide.elements ?? []).map((element) => element?.id).filter((id) => typeof id === "string" && id)));
  }
  return targetIds;
}

export function buildCreativeRepairPatch(review, attempt, manifest) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
    throw new Error("buildCreativeRepairPatch attempt must be an integer from 1 through 3");
  }
  const patches = [];
  const evidence = [];
  const targetIds = targetIdsBySlide(manifest);
  for (const [slideIndex, slide] of (review?.slides ?? []).entries()) {
    for (const [repairIndex, recommendation] of (slide?.recommendedRepairs ?? []).entries()) {
      if (!targetIds.get(slide?.id)?.has(recommendation?.target)) continue;
      const patch = convertRecommendation(slide?.id, recommendation);
      if (!patch) continue;
      patches.push(patch);
      evidence.push({ source: "visual-review", path: `/slides/${slideIndex}/recommendedRepairs/${repairIndex}` });
    }
  }
  return { attempt, reason: PATCH_REASON, evidence, patches };
}
