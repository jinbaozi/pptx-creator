/**
 * color-tokens.mjs
 *
 * Shared mapper that resolves extracted colors to DESIGN.md tokens using
 * CIE76 ΔE in CIELAB space. Used by both the HTML adapter (CSS rule
 * resolution — exact hex → token key) and the image adapter (extracted
 * palette → nearest token within ΔE76 threshold).
 *
 * - Pure JS, no new dependency.
 * - sRGB → linear RGB → XYZ (D65) → LAB, then ΔE76 distance.
 * - Strict replica mode (`options.isReplica === true`) bypasses resolution.
 *
 * Exports:
 *   deltaE76(rgbA, rgbB)          pure math, returns a non-negative number.
 *   resolveTokens(extracted, tokens, options)
 *                                 nearest-token matcher, returns
 *                                 `{matches, unmapped, paletteMatch, skipped}`.
 *
 * Conventions:
 *   - All hex inputs are 6-digit "#RRGGBB", case-insensitive on entry.
 *   - token value strings may be "#RRGGBB" or any token reference — only
 *     literal hex values are used for distance math.
 *   - `paletteMatch` is 0..1; empty inputs return 1 (no mismatch).
 *   - `confidence` is `1 - (ΔE / threshold)` clamped to [0, 1].
 */

const D65 = {
  // sRGB → XYZ (D65) matrix (rows = R, G, B; columns = X, Y, Z).
  // Standard sRGB primaries with D65 white point.
  xn: 95.047,
  yn: 100.0,
  zn: 108.883
};

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function srgbChannelToLinear(c) {
  // c is 0..1
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function pivotXyz(t) {
  // t in [0, 1.0+]; f(t) for the LAB L* term
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/**
 * Parse "#RRGGBB" or "RRGGBB" (case-insensitive) into [r, g, b] each 0..255.
 * Throws on invalid input. Used internally and exposed for tests.
 */
export function hexToRgb(hex) {
  if (typeof hex !== "string") {
    throw new TypeError(`hexToRgb expected string, got ${typeof hex}`);
  }
  const trimmed = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    throw new RangeError(`hexToRgb: invalid hex "${hex}"`);
  }
  const value = parseInt(trimmed, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToLab([r, g, b]) {
  const rl = srgbChannelToLinear(r / 255);
  const gl = srgbChannelToLinear(g / 255);
  const bl = srgbChannelToLinear(b / 255);

  // sRGB → XYZ (D65). Multipliers from the sRGB specification.
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;

  const fx = pivotXyz(x / (D65.xn / 100));
  const fy = pivotXyz(y / (D65.yn / 100));
  const fz = pivotXyz(z / (D65.zn / 100));

  const L = 116 * fy - 16;
  const A = 500 * (fx - fy);
  const B = 200 * (fy - fz);
  return [L, A, B];
}

/**
 * CIE76 ΔE between two sRGB colors. Accepts:
 *   - two `[r, g, b]` tuples (0..255), or
 *   - two `"#RRGGBB"` strings.
 *
 * Returns 0 for identical colors. Magnitude grows roughly with perceptual
 * difference — typical ΔE76 thresholds in design tooling are 1 (just
 * noticeable) to 10 (clearly different).
 */
export function deltaE76(a, b) {
  let rgbA;
  let rgbB;
  if (typeof a === "string") rgbA = hexToRgb(a);
  else rgbA = a;
  if (typeof b === "string") rgbB = hexToRgb(b);
  else rgbB = b;
  const [l1, a1, b1] = rgbToLab(rgbA);
  const [l2, a2, b2] = rgbToLab(rgbB);
  const dL = l1 - l2;
  const dA = a1 - a2;
  const dB = b1 - b2;
  return Math.sqrt(dL * dL + dA * dA + dB * dB);
}

/**
 * Normalize an extracted-color entry. Tolerates either `{hex}` or `{value}`
 * as the input key, and a missing or empty `origin` string.
 */
function normalizeExtracted(entry, index) {
  if (typeof entry === "string") {
    return { hex: entry, origin: `entry-${index}` };
  }
  if (!entry || typeof entry !== "object") {
    throw new TypeError(`resolveTokens: entry ${index} must be string or object`);
  }
  const hex = entry.hex ?? entry.value;
  if (typeof hex !== "string" || hex.length === 0) {
    throw new TypeError(`resolveTokens: entry ${index} missing hex`);
  }
  const origin = entry.origin ?? `entry-${index}`;
  return { hex, origin };
}

function extractDesignColors(designTokens) {
  const colors = designTokens?.colors ?? {};
  const result = [];
  for (const name of Object.keys(colors)) {
    const value = colors[name];
    if (typeof value !== "string") continue;
    // Accept literal hex; ignore token references like "{colors.primary}".
    const trimmed = value.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) continue;
    const hex = trimmed.startsWith("#") ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
    result.push({ name, hex });
  }
  return result;
}

/**
 * Build a hex-keyed lookup of design tokens (case-insensitive). Used by the
 * HTML adapter's exact-match branch.
 */
export function buildTokenLookup(designTokens) {
  const lookup = new Map();
  const tokens = designTokens?.colors ?? {};
  for (const name of Object.keys(tokens)) {
    const value = tokens[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) continue;
    const hex = trimmed.startsWith("#") ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
    lookup.set(hex, name);
  }
  return lookup;
}

/**
 * Resolve a list of extracted colors against a DESIGN.md token table.
 *
 * @param {Array<{hex: string, origin?: string}>|string[]} extractedColors
 * @param {{colors: Record<string, string>}} designTokens
 * @param {object} [options]
 *   - formula: 'ΔE76' (only one supported; reserved for future ΔE94/ΔE2000).
 *   - threshold: ΔE76 cutoff for a match (default 8).
 *   - isReplica: when true, skip resolution entirely.
 *
 * @returns {{
 *   matches: Array<{extractedHex, tokenName, deltaE, confidence, origin}>,
 *   unmapped: Array<{extractedHex, origin}>,
 *   paletteMatch: number,
 *   skipped: boolean
 * }}
 */
export function resolveTokens(extractedColors, designTokens, options = {}) {
  const formula = options.formula ?? "ΔE76";
  const threshold = options.threshold ?? 8;
  const isReplica = Boolean(options.isReplica);

  if (formula !== "ΔE76") {
    throw new RangeError(`resolveTokens: unsupported formula "${formula}"`);
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new RangeError(`resolveTokens: threshold must be a positive number`);
  }

  if (isReplica) {
    return { matches: [], unmapped: [], paletteMatch: 0, skipped: true };
  }

  const extracted = (extractedColors ?? []).map((entry, index) => normalizeExtracted(entry, index));
  const designColors = extractDesignColors(designTokens);

  if (extracted.length === 0) {
    return { matches: [], unmapped: [], paletteMatch: 1, skipped: false };
  }
  if (designColors.length === 0) {
    return {
      matches: [],
      unmapped: extracted.map(({ hex, origin }) => ({ extractedHex: hex, origin })),
      paletteMatch: 0,
      skipped: false
    };
  }

  const matches = [];
  const unmapped = [];
  let weightedMatchSum = 0;
  let totalWeight = 0;

  for (const { hex, origin } of extracted) {
    let normalizedHex;
    try {
      const [r, g, b] = hexToRgb(hex);
      normalizedHex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    } catch (err) {
      // Invalid hex — treat as unmapped; downstream reports the original string.
      unmapped.push({ extractedHex: hex, origin });
      totalWeight += 1;
      continue;
    }

    let nearest = null;
    for (const token of designColors) {
      const delta = deltaE76(normalizedHex, token.hex);
      if (nearest === null || delta < nearest.deltaE) {
        nearest = { tokenName: token.name, hex: token.hex, deltaE: delta };
      }
    }

    const weightMatch = /^\s*$/.test(origin) ? 1 : 1;
    totalWeight += weightMatch;

    if (nearest.deltaE <= threshold) {
      const confidence = clamp01(1 - nearest.deltaE / threshold);
      matches.push({
        extractedHex: normalizedHex,
        tokenName: nearest.tokenName,
        deltaE: round4(nearest.deltaE),
        confidence: round4(confidence),
        origin
      });
      weightedMatchSum += weightMatch * confidence;
    } else {
      unmapped.push({ extractedHex: normalizedHex, origin });
      weightedMatchSum += 0;
    }
  }

  const paletteMatch = totalWeight === 0 ? 1 : round4(weightedMatchSum / totalWeight);

  return {
    matches,
    unmapped,
    paletteMatch,
    skipped: false
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Convenience: resolve a single hex to a token reference string ("{colors.name}")
 * if the lookup matches a design token exactly, or return null otherwise.
 * Used by the HTML adapter for direct CSS → token-key mapping.
 */
export function exactTokenRef(hex, tokenLookup) {
  if (!(tokenLookup instanceof Map) || typeof hex !== "string") return null;
  const trimmed = hex.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  const normalized = trimmed.startsWith("#") ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
  const tokenName = tokenLookup.get(normalized);
  if (!tokenName) return null;
  return `colors.${tokenName}`;
}