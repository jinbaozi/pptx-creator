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
  "process-flow": ["process-flow", "process-staggered", "process-rail"],
  "quote-story": ["quote-story", "quote-ambient"],
  "section-break": ["section-break"],
  "table-chart-diagram": ["data-led", "image-led"],
  "timeline-roadmap": ["timeline-roadmap", "timeline-alternating"]
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
  "process-staggered": "process",
  "process-rail": "process",
  "quote-story": "quote",
  "quote-ambient": "quote",
  "section-break": "section",
  "data-led": "data",
  "timeline-roadmap": "timeline",
  "timeline-alternating": "timeline"
});

const SILHOUETTE_BY_VARIANT = Object.freeze({
  "cover-hero": "cover-hero",
  "closing-band": "closing-band",
  balanced: "comparison-equal",
  "focus-right": "comparison-right-emphasis",
  "flat-compare": "comparison-flat",
  "metrics-standard": "metrics-grid",
  "metrics-rail": "metrics-rail",
  "metrics-emphasis": "metrics-emphasis",
  "split-balanced": "split-equal",
  "split-wide-left": "split-wide-left",
  "split-flat": "split-flat",
  "image-led": "image-led",
  "image-caption": "image-caption",
  "summary-stack": "summary-stack",
  "summary-offset": "summary-offset",
  "summary-flat": "summary-flat",
  "statement-left": "statement-left",
  "statement-centered": "statement-centered",
  "statement-ambient": "statement-ambient",
  "process-flow": "process-linear",
  "process-staggered": "process-staggered",
  "process-rail": "process-rail",
  "quote-story": "quote-story",
  "quote-ambient": "quote-ambient",
  "section-break": "section-break",
  "data-led": "data-led",
  "timeline-roadmap": "timeline-linear",
  "timeline-alternating": "timeline-alternating"
});

const CAPACITY_BY_VARIANT = Object.freeze({
  "process-flow": { ideal: 4, maximum: 4 },
  "process-staggered": { ideal: 5, maximum: 5 },
  "process-rail": { ideal: 3, maximum: 4 },
  "timeline-roadmap": { ideal: 4, maximum: 4 },
  "timeline-alternating": { ideal: 5, maximum: 6 }
});

function candidatesFor(slide) {
  return VARIANT_CATALOG[slide.layoutArchetype] ?? VARIANT_CATALOG[slide.type] ?? [slide.type];
}
function candidateIndex(slide, count) {
  return count > 0 ? Math.abs(Number(slide.order) || 0) % count : 0;
}

function itemCount(slide) {
  const content = slide.content ?? slide.slots ?? {};
  if (Array.isArray(content.steps)) return content.steps.length;
  if (Array.isArray(content.milestones)) return content.milestones.length;
  if (Array.isArray(content.metrics)) return content.metrics.length;
  if (Array.isArray(content.points)) return content.points.length;
  return 0;
}

function candidateScore(slide, variant, index, candidateCount, state) {
  const family = FAMILY_BY_VARIANT[variant] ?? slide.type;
  const silhouette = SILHOUETTE_BY_VARIANT[variant] ?? variant;
  const capacity = CAPACITY_BY_VARIANT[variant];
  const count = itemCount(slide);
  let score = 0;
  if (capacity) {
    score += Math.abs(count - capacity.ideal) * 4;
    score += Math.max(0, count - capacity.maximum) * 100;
  }
  const content = slide.content ?? slide.slots ?? {};
  const leftCount = content.left?.points?.length ?? 0;
  const rightCount = content.right?.points?.length ?? 0;
  const comparisonCount = leftCount + rightCount;
  if (variant === "balanced") score += Math.abs(leftCount - rightCount) * 6 + (comparisonCount > 4 ? 20 : 0);
  if (variant === "focus-right") score += rightCount > leftCount ? 0 : 12;
  if (variant === "flat-compare") score += comparisonCount >= 6 ? 0 : 16;
  if (family === state.previousFamily) {
    score += 8;
    if (state.consecutiveFamily >= state.maxConsecutiveFamily) score += 64;
  }
  if (silhouette === state.previousSilhouette) score += 12;
  const preferred = candidateIndex(slide, candidateCount);
  score += ((index - preferred + candidateCount) % candidateCount) / 1000;
  return { score, family, silhouette };
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
  let previousSilhouette = null;
  let consecutiveFamily = 0;
  for (const slide of slides ?? []) {
    const candidates = candidatesFor(slide).slice(0, Math.max(1, poolSize));
    const ranked = candidates.map((variant, index) => ({
      variant,
      index,
      ...candidateScore(slide, variant, index, candidates.length, {
        previousFamily,
        previousSilhouette,
        consecutiveFamily,
        maxConsecutiveFamily: maxConsecutive
      })
    })).sort((left, right) => left.score - right.score || left.index - right.index);
    const selected = ranked[0] ?? {
      variant: slide.type,
      family: slide.type,
      silhouette: slide.type,
      score: 0
    };
    const variant = selected.variant;
    const family = selected.family;
    const silhouette = selected.silhouette;
    consecutiveFamily = family === previousFamily ? consecutiveFamily + 1 : 1;
    plan.set(slide.id, Object.freeze({
      id: variant,
      family,
      silhouette,
      selectionScore: Number(selected.score.toFixed(3)),
      showEyebrow: !["summary-flat", "split-flat", "flat-compare"].includes(variant),
      ambientDecoration: ["statement-ambient", "quote-ambient"].includes(variant)
    }));
    previousFamily = family;
    previousSilhouette = silhouette;
  }
  return plan;
}

export function layoutVariantCatalog() {
  return structuredClone(VARIANT_CATALOG);
}
