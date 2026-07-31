import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.mjs";

export const THEME_VERSION = "1.0.0";
export const DEFAULT_THEME_ID = "legacy-default";

const themeSkillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const THEME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const FONT_STACK = /^(?=.*[A-Za-z0-9\u00C0-\uFFFF])[A-Za-z0-9\u00C0-\uFFFF .,'"-]+$/u;
const FONT_FALLBACK = /^[A-Za-z0-9\u00C0-\uFFFF .'-]+$/u;
const TOKEN_GROUPS = Object.freeze(["fonts", "colors", "type", "space", "radius", "shadow"]);
const TOKEN_KEYS = Object.freeze({
  canvas: ["width", "height", "aspectRatio"],
  fonts: ["display", "body"],
  colors: ["background", "surface", "text", "muted", "primary", "primarySoft", "accent", "positive", "border"],
  type: ["display", "title", "section", "body", "label", "source"],
  space: ["canvasX", "canvasY", "gap", "small"],
  radius: ["card", "pill"],
  shadow: ["card"]
});
const CONTRAST_CHECKS = Object.freeze([
  ["text", "background", 4.5],
  ["text", "surface", 4.5],
  ["muted", "background", 4.5],
  ["muted", "surface", 4.5],
  ["primary", "background", 4.5],
  ["primary", "surface", 4.5],
  ["primary", "primarySoft", 4.5]
]);

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder));
}

function themeFail(code, message, path, details) {
  fail(code, message, {
    ...(path ? { path } : {}),
    ...(details === undefined ? {} : { details })
  });
}

function requireRecord(value, path, code) {
  if (!isRecord(value)) themeFail(code, `${path} must be an object`, path);
  return value;
}

function requireText(value, path, code, options = {}) {
  const { min = 1, max = 240, exactWhitespace = false } = options;
  if (typeof value !== "string" || value.trim().length < min || value.length > max || value.includes("\0")
      || (exactWhitespace && value !== value.trim())) {
    themeFail(code, `${path} must be a ${min > 0 ? "non-empty " : ""}string${max ? ` no longer than ${max} characters` : ""}`, path);
  }
  return value;
}

function requireExactKeys(value, path, code, required, allowed = required) {
  requireRecord(value, path, code);
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) themeFail(code, `${path}.${key} is not supported`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) themeFail(code, `${path}.${key} is required`, `${path}.${key}`);
  }
  return value;
}

function requireStringArray(value, path, code, options = {}) {
  const { min = 1, max = 16, itemMax = 240, pattern } = options;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    themeFail(code, `${path} must contain ${min}${max === min ? "" : ` to ${max}`} string value(s)`, path);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    requireText(item, `${path}[${index}]`, code, { max: itemMax, exactWhitespace: true });
    if (pattern && !pattern.test(item)) themeFail(code, `${path}[${index}] contains unsupported characters`, `${path}[${index}]`);
    const key = item.toLocaleLowerCase("en-US");
    if (seen.has(key)) themeFail(code, `${path} cannot repeat ${JSON.stringify(item)}`, `${path}[${index}]`);
    seen.add(key);
  }
  return value;
}

function validateThemeId(value, path, code) {
  requireText(value, path, code, { max: 128, exactWhitespace: true });
  if (!THEME_ID.test(value)) themeFail(code, `${path} must be a stable theme identifier`, path);
  return value;
}

function safeRelativePath(value, path) {
  requireText(value, path, "E_THEME_PATH", { max: 512, exactWhitespace: true });
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    themeFail("E_THEME_PATH", `${path} must be a package-relative POSIX path`, path);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    themeFail("E_THEME_PATH", `${path} escapes its package root`, path);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../")) {
    themeFail("E_THEME_PATH", `${path} must be a normalized package-relative path`, path);
  }
  return normalized;
}

function canonicalRoot(options = {}) {
  if (!isRecord(options)) themeFail("E_THEME_ROOT", "Theme loader options must be an object", "$.options");
  const configuredRoot = options.root ?? themeSkillRoot;
  if (typeof configuredRoot !== "string" || !configuredRoot.trim()) {
    themeFail("E_THEME_ROOT", "Theme loader root must be a directory", "$.options.root");
  }
  const requestedRoot = resolve(configuredRoot);
  try {
    if (!statSync(requestedRoot).isDirectory()) {
      themeFail("E_THEME_ROOT", `Theme loader root is not a directory: ${requestedRoot}`, "$.options.root");
    }
    return realpathSync(requestedRoot);
  } catch (error) {
    if (error?.code?.startsWith("E_THEME_")) throw error;
    themeFail("E_THEME_ROOT", `Theme loader root is unavailable: ${requestedRoot}`, "$.options.root");
  }
}

function readPackageFile(root, relativePath, path) {
  const normalized = safeRelativePath(relativePath, path);
  const candidate = resolve(root, normalized);
  if (!inside(root, candidate)) themeFail("E_THEME_PATH", `${path} escapes the package root`, path);

  let details;
  try {
    details = lstatSync(candidate);
  } catch {
    themeFail("E_THEME_RESOURCE", `${path} does not exist: ${normalized}`, path);
  }
  if (details.isSymbolicLink()) themeFail("E_THEME_PATH", `${path} cannot be a symlink: ${normalized}`, path);
  if (!details.isFile()) themeFail("E_THEME_RESOURCE", `${path} must be a regular file: ${normalized}`, path);

  let canonicalPath;
  try {
    canonicalPath = realpathSync(candidate);
  } catch {
    themeFail("E_THEME_RESOURCE", `${path} cannot be resolved: ${normalized}`, path);
  }
  if (!inside(root, canonicalPath)) themeFail("E_THEME_PATH", `${path} resolves outside the package root`, path);

  try {
    return { relativePath: normalized, bytes: readFileSync(canonicalPath) };
  } catch {
    themeFail("E_THEME_RESOURCE", `${path} cannot be read: ${normalized}`, path);
  }
}

function readJsonResource(resource, path, code) {
  let value;
  try {
    value = JSON.parse(resource.bytes.toString("utf8"));
  } catch (error) {
    themeFail(code, `${path} contains invalid JSON: ${error.message}`, path);
  }
  return requireRecord(value, path, code);
}

function loadRegistry(root) {
  const resource = readPackageFile(root, "assets/themes/registry.json", "$.registry");
  const registry = readJsonResource(resource, "$.registry", "E_THEME_REGISTRY");
  requireExactKeys(registry, "$.registry", "E_THEME_REGISTRY", ["version", "themes"]);
  if (registry.version !== THEME_VERSION) {
    themeFail("E_THEME_REGISTRY", `$.registry.version must be ${THEME_VERSION}`, "$.registry.version");
  }
  if (!Array.isArray(registry.themes) || registry.themes.length === 0) {
    themeFail("E_THEME_REGISTRY", "$.registry.themes must contain at least one theme", "$.registry.themes");
  }

  const entries = [];
  const ids = new Set();
  for (const [index, entry] of registry.themes.entries()) {
    const path = `$.registry.themes[${index}]`;
    requireExactKeys(entry, path, "E_THEME_REGISTRY", ["id", "manifest"]);
    const id = validateThemeId(entry.id, `${path}.id`, "E_THEME_REGISTRY");
    if (ids.has(id)) themeFail("E_THEME_REGISTRY", `${path}.id duplicates ${JSON.stringify(id)}`, `${path}.id`);
    ids.add(id);
    const manifestPath = safeRelativePath(entry.manifest, `${path}.manifest`);
    const expectedManifestPath = `assets/themes/${id}/manifest.json`;
    if (manifestPath !== expectedManifestPath) {
      themeFail("E_THEME_REGISTRY", `${path}.manifest must be ${expectedManifestPath}`, `${path}.manifest`);
    }
    entries.push({ id, manifestPath });
  }
  return { entries, registrySha256: sha256(resource.bytes) };
}

function manifestResourcePath(manifestPath, value, path) {
  const localPath = safeRelativePath(value, path);
  return posix.join(posix.dirname(manifestPath), localPath);
}

function validateManifest(value, entry, path) {
  const required = ["version", "id", "label", "description", "useWhen", "quietConstraints", "antiPatterns", "tokens", "preview", "notice", "fontFallbacks"];
  requireExactKeys(value, path, "E_THEME_MANIFEST", required, [...required, "adapterOnly"]);
  if (value.version !== THEME_VERSION) themeFail("E_THEME_MANIFEST", `${path}.version must be ${THEME_VERSION}`, `${path}.version`);
  if (validateThemeId(value.id, `${path}.id`, "E_THEME_MANIFEST") !== entry.id) {
    themeFail("E_THEME_MANIFEST", `${path}.id must match registered theme ${entry.id}`, `${path}.id`);
  }
  requireText(value.label, `${path}.label`, "E_THEME_MANIFEST", { max: 120, exactWhitespace: true });
  requireText(value.description, `${path}.description`, "E_THEME_MANIFEST", { max: 480, exactWhitespace: true });
  requireStringArray(value.useWhen, `${path}.useWhen`, "E_THEME_MANIFEST", { max: 12 });
  requireStringArray(value.quietConstraints, `${path}.quietConstraints`, "E_THEME_MANIFEST", { max: 12 });
  requireStringArray(value.antiPatterns, `${path}.antiPatterns`, "E_THEME_MANIFEST", { max: 12 });
  safeRelativePath(value.tokens, `${path}.tokens`);
  safeRelativePath(value.preview, `${path}.preview`);
  safeRelativePath(value.notice, `${path}.notice`);
  if (value.adapterOnly !== undefined && typeof value.adapterOnly !== "boolean") {
    themeFail("E_THEME_MANIFEST", `${path}.adapterOnly must be a boolean`, `${path}.adapterOnly`);
  }
  requireStringArray(value.fontFallbacks, `${path}.fontFallbacks`, "E_THEME_MANIFEST", {
    max: 12,
    itemMax: 120,
    pattern: FONT_FALLBACK
  });
  return {
    version: value.version,
    id: value.id,
    label: value.label,
    description: value.description,
    useWhen: clone(value.useWhen),
    quietConstraints: clone(value.quietConstraints),
    antiPatterns: clone(value.antiPatterns),
    tokens: value.tokens,
    preview: value.preview,
    notice: value.notice,
    ...(value.adapterOnly === undefined ? {} : { adapterOnly: value.adapterOnly }),
    fontFallbacks: clone(value.fontFallbacks)
  };
}

function requireBoundedNumber(value, path, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    themeFail("E_THEME_TOKEN", `${path} must be a number from ${minimum} to ${maximum}`, path);
  }
  return value;
}

function validateFontStack(value, path) {
  requireText(value, path, "E_THEME_TOKEN", { max: 240, exactWhitespace: true });
  if (!FONT_STACK.test(value)) themeFail("E_THEME_TOKEN", `${path} must be a safe CSS font stack`, path);
}

function validateShadow(value, path) {
  requireText(value, path, "E_THEME_TOKEN", { max: 120, exactWhitespace: true });
  if (value === "none") return;
  const match = /^(?<lengths>(?:0|-?\d+(?:\.\d+)?px)(?:\s+(?:0|-?\d+(?:\.\d+)?px)){2,3})\s+(?<color>#[0-9A-Fa-f]{6}|rgba?\((?<channels>[^)]+)\))$/.exec(value);
  if (!match) themeFail("E_THEME_TOKEN", `${path} must be a safe CSS box-shadow`, path);
  for (const length of match.groups.lengths.split(/\s+/)) {
    const number = length === "0" ? 0 : Number.parseFloat(length);
    if (!Number.isFinite(number) || Math.abs(number) > 200) {
      themeFail("E_THEME_TOKEN", `${path} cannot use a length outside -200px to 200px`, path);
    }
  }
  if (match.groups.color.startsWith("#")) return;
  const functionName = match.groups.color.slice(0, match.groups.color.indexOf("("));
  const channels = match.groups.channels.split(",").map((channel) => channel.trim());
  if (!((functionName === "rgb" && channels.length === 3) || (functionName === "rgba" && channels.length === 4))) {
    themeFail("E_THEME_TOKEN", `${path} must use valid rgb() or rgba() channels`, path);
  }
  for (const [index, channel] of channels.entries()) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(channel)) {
      themeFail("E_THEME_TOKEN", `${path} contains an invalid color channel`, path);
    }
    const number = Number(channel);
    const maximum = index === 3 ? 1 : 255;
    if (!Number.isFinite(number) || number < 0 || number > maximum) {
      themeFail("E_THEME_TOKEN", `${path} contains an out-of-range color channel`, path);
    }
  }
}

function relativeLuminance(color) {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

function validateThemeTokens(value, path) {
  requireExactKeys(value, path, "E_THEME_TOKEN", ["version", "canvas", "fonts", "colors", "type", "space", "radius", "shadow"]);
  if (value.version !== THEME_VERSION) themeFail("E_THEME_TOKEN", `${path}.version must be ${THEME_VERSION}`, `${path}.version`);

  requireExactKeys(value.canvas, `${path}.canvas`, "E_THEME_TOKEN", TOKEN_KEYS.canvas);
  if (value.canvas.width !== 1280 || value.canvas.height !== 720 || value.canvas.aspectRatio !== "16:9") {
    themeFail("E_THEME_TOKEN", `${path}.canvas must be exactly 1280×720 at 16:9`, `${path}.canvas`);
  }

  requireExactKeys(value.fonts, `${path}.fonts`, "E_THEME_TOKEN", TOKEN_KEYS.fonts);
  for (const key of TOKEN_KEYS.fonts) validateFontStack(value.fonts[key], `${path}.fonts.${key}`);

  requireExactKeys(value.colors, `${path}.colors`, "E_THEME_TOKEN", TOKEN_KEYS.colors);
  for (const key of TOKEN_KEYS.colors) {
    if (typeof value.colors[key] !== "string" || !HEX_COLOR.test(value.colors[key])) {
      themeFail("E_THEME_TOKEN", `${path}.colors.${key} must be a six-digit hexadecimal color`, `${path}.colors.${key}`);
    }
  }

  requireExactKeys(value.type, `${path}.type`, "E_THEME_TOKEN", TOKEN_KEYS.type);
  const type = value.type;
  requireBoundedNumber(type.display, `${path}.type.display`, 38, 96);
  requireBoundedNumber(type.title, `${path}.type.title`, 38, 96);
  requireBoundedNumber(type.section, `${path}.type.section`, 24, 72);
  requireBoundedNumber(type.body, `${path}.type.body`, 22, 48);
  requireBoundedNumber(type.label, `${path}.type.label`, 15, 32);
  requireBoundedNumber(type.source, `${path}.type.source`, 12, 24);
  if (!(type.display >= type.title && type.title >= type.section && type.section >= type.body
      && type.body >= type.label && type.label >= type.source)) {
    themeFail("E_THEME_TOKEN", `${path}.type must preserve display-to-source hierarchy`, `${path}.type`);
  }

  requireExactKeys(value.space, `${path}.space`, "E_THEME_TOKEN", TOKEN_KEYS.space);
  const space = value.space;
  requireBoundedNumber(space.canvasX, `${path}.space.canvasX`, 48, 144);
  requireBoundedNumber(space.canvasY, `${path}.space.canvasY`, 40, 96);
  requireBoundedNumber(space.gap, `${path}.space.gap`, 8, 64);
  requireBoundedNumber(space.small, `${path}.space.small`, 4, 32);
  if (space.small > space.gap) themeFail("E_THEME_TOKEN", `${path}.space.small cannot exceed gap`, `${path}.space.small`);

  requireExactKeys(value.radius, `${path}.radius`, "E_THEME_TOKEN", TOKEN_KEYS.radius);
  requireBoundedNumber(value.radius.card, `${path}.radius.card`, 0, 40);
  requireBoundedNumber(value.radius.pill, `${path}.radius.pill`, 12, 999);

  requireExactKeys(value.shadow, `${path}.shadow`, "E_THEME_TOKEN", TOKEN_KEYS.shadow);
  validateShadow(value.shadow.card, `${path}.shadow.card`);

  for (const [foreground, background, minimum] of CONTRAST_CHECKS) {
    const ratio = contrastRatio(value.colors[foreground], value.colors[background]);
    if (ratio + 0.01 < minimum) {
      themeFail("E_THEME_CONTRAST", `${path}.colors must keep ${foreground}/${background} contrast at least ${minimum}:1`, `${path}.colors`, {
        foreground,
        background,
        ratio
      });
    }
  }

  return value;
}

function validateFallbacks(manifest, tokens, path) {
  const stack = `${tokens.fonts.display},${tokens.fonts.body}`.toLocaleLowerCase("en-US");
  for (const [index, fallback] of manifest.fontFallbacks.entries()) {
    if (!stack.includes(fallback.toLocaleLowerCase("en-US"))) {
      themeFail("E_THEME_MANIFEST", `${path}.fontFallbacks[${index}] must occur in a declared font stack`, `${path}.fontFallbacks[${index}]`);
    }
  }
}

function validatePreview(resource, path) {
  const source = resource.bytes.toString("utf8");
  if (!/^\s*<svg\b/i.test(source)) themeFail("E_THEME_RESOURCE", `${path} must be an SVG preview`, path);
  if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(source)
      || /url\(\s*["']?\s*(?:https?:|\/\/|data:)/i.test(source)) {
    themeFail("E_THEME_RESOURCE", `${path} contains active or externally loaded SVG content`, path);
  }
}

function validateNotice(resource, path) {
  if (!resource.bytes.toString("utf8").trim()) themeFail("E_THEME_RESOURCE", `${path} cannot be empty`, path);
}

function loadThemeFromRegistry(themeId, root, registry) {
  const id = validateThemeId(themeId, "$.themeId", "E_THEME_ID");
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry) themeFail("E_THEME_NOT_FOUND", `Theme is not registered: ${id}`, "$.themeId");

  const manifestResource = readPackageFile(root, entry.manifestPath, `$.registry.theme(${id}).manifest`);
  const manifestPath = `$.themes.${id}.manifest`;
  const manifest = validateManifest(readJsonResource(manifestResource, manifestPath, "E_THEME_MANIFEST"), entry, manifestPath);
  const tokensResource = readPackageFile(
    root,
    manifestResourcePath(entry.manifestPath, manifest.tokens, `${manifestPath}.tokens`),
    `${manifestPath}.tokens`
  );
  const previewResource = readPackageFile(
    root,
    manifestResourcePath(entry.manifestPath, manifest.preview, `${manifestPath}.preview`),
    `${manifestPath}.preview`
  );
  const noticeResource = readPackageFile(
    root,
    manifestResourcePath(entry.manifestPath, manifest.notice, `${manifestPath}.notice`),
    `${manifestPath}.notice`
  );
  const tokens = clone(validateThemeTokens(readJsonResource(tokensResource, `${manifestPath}.tokens`, "E_THEME_TOKEN"), `${manifestPath}.tokens`));
  validateFallbacks(manifest, tokens, manifestPath);
  validatePreview(previewResource, `${manifestPath}.preview`);
  validateNotice(noticeResource, `${manifestPath}.notice`);

  return deepFreeze({
    id,
    label: manifest.label,
    description: manifest.description,
    useWhen: manifest.useWhen,
    quietConstraints: manifest.quietConstraints,
    antiPatterns: manifest.antiPatterns,
    adapterOnly: manifest.adapterOnly ?? false,
    fontFallbacks: manifest.fontFallbacks,
    manifest: deepFreeze(manifest),
    tokens,
    paths: {
      registry: "assets/themes/registry.json",
      manifest: entry.manifestPath,
      tokens: manifestResourcePath(entry.manifestPath, manifest.tokens, `${manifestPath}.tokens`),
      preview: manifestResourcePath(entry.manifestPath, manifest.preview, `${manifestPath}.preview`),
      notice: manifestResourcePath(entry.manifestPath, manifest.notice, `${manifestPath}.notice`)
    },
    registrySha256: registry.registrySha256,
    manifestSha256: sha256(manifestResource.bytes),
    tokenSha256: sha256(tokensResource.bytes),
    previewSha256: sha256(previewResource.bytes),
    noticeSha256: sha256(noticeResource.bytes)
  });
}

/**
 * Synchronously load one registered, package-local theme and validate all of
 * its manifest, tokens, and declared preview/notice resources.
 */
export function loadTheme(themeId, options = {}) {
  const root = canonicalRoot(options);
  return loadThemeFromRegistry(themeId, root, loadRegistry(root));
}

/**
 * Synchronously load every registered theme in registry order.
 */
export function listThemes(options = {}) {
  const root = canonicalRoot(options);
  const registry = loadRegistry(root);
  return registry.entries.map((entry) => loadThemeFromRegistry(entry.id, root, registry));
}

/**
 * Return the raw SHA-256 fingerprints for the theme files that form its
 * deterministic design lock.
 */
export function themeFingerprints(theme) {
  requireRecord(theme, "$.theme", "E_THEME_FINGERPRINT");
  const fingerprints = {};
  for (const key of ["registrySha256", "manifestSha256", "tokenSha256", "previewSha256", "noticeSha256"]) {
    if (typeof theme[key] !== "string" || !SHA256.test(theme[key])) {
      themeFail("E_THEME_FINGERPRINT", `$.theme.${key} must be a SHA-256 fingerprint`, `$.theme.${key}`);
    }
    fingerprints[key] = theme[key];
  }
  return deepFreeze(fingerprints);
}

/**
 * Apply only declared, safe token overrides to a loaded theme. The returned
 * token object is detached from the theme and keeps its fixed 1280×720 canvas.
 */
export function materializeThemeTokens(theme, overrides = {}) {
  requireRecord(theme, "$.theme", "E_THEME_OVERRIDE");
  const tokens = clone(validateThemeTokens(theme.tokens, "$.theme.tokens"));
  if (!isRecord(overrides)) themeFail("E_THEME_OVERRIDE", "$.overrides must be an object", "$.overrides");

  for (const [group, values] of Object.entries(overrides)) {
    const groupPath = `$.overrides.${group}`;
    if (!TOKEN_GROUPS.includes(group)) themeFail("E_THEME_OVERRIDE", `${groupPath} is not an overridable token group`, groupPath);
    requireRecord(values, groupPath, "E_THEME_OVERRIDE");
    for (const [key, value] of Object.entries(values)) {
      const tokenPath = `${groupPath}.${key}`;
      if (!TOKEN_KEYS[group].includes(key)) themeFail("E_THEME_OVERRIDE", `${tokenPath} is not an overridable token`, tokenPath);
      tokens[group][key] = value;
    }
  }

  return clone(validateThemeTokens(tokens, "$.overrides"));
}
