export const NARRATIVE_REPORT_VERSION = "1.0.0";

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

function coverageDiagnostic({ expectedIds, actualIds, path, code, label, errors }) {
  const expected = new Set(expectedIds);
  const unknownSlideIds = actualIds.filter((id) => !expected.has(id));
  const duplicateSlideIds = duplicateIds(actualIds);
  const missingSlideIds = expectedIds.filter((id) => !actualIds.includes(id));
  const matches = actualIds.length === expectedIds.length && actualIds.every((id, index) => id === expectedIds[index]);
  if (!matches) {
    errors.push(finding(code, path, `${label} must cover slides exactly once in slide order`, {
      expectedSlideIds: [...expectedIds],
      actualSlideIds: [...actualIds],
      missingSlideIds,
      unknownSlideIds,
      duplicateSlideIds
    }));
  }
  return {
    expectedSlideIds: [...expectedIds],
    actualSlideIds: [...actualIds],
    matches,
    missingSlideIds,
    unknownSlideIds,
    duplicateSlideIds
  };
}

function titleChainDiagnostic(slides, titleChain, errors) {
  const expected = slides.map((slide) => slide.title.trim());
  const declared = asArray(titleChain);
  const matches = declared.length === expected.length
    && declared.every((title, index) => typeof title === "string" && title.trim() === expected[index]);
  if (!matches) {
    errors.push(finding(
      "E_NARRATIVE_TITLE_CHAIN",
      "$.narrative.titleChain",
      "narrative.titleChain must reproduce slide titles in order",
      { expected, declared: [...declared] }
    ));
  }
  return { expected, declared: [...declared], matches };
}

/**
 * Calculates a read-only narrative diagnostic for a Plan 2.0 object.
 * Callers validate the input separately; this reporter never changes the plan.
 */
export function analyzeNarrative(plan) {
  const errors = [];
  const warnings = [];
  const slides = asArray(plan?.slides);
  const narrative = plan?.narrative ?? {};
  const slideIds = slides.map((slide) => slide.id);
  const slideById = new Map(slides.map((slide) => [slide.id, slide]));
  const beats = asArray(narrative.beats);
  const beatById = new Map(beats.map((beat) => [beat.id, beat]));
  const chapters = asArray(narrative.chapters);

  const titleChain = titleChainDiagnostic(slides, narrative.titleChain, errors);

  const chapterItems = chapters.map((chapter, index) => {
    const beatIds = asArray(chapter.beatIds);
    const slideRefs = asArray(chapter.slideIds);
    const unknownBeatIds = beatIds.filter((id) => !beatById.has(id));
    if (unknownBeatIds.length > 0) {
      errors.push(finding(
        "E_NARRATIVE_REF",
        `$.narrative.chapters[${index}].beatIds`,
        "Chapter references unknown beat IDs",
        { unknownBeatIds }
      ));
    }
    return {
      id: chapter.id,
      title: chapter.title,
      beatIds: [...beatIds],
      slideIds: [...slideRefs],
      unknownBeatIds
    };
  });
  const chapterCoverage = coverageDiagnostic({
    expectedIds: slideIds,
    actualIds: chapterItems.flatMap((chapter) => chapter.slideIds),
    path: "$.narrative.chapters",
    code: "E_NARRATIVE_COVERAGE",
    label: "narrative.chapters",
    errors
  });

  const beatItems = beats.map((beat) => ({
    id: beat.id,
    role: beat.role,
    text: beat.text,
    slideIds: [...asArray(beat.slideIds)]
  }));
  const beatCoverage = coverageDiagnostic({
    expectedIds: slideIds,
    actualIds: beatItems.flatMap((beat) => beat.slideIds),
    path: "$.narrative.beats",
    code: "E_NARRATIVE_COVERAGE",
    label: "narrative.beats",
    errors
  });

  const assignedBeatIds = chapterItems.flatMap((chapter) => chapter.beatIds);
  const unassignedBeatIds = beatItems.map((beat) => beat.id).filter((id) => !assignedBeatIds.includes(id));
  const repeatedBeatIds = duplicateIds(assignedBeatIds);
  if (unassignedBeatIds.length > 0 || repeatedBeatIds.length > 0) {
    warnings.push(finding(
      "W_NARRATIVE_CHAPTER_BEAT_ASSIGNMENT",
      "$.narrative.chapters",
      "Chapter-to-beat assignments are incomplete or repeated",
      { unassignedBeatIds, repeatedBeatIds }
    ));
  }

  const attentionPoints = asArray(narrative.attentionCurve).map((point) => ({
    slideId: point?.slideId,
    order: slideById.get(point?.slideId)?.order ?? null,
    level: point?.level
  }));
  const attentionCoverage = coverageDiagnostic({
    expectedIds: slideIds,
    actualIds: attentionPoints.map((point) => point.slideId),
    path: "$.narrative.attentionCurve",
    code: "E_NARRATIVE_ATTENTION",
    label: "narrative.attentionCurve",
    errors
  });
  const invalidAttentionPoints = attentionPoints
    .filter((point) => !Number.isInteger(point.level) || point.level < 1 || point.level > 5)
    .map((point) => point.slideId);
  if (invalidAttentionPoints.length > 0) {
    errors.push(finding(
      "E_NARRATIVE_ATTENTION",
      "$.narrative.attentionCurve",
      "Attention levels must be integer values from 1 through 5",
      { invalidAttentionPoints }
    ));
  }
  const validLevels = attentionPoints.map((point) => point.level).filter((level) => Number.isInteger(level));
  const peakLevel = validLevels.length > 0 ? Math.max(...validLevels) : null;
  const peakSlideIds = peakLevel === null
    ? []
    : attentionPoints.filter((point) => point.level === peakLevel).map((point) => point.slideId);

  const closingSlides = slides.filter((slide) => (
    resolveLayoutArchetype(slide.intent)?.legacyType === "closing"
    || resolveLayoutArchetype(slide.layoutArchetype)?.legacyType === "closing"
  ));
  const closingSlideIds = closingSlides.map((slide) => slide.id);
  const actionSlideIds = closingSlides
    .filter((slide) => typeof slide.slots?.action?.text === "string" && slide.slots.action.text.trim())
    .map((slide) => slide.id);
  if (closingSlideIds.length === 0) {
    errors.push(finding(
      "E_NARRATIVE_ACTION",
      "$.slides",
      "A narrative must include a closing/action slide",
      { closingSlideIds }
    ));
  }
  if (actionSlideIds.length !== closingSlideIds.length) {
    errors.push(finding(
      "E_NARRATIVE_ACTION",
      "$.slides",
      "Each closing/action slide must declare an action",
      { closingSlideIds, actionSlideIds }
    ));
  }
  const actionBeatIds = beatItems.filter((beat) => beat.role === "action").map((beat) => beat.id);
  const attentionBySlideId = new Map(attentionPoints.map((point) => [point.slideId, point.level]));

  return {
    version: NARRATIVE_REPORT_VERSION,
    kind: "text-to-html.narrative-diagnostics",
    status: reportStatus(errors, warnings),
    deck: {
      id: plan?.deck?.id ?? null,
      title: plan?.deck?.title ?? null,
      slideCount: slides.length
    },
    narrative: {
      framework: narrative.framework ?? null,
      thesis: narrative.thesis ?? null
    },
    titleChain,
    chapters: {
      coverage: chapterCoverage,
      items: chapterItems,
      beatAssignment: {
        assignedBeatIds,
        unassignedBeatIds,
        repeatedBeatIds
      }
    },
    beats: {
      coverage: beatCoverage,
      items: beatItems
    },
    attention: {
      coverage: attentionCoverage,
      points: attentionPoints,
      peakLevel,
      peakSlideIds
    },
    action: {
      desiredAction: plan?.brief?.desiredAction ?? null,
      closingSlideIds,
      actionSlideIds,
      actionBeatIds,
      attentionLevels: closingSlideIds.map((slideId) => ({
        slideId,
        level: attentionBySlideId.get(slideId) ?? null
      }))
    },
    errors,
    warnings
  };
}
import { resolveLayoutArchetype } from "./archetypes.mjs";
