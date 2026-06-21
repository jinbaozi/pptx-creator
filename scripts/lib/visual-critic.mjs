const DEFAULT_SIZE = { width: 13.333, height: 7.5 };

import { scoreSlopRisk } from "./slop-risk.mjs";

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function addIssue(issues, issue) {
  issues.push(issue);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function consistencyAdjustments(consistencyReport) {
  if (!consistencyReport || typeof consistencyReport !== "object") {
    return { alignment: 0, designSystemFit: 0, compatibility: 0 };
  }
  let alignment = 0;
  let designSystemFit = 0;
  let compatibility = 0;

  // coordinateDriftPx > 1 reduces alignment.
  const drift = safeNumber(consistencyReport.coordinateDriftPx, null);
  if (drift !== null && drift > 1) {
    // 0 penalty at 1px; 30 at 10px; cap at 30 above 10px.
    alignment = clamp(Math.round((drift - 1) * 3.5), 0, 30);
  }

  // paletteMatch < 0.85 reduces designSystemFit.
  const palette = safeNumber(consistencyReport.paletteMatch, null);
  if (palette !== null && palette < 0.85) {
    // 0 penalty at 0.85; 30 at 0; linear.
    designSystemFit = clamp(Math.round((0.85 - palette) * 200), 0, 30);
  }

  // fontFallback non-empty reduces compatibility.
  const fontFallback = Array.isArray(consistencyReport.fontFallback)
    ? consistencyReport.fontFallback
    : [];
  if (fontFallback.length > 0) {
    // 8 penalty per fallback, capped at 30.
    compatibility = clamp(fontFallback.length * 8, 0, 30);
  }

  return { alignment, designSystemFit, compatibility };
}

function safeNumber(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function scoreSlide(slide, deckSize, adjustments) {
  const issues = [];
  const repairs = [];
  const elements = slide.elements || [];
  const slideArea = Math.max(1, number(deckSize.width, DEFAULT_SIZE.width) * number(deckSize.height, DEFAULT_SIZE.height));
  for (const el of elements) {
    const x = number(el.x);
    const y = number(el.y);
    const w = number(el.w);
    const h = number(el.h);
    if (x < 0 || y < 0 || x + w > deckSize.width || y + h > deckSize.height) {
      addIssue(issues, {
        severity: "high",
        type: "bounds",
        message: `Element ${el.id} exceeds slide bounds.`,
        target: el.id
      });
      repairs.push({
        action: "resize",
        target: el.id,
        params: { fitToSlide: true }
      });
    }
    if (el.type === "shape") {
      const areaRatio = (w * h) / slideArea;
      const isDecorativeBackground =
        areaRatio >= 0.7 &&
        !el.text &&
        !el.role &&
        !/background|backdrop|canvas/i.test(String(el.id ?? ""));
      if (isDecorativeBackground) {
        addIssue(issues, {
          severity: "medium",
          type: "dominant-empty-container",
          message: `Shape ${el.id} is an oversized empty decorative container that can dominate the slide.`,
          target: el.id
        });
        repairs.push({
          action: "removeElement",
          target: el.id,
          params: { reason: "oversized empty decorative container" }
        });
      }
    }
    if (el.type === "text") {
      const fontSize = number(el.style?.fontSize, 16);
      if (fontSize < 11) {
        addIssue(issues, {
          severity: "medium",
          type: "font-size",
          message: `Element ${el.id} uses font size below 11pt.`,
          target: el.id
        });
        repairs.push({
          action: "updateStyle",
          target: el.id,
          params: { fontSize: 11 }
        });
      }
    }
    if (el.type === "chart") {
      const data = Array.isArray(el.data) ? el.data : [];
      const labelBudget = Math.max(1, Math.floor(w / 0.45));
      if (data.length > labelBudget) {
        addIssue(issues, {
          severity: "medium",
          type: "chart-label-density",
          message: `Chart ${el.id} has more labels than the available width supports.`,
          target: el.id
        });
      }
      if (!el.description) {
        addIssue(issues, {
          severity: "medium",
          type: "chart-description",
          message: `Chart ${el.id} is missing a plain-language description.`,
          target: el.id
        });
      }
    }
    if (el.type === "diagram") {
      if (!el.description) {
        addIssue(issues, {
          severity: "medium",
          type: "diagram-description",
          message: `Diagram ${el.id} is missing a plain-language description.`,
          target: el.id
        });
      }
      const layers = el.layers ?? el.lanes;
      if (["layeredArchitecture", "compilerPipeline", "capabilityStack", "swimlane"].includes(el.kind) && (!Array.isArray(layers) || layers.length === 0)) {
        addIssue(issues, {
          severity: "high",
          type: "diagram-empty-layers",
          message: `Diagram ${el.id} has no layers or lanes.`,
          target: el.id
        });
      }
    }
  }
  if (!elements.some((el) => el.type === "text")) {
    addIssue(issues, {
      severity: "medium",
      type: "hierarchy",
      message: "Slide has no native text element.",
      target: slide.id
    });
  }
  const penalty = issues.reduce((sum, issue) => sum + (issue.severity === "high" ? 18 : 10), 0);
  const score = Math.max(0, 100 - penalty);
  const scores = {
    hierarchy: elements.some((el) => el.type === "text") ? 85 : 45,
    alignment: issues.some((issue) => issue.type === "bounds") ? 55 : 88,
    density: elements.length > 14 ? 65 : 85,
    contrast: 82,
    variety: 80,
    editability: elements.some((el) => el.type === "image") ? 78 : 95,
    designSystemFit: 82,
    compatibility: 90,
    // 9th dimension. NOT included in the penalty sum above (per U3 R7
    // and visual-critic design: slopRisk is reported alongside, not as
    // a multiplicative tax on the per-slide score). 0 by default;
    // reviewManifest() injects the real value before emitting.
    slopRisk: 0
  };
  if (adjustments) {
    scores.alignment = Math.max(0, scores.alignment - (adjustments.alignment || 0));
    scores.designSystemFit = Math.max(0, scores.designSystemFit - (adjustments.designSystemFit || 0));
    scores.compatibility = Math.max(0, scores.compatibility - (adjustments.compatibility || 0));
  }
  return {
    id: slide.id,
    score,
    scores,
    issues,
    recommendedRepairs: repairs
  };
}

export function reviewManifest(manifest, options = {}, consistencyReport = null, slopRiskReport = null) {
  const deckSize = manifest.deck?.size || DEFAULT_SIZE;
  const adjustments = consistencyAdjustments(consistencyReport);
  const designTokens = manifest?.designSystem?.tokens ?? {};
  // Per-slide slopRisk scoring. If a deck-level slopRiskReport is provided
  // (e.g. from `scripts/run-slop-risk.mjs`), distribute it evenly to every
  // slide; otherwise fall back to calling scoreSlopRisk per slide.
  const perSlideSlop = new Map();
  if (slopRiskReport && typeof slopRiskReport === "object" && Array.isArray(slopRiskReport.slides)) {
    for (const entry of slopRiskReport.slides) {
      perSlideSlop.set(entry.id ?? "(unknown)", entry);
    }
  }
  const slides = (manifest.slides || []).map((slide) => {
    const result = scoreSlide(slide, deckSize, adjustments);
    let slopEntry = perSlideSlop.get(slide.id);
    if (!slopEntry) {
      const fallback = scoreSlopRisk({ slides: [slide] }, designTokens);
      slopEntry = { id: slide.id, score: fallback.score, signals: fallback.signals };
    }
    result.scores.slopRisk = slopEntry.score;
    if (Array.isArray(slopEntry.signals)) {
      result.slopSignals = slopEntry.signals;
    }
    return result;
  });
  const deckScore = slides.length
    ? Math.round(slides.reduce((sum, slide) => sum + slide.score, 0) / slides.length)
    : 0;
  const slopRiskDeck = slides.length
    ? Math.round(slides.reduce((sum, slide) => sum + (slide.scores.slopRisk ?? 0), 0) / slides.length)
    : 0;
  const review = {
    mode: options.mode || "creative",
    deckScore,
    slopRisk: slopRiskDeck,
    slides
  };
  if (consistencyReport) {
    review.consistencyAdjustments = adjustments;
  }
  return review;
}
