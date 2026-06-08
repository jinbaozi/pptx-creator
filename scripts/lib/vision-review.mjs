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

function screenshotToSlideId(entry) {
  if (typeof entry === "string") return entry.replace(/\.png$/, "");
  if (entry && typeof entry === "object" && typeof entry.id === "string") return entry.id;
  return null;
}

function screenshotToEvidence(entry) {
  if (entry && typeof entry === "object" && (entry.width || entry.height)) {
    return { region: { w: entry.width ?? 0, h: entry.height ?? 0 } };
  }
  return undefined;
}

export function runMockVisionReview({ screenshots = [], manifest, options = {} } = {}) {
  const createdAt = new Date().toISOString();
  const knownSlides = (screenshots ?? [])
    .map((entry) => ({ id: screenshotToSlideId(entry), raw: entry }))
    .filter((entry) => entry.id);

  const slides = knownSlides.map((entry, index) => {
    const id = entry.id;
    const message = `Mock review completed for screenshot ${id}; offline mock provider did not access the network.`;
    return {
      slideId: id,
      score: 80,
      findings: [
        {
          id: `mock-${id}-${index + 1}`,
          severity: "info",
          category: "polish",
          message,
          ...(screenshotToEvidence(entry.raw) ? { evidence: screenshotToEvidence(entry.raw) } : {})
        }
      ]
    };
  });

  const deckScore = slides.length > 0 ? 80 : 0;
  const issues = slides.flatMap((slide) =>
    slide.findings.map((finding) => ({
      ...finding,
      slideId: slide.slideId
    }))
  );
  const recommendedPatches = slides
    .flatMap((slide) => slide.findings)
    .filter((finding) => finding.suggestedRepair?.target)
    .map((finding) => ({
      findingId: finding.id,
      target: finding.suggestedRepair.target,
      operation: finding.suggestedRepair.operation,
      changes: finding.suggestedRepair.changes ?? {}
    }));

  const review = {
    reviewer: {
      type: "vision-model",
      provider: "mock",
      model: "mock-vlm",
      createdAt
    },
    deckScore,
    slides,
    ...(manifest ? { metadata: { manifestSlideCount: manifest.slides?.length ?? 0 } } : {})
  };

  return {
    ...review,
    overallScore: deckScore,
    issues,
    recommendedPatches
  };
}

export async function runVisionReview({ screenshots = [], manifest, provider = "mock", options = {} } = {}) {
  if (provider === "mock") {
    return runMockVisionReview({ screenshots, manifest, options });
  }
  throw new Error(`Unsupported vision review provider: ${provider}`);
}
