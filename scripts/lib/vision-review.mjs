const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

export function normalizeVisionReview(review) {
  return {
    ...review,
    slides: (review.slides ?? []).map((slide) => ({
      ...slide,
      findings: (slide.findings ?? []).map((finding) => ({
        source: "vision-model",
        slideId: slide.slideId,
        ...finding
      }))
    }))
  };
}

export function mergeReviews({ deterministicReview, visionReview, knownElementIds = new Set() }) {
  const deterministicFindings = (deterministicReview?.findings ?? []).map((finding) => ({
    source: "deterministic",
    ...finding
  }));
  const visionFindings = (visionReview?.slides ?? []).flatMap((slide) =>
    (slide.findings ?? []).map((finding) => ({
      source: "vision-model",
      slideId: slide.slideId,
      ...finding
    }))
  );
  const findings = [...deterministicFindings, ...visionFindings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
  );
  const repairCandidates = visionFindings
    .filter((finding) => finding.suggestedRepair?.target && knownElementIds.has(finding.suggestedRepair.target))
    .map((finding) => ({
      findingId: finding.id,
      slideId: finding.slideId,
      operation: finding.suggestedRepair.operation,
      target: finding.suggestedRepair.target,
      changes: finding.suggestedRepair.changes ?? {}
    }));
  return { findings, repairCandidates };
}
