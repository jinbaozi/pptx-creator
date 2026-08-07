import { expandChartElement } from "./chart-renderer.mjs";
import { expandDiagramElement } from "./diagram-compiler.mjs";

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_MARGIN_PT = 0.05;
const EPSILON_IN = 0.005;

const MINIMUM_FONT_SIZE = Object.freeze({
  title: 16,
  heading: 16,
  "card-title": 12,
  metric: 24,
  "card-metric": 20,
  caption: 8,
  body: 11
});

const CREATIVE_MINIMUM_FONT_SIZE = Object.freeze({
  title: 28,
  heading: 18,
  "card-title": 18,
  metric: 24,
  "card-metric": 20,
  "table-header": 11,
  label: 11,
  source: 9,
  caption: 9,
  "list-item": 16,
  body: 16
});

function resolveToken(value, tokens) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\{([^}]+)\}$/);
  if (!match) return value;
  let cursor = tokens;
  for (const segment of match[1].split(".")) cursor = cursor?.[segment];
  return cursor ?? value;
}

function resolvedTypography(element, tokens) {
  const value = resolveToken(element.style?.typography, tokens);
  return value && typeof value === "object" ? value : {};
}

function resolvedFont(element, tokens) {
  const typography = resolvedTypography(element, tokens);
  return {
    fontFamily: element.style?.fontFamily ?? typography.fontFamily,
    fontWeight: element.style?.fontWeight ?? typography.fontWeight ?? (element.style?.bold ? 700 : 400),
    italic: element.style?.italic ?? typography.italic ?? false,
    allowFallback: true
  };
}

export function materializeTextFonts(manifest, designTokens = {}, fontCatalog = {}) {
  const next = structuredClone(manifest);
  const substitutions = [];
  const defaultFamily = designTokens.typography?.body?.fontFamily;

  const requestedFrom = (style, fallback) => style?.fontFamily ?? fallback ?? defaultFamily;
  const fontRequest = (style, family) => ({
    family,
    fontWeight: style?.fontWeight ?? style?.weight,
    fontStyle: style?.fontStyle ?? style?.style,
    italic: style?.italic,
    fontStretch: style?.fontStretch ?? style?.stretch,
    variationAxes: style?.variationAxes ?? style?.axes
  });
  const withFamily = (source, family, postscriptName = null) => {
    if (source?.style && typeof source.style === "object") {
      return {
        ...source,
        style: { ...source.style, fontFamily: family },
        fontFamily: family,
        ...(postscriptName ? { resolvedPostscriptName: postscriptName } : {})
      };
    }
    return {
      ...source,
      fontFamily: family,
      ...(postscriptName ? { resolvedPostscriptName: postscriptName } : {})
    };
  };
  const segmentsFor = (text, style, requested) => {
    if (!requested) return [];
    const source = String(text ?? "");
    if (typeof fontCatalog.resolveFontSegments === "function") {
      const segments = fontCatalog.resolveFontSegments(fontRequest(style, requested), source);
      if (Array.isArray(segments) && segments.length > 0
        && segments.map((segment) => String(segment?.text ?? "")).join("") === source) {
        return segments;
      }
    }
    if (typeof fontCatalog.resolveFontFamily !== "function") return [];
    const family = fontCatalog.resolveFontFamily(fontRequest(style, requested), source);
    return family ? [{ text: source, fontFamily: family, postscriptName: null }] : [];
  };
  const recordSubstitution = (context, requested, segment, scope) => {
    const requestedFamilies = String(requested ?? "").split(",")
      .map((family) => family.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
      .filter(Boolean);
    if (!segment?.fontFamily || requestedFamilies.includes(String(segment.fontFamily).toLowerCase())) return;
    substitutions.push({ ...context, scope, requested, resolved: segment.fontFamily, text: segment.text });
  };
  const materializeRuns = (runs, inheritedStyle, inheritedFamily, context, scope) => {
    const result = [];
    for (const [runIndex, rawRun] of runs.entries()) {
      const run = typeof rawRun === "string" ? { text: rawRun } : rawRun ?? { text: "" };
      const style = { ...inheritedStyle, ...run, ...(run.style ?? {}) };
      const requested = requestedFrom(style, inheritedFamily);
      const segments = segmentsFor(run.text ?? "", style, requested);
      if (segments.length === 0) {
        result.push({ ...run });
        continue;
      }
      for (const segment of segments) {
        result.push(withFamily({ ...run, text: segment.text }, segment.fontFamily, segment.postscriptName));
        recordSubstitution({ ...context, runIndex }, requested, segment, scope);
      }
    }
    return result;
  };
  const materializeTextOwner = (owner, inheritedStyle, inheritedFamily, context, scope, textKey = "text", runsKey = "runs") => {
    const style = { ...inheritedStyle, ...(owner?.style ?? {}) };
    const rawRuns = Array.isArray(owner?.[runsKey]) ? owner[runsKey] : [];
    const runFamily = rawRuns.find((run) => run && typeof run === "object" && (run.fontFamily || run.style?.fontFamily));
    const requested = requestedFrom(style, inheritedFamily ?? runFamily?.fontFamily ?? runFamily?.style?.fontFamily);
    if (!requested) return;
    const runs = rawRuns.length > 0
      ? materializeRuns(rawRuns, style, requested, context, scope)
      : segmentsFor(owner?.[textKey] ?? "", style, requested).map((segment, runIndex) => {
        recordSubstitution({ ...context, runIndex }, requested, segment, scope);
        return withFamily({ text: segment.text }, segment.fontFamily, segment.postscriptName);
      });
    const families = new Set(runs.map((run) => run.fontFamily).filter(Boolean));
    if (runs.length > 1 || rawRuns.length > 0) owner[runsKey] = runs;
    const resolved = families.size === 1 ? [...families][0] : requested;
    if (owner.style && typeof owner.style === "object") owner.style = { ...owner.style, fontFamily: resolved };
    else owner.fontFamily = resolved;
  };

  for (const slide of next.slides ?? []) {
    for (const element of slide.elements ?? []) {
      if (!element || typeof element !== "object") continue;
      const typography = resolvedTypography(element, designTokens);
      const inheritedStyle = { ...typography, ...(element.style ?? {}) };
      const inheritedFamily = requestedFrom(inheritedStyle, defaultFamily);
      const context = { slideId: slide.id, elementId: element.id };
      if (element.type === "text") {
        element.style = { ...(element.style ?? {}) };
        materializeTextOwner(element, typography, inheritedFamily, context, "run");
      } else if (element.type === "table") {
        for (const [sectionIndex, section] of (element.sections ?? []).entries()) {
          for (const [rowIndex, row] of (section.rows ?? []).entries()) {
            for (const [cellIndex, cell] of (row.cells ?? []).entries()) {
              if (!cell || typeof cell !== "object") continue;
              materializeTextOwner(cell, inheritedStyle, inheritedFamily, {
                ...context, sectionIndex, rowIndex, cellIndex
              }, "table-cell");
            }
          }
        }
        if (element.caption) {
          const captionOwner = { text: element.caption, runs: element.captionRuns ?? [], style: element.captionStyle ?? {} };
          materializeTextOwner(captionOwner, inheritedStyle, inheritedFamily, context, "table-caption");
          element.captionRuns = captionOwner.runs;
        }
      } else if (element.type === "chart") {
        const chartText = (element.data ?? []).flatMap((point) => [
          point?.label,
          ...Object.keys(point?.series && typeof point.series === "object" ? point.series : {})
        ]).filter((value) => value !== null && value !== undefined).join(" ");
        const requested = inheritedFamily;
        const resolved = typeof fontCatalog.resolveFontFamily === "function"
          ? fontCatalog.resolveFontFamily(fontRequest(inheritedStyle, requested), chartText)
          : null;
        if (resolved) {
          element.style = { ...(element.style ?? {}), fontFamily: resolved };
          const requestedFamilies = String(requested ?? "").split(",")
            .map((family) => family.trim().replace(/^['"]|['"]$/g, "").toLowerCase());
          if (!requestedFamilies.includes(String(resolved).toLowerCase())) {
            substitutions.push({ ...context, scope: "chart", requested, resolved, text: chartText });
          }
        }
      }
    }
  }
  return { manifest: next, substitutions };
}

function inferRole(element, fontSize) {
  if (typeof element.role === "string" && (MINIMUM_FONT_SIZE[element.role] || CREATIVE_MINIMUM_FONT_SIZE[element.role])) return element.role;
  const id = String(element.id ?? "").toLowerCase();
  if (/source/.test(id)) return "source";
  if (/caption|footnote/.test(id)) return "caption";
  if (/label/.test(id)) return "label";
  if (/table[-_]?header|(^|[-_])th([-_]|$)/.test(id)) return "table-header";
  if (/metric|kpi|stat|big-number/.test(id)) return "metric";
  if (/title|headline|heading/.test(id)) return "title";
  return fontSize >= 32 ? "metric" : fontSize >= 18 ? "heading" : "body";
}

function marginPoints(value) {
  if (Array.isArray(value)) {
    const [top = 0, right = top, bottom = top, left = right] = value.map((item) => Number(item) || 0);
    return { top, right, bottom, left };
  }
  const all = Number.isFinite(Number(value)) ? Number(value) : DEFAULT_MARGIN_PT;
  return { top: all, right: all, bottom: all, left: all };
}

function segmentsForLine(line) {
  if (!line) return [""];
  if (/\s/.test(line)) return line.match(/\S+\s*|\s+/g) ?? [line];
  return [...line];
}

function wrappedLineCount(text, widthPt, fontSize, measureText, font) {
  let lineCount = 0;
  for (const explicitLine of String(text ?? "").split("\n")) {
    const segments = segmentsForLine(explicitLine);
    let current = "";
    let lines = 1;
    for (const segment of segments) {
      const candidate = `${current}${segment}`;
      const measuredWidth = measureText(candidate, fontSize, font);
      const effectiveWidth = Number.isFinite(measuredWidth) ? measuredWidth : heuristicMeasure(candidate, fontSize);
      if (current && effectiveWidth > widthPt) {
        lines += 1;
        current = segment.trimStart();
      } else {
        current = candidate;
      }
    }
    lineCount += lines;
  }
  return Math.max(1, lineCount);
}

function heuristicMeasure(text, fontSize) {
  let units = 0;
  for (const char of String(text ?? "")) units += /[　-〿぀-ゟ゠-ヿ一-鿿＀-￯]/.test(char) ? 1 : 0.55;
  return units * fontSize;
}

export function measureTextElement(element, options = {}) {
  const tokens = options.tokens ?? {};
  const typography = resolvedTypography(element, tokens);
  const fontSize = Number(element.style?.fontSize ?? typography.fontSize ?? DEFAULT_FONT_SIZE);
  const lineHeight = Number(element.style?.lineHeight ?? typography.lineHeight ?? DEFAULT_LINE_HEIGHT);
  const margin = marginPoints(element.style?.margin);
  const bulletIndent = typeof element.style?.bullet === "object" ? Number(element.style.bullet.indent ?? 0) : 0;
  const availableWidth = Math.max(0, Number(element.w) - (margin.left + margin.right + bulletIndent) / 72);
  const availableHeight = Math.max(0, Number(element.h));
  const baseMeasureText = options.measureText ?? heuristicMeasure;
  const charSpacing = Number(element.style?.charSpacing ?? typography.charSpacing ?? 0);
  const measureText = (text, size, font) => {
    const width = baseMeasureText(text, size, font);
    return width + Math.max(0, [...String(text ?? "")].length - 1) * charSpacing;
  };
  const lineCount = wrappedLineCount(element.text, availableWidth * 72, fontSize, measureText, options.font);
  const maxLines = Number.isInteger(Number(element.maxLines)) ? Number(element.maxLines) : null;
  const lineLimitExceeded = maxLines !== null && lineCount > maxLines;
  const requiredHeight = (lineCount * fontSize * lineHeight + margin.top + margin.bottom) / 72;
  const overflowBy = Math.max(0, requiredHeight - availableHeight);
  const role = inferRole(element, fontSize);
  const minimumFontSize = Number(options.minimumFontSize ?? MINIMUM_FONT_SIZE[role] ?? MINIMUM_FONT_SIZE.body);
  const maxHeight = Math.max(0, Number(options.maxHeight ?? availableHeight));
  const suggestedFontSize = requiredHeight > 0
    ? Math.max(0, fontSize * ((availableHeight - (margin.top + margin.bottom) / 72) / Math.max(EPSILON_IN, requiredHeight - (margin.top + margin.bottom) / 72)))
    : fontSize;
  let status = "fits";
  let suggestion;
  if (lineLimitExceeded) {
    status = "content-reflow-required";
  } else if (overflowBy > EPSILON_IN) {
    if (requiredHeight <= maxHeight + EPSILON_IN) {
      status = "resize-required";
      suggestion = { operation: "resize", changes: { h: Number(requiredHeight.toFixed(4)) } };
    } else if (suggestedFontSize >= minimumFontSize) {
      status = "font-reduction-required";
      suggestion = { operation: "updateStyle", changes: { fontSize: Number(suggestedFontSize.toFixed(2)) } };
    } else {
      status = "content-reflow-required";
    }
  }
  return {
    status,
    box: { x: Number(element.x), y: Number(element.y), w: Number(element.w), h: Number(element.h) },
    fontSize,
    minimumFontSize,
    lineCount,
    ...(maxLines !== null ? { maxLines } : {}),
    requiredHeight: Number(requiredHeight.toFixed(6)),
    availableWidth: Number(availableWidth.toFixed(6)),
    availableHeight,
    overflowBy: Number(overflowBy.toFixed(6)),
    suggestedFontSize: Number(Math.max(0, suggestedFontSize).toFixed(4)),
    ...(suggestion ? { suggestion } : {})
  };
}

export async function buildTextFitReport(manifest = {}, options = {}) {
  const source = options.source ?? options.fontCatalog?.source ?? (options.measureText ? "fontkit" : "heuristic");
  if (source === "unavailable") {
    return {
      version: "0.1.0",
      source,
      status: "unavailable",
      summary: { checked: 0, overflowCount: 0 },
      slides: [],
      reason: options.reason ?? "Font measurement capability is unavailable."
    };
  }
  const deckHeight = Number(manifest.deck?.size?.height ?? 7.5);
  const designTokens = options.designTokens ?? manifest.designSystem?.tokens ?? {};
  const measureText = options.measureText
    ?? (typeof options.fontCatalog?.measureText === "function" ? options.fontCatalog.measureText.bind(options.fontCatalog) : undefined);
  let checked = 0;
  let overflowCount = 0;
  const creativeProfile = options.mode === "creative" || manifest.metadata?.qualityProfile === "creative";
  const slides = (manifest.slides ?? []).map((slide) => {
    const expandedElements = (slide.elements ?? []).flatMap((element) => {
      if (element?.type === "chart") return expandChartElement(element);
      if (element?.type === "diagram") return expandDiagramElement(element);
      return [element];
    });
    const elements = expandedElements.filter((element) => element?.type === "text").map((element) => {
      const role = inferRole(element, Number(element.style?.fontSize ?? DEFAULT_FONT_SIZE));
      const measured = measureTextElement(element, {
        tokens: designTokens,
        measureText,
        font: options.fontForElement?.(element) ?? resolvedFont(element, designTokens),
        maxHeight: maximumTextHeight(slide, element, deckHeight),
        minimumFontSize: creativeProfile
          ? CREATIVE_MINIMUM_FONT_SIZE[role] ?? CREATIVE_MINIMUM_FONT_SIZE.body
          : MINIMUM_FONT_SIZE[role] ?? MINIMUM_FONT_SIZE.body
      });
      checked += 1;
      if (measured.status !== "fits") overflowCount += 1;
      return { elementId: element.id, ...measured };
    });
    return { slideId: slide.id, elements };
  });
  return {
    version: "0.1.0",
    source,
    status: overflowCount === 0 ? "passed" : "failed",
    summary: { checked, overflowCount },
    slides
  };
}

export function applyTextFitAdjustments(manifest, report) {
  const next = structuredClone(manifest);
  const adjustments = [];
  const unresolved = [];
  for (const slideReport of report?.slides ?? []) {
    const slide = next.slides?.find((item) => item.id === slideReport.slideId);
    if (!slide) continue;
    for (const elementReport of slideReport.elements ?? []) {
      if (elementReport.status === "fits") continue;
      const element = slide.elements?.find((item) => item.id === elementReport.elementId);
      if (!element) continue;
      const suggestion = elementReport.suggestion;
      if (suggestion?.operation === "resize" && Number(suggestion.changes?.h) > 0) {
        const proposedHeight = Number(suggestion.changes.h);
        const candidate = { ...element, h: proposedHeight };
        const conflicts = (slide.elements ?? []).some((other) => other !== element
          && other.type !== "line"
          && !isBackgroundElement(other)
          && other.id !== element.semanticParentId
          && rectanglesOverlap(candidate, other));
        if (!conflicts) {
          element.h = proposedHeight;
          adjustments.push({ slideId: slide.id, elementId: element.id, operation: "resize", changes: { h: element.h } });
        } else if (Number(elementReport.suggestedFontSize) >= Number(elementReport.minimumFontSize ?? 0)) {
          element.style = { ...(element.style ?? {}), fontSize: Number(elementReport.suggestedFontSize) };
          adjustments.push({ slideId: slide.id, elementId: element.id, operation: "updateStyle", changes: { fontSize: element.style.fontSize } });
        } else {
          unresolved.push({ slideId: slide.id, elementId: element.id, status: elementReport.status });
        }
      } else if (suggestion?.operation === "updateStyle" && Number(suggestion.changes?.fontSize) >= Number(elementReport.minimumFontSize ?? 0)) {
        element.style = { ...(element.style ?? {}), fontSize: Number(suggestion.changes.fontSize) };
        adjustments.push({ slideId: slide.id, elementId: element.id, operation: "updateStyle", changes: { fontSize: element.style.fontSize } });
      } else {
        unresolved.push({ slideId: slide.id, elementId: element.id, status: elementReport.status });
      }
    }
  }
  return { manifest: next, adjustments, unresolved };
}

function rectanglesOverlap(a, b) {
  const ax2 = Number(a.x) + Number(a.w);
  const ay2 = Number(a.y) + Number(a.h);
  const bx2 = Number(b.x) + Number(b.w);
  const by2 = Number(b.y) + Number(b.h);
  const overlapW = Math.max(0, Math.min(ax2, bx2) - Math.max(Number(a.x), Number(b.x)));
  const overlapH = Math.max(0, Math.min(ay2, by2) - Math.max(Number(a.y), Number(b.y)));
  const overlapArea = overlapW * overlapH;
  const smallerArea = Math.min(Number(a.w) * Number(a.h), Number(b.w) * Number(b.h));
  return smallerArea > 0 && overlapArea / smallerArea > 0.05;
}

function isBackgroundElement(element) {
  const role = String(element?.role ?? "").toLowerCase();
  const id = String(element?.id ?? "").toLowerCase();
  return ["background", "backdrop", "canvas"].includes(role)
    || /(^|[-_])(background|backdrop|canvas)([-_]|$)/.test(id);
}

function semanticLabel(element) {
  return `${element?.role ?? ""} ${element?.layoutRegion ?? ""}`.trim().toLowerCase();
}

function isFooterElement(element) {
  return /footer|page[-_ ]?number|slide[-_ ]?number|folio/.test(semanticLabel(element));
}

function bottomInsetInches(element) {
  const padding = marginPoints(element?.style?.padding ?? 0);
  return padding.bottom / 72;
}

export function maximumTextHeight(slide, element, deckHeight) {
  const y = Number(element?.y ?? 0);
  const limits = [Number(deckHeight)];
  const elements = Array.isArray(slide?.elements) ? slide.elements : [];
  const parent = element?.semanticParentId
    ? elements.find((candidate) => candidate?.id === element.semanticParentId)
    : null;
  if (parent) limits.push(Number(parent.y) + Number(parent.h) - bottomInsetInches(parent));
  const footerTop = elements.filter(isFooterElement).reduce(
    (minimum, candidate) => Math.min(minimum, Number(candidate.y)),
    Number.POSITIVE_INFINITY
  );
  if (Number.isFinite(footerTop)) limits.push(footerTop);
  return Math.max(0, Math.min(...limits.filter(Number.isFinite)) - y);
}

function normalizeCreativeTextStyles(manifest) {
  const next = structuredClone(manifest);
  const adjustments = [];
  if (next.metadata?.qualityProfile !== "creative") return { manifest: next, adjustments };
  for (const slide of next.slides ?? []) {
    for (const element of slide.elements ?? []) {
      if (element?.type !== "text") continue;
      const role = inferRole(element, Number(element.style?.fontSize ?? DEFAULT_FONT_SIZE));
      if (role !== "table-header" || Number(element.style?.lineHeight ?? 0) <= 1.4) continue;
      element.style = { ...(element.style ?? {}), lineHeight: 1.2, valign: "middle" };
      adjustments.push({
        slideId: slide.id,
        elementId: element.id,
        operation: "updateStyle",
        changes: { lineHeight: 1.2, valign: "middle" }
      });
    }
  }
  return { manifest: next, adjustments };
}

export async function fitManifestText(manifest, options = {}) {
  const normalized = normalizeCreativeTextStyles(manifest);
  let current = normalized.manifest;
  const adjustments = [...normalized.adjustments];
  const layoutSafetyHistory = [];
  let report;
  for (let attempt = 0; attempt < Math.min(3, Math.max(1, Number(options.maxAttempts ?? 3))); attempt += 1) {
    report = await buildTextFitReport(current, options);
    if (report.status !== "failed") break;
    const applied = applyTextFitAdjustments(current, report);
    current = applied.manifest;
    adjustments.push(...applied.adjustments);
    const { preflightLayout } = await import("./check-layout-safety.mjs");
    layoutSafetyHistory.push(preflightLayout(current, {
      strict: true,
      mode: current.metadata?.qualityProfile === "replica" ? "replica" : "creative",
      measureText: options.measureText,
      fontCatalog: options.fontCatalog,
      designTokens: options.designTokens
    }));
    if (applied.adjustments.length === 0) {
      return { manifest: current, report, adjustments, unresolved: applied.unresolved, layoutSafetyHistory };
    }
  }
  report = await buildTextFitReport(current, options);
  const unresolved = report.slides.flatMap((slide) => slide.elements
    .filter((element) => element.status !== "fits")
    .map((element) => ({ slideId: slide.slideId, elementId: element.elementId, status: element.status })));
  const { preflightLayout } = await import("./check-layout-safety.mjs");
  layoutSafetyHistory.push(preflightLayout(current, {
    strict: true,
    mode: current.metadata?.qualityProfile === "replica" ? "replica" : "creative",
    measureText: options.measureText,
    fontCatalog: options.fontCatalog,
    designTokens: options.designTokens
  }));
  return { manifest: current, report, adjustments, unresolved, layoutSafetyHistory };
}

export const __test__ = { CREATIVE_MINIMUM_FONT_SIZE, heuristicMeasure, marginPoints, resolvedFont, wrappedLineCount };
