/**
 * check-layout-safety.mjs
 *
 * Pure-function layout-safety preflight for `deck.manifest.json`. Implements
 * the 8 detection items from U4 of the visual-design-quality-layer plan:
 *
 *   1. bounds           — element out of slide bounds (critical)
 *   2. overlap          — two non-decorative elements with intersection
 *                         area > 5% of the smaller element area (critical)
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

const TOLERANCE_IN = 0.005;
const OVERLAP_AREA_THRESHOLD = 0.05; // 5% of smaller element area
const DECORATIVE_ROLES = new Set(["background", "backdrop", "canvas"]);

const FONT_SIZE_RULES = {
  body: { critical: 10, warning: 11 },
  caption: { critical: 8, warning: 10 },
  "card-title": { critical: 12, warning: 14 },
  "card-metric": { critical: 20, warning: 28 },
  title: { critical: 16, warning: 18 },
  heading: { critical: 16, warning: 18 },
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
  if (/background|backdrop|canvas/.test(id)) return true;
  return false;
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
  if (/metric|kpi|stat|big-number/.test(lower)) return "metric";
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
export function checkFontSize(element, tokens) {
  if (!element || element.type !== "text") return null;
  const typography = resolveTokenString(element?.style?.typography, tokens);
  const fontSize = num(element?.style?.fontSize, num(typography?.fontSize, 16));
  const role = inferRole(element, tokens);
  const rules = FONT_SIZE_RULES[role] ?? FONT_SIZE_RULES.body;
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
  return /card|panel|container|surface/.test(`${id} ${role} ${component}`);
}

function containsElement(container, child) {
  const tolerance = 0.01;
  return child.x >= container.x - tolerance
    && child.y >= container.y - tolerance
    && child.x + child.w <= container.x + container.w + tolerance
    && child.y + child.h <= container.y + container.h + tolerance;
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
      if (isDecoration(a) || isDecoration(b)) continue;
      if (isIntentionalContainerOverlap(a, b)) continue;
      if (!overlaps(a, b)) continue;
      const areaA = Math.max(1e-6, num(a.w) * num(a.h));
      const areaB = Math.max(1e-6, num(b.w) * num(b.h));
      const overlap = rectOverlapArea(a, b);
      const smaller = Math.min(areaA, areaB);
      if (overlap / smaller > OVERLAP_AREA_THRESHOLD) {
        issues.push({
          severity: "high",
          type: "overlap",
          message: `Elements ${a.id} and ${b.id} overlap by more than 5% of the smaller area.`,
          target: a.id,
          relatedTarget: b.id
        });
      }
    }
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
    const rules = LINE_HEIGHT_RULES[role] ?? LINE_HEIGHT_RULES.body;
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

function pointTouchesBoundary(point, rect, tolerance = 0.08) {
  const insideX = point.x >= rect.x - tolerance && point.x <= rect.x + rect.w + tolerance;
  const insideY = point.y >= rect.y - tolerance && point.y <= rect.y + rect.h + tolerance;
  if (!insideX || !insideY) return false;
  return Math.min(
    Math.abs(point.x - rect.x),
    Math.abs(point.x - (rect.x + rect.w)),
    Math.abs(point.y - rect.y),
    Math.abs(point.y - (rect.y + rect.h))
  ) <= tolerance;
}

function boundaryAnchor(rect, toward) {
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const targetCenter = { x: toward.x + toward.w / 2, y: toward.y + toward.h / 2 };
  const dx = targetCenter.x - center.x;
  const dy = targetCenter.y - center.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: dx >= 0 ? rect.x + rect.w : rect.x, y: center.y };
  }
  return { x: center.x, y: dy >= 0 ? rect.y + rect.h : rect.y };
}

function checkConnectors(slide) {
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const byId = new Map(elements.filter((el) => el?.id).map((el) => [el.id, el]));
  const issues = [];
  for (const line of elements.filter((el) => el?.type === "line")) {
    const sourceId = line.style?.sourceId;
    const targetId = line.style?.targetId;
    if (!sourceId && !targetId) {
      if (/connector|arrow/i.test(line.id ?? "")) {
        issues.push({
          severity: "medium",
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
    if (!source || !target || !pointTouchesBoundary(start, source) || !pointTouchesBoundary(end, target)) {
      let suggestion;
      if (source && target) {
        const expectedStart = boundaryAnchor(source, target);
        const expectedEnd = boundaryAnchor(target, source);
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
        message: `Connector ${line.id} does not terminate on ${sourceId ?? "source"} and ${targetId ?? "target"}.`,
        target: line.id,
        relatedTarget: !source ? sourceId : targetId,
        ...(suggestion ? { suggestion } : {})
      });
    }
  }
  return issues;
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
    return checks;
  }

  // (3) role-aware font-size — text-only.
  for (const el of elements) {
    const issue = checkFontSize(el, tokens);
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

  // (4) line-height.
  for (const issue of checkLineHeight(slide, tokens)) {
    checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
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
    const slideChecks = preflightSlide({ ...slide, elements: expandedElements }, deckSize, tokens, options);
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
 * adapter, workbench) switches on `kind`; the schema enum is the contract.
 */
const KIND_MAP = Object.freeze({
  bounds: "bounds",
  overlap: "overlap",
  "font-size": "font-too-small",
  "line-height-too-tight": "line-height-too-tight",
  "text-overflow": "text-overflow",
  "card-spacing-tight": "card-spacing-tight",
  "connector-detached": "connector-detached",
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
  LINE_HEIGHT_RULES,
  CONTRAST_RULES,
  TOLERANCE_IN,
  OVERLAP_AREA_THRESHOLD,
  contrastRatio,
  relativeLuminance,
  hexToRgb,
  resolveTokenString,
  inferRole,
  isCjk,
  formatReport,
  sortObjectKeys,
  KIND_MAP
};
