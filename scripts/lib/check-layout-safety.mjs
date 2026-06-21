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
 * Output is JSON-serializable. The shape is intentionally simple so the
 * CLI wrapper (`scripts/run-layout-safety-check.mjs`) and the pipeline
 * (`scripts/run-deck-pipeline.mjs`) can consume it without further
 * transformation.
 */

const TOLERANCE_IN = 0.005;
const OVERLAP_AREA_THRESHOLD = 0.05; // 5% of smaller element area
const DECORATIVE_ROLES = new Set(["background", "backdrop", "canvas"]);

const FONT_SIZE_RULES = {
  body: { critical: 10, warning: 11 },
  caption: { critical: 10, warning: 11 },
  title: { critical: 16, warning: 18 },
  heading: { critical: 16, warning: 18 },
  metric: { critical: 24, warning: 32 }
};

const LINE_HEIGHT_RULES = {
  body: { critical: 1.0, warning: 1.35 },
  caption: { critical: 1.0, warning: 1.35 },
  title: { critical: 0.95, warning: 1.10 },
  heading: { critical: 0.95, warning: 1.10 }
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
  if (x < 0 || y < 0 || x + w > size.width + TOLERANCE_IN || y + h > size.height + TOLERANCE_IN) {
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
  const fontSize = num(element?.style?.fontSize, 16);
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

function rectCenterDistance(a, b) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function isContentCard(el) {
  if (!el) return false;
  const id = typeof el.id === "string" ? el.id.toLowerCase() : "";
  return /card/.test(id);
}

function checkOverlap(slide, deckSize) {
  const issues = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  for (let i = 0; i < elements.length; i += 1) {
    for (let j = i + 1; j < elements.length; j += 1) {
      const a = elements[i];
      const b = elements[j];
      if (!a || !b) continue;
      if (isDecoration(a) || isDecoration(b)) continue;
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
    const lineHeight = safeNum(el.style?.lineHeight, null);
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
    const fontSize = num(el.style?.fontSize, 16);
    const w = num(el.w, 0);
    const h = num(el.h, 0);
    if (w <= 0 || h <= 0) continue;
    const isBold = el.style?.bold === true || el.style?.fontWeight === "bold";
    const isItalic = el.style?.italic === true || el.style?.fontStyle === "italic";
    let weight = 1;
    if (isBold) weight *= BOLD_FACTOR;
    if (isItalic) weight *= ITALIC_FACTOR;
    const cjkMul = isCjk(text) ? CJK_MULTIPLIER : 1;
    // Estimate single-line width in inches: text.length * fontSize * aspect / 72.
    const projectedInches = (text.length * fontSize * FONT_ASPECT_RATIO * weight * cjkMul) / 72;
    // Available width in inches = box width * number of lines that fit.
    const fontSizeInches = fontSize / 72;
    const lineHeight = num(el.style?.lineHeight, 1.2);
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
  return num(md, 0.5);
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
      const dist = rectCenterDistance(a, b);
      if (dist < threshold) {
        issues.push({
          severity: "medium",
          type: "card-spacing-tight",
          message: `Cards ${a.id} and ${b.id} are too close (center distance ${dist.toFixed(3)} < ${threshold}).`,
          target: a.id,
          relatedTarget: b.id
        });
      }
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

function preflightSlide(slide, deckSize, tokens) {
  const checks = [];
  const elements = Array.isArray(slide.elements) ? slide.elements : [];

  // (1) bounds — one issue per element.
  for (const el of elements) {
    const issue = checkBounds(el, deckSize);
    if (issue) checks.push({ ...issue, severity: issue.severity === "high" ? "critical" : "warning" });
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
    checks.push({ ...issue, severity: "warning" });
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
    const slideChecks = preflightSlide(slide, deckSize, tokens);
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
  isCjk
};
