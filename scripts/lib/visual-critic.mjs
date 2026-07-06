const DEFAULT_SIZE = { width: 13.333, height: 7.5 };

import { scoreSlopRisk } from "./slop-risk.mjs";
import { checkBounds, checkFontSize } from "./check-layout-safety.mjs";

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

function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\{[^}]+\}$/.test(trimmed)) return null;
  const match = trimmed.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function relativeLuminance(hexColor) {
  const hex = normalizeHexColor(hexColor);
  if (!hex) return null;
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  if (fg === null || bg === null) return null;
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

function isLightColor(hexColor) {
  const luminance = relativeLuminance(hexColor);
  return luminance !== null && luminance >= 0.65;
}

function rgbChannels(hexColor) {
  const hex = normalizeHexColor(hexColor);
  if (!hex) return null;
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => Number.parseInt(part, 16));
}

function colorSaturation(hexColor) {
  const channels = rgbChannels(hexColor);
  if (!channels) return null;
  const [r, g, b] = channels.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const lightness = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * lightness - 1));
}

function isNeutralGrayText(hexColor) {
  const luminance = relativeLuminance(hexColor);
  const saturation = colorSaturation(hexColor);
  return luminance !== null && saturation !== null && saturation <= 0.22 && luminance > 0.12 && luminance < 0.85;
}

function isChromaticBackground(hexColor) {
  const saturation = colorSaturation(hexColor);
  return saturation !== null && saturation >= 0.35;
}

function firstFontFamily(value) {
  if (typeof value !== "string") return null;
  const [first] = value.split(",");
  return first ? first.trim().replace(/^["']|["']$/g, "").toLowerCase() : null;
}

function isOverusedDefaultFont(value) {
  const first = firstFontFamily(value);
  return ["arial", "helvetica", "inter", "system-ui", "-apple-system", "sans-serif"].includes(first);
}

function isPureBlack(value) {
  const hex = normalizeHexColor(value);
  return hex === "#000000";
}

function numericTokens(text) {
  if (typeof text !== "string") return [];
  return text.match(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\w.])/g) ?? [];
}

function isFakePerfectNumber(token) {
  const value = String(token ?? "").trim();
  if (!value) return false;
  if (/^(?:99(?:\.9+)?|100(?:\.0+)?)%$/.test(value)) return true;
  if (/^(?:0|50(?:\.0+)?)%$/.test(value)) return true;
  const compact = value.replace(/,/g, "").replace(/%$/, "");
  if (/^1234567(?:\.0+)?$/.test(compact)) return true;
  if (/^(.)\1{3,}(?:\.0+)?$/.test(compact)) return true;
  return false;
}

function elementBox(element) {
  return {
    x: number(element.x),
    y: number(element.y),
    w: number(element.w),
    h: number(element.h)
  };
}

function overlapArea(a, b) {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const w = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  return w * h;
}

function shapeFillColor(element) {
  return normalizeHexColor(element.style?.backgroundColor ?? element.style?.fill ?? element.style?.color);
}

function isCardLikeShape(element, slideArea) {
  if (element.type !== "shape") return false;
  const box = elementBox(element);
  const areaRatio = (box.w * box.h) / slideArea;
  if (areaRatio < 0.02 || areaRatio > 0.6) return false;
  const shape = String(element.shape ?? "rect").toLowerCase();
  if (!["rect", "roundrect"].includes(shape)) return false;
  if (/background|backdrop|canvas/i.test(String(element.id ?? ""))) return false;
  return Boolean(shapeFillColor(element) || element.style?.borderColor || element.style?.line || element.style?.shadow);
}

function isTemplateCenteredStack(elements, deckSize, slideArea) {
  const deckWidth = number(deckSize.width, DEFAULT_SIZE.width);
  const deckCenter = deckWidth / 2;
  const candidates = elements
    .filter((element) => ["text", "shape"].includes(element.type))
    .filter((element) => !/background|backdrop|canvas/i.test(String(element.id ?? "")))
    .map(elementBox)
    .filter((box) => {
      const areaRatio = (box.w * box.h) / slideArea;
      const widthRatio = box.w / deckWidth;
      return box.w > 0 && box.h > 0 && areaRatio >= 0.004 && areaRatio <= 0.25 && widthRatio >= 0.35 && widthRatio <= 0.75;
    });

  if (candidates.length < 4) return false;
  const centered = candidates.filter((box) => Math.abs(box.x + box.w / 2 - deckCenter) <= 0.25);
  if (centered.length < 4) return false;

  const centers = centered.map((box) => box.x + box.w / 2);
  const widths = centered.map((box) => box.w);
  const yPositions = centered.map((box) => box.y);
  const centerSpread = Math.max(...centers) - Math.min(...centers);
  const widthSpread = Math.max(...widths) - Math.min(...widths);
  const ySpread = Math.max(...yPositions) - Math.min(...yPositions);
  const distinctRows = new Set(yPositions.map((value) => Math.round(value * 5) / 5)).size;

  return centerSpread <= 0.18 && widthSpread <= 0.35 && ySpread >= 2.0 && distinctRows >= 4;
}

function contrastBackgroundForText(textElement, elements, slideBackgroundColor) {
  const textBox = elementBox(textElement);
  const textArea = Math.max(0.01, textBox.w * textBox.h);
  let best = null;

  elements.forEach((candidate, index) => {
    if (candidate.type !== "shape") return;
    const fill = shapeFillColor(candidate);
    if (!fill) return;
    const area = overlapArea(textBox, elementBox(candidate));
    if (area / textArea < 0.45) return;
    if (!best || area > best.area || (area === best.area && index > best.index)) {
      best = { color: fill, area, index };
    }
  });

  return best?.color ?? slideBackgroundColor;
}

function addTasteImpeccableSlideIssues(slide, elements, deckSize, slideArea, issues, options = {}) {
  const backgroundColor = slide.background?.type === "solid" ? normalizeHexColor(slide.background.color) : null;
  const replicaMode = options.mode === "replica" || options.designMode === "replica";

  for (const el of elements) {
    if (el.type !== "text" || !backgroundColor) continue;
    const localBackgroundColor = contrastBackgroundForText(el, elements, backgroundColor);
    const ratio = contrastRatio(el.style?.color, localBackgroundColor);
    if (ratio === null) continue;
    const fontSize = number(el.style?.fontSize, 16);
    const largeText = fontSize >= 18 || Boolean(el.style?.bold);
    const threshold = largeText ? 3 : 4.5;
    if (ratio < threshold) {
      addIssue(issues, {
        severity: "high",
        type: "text-contrast",
        message: `Element ${el.id} has contrast ${ratio.toFixed(2)}:1, below the ${threshold}:1 threshold.`,
        target: el.id
      });
    }
  }

  if (!replicaMode) {
    for (const el of elements) {
      if (el.type === "text" && isOverusedDefaultFont(el.style?.fontFamily)) {
        addIssue(issues, {
          severity: "medium",
          type: "overused-font",
          message: `Element ${el.id} uses a default web font; choose a more intentional type direction or design-system token.`,
          target: el.id
        });
      }

      if (el.type === "text") {
        const localBackgroundColor = backgroundColor ? contrastBackgroundForText(el, elements, backgroundColor) : null;
        if (isNeutralGrayText(el.style?.color) && isChromaticBackground(localBackgroundColor)) {
          addIssue(issues, {
            severity: "medium",
            type: "gray-on-color",
            message: `Element ${el.id} uses neutral gray text on a chromatic background; use a deliberate light/dark or tinted foreground.`,
            target: el.id
          });
        }

        const fakeNumber = numericTokens(el.text).find(isFakePerfectNumber);
        if (fakeNumber) {
          addIssue(issues, {
            severity: "medium",
            type: "fake-perfect-number",
            message: `Element ${el.id} uses a template-like metric (${fakeNumber}); use real measured data or mark the value as illustrative.`,
            target: el.id
          });
        }
      }

      const shadow = el.style?.shadow;
      if (el.type === "shape" && shadow?.type === "outer" && isPureBlack(shadow.color) && number(shadow.opacity, 0) >= 0.25 && isLightColor(backgroundColor)) {
        addIssue(issues, {
          severity: "medium",
          type: "black-shadow",
          message: `Shape ${el.id} uses a heavy pure-black shadow on a light background; tint or soften the shadow.`,
          target: el.id
        });
      }
    }

    const cardShapes = elements.filter((el) => isCardLikeShape(el, slideArea));
    for (const inner of cardShapes) {
      const innerBox = elementBox(inner);
      const innerArea = Math.max(0.01, innerBox.w * innerBox.h);
      const parent = cardShapes.find((candidate) => {
        if (candidate.id === inner.id) return false;
        const parentBox = elementBox(candidate);
        const parentArea = Math.max(0.01, parentBox.w * parentBox.h);
        if (parentArea <= innerArea) return false;
        return overlapArea(innerBox, parentBox) / innerArea >= 0.85;
      });
      if (!parent) continue;
      addIssue(issues, {
        severity: "medium",
        type: "nested-card",
        message: `Shape ${inner.id} is nested inside ${parent.id}; flatten the card structure or create hierarchy without card-in-card framing.`,
        target: inner.id
      });
    }

    if (isTemplateCenteredStack(elements, deckSize, slideArea)) {
      addIssue(issues, {
        severity: "medium",
        type: "template-stack-layout",
        message: "Slide uses a centered same-width content stack; add compositional variance, asymmetry, or stronger visual rhythm.",
        target: slide.id
      });
    }
  }

  const repeatedShapeBuckets = new Map();
  for (const el of elements) {
    if (el.type !== "shape") continue;
    const areaRatio = (number(el.w) * number(el.h)) / slideArea;
    if (areaRatio < 0.025 || areaRatio > 0.25) continue;
    const key = `${Math.round(number(el.w) * 10) / 10}x${Math.round(number(el.h) * 10) / 10}`;
    repeatedShapeBuckets.set(key, (repeatedShapeBuckets.get(key) ?? 0) + 1);
  }
  const repeatedCount = Math.max(0, ...repeatedShapeBuckets.values());
  if (repeatedCount >= 3) {
    addIssue(issues, {
      severity: "medium",
      type: "layout-repetition",
      message: "Slide repeats three or more similarly sized card shapes; add hierarchy, rhythm, or visual variation.",
      target: slide.id
    });
  }

  for (const effect of slide.replicaUnsupportedEffects ?? []) {
    addIssue(issues, {
      severity: "medium",
      type: "replica-unsupported-effect",
      message: `Replica element ${effect.elementId} uses a browser effect that may need native approximation or a local raster layer.`,
      target: effect.elementId
    });
  }

  const coverage = slide.replicaCoverage;
  if (coverage && typeof coverage.coverage === "number" && coverage.coverage < 1) {
    addIssue(issues, {
      severity: "high",
      type: "replica-coverage",
      message: `Replica preserved ${coverage.coveredElements}/${coverage.measuredElements} measured elements as native PPT layers.`,
      target: slide.id
    });
  }
}

function scoreSlide(slide, deckSize, adjustments, options = {}) {
  const issues = [];
  const repairs = [];
  const elements = slide.elements || [];
  const designTokens = options.designTokens ?? {};
  const slideArea = Math.max(1, number(deckSize.width, DEFAULT_SIZE.width) * number(deckSize.height, DEFAULT_SIZE.height));
  for (const el of elements) {
    const x = number(el.x);
    const y = number(el.y);
    const w = number(el.w);
    const h = number(el.h);
    const boundsIssue = checkBounds(el, deckSize);
    if (boundsIssue) {
      addIssue(issues, boundsIssue);
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
      const fontSizeIssue = checkFontSize(el, designTokens);
      if (fontSizeIssue) {
        addIssue(issues, fontSizeIssue);
        const resolvedFontSize = number(el.style?.fontSize, 16);
        const repairTarget = resolvedFontSize < 16 ? 16 : Math.max(resolvedFontSize, 11);
        repairs.push({
          action: "updateStyle",
          target: el.id,
          params: { fontSize: repairTarget }
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
  addTasteImpeccableSlideIssues(slide, elements, deckSize, slideArea, issues, options);
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
  const mode = options.mode || manifest.designSystem?.mode || "creative";
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
    const result = scoreSlide(slide, deckSize, adjustments, {
      ...options,
      mode,
      designMode: manifest.designSystem?.mode,
      designTokens
    });
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
    mode,
    deckScore,
    slopRisk: slopRiskDeck,
    slides
  };
  if (consistencyReport) {
    review.consistencyAdjustments = adjustments;
  }
  return review;
}
