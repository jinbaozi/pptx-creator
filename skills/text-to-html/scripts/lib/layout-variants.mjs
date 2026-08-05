const VARIANT_CATALOG = Object.freeze({
  "closing-action": ["closing-band"],
  "comparison-matrix": ["balanced", "focus-right", "flat-compare"],
  cover: ["cover-hero"],
  dashboard: ["metrics-standard", "metrics-rail", "metrics-emphasis"],
  "editorial-split": ["split-balanced", "split-wide-left", "split-flat"],
  "evidence-image": ["image-led", "image-caption"],
  "executive-summary": ["summary-stack", "summary-offset", "summary-flat"],
  "hero-statement": ["statement-left", "statement-centered", "statement-ambient"],
  "metric-focus": ["metrics-standard", "metrics-emphasis", "metrics-rail"],
  "process-flow": ["process-flow"],
  "quote-story": ["quote-story", "quote-ambient"],
  "section-break": ["section-break"],
  "table-chart-diagram": ["data-led", "image-led"],
  "timeline-roadmap": ["timeline-roadmap"]
});

const FAMILY_BY_VARIANT = Object.freeze({
  "cover-hero": "cover",
  "closing-band": "closing",
  balanced: "comparison",
  "focus-right": "comparison",
  "flat-compare": "comparison",
  "metrics-standard": "metrics",
  "metrics-rail": "metrics",
  "metrics-emphasis": "metrics",
  "split-balanced": "split",
  "split-wide-left": "split",
  "split-flat": "split",
  "image-led": "image",
  "image-caption": "image",
  "summary-stack": "summary",
  "summary-offset": "summary",
  "summary-flat": "summary",
  "statement-left": "statement",
  "statement-centered": "statement",
  "statement-ambient": "statement",
  "process-flow": "process",
  "quote-story": "quote",
  "quote-ambient": "quote",
  "section-break": "section",
  "data-led": "data",
  "timeline-roadmap": "timeline"
});

function candidatesFor(slide) {
  return VARIANT_CATALOG[slide.layoutArchetype] ?? VARIANT_CATALOG[slide.type] ?? [slide.type];
}
function candidateIndex(slide, count) {
  return count > 0 ? Math.abs(Number(slide.order) || 0) % count : 0;
}

/**
 * Selects a stable visual variant without changing the reviewed slide content.
 * The previous family is only used to avoid repetitive adjacent silhouettes.
 */
export function buildLayoutVariantPlan(slides, policy = {}) {
  const maxConsecutive = policy.renderControls?.maxConsecutiveFamily ?? 2;
  const poolSize = policy.renderControls?.variantPool ?? 2;
  const plan = new Map();
  let previousFamily = null;
  let consecutiveFamily = 0;
  for (const slide of slides ?? []) {
    const candidates = candidatesFor(slide).slice(0, Math.max(1, poolSize));
    let index = candidateIndex(slide, candidates.length);
    let variant = candidates[index] ?? candidates[0] ?? slide.type;
    let family = FAMILY_BY_VARIANT[variant] ?? slide.type;
    if (family === previousFamily) consecutiveFamily += 1;
    else consecutiveFamily = 1;
    if (family === previousFamily && consecutiveFamily > maxConsecutive && candidates.length > 1) {
      index = (index + 1) % candidates.length;
      variant = candidates[index] ?? variant;
      family = FAMILY_BY_VARIANT[variant] ?? slide.type;
      consecutiveFamily = family === previousFamily ? consecutiveFamily : 1;
    }
    plan.set(slide.id, Object.freeze({
      id: variant,
      family,
      showEyebrow: !["summary-flat", "split-flat", "flat-compare"].includes(variant),
      ambientDecoration: ["statement-ambient", "quote-ambient"].includes(variant)
    }));
    previousFamily = family;
  }
  return plan;
}

export function layoutVariantCatalog() {
  return structuredClone(VARIANT_CATALOG);
}
