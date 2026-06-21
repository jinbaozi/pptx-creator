/**
 * slop-risk.mjs
 *
 * Pure-function scorer for the 9th visual-critic dimension: `slopRisk`
 * (0..100 anti-AI-slop score; HIGHER = MORE slop). Walks the manifest +
 * design tokens once and emits a list of disjoint signals covering:
 *
 *   Five prohibitions (R6 of the U3 plan):
 *     1. font-family dedup            — >3 unique families in slide   (-20)
 *     2. emoji-as-icon                — emoji codepoint in text/icon  (-15)
 *     3. CSS gradient in inline style — linear/radial-gradient        (-15)
 *     4. all-caps + stroke + shadow   — decorative overuse combo      (-10)
 *     5. English rhetoric on zh title — anglicism on CJK title        (-10)
 *
 *   Four detection patterns (R6 of the U3 plan):
 *     6. rounded-token variance       — card radii all identical      (-20)
 *     7. icon-circle triad            — ≥3 circle-bg icons in a row   (-15)
 *     8. 3-up KPI sandwich            — 3 metric cards in a row       (-10)
 *     9. vertical-rhythm variance     — gaps all identical            (-10)
 *
 * Signal sources MUST remain disjoint from density / variety / hierarchy
 * / editability. Today those dimensions are flat constants in
 * visual-critic.mjs, so the constraint is trivially met. When those
 * dimensions are upgraded to compute from manifest walks (post-v1), they
 * MUST NOT import from this module — copy the helpers instead.
 *
 * Initial weights are PLACEHOLDERS tuned to Cal-0 once the corpus is
 * downloaded. The reviewer-vs-formula agreement target is ≥ 80% within
 * ±20 points (per `references/visual-design-calibration.md`).
 *
 * Exports:
 *   scoreSlopRisk(manifest, designTokens = {}) → {
 *     score: 0..100, signals: Array<{id, weight, count, target}>
 *   }
 *
 * Pure JS, no dependencies, no side effects.
 */

// Signal weights (placeholders; tuned against Cal-0 corpus).
export const SLOP_WEIGHTS = Object.freeze({
  fontFamilyDedup: 20,
  emojiAsIcon: 15,
  cssGradient: 15,
  allCapsStrokeShadow: 10,
  englishRhetoricOnZh: 10,
  roundedTokenVariance: 20,
  iconCircleTriad: 15,
  kpiSandwich: 10,
  verticalRhythmVariance: 10
});

// Generic CSS font families we don't count toward the dedup cap.
const GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"
]);

// Unicode ranges that strongly suggest emoji-as-icon usage.
const EMOJI_RANGES = [
  [0x1f300, 0x1faff], // misc symbols + pictographs + emoticons + transport + supplemental
  [0x2600, 0x27bf],   // dingbats + arrows
  [0x1f000, 0x1f1ff]  // mahjong + regional indicator
];

// English rhetoric patterns often bolted onto Chinese titles.
const ENGLISH_RHETORIC_TOKENS = [
  "the future of",
  "unlock the power of",
  "elevate your",
  "in today's world",
  "in the age of",
  "next-generation",
  "next gen",
  "world-class",
  "best-in-class",
  "cutting-edge",
  "revolutionary",
  "transform your",
  "supercharge",
  "game-changing",
  "delight your",
  "innovative solutions",
  "synergy",
  "leverage",
  "paradigm shift",
  "disrupt"
];

const ROUNDED_TOKENS = [
  "rounded.none", "rounded.sm", "rounded.md", "rounded.lg", "rounded.xl", "rounded.full"
];

/**
 * Extract the role of an element by reading `el.style.typography` token
 * and mapping to one of: "title" | "subtitle" | "heading" | "body" |
 * "caption" | "metric". Returns "body" as a default fallback per KTD-8.
 */
export function inferRole(element) {
  if (!element || typeof element !== "object") return "body";
  // 1. Explicit el.role wins (some manifests tag elements directly).
  if (typeof element.role === "string" && element.role.trim()) {
    return normalizeRole(element.role);
  }
  // 2. style.typography token reference.
  const style = element.style ?? {};
  const tokenRaw = style.typography ?? style.typographyToken;
  if (typeof tokenRaw === "string") {
    return roleFromTypographyToken(tokenRaw);
  }
  // 3. style.fontSize / role hints.
  if (typeof style.fontSize === "number") {
    if (style.fontSize >= 24) return "title";
    if (style.fontSize >= 16) return "heading";
    if (style.fontSize <= 10) return "caption";
  }
  // 4. ID-based inference (Cal-0 corpus uses naming conventions
  //    like `card-metric-005`, `kpi-card-1`, `metric-big-number`).
  const id = String(element.id ?? "").toLowerCase();
  if (/(^|[-_])(metric|kpi|stat|big-?number)([-_]|$)/.test(id)) return "metric";
  if (/(^|[-_])(title|hero|headline)([-_]|$)/.test(id)) return "title";
  if (/(^|[-_])(subtitle|sub|eyebrow|kicker)([-_]|$)/.test(id)) return "subtitle";
  if (/(^|[-_])(caption|footnote|note)([-_]|$)/.test(id)) return "caption";
  return "body";
}

function normalizeRole(role) {
  const lower = String(role).toLowerCase().trim();
  if (lower === "metric" || lower === "kpi") return "metric";
  if (lower === "title" || lower === "hero") return "title";
  if (lower === "subtitle" || lower === "sub") return "subtitle";
  if (lower === "heading" || lower === "h1" || lower === "h2" || lower === "h3") return "heading";
  if (lower === "caption" || lower === "footnote") return "caption";
  return "body";
}

function roleFromTypographyToken(token) {
  // Strip surrounding braces + namespace prefix.
  // e.g. "{typography.title}" -> "title", "typography.subtitle" -> "subtitle"
  const cleaned = String(token).replace(/[{}\s]/g, "");
  const m = /typography\.(.+)$/.exec(cleaned);
  if (!m) return "body";
  return normalizeRole(m[1]);
}

/**
 * Walk the entire manifest and collect every text/shape element with its
 * inferred role. Pure function (no mutation of the input).
 */
function collectElements(manifest) {
  const out = [];
  const slides = Array.isArray(manifest?.slides) ? manifest.slides : [];
  for (const slide of slides) {
    const elements = Array.isArray(slide?.elements) ? slide.elements : [];
    for (const el of elements) {
      out.push({
        id: el.id ?? "(unknown)",
        type: el.type,
        role: inferRole(el),
        el
      });
    }
  }
  return out;
}

function uniqueFontFamilies(elements, designTokens) {
  const set = new Set();
  for (const { el } of elements) {
    const style = el?.style ?? {};
    if (typeof style.fontFamily === "string") {
      addFontFamilies(style.fontFamily, set);
    }
  }
  // Also count resolved design tokens.
  const tokenFonts = designTokens?.typography ?? designTokens?.fonts ?? {};
  if (tokenFonts && typeof tokenFonts === "object") {
    walkFonts(tokenFonts, set);
  }
  return set;
}

function addFontFamilies(cssValue, set) {
  for (const part of String(cssValue).split(",")) {
    const cleaned = part.trim().replace(/^["']|["']$/g, "").trim();
    if (!cleaned) continue;
    if (GENERIC_FONT_FAMILIES.has(cleaned.toLowerCase())) continue;
    set.add(cleaned);
  }
}

function walkFonts(node, set) {
  if (node == null) return;
  if (typeof node === "string") {
    addFontFamilies(node, set);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkFonts(child, set);
    return;
  }
  if (typeof node === "object") {
    if (typeof node.fontFamily === "string") {
      addFontFamilies(node.fontFamily, set);
    }
    for (const child of Object.values(node)) walkFonts(child, set);
  }
}

function countEmojiInText(elements) {
  let count = 0;
  for (const { el } of elements) {
    const text = el?.text ?? el?.label ?? "";
    if (typeof text !== "string") continue;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (isEmojiCodePoint(cp)) {
        count += 1;
        break; // one hit per element is enough
      }
    }
  }
  return count;
}

function isEmojiCodePoint(cp) {
  for (const [lo, hi] of EMOJI_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function countGradientInline(elements) {
  let count = 0;
  const re = /linear-gradient\s*\(|radial-gradient\s*\(|conic-gradient\s*\(/i;
  for (const { el } of elements) {
    const style = el?.style ?? {};
    if (re.test(String(style.fill ?? ""))) { count += 1; continue; }
    if (re.test(String(style.background ?? ""))) { count += 1; continue; }
    if (re.test(String(style.backgroundImage ?? ""))) { count += 1; continue; }
    if (re.test(String(el?.fill ?? ""))) { count += 1; continue; }
  }
  return count;
}

function countAllCapsStrokeShadow(elements) {
  let count = 0;
  for (const { el } of elements) {
    const style = el?.style ?? {};
    const text = String(el?.text ?? "");
    const isAllCaps = /[A-Z]/.test(text) && text === text.toUpperCase() && /[A-Z]/.test(text);
    const hasStroke = style.stroke != null && style.stroke !== "none" && style.stroke !== "";
    const hasShadow = style.shadow != null && style.shadow !== "none" && style.shadow !== "";
    if (isAllCaps && hasStroke && hasShadow) {
      count += 1;
    }
  }
  return count;
}

function countEnglishRhetoricOnZhTitle(elements) {
  let count = 0;
  const re = new RegExp(`\\b(${ENGLISH_RHETORIC_TOKENS.map(escapeRegex).join("|")})\\b`, "i");
  for (const { role, el } of elements) {
    if (role !== "title" && role !== "subtitle") continue;
    const text = String(el?.text ?? "");
    if (!text) continue;
    if (!/[一-鿿]/.test(text)) continue;
    if (re.test(text)) {
      count += 1;
    }
  }
  return count;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countRoundedTokenVariance(elements, designTokens) {
  // Group shapes/cards by slide and check whether the rounded.* token
  // resolves to the same value across all cards on a slide.
  // Strategy: for each slide, collect every shape element with a
  // rounded.* token in style.borderRadius, style.component, or style.fill;
  // count the slide if the unique count is <= 1 AND there are >= 2 cards.
  const slideMap = new Map();
  for (const entry of elements) {
    const el = entry.el;
    if (!el || el.type !== "shape") continue;
    const token = extractRoundedToken(el, designTokens);
    if (!token) continue;
    const slideId = el._slideId ?? "(unknown)";
    if (!slideMap.has(slideId)) slideMap.set(slideId, new Set());
    slideMap.get(slideId).add(token);
  }
  let count = 0;
  for (const tokenSet of slideMap.values()) {
    if (tokenSet.size <= 1 && tokenSet.size > 0) count += 1;
  }
  return count;
}

function extractRoundedToken(element, designTokens) {
  const style = element?.style ?? {};
  const candidates = [
    style.borderRadius,
    style.radius,
    style.component,
    style.fill
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const m = candidate.match(/rounded\.(none|sm|md|lg|xl|full)/);
    if (m) return `rounded.${m[1]}`;
  }
  // Direct token reference (already-resolved style).
  if (typeof style.borderRadius === "string" && /^\d/.test(style.borderRadius.trim())) {
    return style.borderRadius.trim();
  }
  return null;
}

function countIconCircleTriad(elements) {
  // Per slide, look for shape entries where shape === "ellipse" AND a
  // sibling icon/glyph inside or adjacent. We approximate "triad" as 3+
  // circle-shaped elements clustered at the same y-coordinate.
  const yBuckets = new Map();
  for (const { el } of elements) {
    if (!el || el.type !== "shape") continue;
    const shapeName = String(el.shape ?? "").toLowerCase();
    if (shapeName !== "ellipse" && shapeName !== "circle" && shapeName !== "oval") continue;
    const yKey = Math.round(Number(el.y ?? 0) * 4) / 4; // bucket to 0.25 in
    if (!yBuckets.has(yKey)) yBuckets.set(yKey, 0);
    yBuckets.set(yKey, yBuckets.get(yKey) + 1);
  }
  let count = 0;
  for (const n of yBuckets.values()) {
    if (n >= 3) count += 1;
  }
  return count;
}

function countKpiSandwich(elements) {
  // 3-up KPI sandwich: 3+ metric-role elements sharing the same y on a
  // single slide. Approximate by bucket on y to 0.25 in.
  // Cal-0 corpus (e.g. internal-004-html-input) shows a 4-card metric row
  // where each card has a metric-shaped id but a distinct x — we bucket
  // by y AND count the row regardless of how many cards share the row.
  const yBuckets = new Map();
  for (const { role, el } of elements) {
    if (role !== "metric") continue;
    const yKey = Math.round(Number(el.y ?? 0) * 4) / 4;
    if (!yBuckets.has(yKey)) yBuckets.set(yKey, 0);
    yBuckets.set(yKey, yBuckets.get(yKey) + 1);
  }
  let count = 0;
  for (const n of yBuckets.values()) {
    if (n >= 3) count += 1;
  }
  return count;
}

function countVerticalRhythmVariance(elements) {
  // Group shapes/text by slide (we use the y order on each "lane"). If
  // the gaps between consecutive elements' y values are all identical
  // (variance == 0), flag the slide.
  // We approximate by reading every element's y on the manifest order
  // (since true slide partitioning requires slideId propagation).
  const ys = elements.map(({ el }) => Number(el.y ?? 0)).filter((n) => Number.isFinite(n));
  if (ys.length < 3) return 0;
  const sorted = [...ys].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const g = +(sorted[i] - sorted[i - 1]).toFixed(3);
    if (g > 0) gaps.push(g);
  }
  if (gaps.length < 2) return 0;
  const distinct = new Set(gaps);
  return distinct.size === 1 ? 1 : 0;
}

/**
 * Main entry point. Pure function.
 *
 * @param {object} manifest  Decoded deck manifest.
 * @param {object} [designTokens]  Decoded DESIGN.md token table.
 * @returns {{score: number, signals: Array<{id: string, weight: number, count: number}>}}
 */
export function scoreSlopRisk(manifest, designTokens = {}) {
  const elements = collectElements(manifest);
  const safeTokens = (designTokens && typeof designTokens === "object") ? designTokens : {};

  const fontFamilies = uniqueFontFamilies(elements, safeTokens);

  const signals = [];

  // 1. font-family dedup
  {
    const count = fontFamilies.size;
    if (count > 3) {
      signals.push({ id: "font-family-dedup", weight: SLOP_WEIGHTS.fontFamilyDedup, count });
    } else {
      signals.push({ id: "font-family-dedup", weight: 0, count });
    }
  }

  // 2. emoji-as-icon
  {
    const count = countEmojiInText(elements);
    signals.push({ id: "emoji-as-icon", weight: count > 0 ? SLOP_WEIGHTS.emojiAsIcon : 0, count });
  }

  // 3. css-gradient in inline styles
  {
    const count = countGradientInline(elements);
    signals.push({ id: "css-gradient", weight: count > 0 ? SLOP_WEIGHTS.cssGradient : 0, count });
  }

  // 4. all-caps + stroke + shadow
  {
    const count = countAllCapsStrokeShadow(elements);
    signals.push({
      id: "all-caps-stroke-shadow",
      weight: count > 0 ? SLOP_WEIGHTS.allCapsStrokeShadow : 0,
      count
    });
  }

  // 5. English rhetoric on Chinese title
  {
    const count = countEnglishRhetoricOnZhTitle(elements);
    signals.push({
      id: "english-rhetoric-on-zh",
      weight: count > 0 ? SLOP_WEIGHTS.englishRhetoricOnZh : 0,
      count
    });
  }

  // 6. rounded-token variance
  {
    const count = countRoundedTokenVariance(elements, safeTokens);
    signals.push({
      id: "rounded-token-variance",
      weight: count > 0 ? SLOP_WEIGHTS.roundedTokenVariance : 0,
      count
    });
  }

  // 7. icon-circle triad
  {
    const count = countIconCircleTriad(elements);
    signals.push({
      id: "icon-circle-triad",
      weight: count > 0 ? SLOP_WEIGHTS.iconCircleTriad : 0,
      count
    });
  }

  // 8. 3-up KPI sandwich
  {
    const count = countKpiSandwich(elements);
    signals.push({
      id: "kpi-sandwich",
      weight: count > 0 ? SLOP_WEIGHTS.kpiSandwich : 0,
      count
    });
  }

  // 9. vertical-rhythm variance
  {
    const count = countVerticalRhythmVariance(elements);
    signals.push({
      id: "vertical-rhythm-variance",
      weight: count > 0 ? SLOP_WEIGHTS.verticalRhythmVariance : 0,
      count
    });
  }

  const penalty = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, Math.min(100, penalty));
  return { score, signals };
}

export const __test__ = {
  inferRole,
  collectElements,
  uniqueFontFamilies,
  countEmojiInText,
  countGradientInline,
  countAllCapsStrokeShadow,
  countEnglishRhetoricOnZhTitle,
  countRoundedTokenVariance,
  countIconCircleTriad,
  countKpiSandwich,
  countVerticalRhythmVariance,
  SLOP_WEIGHTS,
  ENGLISH_RHETORIC_TOKENS
};
