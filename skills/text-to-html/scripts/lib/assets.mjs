import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, join, posix, resolve } from "node:path";
import { fail } from "./errors.mjs";
import { assertSafeOutputDir, inside } from "./utils.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,16}$/;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const NETWORK_POLICIES = new Set(["offline", "prefer", "require"]);
const MIME_EXTENSIONS = new Map([
  ["image/svg+xml", ".svg"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);

function assetPath(index, field = "") {
  return `$.assets[${index}]${field ? `.${field}` : ""}`;
}

function requireString(value, path, code = "E_ASSET_SCHEMA") {
  if (typeof value !== "string" || !value.trim()) {
    fail(code, `${path} must be a non-empty string`, { path });
  }
  return value;
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("E_ASSET_SCHEMA", `${path} must be an object`, { path });
  }
  return value;
}

function normalizedNetworkPolicy(value) {
  const policy = value ?? "offline";
  if (!NETWORK_POLICIES.has(policy)) {
    fail("E_NETWORK_POLICY", "networkPolicy must be offline, prefer, or require", { path: "$.networkPolicy" });
  }
  return policy;
}

function locatorKind(locator) {
  if (/^https?:/i.test(locator) || locator.startsWith("//")) return "remote";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(locator)) return "non-local";
  return "local";
}

function normalizeRemoteLocator(locator, path) {
  let parsed;
  try {
    parsed = new URL(locator);
  } catch {
    fail("E_REMOTE_ASSET", `${path} must be an absolute HTTP(S) URL`, { path });
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail("E_REMOTE_ASSET", `${path} must be an absolute credential-free HTTPS URL`, { path });
  }
  if (isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    fail("E_REMOTE_ASSET", `${path} cannot target an IP literal or local network hostname`, { path });
  }
  return parsed.href;
}

function normalizeLocalLocator(locator, path) {
  if (locator !== locator.trim() || locator.includes("\0")) {
    fail("E_ASSET_PATH", `${path} must be a normalized package-relative path`, { path });
  }
  const portable = locator.replaceAll("\\", "/");
  if (portable.startsWith("/") || portable.split("/").includes("..")) {
    fail("E_ASSET_PATH", `${path} escapes its package root`, { path });
  }
  const normalized = posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail("E_ASSET_PATH", `${path} escapes its package root`, { path });
  }
  return normalized;
}

function normalizeRights(rights, path) {
  requireObject(rights, path);
  const normalized = { status: requireString(rights.status, `${path}.status`).trim() };
  for (const key of ["spdx", "licenseUrl", "attribution"]) {
    if (rights[key] === undefined) continue;
    normalized[key] = requireString(rights[key], `${path}.${key}`).trim();
  }
  return normalized;
}

function normalizeFallback(fallback, path) {
  if (fallback === undefined) return undefined;
  requireObject(fallback, path);
  return {
    selectedLocator: requireString(fallback.selectedLocator, `${path}.selectedLocator`).trim(),
    reason: requireString(fallback.reason, `${path}.reason`).trim()
  };
}

function normalizeMime(value, path) {
  const mime = requireString(value, path).trim().toLowerCase().split(";", 1)[0];
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)) {
    fail("E_ASSET_SCHEMA", `${path} must be a MIME type`, { path });
  }
  return mime;
}

function normalizeExpectedSha256(value, path) {
  if (value === undefined) return undefined;
  const expected = requireString(value, path, "E_ASSET_HASH").toLowerCase();
  if (!SHA256.test(expected)) fail("E_ASSET_HASH", `${path} must be a SHA-256 digest`, { path });
  return expected;
}

function normalizeOptionalString(value, path) {
  if (value === undefined) return undefined;
  return requireString(value, path).trim();
}

function normalizeFocalPoint(value, path) {
  if (value === undefined) return undefined;
  requireObject(value, path);
  if (!Number.isFinite(value.x) || value.x < 0 || value.x > 1
      || !Number.isFinite(value.y) || value.y < 0 || value.y > 1) {
    fail("E_ASSET_SCHEMA", `${path} must contain x and y coordinates from 0 through 1`, { path });
  }
  return { x: value.x, y: value.y };
}

function normalizeAsset(asset, index) {
  const path = assetPath(index);
  requireObject(asset, path);
  const id = requireString(asset.id, `${path}.id`).trim();
  if (!ASSET_ID.test(id) || id === "." || id === "..") {
    fail("E_ASSET_ID", `${path}.id must be a stable filename-safe identifier`, { path: `${path}.id` });
  }

  const rawLocator = requireString(asset.selectedLocator, `${path}.selectedLocator`);
  const kind = locatorKind(rawLocator);
  let selectedLocator;
  if (kind === "remote") selectedLocator = normalizeRemoteLocator(rawLocator, `${path}.selectedLocator`);
  else if (kind === "non-local") {
    fail("E_ASSET_PATH", `${path}.selectedLocator must be a package-relative path or HTTP(S) URL`, {
      path: `${path}.selectedLocator`
    });
  } else {
    selectedLocator = normalizeLocalLocator(rawLocator, `${path}.selectedLocator`);
  }

  return {
    id,
    selectedLocator,
    locatorKind: kind,
    mime: normalizeMime(asset.mime, `${path}.mime`),
    alt: requireString(asset.alt, `${path}.alt`).trim(),
    rights: normalizeRights(asset.rights, `${path}.rights`),
    ...(asset.sourceRef === undefined ? {} : { sourceRef: normalizeOptionalString(asset.sourceRef, `${path}.sourceRef`) }),
    ...(asset.expectedSha256 === undefined ? {} : { expectedSha256: normalizeExpectedSha256(asset.expectedSha256, `${path}.expectedSha256`) }),
    ...(asset.intendedPurpose === undefined ? {} : { intendedPurpose: normalizeOptionalString(asset.intendedPurpose, `${path}.intendedPurpose`) }),
    ...(asset.focalPoint === undefined ? {} : { focalPoint: normalizeFocalPoint(asset.focalPoint, `${path}.focalPoint`) }),
    ...(asset.fallback === undefined ? {} : { fallback: normalizeFallback(asset.fallback, `${path}.fallback`) })
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function outputExtension(locator, mime) {
  let filename = locator;
  if (locatorKind(locator) === "remote") filename = new URL(locator).pathname;
  const extension = extname(posix.basename(filename)).toLowerCase();
  return SAFE_EXTENSION.test(extension) ? extension : (MIME_EXTENSIONS.get(mime) ?? "");
}

async function canonicalSourceRoot(sourceRoot) {
  if (typeof sourceRoot !== "string" || !sourceRoot.trim()) {
    fail("E_ASSET_SOURCE_ROOT", "sourceRoot must be a directory", { path: "$.sourceRoot" });
  }
  const resolved = resolve(sourceRoot);
  let details;
  try {
    details = await stat(resolved);
  } catch {
    fail("E_ASSET_SOURCE_ROOT", `sourceRoot does not exist: ${resolved}`, { path: "$.sourceRoot" });
  }
  if (!details.isDirectory()) fail("E_ASSET_SOURCE_ROOT", `sourceRoot is not a directory: ${resolved}`, { path: "$.sourceRoot" });
  return realpath(resolved);
}

async function readPackageAsset(sourceRoot, locator, path) {
  const candidate = resolve(sourceRoot, locator);
  if (!inside(sourceRoot, candidate)) fail("E_ASSET_PATH", `${path} escapes sourceRoot`, { path });
  let details;
  try {
    details = await lstat(candidate);
  } catch {
    fail("E_ASSET_MISSING", `Asset does not exist: ${locator}`, { path });
  }
  if (details.isSymbolicLink()) fail("E_ASSET_SYMLINK", `Asset cannot be a symlink: ${locator}`, { path });
  if (!details.isFile()) fail("E_ASSET_MISSING", `Asset is not a regular file: ${locator}`, { path });
  const canonicalFile = await realpath(candidate);
  if (!inside(sourceRoot, canonicalFile)) fail("E_ASSET_PATH", `${path} resolves outside sourceRoot`, { path });
  return readFile(canonicalFile);
}

function fetchedBytes(value, path) {
  const body = value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)
    ? (value.bytes ?? value.body)
    : value;
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  fail("E_REMOTE_ASSET", `${path} fetchAsset must return bytes, a Uint8Array, or { bytes }`, { path });
}

function assertSafeAssetBytes(bytes, mime, path) {
  if (bytes.length > MAX_ASSET_BYTES) {
    fail("E_ASSET_SIZE", `${path} exceeds the ${MAX_ASSET_BYTES}-byte localization limit`, { path });
  }
  const hasPrefix = (prefix) => bytes.subarray(0, prefix.length).equals(Buffer.from(prefix));
  if (mime === "image/png" && !hasPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    fail("E_ASSET_MIME", `${path} is not a PNG file`, { path });
  }
  if (mime === "image/jpeg" && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    fail("E_ASSET_MIME", `${path} is not a JPEG file`, { path });
  }
  if (mime === "image/gif" && !(hasPrefix("GIF87a") || hasPrefix("GIF89a"))) {
    fail("E_ASSET_MIME", `${path} is not a GIF file`, { path });
  }
  if (mime === "image/webp" && !(hasPrefix("RIFF") && bytes.subarray(8, 12).equals(Buffer.from("WEBP")))) {
    fail("E_ASSET_MIME", `${path} is not a WebP file`, { path });
  }
  if (mime === "image/svg+xml") {
    const source = bytes.toString("utf8");
    if (!/<svg\b/i.test(source)) fail("E_ASSET_MIME", `${path} is not an SVG file`, { path });
    if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(source)
        || /url\(\s*["']?\s*(?:https?:|\/\/|data:)/i.test(source)) {
      fail("E_ASSET_UNSAFE", `${path} contains active or externally loaded SVG content`, { path });
    }
  }
  if (/^(?:text\/html|application\/(?:javascript|x-javascript)|image\/svg\+xml)$/i.test(mime) && bytes.length === 0) {
    fail("E_ASSET_MIME", `${path} is empty`, { path });
  }
}

async function fetchRemoteAsset(fetchAsset, asset, networkPolicy, path) {
  if (networkPolicy === "offline") {
    fail("E_REMOTE_ASSET", `Remote assets are disabled by networkPolicy: ${asset.selectedLocator}`, { path });
  }
  if (typeof fetchAsset !== "function") {
    fail("E_REMOTE_ASSET", `Remote asset requires an injected fetchAsset: ${asset.selectedLocator}`, { path });
  }
  let response;
  try {
    response = await fetchAsset(asset.selectedLocator, { asset: structuredClone(asset), networkPolicy });
  } catch (error) {
    fail("E_REMOTE_ASSET", `Cannot localize remote asset ${asset.selectedLocator}: ${error instanceof Error ? error.message : String(error)}`, {
      path,
      details: { causeCode: error?.code }
    });
  }
  if (response && typeof response === "object" && typeof response.url === "string") {
    normalizeRemoteLocator(response.url, `${path}.response.url`);
  }
  return fetchedBytes(response, path);
}

async function ensureDirectoryInside(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail("E_OUTPUT_PATH", `Cannot create output directory ${current}: ${error.message}`, { path: "$.outputDir" });
      }
    }
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      fail("E_OUTPUT_PATH", `Cannot inspect output directory ${current}: ${error.message}`, { path: "$.outputDir" });
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      fail("E_OUTPUT_PATH", `Output directory cannot be a symlink or file: ${current}`, { path: "$.outputDir" });
    }
    const canonical = await realpath(current);
    if (!inside(root, canonical)) fail("E_OUTPUT_PATH", `Output directory escapes outputDir: ${current}`, { path: "$.outputDir" });
    current = canonical;
  }
  return current;
}

async function mediaDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    fail("E_OUTPUT_PATH", "outputDir must be a directory", { path: "$.outputDir" });
  }
  const resolved = assertSafeOutputDir(outputDir);
  await mkdir(resolved, { recursive: true });
  const details = await lstat(resolved);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("E_OUTPUT_PATH", `outputDir cannot be a symlink or file: ${resolved}`, { path: "$.outputDir" });
  }
  const canonical = await realpath(resolved);
  return { outputDir: canonical, mediaDir: await ensureDirectoryInside(canonical, ["assets", "media"]) };
}

async function writeAsset(mediaDir, filename, bytes) {
  const target = join(mediaDir, filename);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail("E_OUTPUT_PATH", `Localized asset target cannot be a symlink or directory: ${filename}`, { path: "$.outputDir" });
    }
    const existingBytes = await readFile(target);
    if (!existingBytes.equals(bytes)) {
      fail("E_OUTPUT_STALE", `Localized asset target already contains different bytes: ${filename}`, { path: "$.outputDir" });
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let temporary;
  for (let index = 1; index <= 100; index += 1) {
    const candidate = join(mediaDir, `.${filename}.localize-${index}.tmp`);
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      temporary = candidate;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail("E_OUTPUT_PATH", `Cannot write localized asset ${filename}: ${error.message}`, { path: "$.outputDir" });
      }
    }
  }
  if (!temporary) fail("E_OUTPUT_PATH", `Cannot allocate a safe output file for ${filename}`, { path: "$.outputDir" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    fail("E_OUTPUT_PATH", `Cannot finalize localized asset ${filename}: ${error.message}`, { path: "$.outputDir" });
  }
}

function noticeFor(assetRecords) {
  const lines = ["NOTICE", ""];
  if (assetRecords.length === 0) {
    lines.push("No localized assets.");
  } else {
    for (const asset of assetRecords) {
      lines.push(`Asset: ${asset.id}`);
      lines.push(`Selected locator: ${asset.selectedLocator}`);
      lines.push(`Localized path: ${asset.outputPath}`);
      lines.push(`SHA-256: ${asset.sha256}`);
      lines.push(`Rights status: ${asset.rights.status}`);
      if (asset.rights.spdx) lines.push(`SPDX: ${asset.rights.spdx}`);
      if (asset.rights.licenseUrl) lines.push(`License URL: ${asset.rights.licenseUrl}`);
      if (asset.rights.attribution) lines.push(`Attribution: ${asset.rights.attribution}`);
      if (asset.sourceRef) lines.push(`Source reference: ${asset.sourceRef}`);
      if (asset.fallbackUsed) lines.push(`Fallback used: ${asset.fallbackUsed.selectedLocator} (${asset.fallbackUsed.reason})`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Localize V2 Plan assets without performing a network request itself.
 * Remote locators remain blocked unless a non-offline policy and an injected
 * fetchAsset function explicitly authorize them.
 */
export async function localizeAssets({ assets, sourceRoot, outputDir, networkPolicy, fetchAsset } = {}) {
  if (!Array.isArray(assets)) fail("E_ASSET_SCHEMA", "$.assets must be an array", { path: "$.assets" });
  const policy = normalizedNetworkPolicy(networkPolicy);
  const canonicalRoot = await canonicalSourceRoot(sourceRoot);
  const normalizedAssets = assets.map((asset, index) => normalizeAsset(asset, index));
  const ids = new Set();
  const outputPaths = new Set();
  const prepared = [];

  for (const [index, asset] of normalizedAssets.entries()) {
    const path = assetPath(index, "selectedLocator");
    if (ids.has(asset.id)) fail("E_DUPLICATE_ID", `$.assets contains duplicate id ${asset.id}`, { path: assetPath(index, "id") });
    ids.add(asset.id);

    let bytes;
    let materializedLocator = asset.selectedLocator;
    let fallbackUsed;
    try {
      bytes = asset.locatorKind === "local"
        ? await readPackageAsset(canonicalRoot, asset.selectedLocator, path)
        : await fetchRemoteAsset(fetchAsset, asset, policy, path);
    } catch (error) {
      if (asset.locatorKind !== "remote" || policy !== "prefer" || !asset.fallback) throw error;
      if (locatorKind(asset.fallback.selectedLocator) !== "local") {
        fail("E_ASSET_FALLBACK", `${assetPath(index, "fallback.selectedLocator")} must be package-local`, {
          path: assetPath(index, "fallback.selectedLocator")
        });
      }
      materializedLocator = normalizeLocalLocator(asset.fallback.selectedLocator, assetPath(index, "fallback.selectedLocator"));
      bytes = await readPackageAsset(canonicalRoot, materializedLocator, assetPath(index, "fallback.selectedLocator"));
      fallbackUsed = { selectedLocator: materializedLocator, reason: asset.fallback.reason };
    }
    const digest = sha256(bytes);
    if (asset.expectedSha256 && asset.expectedSha256 !== digest) {
      fail("E_ASSET_HASH", `Asset ${asset.id} does not match its expected SHA-256`, {
        path: assetPath(index, "expectedSha256"),
        details: { expectedSha256: asset.expectedSha256, actualSha256: digest }
      });
    }
    assertSafeAssetBytes(bytes, asset.mime, path);
    const outputPath = `assets/media/${asset.id}${outputExtension(materializedLocator, asset.mime)}`;
    const outputKey = outputPath.toLowerCase();
    if (outputPaths.has(outputKey)) {
      fail("E_DUPLICATE_ID", `$.assets produces duplicate output path ${outputPath}`, { path: assetPath(index, "id") });
    }
    outputPaths.add(outputKey);
    prepared.push({
      ...asset,
      bytes,
      sha256: digest,
      outputPath,
      materializedLocator,
      ...(fallbackUsed ? { fallbackUsed } : {})
    });
  }

  const { mediaDir } = await mediaDirectory(outputDir);
  const assetRecords = [];
  for (const preparedAsset of prepared) {
    const { bytes, locatorKind, materializedLocator, fallbackUsed, ...asset } = preparedAsset;
    await writeAsset(mediaDir, posix.basename(asset.outputPath), bytes);
    assetRecords.push({
      ...asset,
      sourcePath: materializedLocator,
      origin: fallbackUsed ? "fallback-local" : locatorKind,
      ...(fallbackUsed ? { fallbackUsed } : {})
    });
  }

  const provenanceLedger = assetRecords.map((asset) => ({
    assetId: asset.id,
    origin: asset.origin,
    selectedLocator: asset.selectedLocator,
    outputPath: asset.outputPath,
    sha256: asset.sha256,
    mime: asset.mime,
    rights: structuredClone(asset.rights),
    ...(asset.sourceRef ? { sourceRef: asset.sourceRef } : {}),
    ...(asset.expectedSha256 ? { expectedSha256: asset.expectedSha256 } : {}),
    ...(asset.intendedPurpose ? { intendedPurpose: asset.intendedPurpose } : {}),
    ...(asset.focalPoint ? { focalPoint: structuredClone(asset.focalPoint) } : {}),
    ...(asset.fallback ? { fallback: structuredClone(asset.fallback) } : {}),
    ...(asset.fallbackUsed ? { fallbackUsed: structuredClone(asset.fallbackUsed) } : {})
  }));

  return { assetRecords, provenanceLedger, notice: noticeFor(assetRecords) };
}
