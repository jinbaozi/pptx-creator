export const CREATIVE_GATE = Object.freeze({ deckScore: 80, slideScore: 70, slopRisk: 20, criticalFindings: 0, editabilityLevel: 4 });

export function buildContextualTasteProfile(plan) {
  const checks = [];
  const read = String(plan?.designRead ?? "").toLowerCase();
  if ((plan?.dials?.compositionVariance ?? 0) >= 35) checks.push("composition-variance");
  checks.push("density-fit", "energy-fit");
  if (/editorial|编辑|叙事/.test(read)) checks.push("editorial-hierarchy");
  if (/restrain|克制|calm|安静/.test(read)) checks.push("restraint");
  if (/asymmetr|不对称/.test(read) && !checks.includes("composition-variance")) checks.push("composition-variance");
  const locked = plan?.intentOverride?.sourceLocked === true || plan?.intentOverride?.brandLocked === true;
  return { designRead: plan?.designRead ?? "", checks, genericHeuristicsSuppressed: locked };
}

const GENERIC_HEURISTIC_TYPES = new Set([
  "overused-font", "gray-on-color", "black-shadow", "nested-card", "template-stack-layout", "layout-repetition", "dominant-empty-container"
]);

export function applyContextualTaste(review, manifest, plan) {
  const profile = buildContextualTasteProfile(plan);
  const slides = (review.slides ?? []).map((slide) => {
    const originalIssues = slide.issues ?? [];
    const issues = profile.genericHeuristicsSuppressed
      ? originalIssues.filter((issue) => !GENERIC_HEURISTIC_TYPES.has(issue.type))
      : [...originalIssues];
    const removedPenalty = originalIssues
      .filter((issue) => !issues.includes(issue))
      .reduce((sum, issue) => sum + (issue.severity === "high" ? 18 : 10), 0);
    return { ...slide, score: Math.min(100, slide.score + removedPenalty), issues };
  });
  const findings = [];
  if (!profile.genericHeuristicsSuppressed && profile.checks.includes("composition-variance") && (manifest.slides?.length ?? 0) >= 4) {
    const distinct = new Set((manifest.slides ?? []).map((slide) => slide.type)).size;
    if (distinct / manifest.slides.length < 0.5) findings.push({ severity: "high", type: "context-composition-variance", message: "The requested composition variance is not reflected across slide families." });
  }
  const averageElements = (manifest.slides?.length ?? 0) > 0
    ? manifest.slides.reduce((sum, slide) => sum + (slide.elements?.length ?? 0), 0) / manifest.slides.length
    : 0;
  const density = plan?.dials?.visualDensity ?? 50;
  if (!profile.genericHeuristicsSuppressed && ((density <= 30 && averageElements > 9) || (density >= 75 && averageElements < 5))) {
    findings.push({ severity: "high", type: "context-density-fit", message: "Rendered element density conflicts with the deck plan density dial." });
  }
  if (findings.length && slides[0]) {
    slides[0].issues.push(...findings);
    slides[0].score = Math.max(0, slides[0].score - findings.length * 18);
  }
  const deckScore = slides.length ? Math.round(slides.reduce((sum, slide) => sum + slide.score, 0) / slides.length) : 0;
  return { ...review, deckScore, slides, contextualTaste: { ...profile, findings } };
}

export function evaluateCreativeGate(quality = {}, options = {}) {
  const mode = options.mode ?? "creative";
  if (mode !== "creative") return { applicable: false, passed: true, reasons: [] };
  const reasons = [];
  if (Number(quality.deckScore) < CREATIVE_GATE.deckScore) reasons.push(`deck score ${quality.deckScore ?? "missing"} < 80`);
  const slides = Array.isArray(quality.slides) ? quality.slides : [];
  slides.forEach((slide, index) => { if (Number(slide.score) < CREATIVE_GATE.slideScore) reasons.push(`slide ${slide.id ?? index + 1} score ${slide.score ?? "missing"} < 70`); });
  if (slides.length === 0) reasons.push("slide scores missing");
  if (Number(quality.slopRisk) > CREATIVE_GATE.slopRisk || !Number.isFinite(Number(quality.slopRisk))) reasons.push(`slop risk ${quality.slopRisk ?? "missing"} > 20`);
  const critical = Number(quality.criticalFindings ?? quality.slides?.flatMap((slide) => slide.issues ?? []).filter((issue) => ["critical", "high"].includes(issue.severity)).length ?? 0);
  if (critical !== 0) reasons.push(`critical findings ${critical} != 0`);
  if (Number(quality.editabilityLevel) < CREATIVE_GATE.editabilityLevel) reasons.push(`editability L${quality.editabilityLevel ?? "missing"} < L4`);
  const preflight = options.fontPreflight;
  const compatibility = preflight ? {
    source: preflight.source ?? "unavailable",
    fallbackCount: preflight.fallback?.length ?? 0,
    score: preflight.source === "unavailable" ? null : Math.max(0, 100 - (preflight.fallback?.length ?? 0) * 15)
  } : undefined;
  return { applicable: true, passed: reasons.length === 0, reasons, thresholds: CREATIVE_GATE, ...(compatibility ? { compatibility } : {}) };
}

export function qualityFromReview(review, editabilityLevel, fontPreflight) {
  const criticalFindings = (review.slides ?? []).flatMap((slide) => slide.issues ?? []).filter((issue) => ["critical", "high"].includes(issue.severity)).length;
  const quality = { ...review, criticalFindings, editabilityLevel };
  return { ...quality, gate: evaluateCreativeGate(quality, { mode: "creative", fontPreflight }), compatibility: { source: fontPreflight?.source ?? "unavailable", fallback: fontPreflight?.fallback ?? [] } };
}

export function editabilityLevelFromCounter(counter = {}) {
  const text = counter.text ?? 0;
  const native = (counter.shape ?? 0) + (counter.table ?? 0);
  const raster = (counter.image ?? 0) + (counter.croppedAsset ?? 0);
  if (text > 0 && native > 0 && raster === 0) return 5;
  if (text > 0 && native > 0 && raster > 0) return 4;
  if (text > 0 && raster > 0) return 3;
  if (native > 0) return 2;
  return 1;
}
