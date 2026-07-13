const PATCH_REASON = "visual-critic-deterministic-recommendations";

function safeProof(proof) {
  return proof && typeof proof === "object" ? proof : {};
}

export function creativeRepairVector(proof = {}) {
  const value = safeProof(proof);
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
  if ((candidateProof.quality?.editabilityLevel ?? 0) < (currentProof.quality?.editabilityLevel ?? 0)) return -1;
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

export function buildCreativeRepairPatch(review, attempt) {
  const patches = [];
  const evidence = [];
  for (const [slideIndex, slide] of (review?.slides ?? []).entries()) {
    for (const [repairIndex, recommendation] of (slide?.recommendedRepairs ?? []).entries()) {
      const patch = convertRecommendation(slide?.id, recommendation);
      if (!patch) continue;
      patches.push(patch);
      evidence.push({ source: "visual-review", path: `/slides/${slideIndex}/recommendedRepairs/${repairIndex}` });
    }
  }
  return { attempt, reason: PATCH_REASON, evidence, patches };
}
