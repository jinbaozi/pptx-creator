const HARD_LIMIT = 3;

function value(metric) {
  return metric?.status === "available" && Number.isFinite(metric.value) ? metric.value : null;
}

export function repairScore(proof = {}) {
  if (!proof || typeof proof !== "object") return 0;
  const fidelity = proof.aggregate?.fidelity ?? {};
  const positive = ["ssim", "bboxIou", "fontMapping", "colorMapping", "nativeHighConfidenceTextRecall"];
  const negative = ["normalizedMae", "ocrCer", "paletteDeltaE2000P95", "bboxP95Drift"];
  let score = 0;
  for (const name of positive) { const metric = value(fidelity[name]); if (metric !== null) score += metric; }
  for (const name of negative) { const metric = value(fidelity[name]); if (metric !== null) score -= metric; }
  const nativeCoverage = value(proof.aggregate?.nativeCoverage); if (nativeCoverage !== null) score += nativeCoverage;
  score += Number(proof.aggregate?.editability?.level ?? 0) / 5;
  score -= (proof.blockingFindings?.length ?? 0) * 0.01;
  return score;
}

export async function runBoundedRepair({ initialProof, initialArtifact = null, maxAttempts = HARD_LIMIT, attempt, compare, accept } = {}) {
  const limit = Math.min(HARD_LIMIT, Math.max(0, Number.isFinite(Number(maxAttempts)) ? Math.floor(Number(maxAttempts)) : HARD_LIMIT));
  const hasCustomComparator = typeof compare === "function";
  const compareProof = hasCustomComparator
    ? compare
    : (candidate, current) => repairScore(candidate) > repairScore(current) + 1e-9 ? 1 : -1;
  const isAccepted = typeof accept === "function" ? accept : (proof) => proof?.accepted === true;
  let bestProof = initialProof; let artifact = initialArtifact; let attempts = 0; const history=[];
  if (isAccepted(initialProof)) return { accepted: true, proof: initialProof, artifact, attempts, history, maxAttempts: limit, stopReason: "accepted" };
  if (typeof attempt !== "function" || limit === 0) return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "repair-unavailable" };
  for (let iteration = 1; iteration <= limit; iteration += 1) {
    const candidate = await attempt({ iteration, proof: bestProof, artifact }); attempts += 1;
    if (!candidate?.proof) { history.push({iteration,outcome:"unavailable"}); return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "repair-unavailable" }; }
    const comparison = compareProof(candidate.proof, bestProof);
    const measurement = hasCustomComparator ? { comparison } : { score: repairScore(candidate.proof) };
    if (isAccepted(candidate.proof) && comparison >= 0) {
      history.push({iteration,outcome:"accepted",...measurement});
      return { accepted: true, proof: candidate.proof, artifact: candidate.artifact ?? artifact, attempts, history, maxAttempts: limit, stopReason: "accepted" };
    }
    if (!(comparison > 0)) { history.push({iteration,outcome:"no-improvement",...measurement}); return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "no-improvement" }; }
    history.push({iteration,outcome:"improved",...measurement});
    bestProof = candidate.proof; artifact = candidate.artifact ?? artifact;
    if (isAccepted(bestProof)) return { accepted: true, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "accepted" };
  }
  return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "attempt-limit" };
}
