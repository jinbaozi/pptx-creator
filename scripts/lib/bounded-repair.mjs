const HARD_LIMIT = 3;

function value(metric) {
  return metric?.status === "available" && Number.isFinite(metric.value) ? metric.value : null;
}

export function repairScore(proof = {}) {
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

export async function runBoundedRepair({ initialProof, initialArtifact = null, maxAttempts = HARD_LIMIT, attempt } = {}) {
  const limit = Math.min(HARD_LIMIT, Math.max(0, Number.isFinite(Number(maxAttempts)) ? Math.floor(Number(maxAttempts)) : HARD_LIMIT));
  let bestProof = initialProof; let artifact = initialArtifact; let bestScore = repairScore(initialProof); let attempts = 0; const history=[];
  if (initialProof?.accepted === true) return { accepted: true, proof: initialProof, artifact, attempts, history, maxAttempts: limit, stopReason: "accepted" };
  if (typeof attempt !== "function" || limit === 0) return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "repair-unavailable" };
  for (let iteration = 1; iteration <= limit; iteration += 1) {
    const candidate = await attempt({ iteration, proof: bestProof, artifact }); attempts += 1;
    if (!candidate?.proof) { history.push({iteration,outcome:"unavailable"}); return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "repair-unavailable" }; }
    const candidateScore = repairScore(candidate.proof);
    if (!(candidateScore > bestScore + 1e-9)) { history.push({iteration,outcome:"no-improvement",score:candidateScore}); return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "no-improvement" }; }
    history.push({iteration,outcome:candidate.proof.accepted===true?"accepted":"improved",score:candidateScore});
    bestProof = candidate.proof; artifact = candidate.artifact ?? artifact; bestScore = candidateScore;
    if (bestProof.accepted === true) return { accepted: true, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "accepted" };
  }
  return { accepted: false, proof: bestProof, artifact, attempts, history, maxAttempts: limit, stopReason: "attempt-limit" };
}
