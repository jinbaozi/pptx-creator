/**
 * Font pre-flight verifier.
 *
 * Walks system font directories to confirm every font referenced by a
 * manifest is actually installed. Two detection paths are supported:
 *
 *   - "fontkit"   — dynamic-imported. Reads postscriptName + familyName
 *                   out of each .ttf/.otf/.ttc. Highest fidelity.
 *   - "magic-byte"— Pure-JS fallback. Reads the first 4 bytes of each file
 *                   and confirms the TTF (0x00010000) or OTF ("OTTO") magic.
 *                   Names are NOT extracted in this mode.
 *
 * Output is always JSON-serializable.
 *
 * The pattern follows `scripts/lib/python-utils.mjs:26-59` (graceful
 * fallback) and `scripts/lib/ocr_core.py:127-138` (deferred status when
 * a dependency is unavailable).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKEN_PATTERN = /^\{([a-zA-Z][\w.-]*)\}$/;
const DEFAULT_FALLBACK = "system-default";

const SYSTEM_FONT_DIRS = {
  darwin: ["/Library/Fonts", "/System/Library/Fonts", join(homedir(), "Library/Fonts")],
  linux: [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    join(homedir(), ".local", "share", "fonts"),
    join(homedir(), ".fonts")
  ],
  win32: ["C:\\Windows\\Fonts"]
};

/**
 * Resolve a single `{typography.title}`-style token against the design's
 * token map. Returns the original string when no token shape matches.
 */
function resolveTokenString(value, tokens) {
  if (typeof value !== "string") return value;
  const match = TOKEN_PATTERN.exec(value.trim());
  if (!match) return value;
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

/**
 * Recursively collect font references from a value, walking through
 * nested objects and arrays. Token strings like `{typography.title}`
 * are resolved against the design tokens when available.
 */
function collectFontsFromValue(value, tokens, out, key = null) {
  if (value == null) return;
  if (typeof value === "string") {
    const resolved = resolveTokenString(value, tokens);
    if (typeof resolved === "string") {
      if (key === "fontFamily") addFontName(out, resolved);
    } else if (resolved && typeof resolved === "object") {
      collectFontsFromValue(resolved, tokens, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFontsFromValue(item, tokens, out, key);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      collectFontsFromValue(child, tokens, out, childKey);
    }
  }
}

function addFontName(set, raw) {
  if (typeof raw !== "string") return;
  // A CSS font-family value may list several names separated by commas.
  // Split on commas, strip quotes/whitespace, drop generic families.
  const generics = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
  for (const part of raw.split(",")) {
    const cleaned = part
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (!cleaned) continue;
    if (generics.has(cleaned.toLowerCase())) continue;
    set.add(cleaned);
  }
}

/**
 * Returns the set of font directories appropriate for the current OS.
 * Directories that don't exist are filtered out.
 */
function getFontDirs() {
  const dirs = SYSTEM_FONT_DIRS[process.platform] ?? SYSTEM_FONT_DIRS.linux;
  return dirs.filter((dir) => existsSync(dir));
}

function walkFontFiles(rootDir, out) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFontFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(".ttf") && !lower.endsWith(".otf") && !lower.endsWith(".ttc")) continue;
    try {
      const stats = statSync(full);
      if (!stats.isFile()) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
}

function collectFontFiles() {
  const dirs = getFontDirs();
  const files = [];
  for (const dir of dirs) {
    walkFontFiles(dir, files);
  }
  return files.sort();
}

async function loadFontkit() {
  try {
    const mod = await import("fontkit");
    return mod.default ?? mod;
  } catch (error) {
    return { error };
  }
}

function readMagicBytes(filePath) {
  try {
    const fd = readFileSync(filePath);
    if (fd.length < 4) return null;
    return [fd[0], fd[1], fd[2], fd[3]];
  } catch {
    return null;
  }
}

function isTtfMagic(bytes) {
  return (
    bytes[0] === 0x00 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  );
}

function isOtfMagic(bytes) {
  return bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f;
}

/**
 * Build the availability map and source label using fontkit (preferred).
 * Returns `null` for `source` when fontkit cannot enumerate any names —
 * callers should fall back to the magic-byte path.
 */
function fontFaces(container) {
  if (Array.isArray(container?.fonts)) return container.fonts;
  return container ? [container] : [];
}

function normalizedFontName(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

const FONT_WEIGHT_KEYWORDS = Object.freeze({
  thin: 100,
  hairline: 100,
  extralight: 200,
  "extra-light": 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  "semi-bold": 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  "extra-bold": 800,
  ultrabold: 800,
  black: 900,
  heavy: 900
});

const FONT_STRETCH_KEYWORDS = Object.freeze({
  ultracondensed: 50,
  "extra-condensed": 62.5,
  extracondensed: 62.5,
  condensed: 75,
  "semi-condensed": 87.5,
  "semi condensed": 87.5,
  normal: 100,
  "semi-expanded": 112.5,
  semiexpanded: 112.5,
  expanded: 125,
  "extra-expanded": 150,
  extraexpanded: 150,
  ultraexpanded: 200
});

// `usWidthClass` is an integer from 1 (ultra-condensed) to 9 (ultra-expanded).
const WIDTH_CLASS_TO_PERCENT = Object.freeze({
  1: 50,
  2: 62.5,
  3: 75,
  4: 87.5,
  5: 100,
  6: 112.5,
  7: 125,
  8: 150,
  9: 200
});

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWeight(value, fallback = 400) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
    if (normalized in FONT_WEIGHT_KEYWORDS) return FONT_WEIGHT_KEYWORDS[normalized];
  }
  return numberOrNull(value) ?? fallback;
}

function normalizeStretch(value, fallback = 100) {
  if (typeof value === "string") {
    const cleaned = value.trim().toLowerCase().replace(/\s+/g, "-");
    if (cleaned in FONT_STRETCH_KEYWORDS) return FONT_STRETCH_KEYWORDS[cleaned];
    if (cleaned.endsWith("%")) return numberOrNull(cleaned.slice(0, -1)) ?? fallback;
  }
  const number = numberOrNull(value);
  if (number == null) return fallback;
  return number >= 1 && number <= 9 && Number.isInteger(number)
    ? WIDTH_CLASS_TO_PERCENT[number] ?? fallback
    : number;
}

function normalizeStyle(value, italic = false) {
  if (typeof value === "boolean") return value ? "italic" : "normal";
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "oblique") return "oblique";
  if (normalized === "italic") return "italic";
  return italic ? "italic" : "normal";
}

/**
 * Convert a CSS-like request or a font metadata object to a stable face query.
 * The old string-only `resolveFontFamily(name, text)` call remains supported.
 */
export function normalizeFontRequest(request, text = "") {
  const raw = typeof request === "string" ? { fontFamily: request } : (request ?? {});
  const family = raw.family ?? raw.fontFamily ?? raw.familyName ?? raw.name ?? "";
  const style = normalizeStyle(raw.style ?? raw.fontStyle, raw.italic === true);
  const axes = raw.variationAxes ?? raw.axes ?? raw.variations ?? {};
  return {
    family: String(family ?? "").trim(),
    postscriptName: raw.postscriptName ?? raw.postScriptName ?? null,
    fullName: raw.fullName ?? null,
    weight: normalizeWeight(raw.weight ?? raw.fontWeight, 400),
    style,
    stretch: normalizeStretch(raw.stretch ?? raw.fontStretch, 100),
    variationAxes: axes && typeof axes === "object" && !Array.isArray(axes) ? { ...axes } : {},
    text: raw.text ?? text ?? "",
    allowFallback: raw.allowFallback !== false
  };
}

function os2ForFace(face) {
  return face?.["OS/2"] ?? face?.os2 ?? face?.OS2 ?? {};
}

function inferFontWeight(face) {
  const os2 = os2ForFace(face);
  const direct = face?.weight ?? face?.weightClass ?? os2.usWeightClass;
  if (direct != null) return normalizeWeight(direct);
  const names = [face?.subfamilyName, face?.fullName, face?.postscriptName]
    .filter(Boolean).join(" ").toLowerCase().replace(/[-_]/g, " ");
  for (const [keyword, weight] of Object.entries(FONT_WEIGHT_KEYWORDS)) {
    if (names.includes(keyword.replace(/-/g, " "))) return weight;
  }
  return 400;
}

function inferFontStyle(face) {
  const os2 = os2ForFace(face);
  const selection = os2.fsSelection ?? {};
  const italic = face?.italic === true
    || face?.isItalic === true
    || selection.italic === true
    || (face?.italicAngle != null && Number(face.italicAngle) !== 0);
  const oblique = face?.oblique === true || selection.oblique === true;
  return oblique ? "oblique" : italic ? "italic" : "normal";
}

function inferFontStretch(face) {
  const os2 = os2ForFace(face);
  if (face?.stretch != null) return normalizeStretch(face.stretch);
  if (os2.usWidthClass != null) return normalizeStretch(os2.usWidthClass);
  const names = [face?.subfamilyName, face?.fullName, face?.postscriptName]
    .filter(Boolean).join(" ").toLowerCase().replace(/[-_]/g, " ");
  if (/ultra\s*condensed/.test(names)) return 50;
  if (/extra\s*condensed/.test(names)) return 62.5;
  if (/semi\s*condensed/.test(names)) return 87.5;
  if (/condensed|narrow/.test(names)) return 75;
  if (/ultra\s*expanded/.test(names)) return 200;
  if (/extra\s*expanded/.test(names)) return 150;
  if (/semi\s*expanded/.test(names)) return 112.5;
  if (/expanded|wide/.test(names)) return 125;
  return 100;
}

function variableAxesForFace(face) {
  const axes = face?.variationAxes ?? face?.axes ?? {};
  if (!axes || typeof axes !== "object" || Array.isArray(axes)) return {};
  return Object.fromEntries(Object.entries(axes).map(([tag, value]) => {
    if (value && typeof value === "object") {
      return [tag, {
        name: value.name ?? tag,
        min: numberOrNull(value.min),
        default: numberOrNull(value.default),
        max: numberOrNull(value.max)
      }];
    }
    return [tag, { name: tag, min: null, default: numberOrNull(value), max: null }];
  }));
}

function fsTypeValue(face) {
  const os2 = os2ForFace(face);
  return face?.fsType ?? os2.fsType ?? null;
}

/**
 * Interpret OpenType OS/2 fsType bits (or fontkit's decoded object) without
 * claiming that an unknown license is safe to embed.
 */
export function embeddingLicenseFromFsType(rawValue) {
  const numeric = numberOrNull(rawValue);
  const decoded = rawValue && typeof rawValue === "object" ? rawValue : {};
  const restricted = numeric != null
    ? Boolean(numeric & 0x0002)
    : Boolean(decoded.noEmbedding || decoded.restricted || decoded.restrictedLicense);
  const previewPrint = numeric != null
    ? Boolean(numeric & 0x0004)
    : Boolean(decoded.previewPrint || decoded.previewAndPrint || decoded.previewOnly || decoded.viewOnly);
  const editable = numeric != null
    ? Boolean(numeric & 0x0008)
    : Boolean(decoded.editable || decoded.editableEmbedding);
  const noSubsetting = numeric != null
    ? Boolean(numeric & 0x0100)
    : Boolean(decoded.noSubsetting);
  const bitmapOnly = numeric != null
    ? Boolean(numeric & 0x0200)
    : Boolean(decoded.bitmapOnly);
  let mode = "unknown";
  let canEmbed = null;
  let reason = "fsType was not exposed by the font parser";
  if (restricted) {
    mode = "restricted";
    canEmbed = false;
    reason = "OS/2 fsType restricts embedding";
  } else if (editable) {
    mode = "editable";
    canEmbed = true;
    reason = "editable embedding permitted";
  } else if (previewPrint) {
    mode = "preview-print";
    canEmbed = true;
    reason = "preview/print embedding permitted";
  } else if (numeric != null || Object.keys(decoded).length > 0) {
    mode = "installable";
    canEmbed = true;
    reason = "installable embedding permitted";
  }
  return {
    fsType: numeric != null ? numeric : rawValue ?? null,
    mode,
    canEmbed,
    noSubsetting,
    bitmapOnly,
    reason
  };
}

function glyphCoverage(face, text = "") {
  const chars = [...String(text ?? "")];
  const missing = [];
  let covered = 0;
  for (const char of chars) {
    if (/\s/.test(char)) {
      covered += 1;
      continue;
    }
    let supported = true;
    if (face && typeof face.glyphForCodePoint === "function") {
      try {
        const glyph = face.glyphForCodePoint(char.codePointAt(0));
        supported = Boolean(glyph && glyph.id !== 0);
      } catch {
        supported = false;
      }
    }
    if (supported) covered += 1;
    else missing.push({ char, codePoint: char.codePointAt(0) });
  }
  const total = chars.length;
  return {
    text: String(text ?? ""),
    totalGlyphs: total,
    coveredGlyphs: covered,
    missingGlyphs: missing,
    ratio: total === 0 ? 1 : covered / total,
    complete: missing.length === 0
  };
}

function faceMetadata(face, filePath, index) {
  const embedding = embeddingLicenseFromFsType(fsTypeValue(face));
  return {
    filePath: filePath ?? null,
    faceIndex: index,
    familyName: face?.familyName ?? null,
    postscriptName: face?.postscriptName ?? null,
    fullName: face?.fullName ?? null,
    subfamilyName: face?.subfamilyName ?? null,
    weight: inferFontWeight(face),
    style: inferFontStyle(face),
    stretch: inferFontStretch(face),
    variableAxes: variableAxesForFace(face),
    embedding,
    names: [face?.familyName, face?.postscriptName, face?.fullName]
      .filter(Boolean).map((value) => String(value)),
    _face: face
  };
}

function publicFaceMetadata(entry) {
  if (!entry) return null;
  const { _face, ...publicEntry } = entry;
  return publicEntry;
}

function splitFontFamilies(value) {
  return String(value ?? "").split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function nameMatchRank(entry, request) {
  const requestedNames = [
    ...splitFontFamilies(request.family),
    request.postscriptName,
    request.fullName
  ].filter(Boolean).map(normalizedFontName);
  const candidateNames = [entry.familyName, entry.postscriptName, entry.fullName]
    .filter(Boolean).map(normalizedFontName);
  let best = Infinity;
  for (const requested of requestedNames) {
    for (let index = 0; index < candidateNames.length; index += 1) {
      if (requested && requested === candidateNames[index]) best = Math.min(best, index);
    }
  }
  return best;
}

function styleDistance(requested, actual) {
  if (requested === actual) return 0;
  if (requested === "italic" && actual === "oblique") return 1;
  if (requested === "oblique" && actual === "italic") return 1;
  return 2;
}

function axisDistance(requestedAxes, candidateAxes) {
  let distance = 0;
  for (const [tag, requestedValue] of Object.entries(requestedAxes ?? {})) {
    const requested = numberOrNull(requestedValue);
    if (requested == null) continue;
    const axis = candidateAxes?.[tag];
    if (!axis) {
      distance += 100;
      continue;
    }
    const min = axis.min ?? requested;
    const max = axis.max ?? requested;
    const clamped = Math.max(min, Math.min(max, requested));
    distance += Math.abs(requested - clamped);
  }
  return distance;
}

/**
 * Return a deterministic lower-is-better score for a candidate face.
 * Family identity dominates style/weight, while complete glyph coverage is
 * preferred when two otherwise-near faces compete.
 */
export function scoreFontFace(candidate, request, text = "") {
  const entry = candidate?._face ? candidate : faceMetadata(candidate, null, 0);
  const normalized = normalizeFontRequest(request, text);
  const familyRank = nameMatchRank(entry, normalized);
  const familyPenalty = Number.isFinite(familyRank) ? familyRank * 100 : 1000;
  const coverage = glyphCoverage(entry._face, normalized.text);
  const coveragePenalty = coverage.complete ? 0 : 100 + coverage.missingGlyphs.length * 10;
  const weightPenalty = Math.abs(normalized.weight - entry.weight) / 10;
  const stylePenalty = styleDistance(normalized.style, entry.style) * 20;
  const stretchPenalty = Math.abs(normalized.stretch - entry.stretch) / 10;
  const axesPenalty = axisDistance(normalized.variationAxes, entry.variableAxes);
  return familyPenalty * 10000 + coveragePenalty * 1000 + weightPenalty + stylePenalty + stretchPenalty + axesPenalty;
}

function faceMatchDetails(candidate, request, text = "") {
  const entry = candidate?._face ? candidate : faceMetadata(candidate, null, 0);
  const normalized = normalizeFontRequest(request, text);
  const familyRank = nameMatchRank(entry, normalized);
  const coverage = glyphCoverage(entry._face, normalized.text);
  return {
    score: scoreFontFace(entry, normalized),
    familyMatch: Number.isFinite(familyRank),
    familyRank,
    exactWeight: normalized.weight === entry.weight,
    exactStyle: normalized.style === entry.style,
    exactStretch: normalized.stretch === entry.stretch,
    coverage
  };
}

const PREFERRED_FALLBACKS = [
  "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei",
  "Hiragino Sans GB", "Heiti SC", "Songti SC", "Arial Unicode MS", "Arial"
];

function compareFaceEntries(left, right, request) {
  const scoreDelta = scoreFontFace(left, request) - scoreFontFace(right, request);
  if (scoreDelta !== 0) return scoreDelta;
  return [left.familyName, left.fullName, left.postscriptName, left.filePath, left.faceIndex]
    .map((value) => String(value ?? ""))
    .join("\u0000")
    .localeCompare([
      right.familyName, right.fullName, right.postscriptName, right.filePath, right.faceIndex
    ].map((value) => String(value ?? "")).join("\u0000"));
}

function preferredFallbackRank(entry) {
  const family = normalizedFontName(entry.familyName);
  const index = PREFERRED_FALLBACKS.findIndex((name) => normalizedFontName(name) === family);
  return index < 0 ? PREFERRED_FALLBACKS.length : index;
}

function resolveFaceEntry(entries, request, text = "", allowFallback = true) {
  const normalized = normalizeFontRequest(request, text);
  const familyMatches = entries.filter((entry) => Number.isFinite(nameMatchRank(entry, normalized)));
  let pool = familyMatches;
  if (familyMatches.length === 0 && !allowFallback) return null;

  // Prefer a complete face from the requested family, then a preferred
  // fallback with complete coverage. Never silently label a missing family as
  // present merely because a font file exists.
  const complete = (candidate) => glyphCoverage(candidate._face, normalized.text).complete;
  if (familyMatches.length > 0 && !familyMatches.some(complete) && allowFallback) {
    pool = entries.filter(complete);
    if (pool.length === 0) pool = entries;
  } else if (familyMatches.length === 0 && allowFallback) {
    const completeEntries = entries.filter(complete);
    pool = completeEntries.length > 0 ? completeEntries : entries;
    const preferred = pool.filter((entry) => preferredFallbackRank(entry) < PREFERRED_FALLBACKS.length);
    if (preferred.length > 0) pool = preferred;
  }
  return [...pool].sort((left, right) => compareFaceEntries(left, right, normalized))[0] ?? null;
}

function substitutionReason(request, entry, text = "") {
  if (!entry) return "unavailable";
  const normalized = normalizeFontRequest(request, text);
  const details = faceMatchDetails(entry, normalized);
  if (!details.coverage.complete) return "glyph-coverage-incomplete";
  if (!details.familyMatch) return "family-unavailable-fallback";
  if (details.exactWeight && details.exactStyle && details.exactStretch) return "exact-face";
  return "nearest-face-variant";
}

function enumerateWithFontkit(fontkit, fontFiles) {
  const names = new Set();
  const entries = [];
  let opened = 0;
  for (const filePath of fontFiles) {
    try {
      const container = fontkit.openSync(filePath);
      for (const [index, font] of fontFaces(container).entries()) {
        opened += 1;
        const entry = faceMetadata(font, filePath, index);
        entries.push(entry);
        for (const name of entry.names) names.add(name);
      }
    } catch {
      // Skip unreadable / unsupported fonts; fall through to magic bytes
      // if the file happens to be invalid for fontkit.
    }
  }
  return { names, opened, entries };
}

function catalogUnavailable() {
  return {
    source: "unavailable",
    faces: [],
    hasFont: () => false,
    resolveFontFace: () => null,
    resolveFontFamily: () => null,
    measureText: () => null
  };
}

export async function createFontMetricsCatalog(options = {}) {
  const files = Array.isArray(options.files) ? options.files.slice() : collectFontFiles();
  const fontkit = await (options.loadFontkit ?? loadFontkit)();
  if (!fontkit || typeof fontkit.openSync !== "function" || fontkit.error) {
    return catalogUnavailable();
  }
  const enumerated = enumerateWithFontkit(fontkit, files);
  const entries = enumerated.entries;
  if (entries.length === 0) return catalogUnavailable();
  const aliases = new Map();
  for (const entry of entries) {
    for (const name of entry.names) {
      const normalized = normalizedFontName(name);
      if (!normalized) continue;
      const list = aliases.get(normalized) ?? [];
      list.push(entry);
      aliases.set(normalized, list);
    }
  }
  const findFace = (fontFamily) => {
    for (const candidate of splitFontFamilies(fontFamily)) {
      const hit = aliases.get(normalizedFontName(candidate))?.[0];
      if (hit) return hit;
    }
    return null;
  };
  const resolveEntry = (request, text = "", allowFallback = true) =>
    resolveFaceEntry(entries, normalizeFontRequest(request, text), text, allowFallback);
  return {
    source: "fontkit",
    faces: entries.map(publicFaceMetadata),
    hasFont: (fontFamily) => Boolean(findFace(fontFamily)),
    resolveFontFace(request, text = "", options = {}) {
      return publicFaceMetadata(resolveEntry(request, text, options.allowFallback !== false));
    },
    resolveFontFamily(fontFamily, text = "") {
      const face = resolveEntry(fontFamily, text, true);
      return face?.familyName ?? face?.postscriptName ?? null;
    },
    measureText(text, fontSize, font = {}) {
      const entry = resolveEntry(font, text, font.allowFallback === true);
      const face = entry?._face;
      if (!face) return null;
      const layout = face.layout(String(text ?? ""));
      const advance = (layout.positions ?? []).reduce((sum, position) => sum + Number(position.xAdvance ?? 0), 0);
      const weightFactor = normalizeWeight(font.fontWeight ?? font.weight, 400) >= 700 ? 1.04 : 1;
      return advance / Number(face.unitsPerEm) * Number(fontSize) * weightFactor;
    }
  };
}

/**
 * Pure-JS enumeration. Confirms each file is a TTF/OTF/TTC by reading
 * the magic bytes; the returned `names` set is empty because the format
 * alone does not tell us the font's family/postscript name.
 */
function enumerateWithMagicBytes(fontFiles) {
  const names = new Set();
  let opened = 0;
  for (const filePath of fontFiles) {
    const bytes = readMagicBytes(filePath);
    if (!bytes) continue;
    if (isTtfMagic(bytes) || isOtfMagic(bytes)) {
      opened += 1;
      // We can confirm the file is a real font, but we cannot extract a
      // human-readable name from the magic bytes alone.
    }
  }
  return { names, opened };
}

function styleObjectFor(value, tokens) {
  if (!value || typeof value !== "object") return {};
  const typography = resolveTokenString(value.typography, tokens);
  return {
    ...(typography && typeof typography === "object" ? typography : {}),
    ...value
  };
}

function addFontRequest(requests, style, tokens, text = "", context = {}) {
  const resolved = styleObjectFor(style, tokens);
  const family = resolveTokenString(resolved.fontFamily, tokens);
  if (typeof family !== "string" || !family.trim()) return;
  const request = normalizeFontRequest({
    family,
    fontWeight: resolved.fontWeight ?? resolved.weight,
    fontStyle: resolved.fontStyle ?? resolved.style,
    italic: resolved.italic,
    fontStretch: resolved.fontStretch ?? resolved.stretch,
    variationAxes: resolved.variationAxes ?? resolved.axes,
    text
  });
  requests.push({ ...request, ...context });
}

/**
 * Collect style-aware font requests in manifest order. This is additive to
 * `collectReferencedFonts`, which intentionally remains a Set for callers
 * that only need family availability.
 */
export function collectReferencedFontRequests(manifest, tokens) {
  const requests = [];
  if (!manifest || typeof manifest !== "object") return requests;
  const designTokens = tokens ?? manifest.designSystem?.tokens ?? {};

  // A typography token can be used without a slide element (for example by a
  // downstream package), so retain it as a request with empty text.
  const visitTokens = (value, path = []) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.fontFamily != null) addFontRequest(requests, value, designTokens, "", { path: path.join(".") });
    for (const [key, child] of Object.entries(value)) visitTokens(child, [...path, key]);
  };
  visitTokens(designTokens);

  for (const [slideIndex, slide] of (Array.isArray(manifest.slides) ? manifest.slides : []).entries()) {
    addFontRequest(requests, slide?.style, designTokens, "", { slideIndex });
    for (const [elementIndex, element] of (Array.isArray(slide?.elements) ? slide.elements : []).entries()) {
      if (!element || typeof element !== "object") continue;
      addFontRequest(requests, element.style, designTokens, element.text ?? "", {
        slideId: slide.id,
        elementId: element.id,
        slideIndex,
        elementIndex
      });
    }
  }
  const seen = new Set();
  return requests.filter((request) => {
    const key = JSON.stringify({
      family: request.family,
      weight: request.weight,
      style: request.style,
      stretch: request.stretch,
      variationAxes: request.variationAxes,
      text: request.text
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pre-flight all font references in `manifest`.
 *
 * @param {object} manifest   Decoded `deck.manifest.json`.
 * @param {object} [design]   Decoded `DESIGN.md` (provides tokens).
 * @param {object} [options]  Optional `{ fonts?: Set<string>, files?: string[],
 *                            loadFontkit?: () => Promise<object> }` overrides.
 * @returns {Promise<{
 *   availability: Record<string, "present" | "missing">,
 *   fallback: Array<{ requested: string, fallback: string }>,
 *   source: "fontkit" | "magic-byte" | "unavailable"
 * }>}
 */
export async function preflightFonts(manifest, design, options = {}) {
  const tokens = (design && design.tokens) || (manifest && manifest.designSystem && manifest.designSystem.tokens) || {};
  const referencedFonts = options.fonts instanceof Set
    ? new Set(options.fonts)
    : collectReferencedFonts(manifest, tokens);
  const requests = Array.isArray(options.fontRequests)
    ? options.fontRequests.map((request) => normalizeFontRequest(request, request?.text ?? ""))
    : options.fonts instanceof Set
      ? [...referencedFonts].map((family) => normalizeFontRequest({ family }))
      : collectReferencedFontRequests(manifest, tokens);

  const files = Array.isArray(options.files)
    ? options.files.slice()
    : collectFontFiles();

  // No fonts are referenced — nothing to verify.
  if (referencedFonts.size === 0 && requests.length === 0) {
    return { availability: {}, fallback: [], source: files.length > 0 ? "fontkit" : "unavailable" };
  }

  // Prefer fontkit; fall back to magic-byte detection.
  const fontkit = await (options.loadFontkit ?? loadFontkit)();
  let availableNames = new Set();
  let entries = [];
  let source;
  if (fontkit && typeof fontkit.openSync === "function" && !fontkit.error) {
    const result = enumerateWithFontkit(fontkit, files);
    availableNames = result.names;
    entries = result.entries;
    if (availableNames.size > 0) {
      source = "fontkit";
    } else {
      const magic = enumerateWithMagicBytes(files);
      source = magic.opened > 0 ? "magic-byte" : "unavailable";
    }
  } else {
    const magic = enumerateWithMagicBytes(files);
    source = magic.opened > 0 ? "magic-byte" : "unavailable";
  }

  const availability = {};
  const fallback = [];
  for (const font of referencedFonts) {
    if ([...availableNames].some((name) => normalizedFontName(name) === normalizedFontName(font))) {
      availability[font] = "present";
    } else {
      availability[font] = "missing";
      fallback.push({ requested: font, fallback: DEFAULT_FALLBACK });
    }
  }

  const resolutions = requests.map((request) => {
    const resolvedEntry = resolveFaceEntry(entries, request, request.text, true);
    const coverage = resolvedEntry
      ? glyphCoverage(resolvedEntry._face, request.text)
      : { text: String(request.text ?? ""), totalGlyphs: 0, coveredGlyphs: 0, missingGlyphs: [], ratio: 0, complete: false };
    const resolved = publicFaceMetadata(resolvedEntry);
    const requested = {
      family: request.family,
      postscriptName: request.postscriptName,
      fullName: request.fullName,
      weight: request.weight,
      style: request.style,
      stretch: request.stretch,
      variationAxes: request.variationAxes,
      text: request.text,
      ...(request.slideId ? { slideId: request.slideId } : {}),
      ...(request.elementId ? { elementId: request.elementId } : {})
    };
    return {
      requested,
      resolved,
      requestedFace: requested,
      resolvedFace: resolved,
      substitutionReason: substitutionReason(request, resolvedEntry, request.text),
      glyphCoverage: coverage,
      embedding: resolved?.embedding ?? embeddingLicenseFromFsType(null)
    };
  });

  return {
    availability,
    fallback,
    source,
    resolutions,
    // `faceMatches` is the explicit report name used by downstream QA; keep
    // `resolutions` as the compact API for callers that need the same data.
    faceMatches: resolutions
  };
}

/**
 * Collect every unique font family referenced by the manifest's design
 * tokens and element styles.
 */
export function collectReferencedFonts(manifest, tokens) {
  const fonts = new Set();
  if (!manifest || typeof manifest !== "object") return fonts;

  // Design-system tokens (resolved + unresolved token strings).
  const designTokens =
    tokens ?? (manifest.designSystem && manifest.designSystem.tokens) ?? {};
  collectFontsFromValue(designTokens, designTokens, fonts);

  // Slide-level element styles.
  const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
  for (const slide of slides) {
    collectFontsFromValue(slide?.style, designTokens, fonts);
    const elements = Array.isArray(slide?.elements) ? slide.elements : [];
    for (const element of elements) {
      collectFontsFromValue(element?.style, designTokens, fonts);
    }
  }
  return fonts;
}

export const __test__ = {
  addFontName,
  collectReferencedFonts,
  collectReferencedFontRequests,
  embeddingLicenseFromFsType,
  faceMetadata,
  glyphCoverage,
  getFontDirs,
  isOtfMagic,
  isTtfMagic,
  normalizeFontRequest,
  normalizeStretch,
  normalizeWeight,
  resolveTokenString,
  scoreFontFace,
  substitutionReason,
  fontFaces,
  normalizedFontName,
  walkFontFiles
};
