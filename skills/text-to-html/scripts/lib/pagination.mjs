export const PAGINATION_REPORT_VERSION = "1.0.0";

const EXCLUDED_CONTENT_KEYS = new Set(["sourceRefs", "factStatus", "assetId"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function reportStatus(errors, warnings) {
  if (errors.length > 0) return "failed";
  return warnings.length > 0 ? "attention-required" : "reported";
}

function finding(code, path, message, details) {
  return {
    code,
    path,
    message,
    ...(details === undefined ? {} : { details })
  };
}

function duplicateIds(ids) {
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id) && !duplicates.includes(id)) duplicates.push(id);
    seen.add(id);
  }
  return duplicates;
}

/** Counts visible CJK characters and whitespace-delimited non-CJK words. */
export function contentUnits(value) {
  if (typeof value === "string") {
    const cjk = (value.match(/[\u3400-\u9fff]/gu) ?? []).length;
    const words = value
      .replace(/[\u3400-\u9fff]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return cjk + words;
  }
  if (Array.isArray(value)) return value.reduce((total, item) => total + contentUnits(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value)
    .filter(([key]) => !EXCLUDED_CONTENT_KEYS.has(key))
    .reduce((total, [, item]) => total + contentUnits(item), 0);
}

/** Returns the existing Plan 2.0 primary-support count for a slide. */
export function primarySupportCount(slide) {
  const slots = slide?.slots ?? {};
  if (Array.isArray(slots.points)) return slots.points.length;
  if (Array.isArray(slots.metrics)) return slots.metrics.length;
  if (Array.isArray(slots.steps)) return slots.steps.length;
  if (Array.isArray(slots.milestones)) return slots.milestones.length;
  if (Array.isArray(slots.summary)) return slots.summary.length;
  if (slots.left || slots.right) return Math.max(slots.left?.points?.length ?? 0, slots.right?.points?.length ?? 0);
  return 0;
}

function paginationCoverage(slideIds, budgets, errors) {
  const budgetSlideIds = budgets.map((budget) => budget?.slideId);
  const expected = new Set(slideIds);
  const missingSlideIds = slideIds.filter((id) => !budgetSlideIds.includes(id));
  const unknownSlideIds = budgetSlideIds.filter((id) => !expected.has(id));
  const duplicateSlideIds = duplicateIds(budgetSlideIds);
  const matches = budgetSlideIds.length === slideIds.length && budgetSlideIds.every((id, index) => id === slideIds[index]);
  if (!matches) {
    errors.push(finding(
      "E_PAGINATION_COVERAGE",
      "$.pagination.pageBudgets",
      "pagination.pageBudgets must cover slides exactly once in slide order",
      { expectedSlideIds: [...slideIds], budgetSlideIds, missingSlideIds, unknownSlideIds, duplicateSlideIds }
    ));
  }
  return { expectedSlideIds: [...slideIds], budgetSlideIds, matches, missingSlideIds, unknownSlideIds, duplicateSlideIds };
}

/**
 * Calculates read-only pagination and budget diagnostics for a Plan 2.0 object.
 * It deliberately reports budget/continuation problems instead of changing pages.
 */
export function analyzePagination(plan) {
  const errors = [];
  const warnings = [];
  const slides = asArray(plan?.slides);
  const budgets = asArray(plan?.pagination?.pageBudgets);
  const slideIds = slides.map((slide) => slide.id);
  const slideById = new Map(slides.map((slide) => [slide.id, slide]));
  const coverage = paginationCoverage(slideIds, budgets, errors);
  const firstBudgetIndexBySlideId = new Map();
  for (const [index, budget] of budgets.entries()) {
    if (!firstBudgetIndexBySlideId.has(budget?.slideId)) firstBudgetIndexBySlideId.set(budget?.slideId, index);
  }

  const pages = budgets.map((budget, index) => {
    const path = `$.pagination.pageBudgets[${index}]`;
    const slide = slideById.get(budget?.slideId);
    const contentUnitCount = slide
      ? contentUnits({ title: slide.title, takeaway: slide.takeaway, slots: slide.slots })
      : null;
    const supportCount = slide ? primarySupportCount(slide) : null;
    const maxWords = budget?.maxWords;
    const maxPrimarySupports = budget?.maxPrimarySupports;
    const withinContentBudget = Number.isInteger(maxWords) && contentUnitCount !== null && contentUnitCount <= maxWords;
    const withinSupportBudget = Number.isInteger(maxPrimarySupports) && supportCount !== null && supportCount <= maxPrimarySupports;
    if (!withinContentBudget) {
      errors.push(finding(
        "E_PAGINATION_BUDGET",
        `${path}.maxWords`,
        "Declared content-unit budget is below visible slide content",
        { slideId: budget?.slideId ?? null, contentUnits: contentUnitCount, maxWords }
      ));
    }
    if (!withinSupportBudget) {
      errors.push(finding(
        "E_PAGINATION_BUDGET",
        `${path}.maxPrimarySupports`,
        "Declared primary-support budget is below the slide support count",
        { slideId: budget?.slideId ?? null, primarySupports: supportCount, maxPrimarySupports }
      ));
    }

    const continuationOf = budget?.continuationOf ?? null;
    const semanticBreak = budget?.semanticBreak ?? null;
    const continuationViolations = [];
    if (budget?.canSplit && !semanticBreak) continuationViolations.push("missing-semantic-break");
    if (continuationOf) {
      const previousIndex = firstBudgetIndexBySlideId.get(continuationOf);
      const previous = previousIndex === undefined ? null : budgets[previousIndex];
      if (previousIndex === undefined) continuationViolations.push("unknown-predecessor");
      else if (previousIndex >= index) continuationViolations.push("predecessor-not-earlier");
      if (!budget.canSplit) continuationViolations.push("current-page-not-splittable");
      if (!previous?.canSplit) continuationViolations.push("predecessor-not-splittable");
      if (!semanticBreak) continuationViolations.push("missing-semantic-break");
      if (previous?.canSplit && !previous.semanticBreak) continuationViolations.push("predecessor-missing-semantic-break");
    }
    if (continuationViolations.length > 0) {
      errors.push(finding(
        "E_PAGINATION_CONTINUATION",
        path,
        "Continuation pages require an earlier splittable predecessor and declared semantic breaks",
        { slideId: budget?.slideId ?? null, continuationOf, violations: [...new Set(continuationViolations)] }
      ));
    }

    return {
      slideId: budget?.slideId ?? null,
      order: slide?.order ?? null,
      contentUnits: contentUnitCount,
      maxWords: maxWords ?? null,
      withinContentBudget,
      primarySupports: supportCount,
      maxPrimarySupports: maxPrimarySupports ?? null,
      withinSupportBudget,
      timeSeconds: budget?.timeSeconds ?? null,
      canSplit: budget?.canSplit ?? null,
      semanticBreak,
      continuationOf,
      mustKeepTogether: [...asArray(budget?.mustKeepTogether)],
      notesOnly: [...asArray(budget?.notesOnly)],
      continuation: {
        valid: continuationViolations.length === 0,
        violations: [...new Set(continuationViolations)]
      },
      withinBudget: withinContentBudget && withinSupportBudget
    };
  });

  const briefDuration = plan?.brief?.durationMinutes;
  const briefSeconds = Number.isFinite(briefDuration) ? Math.round(briefDuration * 60) : null;
  const timeValues = budgets.map((budget) => budget?.timeSeconds);
  const plannedSeconds = timeValues.every(Number.isFinite)
    ? timeValues.reduce((total, seconds) => total + seconds, 0)
    : null;
  const deltaSeconds = briefSeconds === null || plannedSeconds === null ? null : plannedSeconds - briefSeconds;
  const durationMatches = deltaSeconds === 0;
  if (!durationMatches) {
    warnings.push(finding(
      "W_PAGINATION_DURATION_MISMATCH",
      "$.pagination.pageBudgets",
      "Planned page duration does not match the brief duration",
      { briefSeconds, plannedSeconds, deltaSeconds }
    ));
  }

  return {
    version: PAGINATION_REPORT_VERSION,
    kind: "text-to-html.pagination-diagnostics",
    status: reportStatus(errors, warnings),
    deck: {
      id: plan?.deck?.id ?? null,
      title: plan?.deck?.title ?? null,
      slideCount: slides.length
    },
    duration: {
      briefSeconds,
      plannedSeconds,
      deltaSeconds,
      matches: durationMatches
    },
    coverage,
    pages,
    continuations: pages
      .filter((page) => page.continuationOf !== null || page.canSplit === true)
      .map((page) => ({
        slideId: page.slideId,
        continuationOf: page.continuationOf,
        canSplit: page.canSplit,
        semanticBreak: page.semanticBreak,
        valid: page.continuation.valid,
        violations: page.continuation.violations
      })),
    errors,
    warnings
  };
}
