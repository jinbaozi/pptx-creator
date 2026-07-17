/**
 * check-layout-safety.mjs
 *
 * Pure-function layout-safety preflight for `deck.manifest.json`. Implements
 * the 8 detection items from U4 of the visual-design-quality-layer plan:
 *
 *   1. bounds           — element out of slide bounds (critical)
 *   2. occlusion        — unapproved content/decorative intersection
 *                         area > 1% of the smaller element area (critical)
 *   3. role-aware font-size  (critical / warning per role bucket)
 *   4. role-aware line-height (critical / warning per role bucket)
 *   5. text-overflow heuristic (warning)
 *   6. card-spacing     — two content-cards too close (warning)
 *   7. contrast         — body / title luminance ratio (critical / warning)
 *   8. letter-spacing   — CJK / Latin body letter-spacing too tight (warning)
 *
 * Exports:
 *   - `preflightLayout(manifest, options)`  → primary entry. Returns
 *     `{checks, summary: {criticalCount, warningCount, blocked, ...}}`.
 *     Internal shape — call `formatReport()` for the schema-conforming wire
 *     shape consumed by the CLI, pipeline, and U6 repair-patch adapter.
 *   - `formatReport(result, options)`       → U5 writer. Pure transform from
 *     the internal `preflightLayout()` output to the
 *     `schemas/layout-safety-report.schema.json` shape. Deterministic key
 *     order; byte-identical output across runs for the same input.
 *   - `checkBounds(element, deckSize)`      → extracted from visual-critic
 *     for reuse by `scripts/lib/visual-critic.mjs`.
 *   - `checkFontSize(element)`              → extracted from visual-critic
 *     for reuse by `scripts/lib/visual-critic.mjs`. Returns the same issue
 *     shape that visual-critic emits (`{severity, type, message, target}`).
 *
 * Role inference (per U4 spec):
 *   1. `el.role` explicit field, if present.
 *   2. `el.style.typography` token → resolve against designTokens; map
 *      token segments containing `title|hero|headline` → title,
 *      `body|caption|note` → body / caption, `metric|kpi|stat` → metric.
 *   3. ID pattern fallback: metric|kpi|stat|big-number → metric;
 *      title|hero|headline → title; caption|footnote|note → caption;
 *      else → body.
 *   4. fontSize fallback: ≥32 → metric; ≥18 → title; else → body.
 *
 * Two output shapes exist:
 *   - **Internal** (`preflightLayout` return value): `{slideId, severity,
 *     type, message, target, relatedTarget?, ...}` — mirrors the
 *     `visual-critic.mjs` issue shape so the visual-critic can reuse
 *     `checkBounds` / `checkFontSize` without translation.
 *   - **Wire** (`formatReport` return value): conforms to
 *     `schemas/layout-safety-report.schema.json`. Stable `kind` enum
 *     (separate from the internal `type`); field names use the
 *     `elementId` / `relatedElementId` vocabulary to match the schema.
 *
 * Output is JSON-serializable. The wire shape is intentionally simple so
 * the CLI wrapper (`scripts/run-layout-safety-check.mjs`), the pipeline
 * (`scripts/run-deck-pipeline.mjs`), and the U6 repair-patch adapter can
 * consume it without further transformation.
 */

import { expandChartElement } from "./chart-renderer.mjs";
import { expandDiagramElement } from "./diagram-compiler.mjs";
import { measureTextElement } from "./text-fit.mjs";
import {
  boundaryAnchor,
  connectorDirectionDot,
  connectorMetadata,
  pointDistance,
  pointTouchesBoundary,
  segmentIntersectsRectInterior
} from "./connector-resolver.mjs";

const TOLERANCE_IN = 0.005;
const CONTAINMENT_TOLERANCE_IN = 0.01;
const OVERLAP_AREA_THRESHOLD = 0.01; // 1% of smaller element area
const DECORATIVE_ROLES = new Set(["background", "backdrop", "canvas", "decoration", "ornament", "accent-rule", "decorative"]);

const FONT_SIZE_RULES = {
  body: { critical: 10, warning: 11 },
  caption: { critical: 8, warning: 10 },
  "card-title": { critical: 12, warning: 14 },
  "card-metric": { critical: 20, warning: 28 },
  title: { critical: 16, warning: 18 },
  heading: { critical: 16, warning: 18 },
  metric: { critical: 24, warning: 32 }
};

const CREATIVE_FONT_SIZE_RULES = {
  body: { critical: 16, warning: 16 },
  "list-item": { critical: 16, warning: 16 },
  caption: { critical: 9, warning: 9 },
  source: { critical: 9, warning: 9 },
  label: { critical: 11, warning: 11 },
  "table-header": { critical: 11, warning: 11 },
  "card-title": { critical: 18, warning: 18 },
  heading: { critical: 18, warning: 18 },
  "card-metric": { critical: 20, warning: 28 },
  title: { critical: 28, warning: 28 },
  metric: { critical: 24, warning: 32 }
};

const LINE_HEIGHT_RULES = {
  body: { critical: 1.0, warning: 1.35 },
  caption: { critical: 1.0, warning: 1.35 },
  "card-title": { critical: 1.0, warning: 1.15 },
  "card-metric": { critical: 0.9, warning: 1.0 },
  title: { critical: 0.95, warning: 1.10 },
  heading: { critical: 0.95, warning: 1.10 },
  metric: { critical: 0.90, warning: 1.0 }
};

const LINE_HEIGHT_MAXIMUMS = {
  body: 1.8,
  "list-item": 1.8,
  caption: 1.8,
  source: 1.6,
  label: 1.5,
  "table-header": 1.4,
  "card-title": 1.4,
  heading: 1.4,
  "card-metric": 1.2,
  title: 1.4,
  metric: 1.2
};

const CONTRAST_RULES = {
  // body / caption: critical below 3.0 (fails AA Large entirely); warning below 4.5 (AA Large only).
  body: { critical: 3.0, warning: 4.5 },
  caption: { critical: 3.0, warning: 4.5 },
  // title / heading / metric: critical below 3.0; warning collapses (single threshold).
  title: { critical: 3.0, warning: 3.0 },
  heading: { critical: 3.0, warning: 3.0 },
  metric: { critical: 3.0, warning: 3.0 }
};

const DEFAULT_DECK_SIZE = { width: 13.333, height: 7.5 };

/* -------------------------------------------------------------------------- */
/* helpers (math / color / tokens)                                            */
/* -------------------------------------------------------------------------- */

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeNum(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isDecoration(el) {
  if (!el || typeof el !== "object") return false;
  const role = typeof el.role === "string" ? el.role.toLowerCase() : "";
  if (DECORATIVE_ROLES.has(role)) return true;
  const id = typeof el.id === "string" ? el.id.toLowerCase() : "";
  if (/background|backdrop|canvas|decoration|ornament|accent/.test(id)) return true;
  return false;
}

function overlapAllowed(a, b) {
  const allowA = Array.isArray(a?.allowOverlapWith) ? a.allowOverlapWith : [];
  const allowB = Array.isArray(b?.allowOverlapWith) ? b.allowOverlapWith : [];
  return allowA.includes(b?.id) || allowB.includes(a?.id);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const trimmed = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  const value = parseInt(trimmed, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function relativeLuminance([r, g, b]) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const rl = channel(r);
  const gl = channel(g);
  const bl = channel(b);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(rgbA, rgbB) {
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const TOKEN_PATTERN = /^\{([a-zA-Z][\w.-]*)\}$/;

function resolveTokenString(value, tokens) {
  if (typeof value !== "string") return value;
  const match = TOKEN_PATTERN.exec(value.trim());
  if (!match) return value;
  if (!tokens || typeof tokens !== "object") return value;
  const path = match[1].split(".");
  let cursor = tokens;
  for (const segment of path) {
    if (cursor && typeof cursor === "object" && segment in cursor) {
      cursor = cursor[segment];
    } else {
      return value;
    }
  }
  return cursor;
}

function lookupToken(value, tokens) {
  const resolved = resolveTokenString(value, tokens);
  if (resolved && typeof resolved === "object") {
    if (typeof resolved.color === "string") return resolved.color;
    if (typeof resolved.fontSize === "number") return resolved.fontSize;
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* role inference                                                             */
/* -------------------------------------------------------------------------- */

function roleFromTypographyToken(value, tokens) {
  if (typeof value !== "string") return null;
  const match = TOKEN_PATTERN.exec(value.trim());
  if (!match) return null;
  const segments = match[1].toLowerCase().split(".");
  const flat = segments.join(".");
  if (/metric|kpi|stat|big-number/.test(flat)) return "metric";
  if (/subtitle/.test(flat)) return "body";
  if (/title|hero|headline/.test(flat)) return "title";
  if (/heading/.test(flat)) return "heading";
  if (/caption|footnote|note/.test(flat)) return "caption";
  if (/body|subtitle/.test(flat)) return "body";
  return null;
}

function roleFromId(id) {
  if (typeof id !== "string") return null;
  const lower = id.toLowerCase();
  if (/table[-_]?header|(^|[-_])th([-_]|$)/.test(lower)) return "table-header";
  if (/metric|kpi|stat|big-number/.test(lower)) return "metric";
  if (/source/.test(lower)) return "source";
  if (/label/.test(lower)) return "label";
  if (/subtitle/.test(lower)) return "body";
  if (/title|hero|headline/.test(lower)) return "title";
  if (/heading/.test(lower)) return "heading";
  if (/caption|footnote|note/.test(lower)) return "caption";
  return null;
}

function roleFromFontSize(fontSize) {
  if (fontSize >= 32) return "metric";
  if (fontSize >= 18) return "title";
  return "body";
}

/**
 * Resolve a logical role bucket for an element. Order:
 * 1. explicit `el.role`
 * 2. `el.style.typography` token path (segments containing keywords)
 * 3. id-pattern fallback
 * 4. font-size fallback
 *
 * Unknown / missing role resolves to `body` (most permissive thresholds).
 */
export function inferRole(element, tokens) {
  if (!element || typeof element !== "object") return "body";
  if (typeof element.role === "string" && element.role.trim()) {
    return element.role.trim().toLowerCase();
  }
  const typoToken = element.style?.typography;
  const fromTypo = roleFromTypographyToken(typoToken, tokens);
  if (fromTypo) return fromTypo;
  const fromId = roleFromId(element.id);
  if (fromId) return fromId;
  const fontSize = num(element.style?.fontSize, 0);
  if (fontSize > 0) return roleFromFontSize(fontSize);
  return "body";
}

/* -------------------------------------------------------------------------- */
/* (1) bounds — extracted verbatim-shape from visual-critic.mjs              */
/* -------------------------------------------------------------------------- */

/**
 * Bounds check. Returns the same `issue` shape that `visual-critic.mjs`
 * `scoreSlide()` historically emitted, so existing tests stay green.
 */
export function checkBounds(element, deckSize) {
  const size = deckSize ?? DEFAULT_DECK_SIZE;
  const x = num(element?.x);
  const y = num(element?.y);
  const w = num(element?.w);
  const h = num(element?.h);
  const minX = element?.type === "line" ? Math.min(x, x + w) : x;
  const maxX = element?.type === "line" ? Math.max(x, x + w) : x + w;
  const minY = element?.type === "line" ? Math.min(y, y + h) : y;
  const maxY = element?.type === "line" ? Math.max(y, y + h) : y + h;
  if (minX < -TOLERANCE_IN || minY < -TOLERANCE_IN || maxX > size.width + TOLERANCE_IN || maxY > size.height + TOLERANCE_IN) {
    return {
      severity: "high",
      type: "bounds",
      message: `Element ${element?.id} exceeds slide bounds.`,
      target: element?.id
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* (3) role-aware font-size — extracted verbatim-shape from visual-critic.mjs */
/* -------------------------------------------------------------------------- */

/**
 * Font-size check. Returns the visual-critic-shaped issue if the element's
 * fontSize falls below the role-specific threshold, else null. When no
 * role can be inferred, falls back to body thresholds.
 */
export function checkFontSize(element, tokens, options = {}) {
  if (!element || element.type !== "text") return null;
  const typography = resolveTokenString(element?.style?.typography, tokens);
  const fontSize = num(element?.style?.fontSize, num(typography?.fontSize, 16));
  const role = inferRole(element, tokens);
  const ruleSet = options.creative === true ? CREATIVE_FONT_SIZE_RULES : FONT_SIZE_RULES;
  const rules = ruleSet[role] ?? ruleSet.body;
  if (fontSize < rules.critical) {
    return {
      severity: "high",
      type: "font-size",
      message: `Element ${element.id} uses font size below ${rules.critical}pt for role ${role}.`,
      target: element.id
    };
  }
  if (fontSize < rules.warning) {
    return {
      severity: "medium",
      type: "font-size",
      message: `Element ${element.id} uses font size below ${rules.warning}pt for role ${role}.`,
      target: element.id
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* (2) overlap                                                                */
/* -------------------------------------------------------------------------- */

function rectOverlapArea(a, b) {
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function isContentCard(el) {
  if (!el || el.type !== "shape") return false;
  const id = typeof el.id === "string" ? el.id.toLowerCase() : "";
  const component = typeof el.style?.component === "string" ? el.style.component.toLowerCase() : "";
  return /card/.test(`${id} ${component}`);
}

function isContainerSurface(el) {
  if (!el || el.type !== "shape") return false;
  const id = typeof el.id === "string" ? el.id.toLowerCase() : "";
  const role = typeof el.role === "string" ? el.role.toLowerCase() : "";
  const component = typeof el.style?.component === "string"
    ? el.style.component.toLowerCase()
    : "";
  return /card|panel|container|surface|module/.test(`${id} ${role} ${component}`);
}

function isExplicitContainmentSurface(el) {
  if (!el || el.type !== "shape") return false;
  const id = typeof el.id === "string" ? el.id.toLowerCase() : "";
  const role = typeof el.role === "string" ? el.role.toLowerCase() : "";
  return /card|panel|container|surface|module/.test(`${id} ${role}`);
}

function containsElement(container, child) {
  return child.x >= container.x - CONTAINMENT_TOLERANCE_IN
    && child.y >= container.y - CONTAINMENT_TOLERANCE_IN
    && child.x + child.w <= container.x + container.w + CONTAINMENT_TOLERANCE_IN
    && child.y + child.h <= container.y + container.h + CONTAINMENT_TOLERANCE_IN;
}

function isIntentionalContainerOverlap(a, b) {
  return (isContainerSurface(a) && containsElement(a, b))
    || (isContainerSurface(b) && containsElement(b, a));
}

function checkOverlap(slide, deckSize) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  for (let i = 0; i < elements.length; i += 1) {
    for (let j = i + 1; j < elements.length; j += 1) {
      const a = elements[i];
      const b = elements[j];
      if (!a || !b) continue;
      if (a.type === "line" || b.type === "line") continue;
      if (overlapAllowed(a, b)) continue;
      if (isIntentionalContainerOverlap(a, b)) continue;
      if (!overlaps(a, b)) continue;
      const areaA = Math.max(1e-6, num(a.w) * num(a.h));
      const areaB = Math.max(1e-6, num(b.w) * num(b.h));
      const overlap = rectOverlapArea(a, b);
      const smaller = Math.min(areaA, areaB);
      if (overlap / smaller > OVERLAP_AREA_THRESHOLD) {
        const decorative = isDecoration(a) || isDecoration(b);
        issues.push({
          severity: "high",
          type: decorative ? "decoration-occlusion" : "content-occlusion",
          message: `Elements ${a.id} and ${b.id} overlap by more than 1% of the smaller area without an explicit pair allowlist.`,
          target: a.id,
          relatedTarget: b.id
        });
      }
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* semantic containment and footer-safe band                                  */
/* -------------------------------------------------------------------------- */

export function checkSemanticContainment(slide) {
  const elements = Array.isArray(slide?.elements) ? slide.elements : [];
  const byId = new Map(elements.filter((element) => element?.id).map((element) => [element.id, element]));
  const issues = [];
  for (const child of elements) {
    if (!child?.semanticParentId || child.type === "line") continue;
    const parent = byId.get(child.semanticParentId);
    // Expanded chart/diagram children retain lineage to a source element that
    // is not present in the rendered manifest. Only enforce visible parents.
    if (!parent || !isExplicitContainmentSurface(parent)) continue;
    if (containsElement(parent, child)) continue;
    issues.push({
      severity: "high",
      type: "semantic-container-escape",
      message: `Element ${child.id} escapes the bounds of semantic parent ${parent.id}.`,
      target: child.id,
      relatedTarget: parent.id
    });
  }
  return issues;
}

function semanticLabel(element) {
  return `${element?.role ?? ""} ${element?.layoutRegion ?? ""}`.trim().toLowerCase();
}

function isFooterElement(element) {
  return /footer|page[-_ ]?number|slide[-_ ]?number|folio/.test(semanticLabel(element));
}

export function checkFooterSafeArea(slide) {
  const elements = Array.isArray(slide?.elements) ? slide.elements : [];
  const footerElements = elements.filter(isFooterElement);
  if (footerElements.length === 0) return [];
  const footerTop = Math.min(...footerElements.map((element) => num(element.y)));
  const relatedFooter = footerElements.reduce((earliest, element) => (
    num(element.y) < num(earliest.y) ? element : earliest
  ));
  const issues = [];
  for (const element of elements) {
    if (!element?.id || isFooterElement(element) || element.type === "line" || isDecoration(element)) continue;
    if (overlapAllowed(element, relatedFooter)) continue;
    const bottom = num(element.y) + num(element.h);
    if (bottom <= footerTop + TOLERANCE_IN) continue;
    issues.push({
      severity: "high",
      type: "footer-safe-area-collision",
      message: `Element ${element.id} extends into the footer-safe band beginning at ${footerTop.toFixed(3)}in.`,
      target: element.id,
      relatedTarget: relatedFooter.id
    });
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* (4) role-aware line-height                                                 */
/* -------------------------------------------------------------------------- */

function checkLineHeight(slide, tokens) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  for (const el of elements) {
    if (!el || el.type !== "text") continue;
    const typography = resolveTokenString(el.style?.typography, tokens);
    const lineHeight = safeNum(el.style?.lineHeight, safeNum(typography?.lineHeight, null));
    if (lineHeight === null) continue;
    const role = inferRole(el, tokens);
    const baseRules = LINE_HEIGHT_RULES[role] ?? LINE_HEIGHT_RULES.body;
    const rules = isCjk(el.text) && ["body", "caption"].includes(role)
      ? { critical: 1.2, warning: 1.35 }
      : baseRules;
    if (lineHeight < rules.critical) {
      issues.push({
        severity: "high",
        type: "line-height-too-tight",
        message: `Element ${el.id} has line-height ${lineHeight}, below critical ${rules.critical} for role ${role}.`,
        target: el.id
      });
    } else if (lineHeight < rules.warning) {
      issues.push({
        severity: "medium",
        type: "line-height-too-tight",
        message: `Element ${el.id} has line-height ${lineHeight}, below warning ${rules.warning} for role ${role}.`,
        target: el.id
      });
    }
    const maximum = LINE_HEIGHT_MAXIMUMS[role] ?? LINE_HEIGHT_MAXIMUMS.body;
    if (lineHeight > maximum) {
      issues.push({
        severity: "high",
        type: "line-height-too-loose",
        message: `Element ${el.id} has line-height ${lineHeight}, above maximum ${maximum} for role ${role}.`,
        target: el.id,
        suggestion: { style: { lineHeight: role === "table-header" ? 1.2 : maximum, ...(role === "table-header" ? { valign: "middle" } : {}) } }
      });
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* (5) text-overflow heuristic                                                */
/* -------------------------------------------------------------------------- */

function isCjk(text) {
  if (typeof text !== "string") return false;
  return /[　-〿぀-ゟ゠-ヿ一-鿿＀-￯]/.test(text);
}

const FONT_ASPECT_RATIO = 0.55; // avg char width / fontSize
const BOLD_FACTOR = 1.1;
const ITALIC_FACTOR = 0.95;
const CJK_MULTIPLIER = 1.7;

function checkTextOverflow(slide, tokens) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  for (const el of elements) {
    if (!el || el.type !== "text") continue;
    const text = typeof el.text === "string" ? el.text : "";
    if (!text) continue;
    const typography = resolveTokenString(el.style?.typography, tokens);
    const fontSize = num(el.style?.fontSize, num(typography?.fontSize, 16));
    const w = num(el.w, 0);
    const h = num(el.h, 0);
    if (w <= 0 || h <= 0) continue;
    const fontWeight = el.style?.fontWeight ?? typography?.fontWeight;
    const isBold = el.style?.bold === true || fontWeight === "bold" || Number(fontWeight) >= 700;
    const isItalic = el.style?.italic === true || el.style?.fontStyle === "italic";
    let weight = 1;
    if (isBold) weight *= BOLD_FACTOR;
    if (isItalic) weight *= ITALIC_FACTOR;
    const cjkMul = isCjk(text) ? CJK_MULTIPLIER : 1;
    // Estimate single-line width in inches: text.length * fontSize * aspect / 72.
    const projectedInches = (text.length * fontSize * FONT_ASPECT_RATIO * weight * cjkMul) / 72;
    // Available width in inches = box width * number of lines that fit.
    const fontSizeInches = fontSize / 72;
    const lineHeight = num(el.style?.lineHeight, num(typography?.lineHeight, 1.2));
    const maxLines = Math.max(1, h / (fontSizeInches * lineHeight));
    const availableInches = w * maxLines;
    if (projectedInches > availableInches) {
      issues.push({
        severity: "medium",
        type: "text-overflow",
        message: `Element ${el.id} may overflow its textbox (projected ${projectedInches.toFixed(2)}in vs available ${availableInches.toFixed(2)}in).`,
        target: el.id
      });
    }
  }
  return issues;
}

function measuredTextResult(element, tokens, options = {}) {
  const typography = resolveTokenString(element.style?.typography, tokens);
  const font = {
    fontFamily: element.style?.fontFamily ?? typography?.fontFamily,
    fontWeight: element.style?.fontWeight ?? typography?.fontWeight ?? 400,
    italic: element.style?.italic ?? false,
    allowFallback: true
  };
  const measureText = options.measureText
    ?? (typeof options.fontCatalog?.measureText === "function" ? options.fontCatalog.measureText.bind(options.fontCatalog) : undefined);
  return measureTextElement(element, { tokens, measureText, font, maxHeight: Number(element.h) });
}

function checkMetricWrap(slide, tokens, options = {}) {
  const issues = [];
  for (const element of slide.elements ?? []) {
    if (element?.type !== "text") continue;
    const role = inferRole(element, tokens);
    if (!['metric', 'card-metric'].includes(role)) continue;
    const measured = measuredTextResult(element, tokens, options);
    if (measured.lineCount <= 1) continue;
    issues.push({
      severity: "high",
      type: "metric-wrap",
      message: `Metric ${element.id} wraps to ${measured.lineCount} lines; replace it with a metric group, price group, or wider layout.`,
      target: element.id,
      suggestion: {
        operation: "host-reflow",
        alternatives: ["metric-group", "price-group", "wider-layout"],
        automaticTextSplit: false
      }
    });
  }
  return issues;
}

function checkTextRequiredBounds(slide, tokens, options = {}) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const byId = new Map(elements.filter((element) => element?.id).map((element) => [element.id, element]));
  for (const element of elements) {
    if (element?.type !== "text" || !String(element.text ?? "")) continue;
    const measured = measuredTextResult(element, tokens, options);
    const paintedBottom = num(element.y) + measured.requiredHeight;
    const parent = element.semanticParentId ? byId.get(element.semanticParentId) : null;
    const exceedsBox = measured.requiredHeight > num(element.h) + TOLERANCE_IN;
    const exceedsParent = parent && isExplicitContainmentSurface(parent)
      && paintedBottom > num(parent.y) + num(parent.h) + CONTAINMENT_TOLERANCE_IN;
    if (!exceedsBox && !exceedsParent) continue;
    issues.push({
      severity: "high",
      type: "text-required-bounds",
      message: exceedsParent
        ? `Rendered text for ${element.id} requires ${measured.requiredHeight.toFixed(3)}in and escapes semantic parent ${parent.id}.`
        : `Rendered text for ${element.id} requires ${measured.requiredHeight.toFixed(3)}in but its textbox height is ${num(element.h).toFixed(3)}in.`,
      target: element.id,
      ...(exceedsParent ? { relatedTarget: parent.id } : {}),
      suggestion: { h: measured.requiredHeight }
    });
  }
  return issues;
}

function checkListItemCollision(slide, tokens, options = {}) {
  const groups = new Map();
  for (const element of slide.elements ?? []) {
    if (element?.type !== "text" || !element.listParentId) continue;
    if (!groups.has(element.listParentId)) groups.set(element.listParentId, []);
    groups.get(element.listParentId).push(element);
  }
  const issues = [];
  for (const [listParentId, items] of groups) {
    const ordered = [...items].sort((a, b) => (num(a.listIndex, Number.MAX_SAFE_INTEGER) - num(b.listIndex, Number.MAX_SAFE_INTEGER)) || num(a.y) - num(b.y));
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      const measured = measuredTextResult(current, tokens, options);
      const paintedBottom = num(current.y) + Math.max(num(current.h), measured.requiredHeight);
      if (paintedBottom <= num(next.y) + TOLERANCE_IN) continue;
      issues.push({
        severity: "high",
        type: "list-item-collision",
        message: `List ${listParentId} item ${current.id} intersects following item ${next.id}.`,
        target: current.id,
        relatedTarget: next.id,
        suggestion: { h: measured.requiredHeight, nextY: paintedBottom + (num(current.style?.fontSize, 16) / 72) * 0.35 }
      });
    }
  }
  return issues;
}

function checkSourceLinks(slide) {
  const issues = [];
  for (const element of slide.elements ?? []) {
    if (element?.type !== "text") continue;
    const sourceMarked = inferRole(element) === "source" || /source|来源|参考/.test(`${element.id ?? ""} ${element.role ?? ""}`.toLowerCase());
    if (!sourceMarked || !/https?:\/\/\S+/i.test(String(element.text ?? ""))) continue;
    if (/^https?:\/\//i.test(String(element.hyperlink?.url ?? ""))) continue;
    issues.push({
      severity: "high",
      type: "source-link-missing",
      message: `Source element ${element.id} displays a URL but has no clickable hyperlink relationship.`,
      target: element.id
    });
  }
  return issues;
}

function checkEvidenceLabels(slide) {
  const issues = [];
  for (const element of slide.elements ?? []) {
    if (element?.type !== "text" || !element.evidence) continue;
    const kind = element.evidence.kind;
    const sourceIds = Array.isArray(element.evidence.sourceIds) ? element.evidence.sourceIds : [];
    const text = String(element.text ?? "");
    const visibleLabel = kind === "vendor-claim"
      ? /厂商声明|厂商口径|vendor claim/i.test(text)
      : kind === "internal-recommendation"
        ? /内部建议|内部判断|internal recommendation/i.test(text)
        : true;
    const requiresSource = ["official-fact", "vendor-claim", "secondary-report"].includes(kind);
    if (visibleLabel && (!requiresSource || sourceIds.length > 0)) continue;
    issues.push({
      severity: "high",
      type: "evidence-label-missing",
      message: !visibleLabel
        ? `Evidence element ${element.id} is ${kind} but lacks a visible audience-facing label.`
        : `Evidence element ${element.id} is ${kind} but is not bound to a registered source.`,
      target: element.id
    });
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* (6) card-spacing                                                           */
/* -------------------------------------------------------------------------- */

function getSpacingMd(tokens) {
  if (!tokens || typeof tokens !== "object") return 0.5;
  const spacing = tokens.spacing;
  if (!spacing || typeof spacing !== "object") return 0.5;
  const md = spacing.md ?? spacing.medium ?? spacing["md"];
  const value = num(md, 0.5);
  return value > 2 ? value / 72 : value;
}

function rectGap(a, b) {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(dx, dy);
}

function checkCardSpacing(slide, tokens) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const cards = elements.filter(isContentCard);
  if (cards.length < 2) return issues;
  const threshold = getSpacingMd(tokens);
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i];
      const b = cards[j];
      if (overlaps(a, b)) continue;
      const gap = rectGap(a, b);
      if (gap < threshold) {
        issues.push({
          severity: "medium",
          type: "card-spacing-tight",
          message: `Cards ${a.id} and ${b.id} are too close (edge gap ${gap.toFixed(3)}in < ${threshold.toFixed(3)}in).`,
          target: a.id,
          relatedTarget: b.id
        });
      }
    }
  }
  return issues;
}

function checkConnectors(slide) {
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const byId = new Map(elements.filter((el) => el?.id && el.type !== "line").map((el) => [el.id, el]));
  const issues = [];
  for (const line of elements.filter((el) => el?.type === "line")) {
    const connector = connectorMetadata(line);
    const sourceId = connector?.sourceId;
    const targetId = connector?.targetId;
    const role = String(line.role ?? "").toLowerCase();
    const id = String(line.id ?? "").toLowerCase();
    const hasArrow = Boolean(line.style?.beginArrowType || line.style?.endArrowType);
    const connectorLike = role === "connector"
      || /connector|arrow|flow|link/.test(id)
      || hasArrow;
    if (role === "axis" && line.axisDirection) {
      const direction = String(line.axisDirection).toLowerCase();
      const w = num(line.w);
      const h = num(line.h);
      const valid = direction === "left" ? w < 0
        : direction === "right" ? w > 0
          : direction === "up" ? h < 0
            : direction === "down" ? h > 0
              : false;
      if (!valid) {
        issues.push({
          severity: "high",
          type: "connector-direction",
          message: `Axis ${line.id} geometry does not match axisDirection=${direction}.`,
          target: line.id
        });
      }
    }
    if (!sourceId && !targetId) {
      if (connectorLike && !["axis", "divider", "decorative"].includes(role)) {
        issues.push({
          severity: "high",
          type: "connector-detached",
          message: `Connector ${line.id} has no sourceId/targetId metadata; endpoint accuracy cannot be verified.`,
          target: line.id
        });
      }
      continue;
    }
    const source = byId.get(sourceId);
    const target = byId.get(targetId);
    const start = { x: num(line.x), y: num(line.y) };
    const end = { x: num(line.x) + num(line.w), y: num(line.y) + num(line.h) };
    const expectedStart = source && target ? boundaryAnchor(source, target, connector?.sourceAnchor ?? "auto") : null;
    const expectedEnd = source && target ? boundaryAnchor(target, source, connector?.targetAnchor ?? "auto") : null;
    const sourceAttached = source && pointTouchesBoundary(start, source) && (!expectedStart || pointDistance(start, expectedStart) <= 0.08);
    const targetAttached = target && pointTouchesBoundary(end, target) && (!expectedEnd || pointDistance(end, expectedEnd) <= 0.08);
    if (!source || !target || sourceId === targetId || !sourceAttached || !targetAttached) {
      let suggestion;
      if (source && target && sourceId !== targetId) {
        suggestion = {
          x: expectedStart.x,
          y: expectedStart.y,
          w: expectedEnd.x - expectedStart.x,
          h: expectedEnd.y - expectedStart.y
        };
      }
      issues.push({
        severity: "high",
        type: "connector-detached",
        message: sourceId === targetId
          ? `Connector ${line.id} must connect two distinct modules.`
          : `Connector ${line.id} does not terminate on the declared anchors of ${sourceId ?? "source"} and ${targetId ?? "target"}.`,
        target: line.id,
        relatedTarget: !source ? sourceId : targetId,
        ...(suggestion ? { suggestion } : {})
      });
      continue;
    }

    if (!line.style?.endArrowType) {
      issues.push({
        severity: "high",
        type: "connector-marker-missing",
        message: `Connector ${line.id} must use an end arrow marker aimed at ${targetId}.`,
        target: line.id,
        relatedTarget: targetId
      });
    }
    if ((line.style?.beginArrowType && !line.style?.endArrowType) || connectorDirectionDot(start, end, target) <= 0) {
      issues.push({
        severity: "high",
        type: "connector-direction",
        message: `Connector ${line.id} points away from target module ${targetId}.`,
        target: line.id,
        relatedTarget: targetId
      });
    }
    if (connector?.route === "orthogonal" && Math.abs(num(line.w)) > 0.02 && Math.abs(num(line.h)) > 0.02) {
      issues.push({
        severity: "high",
        type: "connector-route-invalid",
        message: `Connector ${line.id} declares an orthogonal route but is represented by one diagonal segment.`,
        target: line.id
      });
    }
    if (connector?.route !== "orthogonal") {
      const obstruction = elements.find((element) => element?.id
        && element.type !== "line"
        && element.id !== sourceId
        && element.id !== targetId
        && !isDecoration(element)
        && segmentIntersectsRectInterior(start, end, element));
      if (obstruction) {
        issues.push({
          severity: "high",
          type: "connector-obstructed",
          message: `Connector ${line.id} crosses unrelated module ${obstruction.id}; reroute it or move the module.`,
          target: line.id,
          relatedTarget: obstruction.id
        });
      }
    }
  }
  return issues;
}

function checkVerticalGapBalance(slide, tokens) {
  const issues = [];
  const groups = new Map();
  for (const element of slide.elements ?? []) {
    if (!element?.layoutRegion || element.type === "line" || isDecoration(element)) continue;
    if (!groups.has(element.layoutRegion)) groups.set(element.layoutRegion, []);
    groups.get(element.layoutRegion).push(element);
  }
  for (const [region, elements] of groups) {
    const ordered = [...elements].sort((a, b) => num(a.y) - num(b.y));
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      const gap = num(next.y) - (num(current.y) + num(current.h));
      const typography = resolveTokenString(next.style?.typography, tokens);
      const fontSize = safeNum(next.style?.fontSize, safeNum(typography?.fontSize, 12));
      const minGap = (fontSize / 72) * 0.25;
      if (gap < minGap - 0.005 || gap > 0.75 + 0.005) {
        issues.push({
          severity: "high",
          type: "vertical-gap-imbalance",
          message: `Layout region ${region} has a vertical gap of ${gap.toFixed(3)}in between ${current.id} and ${next.id}; expected ${minGap.toFixed(3)}–0.750in.`,
          target: current.id,
          relatedTarget: next.id
        });
      }
    }
  }
  return issues;
}

function evenlySpaced(values, tolerance = 0.08) {
  if (values.length < 4) return false;
  const sorted = [...values].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index]);
  const average = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return average > 0 && gaps.every((gap) => Math.abs(gap - average) <= tolerance);
}

function checkDecorativeGrid(slide, deckSize, options = {}) {
  if (options.visibleGrid === true) return [];
  const candidates = (slide.elements ?? []).filter((line) => {
    if (line?.type !== "line") return false;
    if (["connector", "axis", "divider"].includes(line.role)) return false;
    if (connectorMetadata(line) || line.style?.beginArrowType || line.style?.endArrowType) return false;
    return Number(line.style?.width ?? 1) <= 1.5;
  });
  const horizontal = candidates.filter((line) => Math.abs(Number(line.h)) <= 0.02 && Math.abs(Number(line.w)) >= deckSize.width * 0.7);
  const vertical = candidates.filter((line) => Math.abs(Number(line.w)) <= 0.02 && Math.abs(Number(line.h)) >= deckSize.height * 0.7);
  const horizontalGrid = evenlySpaced(horizontal.map((line) => Number(line.y)));
  const verticalGrid = evenlySpaced(vertical.map((line) => Number(line.x)));
  if (!horizontalGrid && !verticalGrid) return [];
  const elementIds = [
    ...(horizontalGrid ? horizontal : []),
    ...(verticalGrid ? vertical : [])
  ].map((line) => line.id);
  return [{
    severity: "high",
    type: "decorative-grid",
    message: `Slide contains an unapproved visible background grid made from ${elementIds.length} repeated lines.`,
    target: elementIds[0],
    suggestion: { elementIds }
  }];
}

/* -------------------------------------------------------------------------- */
/* (7) contrast                                                               */
/* -------------------------------------------------------------------------- */

function resolveColor(el, role, tokens) {
  if (el.style && typeof el.style.color === "string") {
    const resolved = lookupToken(el.style.color, tokens);
    if (typeof resolved === "string") return resolved;
  }
  if (tokens && tokens.colors && typeof tokens.colors.text === "string") {
    return tokens.colors.text;
  }
  return null;
}

function resolveBackground(slide, tokens) {
  const bg = slide.background;
  if (!bg || typeof bg !== "object") return null;
  if (typeof bg.color === "string") {
    const resolved = lookupToken(bg.color, tokens);
    if (typeof resolved === "string") return resolved;
  }
  if (tokens && tokens.colors && typeof tokens.colors.background === "string") {
    return tokens.colors.background;
  }
  return null;
}

function checkContrast(slide, tokens) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const bgColor = resolveBackground(slide, tokens);
  if (!bgColor) return issues;
  const bgRgb = hexToRgb(bgColor);
  if (!bgRgb) return issues;
  for (const el of elements) {
    if (!el || el.type !== "text") continue;
    const fg = resolveColor(el, null, tokens);
    if (!fg) continue;
    const fgRgb = hexToRgb(fg);
    if (!fgRgb) continue;
    const ratio = contrastRatio(fgRgb, bgRgb);
    const role = inferRole(el, tokens);
    const rules = CONTRAST_RULES[role] ?? CONTRAST_RULES.body;
    if (ratio < rules.critical) {
      issues.push({
        severity: "high",
        type: "contrast-fail",
        message: `Element ${el.id} contrast ratio ${ratio.toFixed(2)}:1 below ${rules.critical}:1 (role ${role}).`,
        target: el.id
      });
    } else if (ratio < rules.warning) {
      // Warning band exists only when warning is a STRICTER upper bound than
      // critical (body/caption: critical=3.0, warning=4.5 → 3.0-4.5 is the band).
      // Title/metric collapse to a single threshold and never hit this branch.
      if (rules.warning > rules.critical) {
        issues.push({
          severity: "medium",
          type: "contrast-fail",
          message: `Element ${el.id} contrast ratio ${ratio.toFixed(2)}:1 below ${rules.warning}:1 (role ${role}).`,
          target: el.id
        });
      }
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* (8) letter-spacing                                                         */
/* -------------------------------------------------------------------------- */

function checkLetterSpacing(slide, tokens) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  for (const el of elements) {
    if (!el || el.type !== "text") continue;
    const ls = el.style?.letterSpacing;
    if (typeof ls !== "number") continue;
    const role = inferRole(el, tokens);
    const cjk = isCjk(el.text);
    if (role === "body" || role === "caption") {
      const threshold = cjk ? -0.02 : -0.01;
      if (ls < threshold) {
        issues.push({
          severity: "medium",
          type: "letter-spacing-too-tight",
          message: `Element ${el.id} has letter-spacing ${ls}em, below ${threshold}em for ${cjk ? "CJK" : "Latin"} ${role}.`,
          target: el.id
        });
      }
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* per-slide orchestration                                                    */
/* -------------------------------------------------------------------------- */

function preflightSlide(slide, deckSize, tokens, options = {}) {
  const checks = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const htmlTextContracts = options.inputType === "html";

  // (1) bounds — one issue per element.
  for (const el of elements) {
    const issue = checkBounds(el, deckSize);
    if (issue) checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
  }

  // Replica mode preserves source geometry and visual layering. Creative
  // rules such as minimum font sizes, overlap, spacing, and contrast must not
  // hard-block a faithful reconstruction. Bounds remain objective; the
  // text-overflow heuristic remains a warning-only diagnostic.
  if (options.mode === "replica") {
    for (const issue of checkTextOverflow(slide, tokens)) {
      checks.push({ ...issue, severity: "warning" });
    }
    for (const issue of checkConnectors(slide)) {
      checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
    }
    for (const issue of checkSemanticContainment(slide)) {
      checks.push({ ...issue, severity: "warning" });
    }
    for (const issue of checkFooterSafeArea(slide)) {
      checks.push({ ...issue, severity: "warning" });
    }
    for (const issue of checkLineHeight(slide, tokens)) {
      checks.push({ ...issue, severity: "warning" });
    }
    for (const issue of checkTextRequiredBounds(slide, tokens, options)) {
      // Browser-measured HTML text has authoritative CSS metrics. Image/PDF
      // replica text boxes are OCR/reconstruction bounds, so heuristic font
      // metrics may legitimately exceed those boxes without proving clipping.
      checks.push({ ...issue, severity: options.inputType === "html" ? "critical" : "warning" });
    }
    for (const issue of checkListItemCollision(slide, tokens, options)) {
      checks.push({ ...issue, severity: "critical" });
    }
    return checks;
  }

  // (3) role-aware font-size — text-only.
  for (const el of elements) {
    const issue = checkFontSize(el, tokens, { creative: options.creativeFontFloors === true });
    if (issue) {
      checks.push({
        ...issue,
        severity: issue.severity === "high" ? "critical" : "warning"
      });
    }
  }

  // (2) overlap (uses pair enumeration, must run after element validity).
  for (const issue of checkOverlap(slide, deckSize)) {
    checks.push({ ...issue, severity: "critical" });
  }

  for (const issue of checkSemanticContainment(slide)) {
    checks.push({ ...issue, severity: "critical" });
  }

  for (const issue of checkFooterSafeArea(slide)) {
    checks.push({ ...issue, severity: "critical" });
  }

  // (4) line-height.
  for (const issue of checkLineHeight(slide, tokens)) {
    if (issue.type === "line-height-too-loose" && !htmlTextContracts) continue;
    checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
  }

  if (htmlTextContracts) {
    for (const issue of checkMetricWrap(slide, tokens, options)) {
      checks.push({ ...issue, severity: "critical" });
    }

    for (const issue of checkTextRequiredBounds(slide, tokens, options)) {
      checks.push({ ...issue, severity: "critical" });
    }

    for (const issue of checkListItemCollision(slide, tokens, options)) {
      checks.push({ ...issue, severity: "critical" });
    }
  }

  for (const issue of checkSourceLinks(slide)) {
    checks.push({ ...issue, severity: "critical" });
  }

  for (const issue of checkEvidenceLabels(slide)) {
    checks.push({ ...issue, severity: "critical" });
  }

  for (const issue of checkVerticalGapBalance(slide, tokens)) {
    checks.push({ ...issue, severity: "critical" });
  }

  // (5) text-overflow heuristic.
  for (const issue of checkTextOverflow(slide, tokens)) {
    checks.push({ ...issue, severity: "critical" });
  }

  // (6) card-spacing.
  for (const issue of checkCardSpacing(slide, tokens)) {
    checks.push({ ...issue, severity: "warning" });
  }

  // (7) contrast.
  for (const issue of checkContrast(slide, tokens)) {
    checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
  }

  // (8) letter-spacing.
  for (const issue of checkLetterSpacing(slide, tokens)) {
    checks.push({ ...issue, severity: "warning" });
  }

  for (const issue of checkConnectors(slide)) {
    checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
  }

  for (const issue of checkDecorativeGrid(slide, deckSize, options)) {
    checks.push({ ...issue, severity: "critical" });
  }

  return checks;
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run the layout-safety preflight across every slide in the manifest.
 *
 * @param {object} manifest           Decoded `deck.manifest.json`.
 * @param {object} [options]
 *   - designTokens: optional pre-resolved tokens. Falls back to
 *     `manifest.designSystem.tokens`.
 *   - strict: boolean. When true, `summary.blocked` mirrors `criticalCount > 0`.
 *   - mode: `creative` (default) or `replica`. Replica mode only hard-checks
 *     slide bounds and keeps text overflow as a warning-only diagnostic.
 *     The CLI/pipeline computes the actual exit-code policy separately.
 *
 * @returns {{
 *   checks: Array<{slideId, severity, type, message, target, relatedTarget?}>,
 *   summary: {
 *     criticalCount: number,
 *     warningCount: number,
 *     slideCount: number,
 *     blocked: boolean,
 *     version: string
 *   }
 * }}
 */
export function preflightLayout(manifest, options = {}) {
  const safeManifest = manifest && typeof manifest === "object" ? manifest : {};
  const deckSize = safeManifest.deck?.size ?? DEFAULT_DECK_SIZE;
  const tokens = options.designTokens
    ?? safeManifest.designSystem?.tokens
    ?? {};
  const slides = Array.isArray(safeManifest.slides) ? safeManifest.slides : [];

  const checks = [];
  for (const slide of slides) {
    const expandedElements = (slide.elements ?? []).flatMap((element) => {
      if (element?.type === "chart") return expandChartElement(element);
      if (element?.type === "diagram") return expandDiagramElement(element);
      return [element];
    });
    const slideChecks = preflightSlide({ ...slide, elements: expandedElements }, deckSize, tokens, {
      ...options,
      creativeFontFloors: options.creativeFontFloors
        ?? (safeManifest.metadata?.qualityProfile === "creative" && safeManifest.metadata?.inputType === "html"),
      inputType: options.inputType ?? safeManifest.metadata?.inputType,
      visibleGrid: safeManifest.metadata?.designIntent?.visibleGrid === true
    });
    for (const check of slideChecks) {
      checks.push({ slideId: slide.id, ...check });
    }
  }

  const criticalCount = checks.filter((c) => c.severity === "critical").length;
  const warningCount = checks.filter((c) => c.severity === "warning").length;
  const blocked = options.strict === true ? criticalCount > 0 : false;

  return {
    checks,
    summary: {
      criticalCount,
      warningCount,
      slideCount: slides.length,
      blocked,
      version: "0.1.0"
    }
  };
}

/* -------------------------------------------------------------------------- */
/* U5 writer — schema-conforming report formatter                              */
/* -------------------------------------------------------------------------- */

/**
 * Mapping from internal `type` strings (used by the preflight checks and the
 * legacy visual-critic issue shape) to the stable `kind` enum exposed in
 * `schemas/layout-safety-report.schema.json`. Downstream tooling (U6 repair
 * adapter switches on `kind`; the schema enum is the contract.
 */
const KIND_MAP = Object.freeze({
  bounds: "bounds",
  overlap: "overlap",
  "content-occlusion": "content-occlusion",
  "decoration-occlusion": "decoration-occlusion",
  "semantic-container-escape": "semantic-container-escape",
  "footer-safe-area-collision": "footer-safe-area-collision",
  "vertical-gap-imbalance": "vertical-gap-imbalance",
  "font-size": "font-too-small",
  "line-height-too-tight": "line-height-too-tight",
  "line-height-too-loose": "line-height-too-loose",
  "text-overflow": "text-overflow",
  "metric-wrap": "metric-wrap",
  "text-required-bounds": "text-required-bounds",
  "list-item-collision": "list-item-collision",
  "source-link-missing": "source-link-missing",
  "evidence-label-missing": "evidence-label-missing",
  "card-spacing-tight": "card-spacing-tight",
  "connector-detached": "connector-detached",
  "connector-direction": "connector-direction",
  "connector-marker-missing": "connector-marker-missing",
  "connector-obstructed": "connector-obstructed",
  "connector-route-invalid": "connector-route-invalid",
  "decorative-grid": "decorative-grid",
  "contrast-fail": "contrast-fail",
  "letter-spacing-too-tight": "letter-spacing-too-tight"
});

/**
 * Recursively sort object keys for deterministic JSON output. Mirrors the
 * implementation in `consistency-report-writer.mjs` so both writers produce
 * byte-identical output for structurally-equal inputs across runs.
 * Arrays keep their input order — semantic ordering matters there.
 */
export function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortObjectKeys(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Translate one internal `preflightLayout()` check into the wire shape.
 * Pure; called once per check by `formatReport`.
 */
function mapCheckToWire(check) {
  const internalType = typeof check.type === "string" ? check.type : "bounds";
  const kind = KIND_MAP[internalType] ?? "bounds";
  const elementId = typeof check.target === "string" ? check.target : "";
  const wire = {
    elementId,
    kind,
    severity: check.severity,
    message: check.message
  };
  if (typeof check.slideId === "string" && check.slideId.length > 0) {
    wire.slideId = check.slideId;
  }
  if (typeof check.relatedTarget === "string" && check.relatedTarget.length > 0) {
    wire.relatedElementId = check.relatedTarget;
  }
  if (check.suggestion && typeof check.suggestion === "object") {
    wire.suggestion = check.suggestion;
  }
  return wire;
}

/**
 * Pure: transform the internal `preflightLayout()` output into the
 * schema-conforming wire shape consumed by the CLI, pipeline, and U6
 * repair-patch adapter. Deterministic key order via `sortObjectKeys` so
 * the JSON serialized from the result is byte-identical across runs.
 *
 * @param {object} result  Output of `preflightLayout(manifest, options)`.
 * @param {object} [options]
 *   - deckSize: optional `{width, height}` override. Defaults to the
 *     preflight's recorded deck size when present, else
 *     `DEFAULT_DECK_SIZE`.
 *   - version: optional schema/doc version string. Defaults to
 *     `result.summary.version` when present, else "0.1.0".
 *   - createdAt: optional ISO8601 timestamp. When omitted, the field is
 *     absent from the output (strict-soft convention: no `Date.now()`
 *     injection → byte-identical across runs).
 *
 * @returns {{
 *   version: string,
 *   deckSize: {width: number, height: number},
 *   checks: Array<object>,
 *   summary: {criticalCount: number, warningCount: number, slideCount?: number, blocked: boolean}
 * }}
 */
export function formatReport(result, options = {}) {
  const safeResult = result && typeof result === "object" ? result : { checks: [], summary: {} };
  const checksRaw = Array.isArray(safeResult.checks) ? safeResult.checks : [];
  const summaryRaw = safeResult.summary && typeof safeResult.summary === "object" ? safeResult.summary : {};

  const deckSize = options.deckSize ?? DEFAULT_DECK_SIZE;
  const version = options.version ?? summaryRaw.version ?? "0.1.0";

  const wire = {
    version,
    deckSize: {
      width: num(deckSize.width, DEFAULT_DECK_SIZE.width),
      height: num(deckSize.height, DEFAULT_DECK_SIZE.height)
    },
    checks: checksRaw.map(mapCheckToWire),
    summary: {
      criticalCount: Number.isInteger(summaryRaw.criticalCount) ? summaryRaw.criticalCount : 0,
      warningCount: Number.isInteger(summaryRaw.warningCount) ? summaryRaw.warningCount : 0,
      blocked: summaryRaw.blocked === true
    }
  };
  if (Number.isInteger(summaryRaw.slideCount) && summaryRaw.slideCount >= 0) {
    wire.summary.slideCount = summaryRaw.slideCount;
  }
  if (typeof options.createdAt === "string" && options.createdAt.length > 0) {
    wire.createdAt = options.createdAt;
  }

  return sortObjectKeys(wire);
}

export const __test__ = {
  DEFAULT_DECK_SIZE,
  FONT_SIZE_RULES,
  CREATIVE_FONT_SIZE_RULES,
  LINE_HEIGHT_RULES,
  LINE_HEIGHT_MAXIMUMS,
  CONTRAST_RULES,
  TOLERANCE_IN,
  CONTAINMENT_TOLERANCE_IN,
  OVERLAP_AREA_THRESHOLD,
  contrastRatio,
  relativeLuminance,
  hexToRgb,
  resolveTokenString,
  inferRole,
  checkDecorativeGrid,
  isCjk,
  formatReport,
  sortObjectKeys,
  KIND_MAP
};
