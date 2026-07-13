export const CREATIVE_GATE = Object.freeze({ deckScore: 80, slideScore: 70, slopRisk: 20, criticalFindings: 0, editabilityLevel: 4 });

export function buildContextualTasteProfile(plan) {
  const checks = [];
  const read = String(plan?.designRead ?? "").toLowerCase();
  if ((plan?.dials?.compositionVariance ?? 0) >= 35) checks.push("composition-variance");
  checks.push("density-fit", "energy-fit");
  if (/editorial|编辑|叙事/.test(read)) checks.push("editorial-hierarchy");
  if (/visual restraint|restrained (?:visual|tone|palette)|克制|calm|安静/.test(read)) checks.push("restraint");
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
    const retainedTargets = new Set(issues
      .map((issue) => issue?.target)
      .filter((target) => typeof target === "string" && target));
    const recommendedRepairs = (slide.recommendedRepairs ?? []).filter(
      (repair) => typeof repair?.target === "string" && retainedTargets.has(repair.target)
    );
    return { ...slide, score: Math.min(100, slide.score + removedPenalty), issues, recommendedRepairs };
  });
  const findings = [];
  if (profile.checks.includes("composition-variance") && (manifest.slides?.length ?? 0) >= 4) {
    const distinct = new Set((manifest.slides ?? []).map((slide) => slide.type)).size;
    if (distinct / manifest.slides.length < 0.5) findings.push({ severity: "high", type: "context-composition-variance", message: "The requested composition variance is not reflected across slide families." });
  }
  const averageElements = (manifest.slides?.length ?? 0) > 0
    ? manifest.slides.reduce((sum, slide) => sum + (slide.elements?.length ?? 0), 0) / manifest.slides.length
    : 0;
  const density = plan?.dials?.visualDensity ?? 50;
  if ((density <= 30 && averageElements > 9) || (density >= 75 && averageElements < 5)) {
    findings.push({ severity: "high", type: "context-density-fit", message: "Rendered element density conflicts with the deck plan density dial." });
  }
  const elements = (manifest.slides ?? []).flatMap((slide) => slide.elements ?? []);
  const visualElements = elements.filter((element) => ["shape", "line", "chart", "image"].includes(element.type));
  const chromatic = visualElements.filter((element) => {
    const color = String(element.style?.fill ?? element.style?.color ?? element.style?.line ?? "");
    const match = color.match(/^#?([0-9a-f]{6})$/i);
    if (!match) return false;
    const values = [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
    return Math.max(...values) - Math.min(...values) >= 48;
  });
  const energyRatio = visualElements.length ? chromatic.length / visualElements.length : 0;
  const energy = plan?.dials?.visualEnergy ?? 50;
  if ((energy >= 70 && energyRatio < 0.2) || (energy <= 25 && energyRatio > 0.35)) {
    findings.push({ severity: "high", type: "context-energy-fit", message: "Rendered visual energy conflicts with the deck plan energy dial." });
  }
  if (profile.checks.includes("editorial-hierarchy")) {
    const sizes = elements.filter((element) => element.type === "text").map((element) => Number(element.style?.fontSize)).filter(Number.isFinite);
    const hierarchyRatio = sizes.length > 1 ? Math.max(...sizes) / Math.max(1, Math.min(...sizes)) : 1;
    if (hierarchyRatio < 1.5) findings.push({ severity: "high", type: "context-editorial-hierarchy", message: "Editorial direction lacks a legible typographic hierarchy." });
  }
  if (profile.checks.includes("restraint") && (energyRatio > 0.35 || visualElements.length > Math.max(4, elements.length * 0.7))) {
    findings.push({ severity: "high", type: "context-restraint", message: "Restrained direction is overwhelmed by decorative visual elements." });
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
  const finiteMetric = (value) => typeof value === "number" && Number.isFinite(value);
  if (!finiteMetric(quality.deckScore) || quality.deckScore < CREATIVE_GATE.deckScore) reasons.push(`deck score ${quality.deckScore ?? "missing"} must be finite and >= 80`);
  const slides = Array.isArray(quality.slides) ? quality.slides : [];
  slides.forEach((slide, index) => { if (!finiteMetric(slide.score) || slide.score < CREATIVE_GATE.slideScore) reasons.push(`slide ${slide.id ?? index + 1} score ${slide.score ?? "missing"} must be finite and >= 70`); });
  if (slides.length === 0) reasons.push("slide scores missing");
  if (!finiteMetric(quality.slopRisk) || quality.slopRisk > CREATIVE_GATE.slopRisk) reasons.push(`slop risk ${quality.slopRisk ?? "missing"} must be finite and <= 20`);
  if (!finiteMetric(quality.criticalFindings) || quality.criticalFindings !== 0) reasons.push(`critical findings ${quality.criticalFindings ?? "missing"} must be finite and = 0`);
  if (!finiteMetric(quality.editabilityLevel) || quality.editabilityLevel < CREATIVE_GATE.editabilityLevel) reasons.push(`editability L${quality.editabilityLevel ?? "missing"} must be finite and >= L4`);
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
