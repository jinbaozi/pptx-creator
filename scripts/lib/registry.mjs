import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./schema-utils.mjs";

const ASSET_REGISTRY_SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/asset-registry.schema.json", import.meta.url),
  "utf8"
));

const ALLOWED_SOURCE_KINDS = new Set([
  "fact",
  "fact-source",
  "visual-reference",
  "embedded-asset",
  "font-reference",
  "icon-source",
  "replica-source"
]);

const NATIVE_DATA_KINDS = new Set(["chart-data", "diagram-source"]);
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ENCODED_PATH_CONTROL = /%(?:2e|2f|5c)/i;
const UNICODE_PATH_SEPARATOR = /[\u2044\u2215\u29f8\uff0f\uff3c]/;
export const CREATIVE_ASSET_OWNERSHIP_VERSION = "0.1.0";
export const CREATIVE_ASSET_OWNER = "creative-deck-plan-assets";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function trustedFilesystemAnchors(extraAnchors = []) {
  const lexical = [
    tmpdir(),
    homedir(),
    process.cwd(),
    PROJECT_ROOT,
    "/private/tmp",
    "/tmp",
    ...extraAnchors
  ].map((candidate) => path.resolve(candidate));
  const real = lexical.flatMap((candidate) => {
    try { return [realpathSync(candidate)]; } catch { return []; }
  });
  return [...new Set([...lexical, ...real])];
}

/**
 * Reject user-controlled symlink components below a trusted lexical anchor.
 * The anchor itself is trusted so macOS system aliases such as /var -> /private/var
 * do not make normal os.tmpdir() paths unusable.
 */
export function assertNoSymlinkBelowTrustedAnchor(candidate, {
  allowMissing = true,
  extraAnchors = []
} = {}) {
  const target = path.resolve(candidate);
  const anchors = trustedFilesystemAnchors(extraAnchors)
    .filter((anchor) => target === anchor || target.startsWith(`${anchor}${path.sep}`))
    .sort((left, right) => right.length - left.length);
  if (anchors.length === 0) {
    throw new Error(`path is outside trusted filesystem anchors: ${target}`);
  }
  const anchor = anchors[0];
  let cursor = anchor;
  const segments = path.relative(anchor, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let entry;
    try { entry = lstatSync(cursor); } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return target;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`path must not traverse a symbolic link below trusted anchor ${anchor}: ${cursor}`);
    }
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new Error(`path ancestor must be a real directory: ${cursor}`);
    }
  }
  return target;
}

/**
 * Runtime sources are portable POSIX paths below the output assets directory.
 * Source URLs are evidence only and must never pass this boundary.
 */
export function isSafeAssetRuntimePath(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  if (URI_SCHEME.test(value) || value.startsWith("//") || value.startsWith("/") || value.includes("\\")) return false;
  if (ENCODED_PATH_CONTROL.test(value) || UNICODE_PATH_SEPARATOR.test(value)) return false;
  if (!value.startsWith("assets/")) return false;
  const tail = value.slice("assets/".length);
  if (!tail || tail.endsWith("/")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return path.posix.normalize(value) === value;
}

export function assertSafeAssetRuntimePath(value, label = "asset runtime path") {
  if (!isSafeAssetRuntimePath(value)) {
    throw new Error(`${label} must be a normalized local POSIX path below assets/: ${String(value)}`);
  }
  return value;
}

export function verifiedCreativeOwnedAssetPaths(outputDir, ownership, protectedPaths = []) {
  if (!ownership || ownership.version !== CREATIVE_ASSET_OWNERSHIP_VERSION
    || ownership.owner !== CREATIVE_ASSET_OWNER || !Array.isArray(ownership.files)) return [];
  const outputRoot = path.resolve(outputDir);
  const assetsRoot = path.resolve(outputRoot, "assets");
  let assetsEntry;
  try { assetsEntry = lstatSync(assetsRoot); } catch { return []; }
  if (!assetsEntry.isDirectory() || assetsEntry.isSymbolicLink()) return [];
  const protectedSet = new Set(protectedPaths.map((candidate) => path.resolve(candidate)));
  const verified = [];
  for (const relativePath of ownership.files) {
    if (typeof relativePath !== "string" || relativePath.includes("\\")) continue;
    if (relativePath !== path.posix.join("assets", path.posix.basename(relativePath))) continue;
    const digestMatch = path.posix.basename(relativePath).match(/^[A-Za-z0-9._-]+-([a-f0-9]{12})(?:\.[^/]+)$/);
    if (!digestMatch) continue;
    const candidate = path.resolve(outputRoot, relativePath);
    if (path.dirname(candidate) !== assetsRoot || protectedSet.has(candidate)) continue;
    let entry;
    try { entry = lstatSync(candidate); } catch { continue; }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    let bytes;
    try { bytes = readFileSync(candidate); } catch { continue; }
    const actualDigest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    if (actualDigest !== digestMatch[1]) continue;
    verified.push(candidate);
  }
  return [...new Set(verified)];
}

function verifiedHtmlOwnedAssetPaths(outputDir, ownership, protectedPaths = []) {
  if (!ownership || ownership.version !== "0.1.0"
    || Object.prototype.hasOwnProperty.call(ownership, "owner")
    || !Array.isArray(ownership.files) || ownership.files.length !== 1
    || !Array.isArray(ownership.plannedFiles) || ownership.plannedFiles.length === 0) return [];
  const allowedKeys = new Set(["version", "files", "plannedFiles"]);
  if (Object.keys(ownership).some((key) => !allowedKeys.has(key))) return [];
  const runPath = ownership.files[0];
  if (typeof runPath !== "string"
    || !/^assets\/\.pptx-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runPath)) return [];
  const planned = new Set();
  for (const relativePath of ownership.plannedFiles) {
    if (typeof relativePath !== "string" || relativePath.includes("\\")
      || path.posix.dirname(relativePath) !== runPath
      || !/^remote-source-\d{3}\.(?:png|jpe?g|gif|webp|svg|img)$/i.test(path.posix.basename(relativePath))) return [];
    planned.add(relativePath);
  }
  if (planned.size !== ownership.plannedFiles.length) return [];
  const outputRoot = path.resolve(outputDir);
  const candidate = path.resolve(outputRoot, runPath);
  const protectedSet = new Set(protectedPaths.map((entry) => path.resolve(entry)));
  if (protectedSet.has(candidate)) return [];
  let entry;
  try { entry = lstatSync(candidate); } catch { return []; }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
  let children;
  try { children = readdirSync(candidate, { withFileTypes: true }); } catch { return []; }
  for (const child of children) {
    const relativeChild = path.posix.join(runPath, child.name);
    if (!planned.has(relativeChild) || !child.isFile() || child.isSymbolicLink()) return [];
  }
  return [candidate];
}

function verifiedImageOwnedAssetPaths(outputDir, ownership, protectedPaths = []) {
  if (!ownership || ownership.version !== "0.1.0" || ownership.owner !== "image-replica-compiler"
    || !Array.isArray(ownership.files) || !ownership.digests || typeof ownership.digests !== "object"
    || Array.isArray(ownership.digests)) return [];
  const allowedKeys = new Set(["version", "owner", "files", "digests"]);
  if (Object.keys(ownership).some((key) => !allowedKeys.has(key))) return [];
  const outputRoot = path.resolve(outputDir);
  const assetsRoot = path.resolve(outputRoot, "assets");
  let assetsEntry;
  try { assetsEntry = lstatSync(assetsRoot); } catch { return []; }
  if (!assetsEntry.isDirectory() || assetsEntry.isSymbolicLink()) return [];
  const protectedSet = new Set(protectedPaths.map((candidate) => path.resolve(candidate)));
  const verified = [];
  const seen = new Set();
  for (const relativePath of ownership.files) {
    if (!isSafeAssetRuntimePath(relativePath) || seen.has(relativePath)) return [];
    seen.add(relativePath);
    const declaredDigest = ownership.digests[relativePath];
    if (typeof declaredDigest !== "string" || !/^[a-f0-9]{64}$/.test(declaredDigest)) return [];
    const candidate = path.resolve(outputRoot, relativePath);
    if (candidate === assetsRoot || !candidate.startsWith(`${assetsRoot}${path.sep}`) || protectedSet.has(candidate)) return [];
    try { assertNoSymlinkBelowTrustedAnchor(candidate, { allowMissing: false, extraAnchors: [outputRoot] }); } catch { return []; }
    let entry;
    try { entry = lstatSync(candidate); } catch { return []; }
    if (!entry.isFile() || entry.isSymbolicLink()) return [];
    let bytes;
    try { bytes = readFileSync(candidate); } catch { return []; }
    if (createHash("sha256").update(bytes).digest("hex") !== declaredDigest) return [];
    verified.push(candidate);
  }
  if (Object.keys(ownership.digests).length !== seen.size
    || Object.keys(ownership.digests).some((key) => !seen.has(key))) return [];
  return verified;
}

export function verifiedRouteOwnedAssetPaths(outputDir, ownership, protectedPaths = []) {
  if (ownership?.owner === CREATIVE_ASSET_OWNER) {
    return verifiedCreativeOwnedAssetPaths(outputDir, ownership, protectedPaths);
  }
  if (ownership?.owner === "image-replica-compiler") {
    return verifiedImageOwnedAssetPaths(outputDir, ownership, protectedPaths);
  }
  if (!Object.prototype.hasOwnProperty.call(ownership ?? {}, "owner")) {
    return verifiedHtmlOwnedAssetPaths(outputDir, ownership, protectedPaths);
  }
  return [];
}

export function validateSourceRegistry(registry) {
  const issues = [];
  if (!registry || typeof registry !== "object") {
    return { valid: false, issues: [issue("error", "source-registry-invalid", "source registry must be an object")] };
  }

  for (const item of registry.items ?? []) {
    if (!item || typeof item !== "object") {
      issues.push(issue("error", "source-item-invalid", "source item must be an object"));
      continue;
    }
    if (!item.id) issues.push(issue("error", "source-id-required", "source item is missing id"));
    if (!item.kind) issues.push(issue("error", "source-kind-required", `${item.id ?? "source"} is missing kind`));
    if (item.kind && !ALLOWED_SOURCE_KINDS.has(item.kind)) {
      issues.push(issue("warning", "source-kind-unknown", `${item.id ?? "source"} uses unknown kind ${item.kind}`));
    }
    if (item.url && !/^https?:\/\//.test(item.url)) {
      issues.push(issue("error", "source-url-invalid", `${item.id ?? "source"} url must be http or https`));
    }
  }

  return result(issues);
}

export function validateAssetRegistry(registry) {
  const issues = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { valid: false, issues: [issue("error", "asset-registry-invalid", "asset registry must be an object")] };
  }

  const structural = validateJsonSchema(registry, ASSET_REGISTRY_SCHEMA);
  for (const error of structural.errors) {
    issues.push(issue("error", "asset-registry-schema-invalid", `${error.path} ${error.message}`));
  }

  const seenIds = new Set();
  for (const asset of Array.isArray(registry.assets) ? registry.assets : []) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) continue;
    const id = typeof asset.id === "string" && asset.id.trim() ? asset.id : "asset";
    if (seenIds.has(asset.id)) issues.push(issue("error", "asset-id-duplicate", `duplicate asset id ${asset.id}`));
    seenIds.add(asset.id);

    if (!isSafeAssetRuntimePath(asset.localPath)) {
      issues.push(issue("error", "asset-runtime-path-unsafe", `${id} localPath must be a normalized local POSIX path below assets/`));
    }
    if (asset.source?.sourceUrl !== undefined && !/^https?:\/\/\S+$/i.test(asset.source.sourceUrl)) {
      issues.push(issue("error", "asset-source-url-invalid", `${id} sourceUrl must be an http(s) provenance URL`));
    }
    if (asset.rights?.status === "allowed-with-attribution"
      && (typeof asset.rights.attribution !== "string" || asset.rights.attribution.trim() === "")) {
      issues.push(issue("error", "asset-attribution-required", `${id} requires non-empty attribution`));
    }
    if (asset.finalDeckUse === "embedded" && asset.rights?.status === "unknown") {
      issues.push(issue("error", "asset-rights-blocked", `${id} cannot be embedded with unknown rights`));
    }
    if (asset.finalDeckUse === "recreated-locally" && !NATIVE_DATA_KINDS.has(asset.kind)) {
      issues.push(issue("error", "asset-recreation-invalid", `${id} can be recreated locally only from chart-data or diagram-source`));
    }

    if (asset.source?.origin === "generated") {
      if (!asset.generation
        || typeof asset.generation.model !== "string" || asset.generation.model.trim() === ""
        || typeof asset.generation.promptSummary !== "string" || asset.generation.promptSummary.trim() === "") {
        issues.push(issue("error", "asset-generation-required", `${id} generated source requires model and promptSummary`));
      }
    } else if (asset.generation !== undefined) {
      issues.push(issue("error", "asset-generation-invented", `${id} non-generated source must not include generation provenance`));
    }

    const usedInSlides = Array.isArray(asset.usedInSlides) ? asset.usedInSlides : [];
    if (new Set(usedInSlides).size !== usedInSlides.length) {
      issues.push(issue("error", "asset-slide-use-duplicate", `${id} usedInSlides must be unique`));
    }
    if (["embedded", "recreated-locally"].includes(asset.finalDeckUse) && usedInSlides.length === 0) {
      issues.push(issue("error", "asset-final-use-without-slide", `${id} ${asset.finalDeckUse} requires at least one usedInSlides entry`));
    }
  }

  return result(issues);
}

export function canonicalAssetRegistryText(registry) {
  const validation = validateAssetRegistry(registry);
  if (!validation.valid) {
    throw new Error(`asset registry invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  }
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function summarizeRegistry({ sources, assets }) {
  const sourceItems = sources?.items ?? [];
  const assetItems = assets?.assets ?? [];
  return {
    sourceCount: sourceItems.length,
    assetCount: assetItems.length,
    embeddedAssetCount: assetItems.filter((asset) => asset.finalDeckUse === "embedded").length
  };
}

function result(issues) {
  return { valid: issues.every((entry) => entry.severity !== "error"), issues };
}

function issue(severity, code, message) {
  return { severity, code, message };
}
