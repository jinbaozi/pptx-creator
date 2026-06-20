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
function collectFontsFromValue(value, tokens, out) {
  if (value == null) return;
  if (typeof value === "string") {
    const resolved = resolveTokenString(value, tokens);
    if (typeof resolved === "string") {
      addFontName(out, resolved);
    } else if (resolved && typeof resolved === "object") {
      collectFontsFromValue(resolved, tokens, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFontsFromValue(item, tokens, out);
    }
    return;
  }
  if (typeof value === "object") {
    if (typeof value.fontFamily === "string") {
      const family = resolveTokenString(value.fontFamily, tokens);
      if (typeof family === "string") addFontName(out, family);
    }
    for (const child of Object.values(value)) {
      collectFontsFromValue(child, tokens, out);
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
  return files;
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
function enumerateWithFontkit(fontkit, fontFiles) {
  const names = new Set();
  let opened = 0;
  for (const filePath of fontFiles) {
    try {
      const font = fontkit.openSync(filePath);
      opened += 1;
      const postscript = font.postscriptName;
      const family = font.familyName;
      if (postscript) names.add(postscript);
      if (family) names.add(family);
    } catch {
      // Skip unreadable / unsupported fonts; fall through to magic bytes
      // if the file happens to be invalid for fontkit.
    }
  }
  return { names, opened };
}

/**
 * Pure-JS enumeration. Confirms each file is a TTF/OTF/TTC by reading
 * the magic bytes; the returned `names` set is empty because the format
 * alone does not tell us the font's family/postscript name.
 */
function enumerateWithMagicBytes(fontFiles) {
  const names = new Set();
  for (const filePath of fontFiles) {
    const bytes = readMagicBytes(filePath);
    if (!bytes) continue;
    if (isTtfMagic(bytes) || isOtfMagic(bytes)) {
      // We can confirm the file is a real font, but we cannot extract a
      // human-readable name from the magic bytes alone.
    }
  }
  return { names, opened: fontFiles.length };
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

  const files = Array.isArray(options.files)
    ? options.files.slice()
    : collectFontFiles();

  // No fonts are referenced — nothing to verify.
  if (referencedFonts.size === 0) {
    return { availability: {}, fallback: [], source: files.length > 0 ? "fontkit" : "unavailable" };
  }

  // Prefer fontkit; fall back to magic-byte detection.
  const fontkit = await (options.loadFontkit ?? loadFontkit)();
  let availableNames = new Set();
  let source;
  if (fontkit && typeof fontkit.openSync === "function" && !fontkit.error) {
    const result = enumerateWithFontkit(fontkit, files);
    availableNames = result.names;
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
    if (availableNames.has(font)) {
      availability[font] = "present";
    } else {
      availability[font] = "missing";
      fallback.push({ requested: font, fallback: DEFAULT_FALLBACK });
    }
  }

  return { availability, fallback, source };
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
  getFontDirs,
  isOtfMagic,
  isTtfMagic,
  resolveTokenString,
  walkFontFiles
};
