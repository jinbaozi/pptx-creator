#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse } from "node-html-parser";
import { writeManifestFromHtml, fetchRemoteAssetSecure } from "./html-to-manifest.mjs";
import { writeMeasurements } from "./measure-html.mjs";
import { editableLevel } from "./render-pptx.mjs";
import { parseDesignFile } from "./parse-design-md.mjs";
import { validatePresentationPackage } from "./validate-presentation-package.mjs";
import {
  auditHtmlFile,
  withSettledHtmlPage,
  withTemporarilyVisibleSlide
} from "./lib/html-layout-audit.mjs";
import {
  formatReport,
  preflightLayout
} from "./lib/check-layout-safety.mjs";
import {
  createFontMetricsCatalog,
  preflightFonts
} from "./lib/font-preflight.mjs";
import { materializeTextFonts } from "./lib/text-fit.mjs";
import { auditPptxGeometry } from "./lib/pptx-geometry-audit.mjs";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_VERSION = "2.0.0";
const PROTOCOL_VERSION = "1.0.0";
const MIN_BROWSER_TIMEOUT_MS = 90_000;
const MAX_REPAIR_ATTEMPTS = 3;
const DEFAULT_VISUAL_THRESHOLD = 48;
const PROTOCOL_FILENAMES = [
  "presentation-package.json",
  "deck-manifest.json"
];
const GENERATED_TOP_LEVEL = [
  "final.pptx",
  "final.pptx.pending",
  "presentation-package.json",
  "output-manifest.json",
  "qa-report.json",
  "qa-report.md",
  "editable-report.json",
  "editable-report.md",
  "compatibility-report.json",
  "fallback-ledger.json",
  "font-report.json",
  "contract-report.json",
  "layout-safety-report.json",
  "pptx-geometry-report.json",
  "visual-comparison.json",
  "html-layout-report.json",
  "html-mobile-report.json",
  "failure-report.json",
  "deck.manifest.json",
  "layout-measurements.json",
  "inputHints.json",
  "deck.prepared.html",
  "design-tokens.json",
  "preview",
  "visual-diff",
  "evidence",
  "assets",
  "design-system"
];
const CHART_KINDS = new Set([
  "stackedBar",
  "groupedBar",
  "horizontalBar",
  "kpiGroup",
  "sparkline"
]);

export class HtmlToPptxError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "HtmlToPptxError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new HtmlToPptxError(code, message, details);
}

function numberOption(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail("E_ARGUMENT", `${label} must be a finite number`);
  return number;
}

export function parseArgs(argv) {
  const options = {
    maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
    browserTimeoutMs: MIN_BROWSER_TIMEOUT_MS,
    visualThreshold: DEFAULT_VISUAL_THRESHOLD,
    allowRemoteAssets: false,
    overwrite: false
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max-repair-attempts") {
      options.maxRepairAttempts = numberOption(argv[++index], arg);
    } else if (arg === "--browser-timeout-ms") {
      options.browserTimeoutMs = numberOption(argv[++index], arg);
    } else if (arg === "--visual-threshold") {
      options.visualThreshold = numberOption(argv[++index], arg);
    } else if (arg === "--allow-remote-assets") {
      options.allowRemoteAssets = true;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--design-system") {
      options.designSystem = argv[++index];
    } else if (arg.startsWith("--")) {
      fail("E_ARGUMENT", `unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!Number.isInteger(options.maxRepairAttempts)
    || options.maxRepairAttempts < 0
    || options.maxRepairAttempts > MAX_REPAIR_ATTEMPTS) {
    fail("E_ARGUMENT", `--max-repair-attempts must be an integer from 0 to ${MAX_REPAIR_ATTEMPTS}`);
  }
  if (options.browserTimeoutMs < MIN_BROWSER_TIMEOUT_MS) {
    fail("E_ARGUMENT", `--browser-timeout-ms must be at least ${MIN_BROWSER_TIMEOUT_MS}`);
  }
  if (options.visualThreshold < 0 || options.visualThreshold > 255) {
    fail("E_ARGUMENT", "--visual-threshold must be between 0 and 255");
  }
  return { input: positional[0], output: positional[1], options };
}

function pathWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readJson(path, code = "E_JSON") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(code, `cannot read JSON ${path}: ${error.message}`);
  }
}

async function packageInput(packagePath) {
  const resolvedPackagePath = resolve(packagePath);
  const value = await readJson(resolvedPackagePath, "E_PROTOCOL_JSON");
  let summary;
  try {
    summary = validatePresentationPackage(value);
  } catch (error) {
    throw new HtmlToPptxError(error.code ?? "E_PROTOCOL", error.message, {
      path: error.path ?? "$"
    });
  }
  if (!["html-presentation", "image-reconstruction"].includes(value.kind)) {
    fail("E_PROTOCOL_KIND", `package kind ${value.kind} cannot be converted from HTML`);
  }
  if (!value.entrypoint) {
    fail("E_PROTOCOL_ENTRYPOINT", "presentation-package 1.0.0 requires an HTML entrypoint for this Skill");
  }
  const root = dirname(resolvedPackagePath);
  const entrypoint = resolve(root, value.entrypoint);
  if (!pathWithin(root, entrypoint)) {
    fail("E_PROTOCOL_PATH", `entrypoint escapes the package root: ${value.entrypoint}`);
  }
  let realRoot;
  let realEntrypoint;
  try {
    [realRoot, realEntrypoint] = await Promise.all([realpath(root), realpath(entrypoint)]);
  } catch (error) {
    fail("E_INPUT_NOT_FOUND", `package entrypoint is not readable: ${entrypoint}`, {
      cause: error.code
    });
  }
  if (!pathWithin(realRoot, realEntrypoint)) {
    fail("E_PROTOCOL_PATH", `entrypoint resolves outside the package root: ${value.entrypoint}`);
  }
  if (![".html", ".htm"].includes(extname(realEntrypoint).toLowerCase())) {
    fail("E_INPUT_TYPE", `package entrypoint must be HTML: ${value.entrypoint}`);
  }
  return {
    inputKind: "presentation-package",
    htmlPath: realEntrypoint,
    packagePath: resolvedPackagePath,
    packageRoot: realRoot,
    packageManifest: value,
    protocolSummary: summary
  };
}

export async function resolveHtmlInput(inputPath) {
  if (!inputPath) fail("E_ARGUMENT", "input path is required");
  const resolvedInput = resolve(inputPath);
  let inputStat;
  try {
    inputStat = await stat(resolvedInput);
  } catch (error) {
    fail("E_INPUT_NOT_FOUND", `input does not exist: ${resolvedInput}`, {
      cause: error.code
    });
  }
  if (inputStat.isFile()) {
    const extension = extname(resolvedInput).toLowerCase();
    if ([".html", ".htm"].includes(extension)) {
      return {
        inputKind: "plain-html",
        htmlPath: await realpath(resolvedInput),
        packagePath: null,
        packageRoot: dirname(await realpath(resolvedInput)),
        packageManifest: null,
        protocolSummary: null
      };
    }
    if (extension === ".json") return packageInput(resolvedInput);
    fail("E_INPUT_TYPE", `input must be an HTML file, directory, or presentation-package JSON: ${resolvedInput}`);
  }
  if (!inputStat.isDirectory()) {
    fail("E_INPUT_TYPE", `input is not a regular file or directory: ${resolvedInput}`);
  }
  for (const filename of PROTOCOL_FILENAMES) {
    const candidate = join(resolvedInput, filename);
    try {
      if ((await stat(candidate)).isFile()) return packageInput(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const indexPath = join(resolvedInput, "index.html");
  try {
    if ((await stat(indexPath)).isFile()) {
      return {
        inputKind: "html-directory",
        htmlPath: await realpath(indexPath),
        packagePath: null,
        packageRoot: await realpath(resolvedInput),
        packageManifest: null,
        protocolSummary: null
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const htmlFiles = (await readdir(resolvedInput))
    .filter((name) => [".html", ".htm"].includes(extname(name).toLowerCase()));
  if (htmlFiles.length === 1) {
    return {
      inputKind: "html-directory",
      htmlPath: await realpath(join(resolvedInput, htmlFiles[0])),
      packagePath: null,
      packageRoot: await realpath(resolvedInput),
      packageManifest: null,
      protocolSummary: null
    };
  }
  fail(
    "E_INPUT_AMBIGUOUS",
    `directory must contain index.html, one HTML file, or a supported protocol file; found ${htmlFiles.length} HTML files`
  );
}

async function prepareOutput(outputDir, overwrite) {
  if (!outputDir) fail("E_ARGUMENT", "output directory is required");
  const output = resolve(outputDir);
  let entries = [];
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink()) {
      fail("E_OUTPUT_SYMLINK", `output directory cannot be a symbolic link: ${output}`);
    }
    if (!info.isDirectory()) {
      fail("E_OUTPUT_TYPE", `output must be a real directory: ${output}`);
    }
    entries = await readdir(output);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(output, { recursive: true });
  }
  await assertNoOutputSymlinks(output);
  if (entries.length > 0 && !overwrite) {
    fail("E_OUTPUT_EXISTS", `output directory is not empty; pass --overwrite to replace generated artifacts: ${output}`);
  }
  if (overwrite) {
    for (const name of GENERATED_TOP_LEVEL) {
      await rm(join(output, name), { recursive: true, force: true });
    }
    const residual = await readdir(output);
    if (residual.length > 0) {
      fail("E_OUTPUT_STALE", `output contains unrecognized residual entries after overwrite cleanup: ${residual.join(", ")}`);
    }
  }
  await mkdir(output, { recursive: true });
  return output;
}

async function assertNoOutputSymlinks(outputDir, currentDir = outputDir) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const path = join(currentDir, entry.name);
    const relativePath = relative(outputDir, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      fail("E_OUTPUT_SYMLINK", `output contains an unsupported symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) await assertNoOutputSymlinks(outputDir, path);
  }
}

function remoteAssetUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(/https?:\/\/[^\s"'(),<>]+/gi)) {
    urls.add(match[0]);
  }
  return [...urls];
}

function imageExtension(bytes, sourceUrl = "") {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return ".gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (/^\s*<svg[\s>]/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 512)))) return ".svg";
  const extension = extname(new URL(sourceUrl).pathname).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)
    ? extension
    : ".bin";
}

async function prepareBrowserHtml(input, outputDir, options) {
  const source = await readFile(input.htmlPath, "utf8");
  const urls = remoteAssetUrls(source);
  if (urls.length === 0) return { browserHtmlPath: input.htmlPath, remoteAssets: [] };
  if (!options.allowRemoteAssets) {
    fail("E_REMOTE_ASSET", `remote assets are disabled; pass --allow-remote-assets (${urls[0]})`);
  }
  const assetsDir = join(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  let localized = source;
  const remoteAssets = [];
  for (const [index, url] of urls.entries()) {
    let bytes;
    try {
      bytes = await fetchRemoteAssetSecure(url, {
        timeoutMs: options.browserTimeoutMs,
        maxBytes: 10 * 1024 * 1024,
        maxRedirects: 3
      });
    } catch (error) {
      fail("E_REMOTE_ASSET", `cannot localize remote asset ${url}: ${error.message}`);
    }
    const extension = imageExtension(bytes, url);
    if (extension === ".bin") {
      fail("E_REMOTE_ASSET", `remote asset has an unsupported image format: ${url}`);
    }
    const path = join(assetsDir, `remote-${String(index + 1).padStart(3, "0")}${extension}`);
    await writeFile(path, bytes);
    localized = localized.split(url).join(pathToFileURL(path).href);
    remoteAssets.push({ url, path });
  }
  const baseTag = `<base href="${pathToFileURL(dirname(input.htmlPath) + sep).href}">`;
  localized = /<head\b[^>]*>/i.test(localized)
    ? localized.replace(/<head\b[^>]*>/i, (match) => `${match}${baseTag}`)
    : `${baseTag}${localized}`;
  const browserHtmlPath = join(outputDir, "deck.prepared.html");
  await writeFile(browserHtmlPath, localized, "utf8");
  return { browserHtmlPath, remoteAssets };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function dataImage(value) {
  const match = String(value).match(/^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([\s\S]+)$/i);
  if (!match) return null;
  const extensions = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg"
  };
  return {
    bytes: Buffer.from(match[2], "base64"),
    extension: extensions[match[1].toLowerCase()]
  };
}

function pathWithoutQuery(value) {
  return String(value).split(/[?#]/, 1)[0];
}

async function localizeManifestAssets(manifest, input, outputDir) {
  const assetsDir = join(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const copies = new Map();
  const ledger = [];

  async function localize(src, hint) {
    if (!src) return src;
    if (/^https?:\/\//i.test(src)) {
      fail("E_REMOTE_ASSET", `unlocalized remote asset remained in the manifest: ${src}`);
    }
    let bytes;
    let extension;
    let sourcePath = null;
    const embedded = dataImage(src);
    if (embedded) {
      bytes = embedded.bytes;
      extension = embedded.extension;
    } else {
      try {
        sourcePath = String(src).startsWith("file:")
          ? fileURLToPath(src)
          : isAbsolute(src)
            ? pathWithoutQuery(src)
            : resolve(dirname(input.htmlPath), pathWithoutQuery(src));
      } catch (error) {
        fail("E_ASSET_PATH", `invalid asset path ${src}: ${error.message}`);
      }
      try {
        const info = await stat(sourcePath);
        if (!info.isFile()) fail("E_ASSET_PATH", `asset is not a regular file: ${sourcePath}`);
        bytes = await readFile(sourcePath);
      } catch (error) {
        if (error instanceof HtmlToPptxError) throw error;
        fail("E_ASSET_PATH", `asset cannot be read: ${sourcePath}`, { cause: error.code });
      }
      extension = extname(sourcePath).toLowerCase() || imageExtension(bytes);
    }
    const digest = sha256Bytes(bytes);
    if (copies.has(digest)) return copies.get(digest);
    const safeHint = String(hint).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) || "asset";
    const filename = `${digest.slice(0, 12)}-${safeHint}${extension}`;
    const targetPath = join(assetsDir, filename);
    await writeFile(targetPath, bytes);
    const relativePath = relative(outputDir, targetPath).replaceAll("\\", "/");
    copies.set(digest, relativePath);
    ledger.push({
      id: `asset-${digest.slice(0, 12)}`,
      source: sourcePath ?? "embedded-data-uri",
      path: relativePath,
      sha256: digest
    });
    return relativePath;
  }

  for (const asset of manifest.assets ?? []) {
    if (asset?.src) asset.src = await localize(asset.src, asset.id ?? "asset");
  }
  for (const slide of manifest.slides ?? []) {
    if (slide.background?.type === "image" && slide.background.src) {
      slide.background.src = await localize(slide.background.src, `${slide.id}-background`);
    }
    for (const element of slide.elements ?? []) {
      if (["image", "cropped-asset"].includes(element?.type) && element.src) {
        element.src = await localize(element.src, element.id ?? "image");
      }
    }
  }
  return ledger;
}

function updateReplicaCoverage(manifest, slideIndex, elementId) {
  const coverage = manifest.metadata?.replicaSource?.coverage;
  const slide = coverage?.slides?.[slideIndex];
  if (!slide) return;
  slide.droppedElements = (slide.droppedElements ?? [])
    .filter((entry) => entry.elementId !== elementId);
  slide.unsupportedEffects = (slide.unsupportedEffects ?? [])
    .filter((entry) => entry.elementId !== elementId);
  slide.coveredElements = Math.min(
    Number(slide.measuredElements ?? 0),
    Number(slide.coveredElements ?? 0) + 1
  );
  slide.coverage = slide.measuredElements
    ? Number((slide.coveredElements / slide.measuredElements).toFixed(4))
    : 1;
  coverage.droppedElements = (coverage.droppedElements ?? [])
    .filter((entry) => !(entry.slideId === slide.slideId && entry.elementId === elementId));
  coverage.unsupportedEffects = (coverage.unsupportedEffects ?? [])
    .filter((entry) => !(entry.slideId === slide.slideId && entry.elementId === elementId));
  coverage.coverage = coverage.slides?.length
    ? Math.min(...coverage.slides.map((item) => Number(item.coverage ?? 0)))
    : 1;
}

export function injectNativeCharts(html, manifest, measurements) {
  const root = parse(html);
  const conversions = [];
  for (const node of root.querySelectorAll("[data-pptx-chart]")) {
    const id = node.getAttribute("data-pptx-id")
      ?? node.getAttribute("data-id")
      ?? node.id;
    if (!id) fail("E_CHART_MARKER", "data-pptx-chart requires data-pptx-id or id");
    let spec;
    try {
      spec = JSON.parse(node.getAttribute("data-pptx-chart"));
    } catch (error) {
      fail("E_CHART_MARKER", `chart ${id} contains invalid JSON: ${error.message}`);
    }
    if (!CHART_KINDS.has(spec.kind)) {
      fail("E_CHART_MARKER", `chart ${id} kind ${spec.kind ?? "missing"} is unsupported; supported=${[...CHART_KINDS].join(",")}`);
    }
    if (!Array.isArray(spec.data) || spec.data.length === 0) {
      fail("E_CHART_MARKER", `chart ${id} requires a non-empty data array`);
    }
    const measurement = measurements.elements.find((entry) => entry.id === id);
    if (!measurement
      || !["x", "y", "w", "h"].every((key) => Number.isFinite(Number(measurement[key])))) {
      fail("E_CHART_MARKER", `chart ${id} has no stable browser measurement`);
    }
    const slide = manifest.slides?.[measurement.slideIndex];
    if (!slide) fail("E_CHART_MARKER", `chart ${id} references a missing slide`);
    slide.elements = (slide.elements ?? [])
      .filter((element) => ![id, `${id}-box`].includes(element.id));
    slide.elements.push({
      type: "chart",
      id,
      kind: spec.kind,
      data: spec.data,
      style: spec.style ?? {},
      x: Number(measurement.x),
      y: Number(measurement.y),
      w: Number(measurement.w),
      h: Number(measurement.h)
    });
    slide.replicaUnsupportedEffects = (slide.replicaUnsupportedEffects ?? [])
      .filter((effect) => effect.elementId !== id);
    updateReplicaCoverage(manifest, measurement.slideIndex, id);
    conversions.push({ slideId: slide.id, elementId: id, kind: spec.kind });
  }
  return conversions;
}

export function suppressNativeTableDescendants(manifest, measurements) {
  const descendantTags = new Set(["thead", "tbody", "tfoot", "tr", "th", "td"]);
  const suppressions = [];
  for (const [slideIndex, slide] of (manifest.slides ?? []).entries()) {
    const slideMeasurements = (measurements.elements ?? [])
      .filter((measurement) => measurement.slideIndex === slideIndex);
    const nativeTableIds = new Set(
      (slide.elements ?? [])
        .filter((element) => element.type === "table")
        .map((element) => element.id)
    );
    const nativeTables = slideMeasurements.filter(
      (measurement) => measurement.kind === "table"
        && nativeTableIds.has(measurement.id)
    );
    if (nativeTables.length === 0) continue;
    const existingIds = new Set((slide.elements ?? []).map((element) => element.id));
    const suppressedIds = new Set();
    const byTable = new Map();
    for (const measurement of slideMeasurements) {
      if (!descendantTags.has(String(measurement.tagName ?? "").toLowerCase())) continue;
      const table = nativeTables.find((candidate) => {
        const tolerance = 0.02;
        return Number(measurement.x) >= Number(candidate.x) - tolerance
          && Number(measurement.y) >= Number(candidate.y) - tolerance
          && Number(measurement.x) + Number(measurement.w)
            <= Number(candidate.x) + Number(candidate.w) + tolerance
          && Number(measurement.y) + Number(measurement.h)
            <= Number(candidate.y) + Number(candidate.h) + tolerance;
      });
      if (!table) continue;
      const ids = [measurement.id, `${measurement.id}-box`]
        .filter((id) => existingIds.has(id));
      if (ids.length === 0) continue;
      for (const id of ids) suppressedIds.add(id);
      const tableIds = byTable.get(table.id) ?? [];
      tableIds.push(...ids);
      byTable.set(table.id, tableIds);
    }
    if (suppressedIds.size === 0) continue;
    slide.elements = (slide.elements ?? [])
      .filter((element) => !suppressedIds.has(element.id));
    for (const [tableId, elementIds] of byTable) {
      suppressions.push({
        slideId: slide.id,
        tableId,
        elementIds: [...new Set(elementIds)].sort()
      });
    }
  }
  return suppressions;
}

export function suppressDuplicateNestedTextElements(manifest, measurements) {
  const suppressions = [];
  const normalizedText = (measurement) =>
    String(measurement.visibleText ?? measurement.text ?? "").replace(/\s+/g, " ").trim();
  const isGeneratedId = (id) => /^html-\d{3}-\d{3}(?:-|$)/.test(String(id));
  const contains = (outer, inner) => {
    const tolerance = 0.02;
    return Number(inner.x) >= Number(outer.x) - tolerance
      && Number(inner.y) >= Number(outer.y) - tolerance
      && Number(inner.x) + Number(inner.w) <= Number(outer.x) + Number(outer.w) + tolerance
      && Number(inner.y) + Number(inner.h) <= Number(outer.y) + Number(outer.h) + tolerance;
  };
  for (const [slideIndex, slide] of (manifest.slides ?? []).entries()) {
    const textMeasurements = (measurements.elements ?? []).filter(
      (measurement) => measurement.slideIndex === slideIndex
        && measurement.kind === "text"
        && normalizedText(measurement)
    );
    const stableParents = textMeasurements.filter(
      (measurement) => !isGeneratedId(measurement.id)
    );
    const duplicateIds = new Set();
    for (const candidate of textMeasurements.filter((measurement) => isGeneratedId(measurement.id))) {
      const duplicateOf = stableParents.find((parent) =>
        parent.id !== candidate.id
        && (candidate.semantics?.semanticParentId === parent.id
          || (normalizedText(parent) === normalizedText(candidate)
            && contains(parent, candidate))));
      if (!duplicateOf) continue;
      duplicateIds.add(candidate.id);
      duplicateIds.add(`${candidate.id}-box`);
      suppressions.push({
        slideId: slide.id,
        elementId: candidate.id,
        coveredBy: duplicateOf.id,
        reason: "generated nested text duplicates a stable semantic text object"
      });
    }
    if (duplicateIds.size > 0) {
      slide.elements = (slide.elements ?? [])
        .filter((element) => !duplicateIds.has(element.id));
    }
  }
  return suppressions;
}

function fallbackReason(effect) {
  return [
    effect.reason,
    effect.filter && `filter:${effect.filter}`,
    effect.backdropFilter && `backdrop-filter:${effect.backdropFilter}`,
    effect.clipPath && `clip-path:${effect.clipPath}`,
    effect.backgroundImage && `background:${effect.backgroundImage}`,
    effect.unsupportedVisual
  ].filter(Boolean).join("; ") || "unsupported-css-effect";
}

export async function applyLocalizedFallbacks(
  htmlPath,
  manifest,
  measurements,
  outputDir,
  browserTimeoutMs
) {
  const plans = [];
  const seen = new Set();
  for (const [slideIndex, slide] of (manifest.slides ?? []).entries()) {
    for (const effect of slide.replicaUnsupportedEffects ?? []) {
      const key = `${slideIndex}\0${effect.elementId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (effect.elementId === "__slide-background") {
        fail("E_FULL_SLIDE_RASTER_FORBIDDEN", "unsupported full-slide CSS background cannot be rasterized");
      }
      const measurement = measurements.elements.find(
        (entry) => entry.slideIndex === slideIndex && entry.id === effect.elementId
      );
      if (!measurement?.px || measurement.px.w <= 0 || measurement.px.h <= 0) {
        fail("E_LOCAL_FALLBACK", `unsupported effect ${effect.elementId} has no safe browser crop`);
      }
      if (measurement.px.w >= measurements.viewport.width * 0.98
        && measurement.px.h >= measurements.viewport.height * 0.98) {
        fail("E_FULL_SLIDE_RASTER_FORBIDDEN", `unsupported effect ${effect.elementId} covers the full slide`);
      }
      plans.push({
        slideIndex,
        slideId: slide.id,
        elementId: effect.elementId,
        px: measurement.px,
        inches: {
          x: Number(measurement.x),
          y: Number(measurement.y),
          w: Number(measurement.w),
          h: Number(measurement.h)
        },
        reason: fallbackReason(effect)
      });
    }
  }
  if (plans.length === 0) return [];
  const assetsDir = join(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await withSettledHtmlPage(htmlPath, {
    viewportWidth: measurements.viewport.width,
    viewportHeight: measurements.viewport.height,
    totalTimeoutMs: browserTimeoutMs,
    networkEnabled: false
  }, async (page) => {
    const slides = page.locator(".pptx-slide, [data-slide]");
    const count = await slides.count();
    for (const [index, plan] of plans.entries()) {
      await withTemporarilyVisibleSlide(page, plan.slideIndex, async () => {
        const slideBox = count > 0
          ? await slides.nth(plan.slideIndex).boundingBox()
          : { x: 0, y: 0 };
        if (!slideBox) fail("E_LOCAL_FALLBACK", `slide ${plan.slideId} has no screenshot geometry`);
        const path = join(assetsDir, `fallback-${String(index + 1).padStart(3, "0")}.png`);
        await page.screenshot({
          path,
          omitBackground: true,
          animations: "disabled",
          timeout: browserTimeoutMs,
          clip: {
            x: Math.max(0, slideBox.x + plan.px.x),
            y: Math.max(0, slideBox.y + plan.px.y),
            width: Math.max(1, plan.px.w),
            height: Math.max(1, plan.px.h)
          }
        });
        plan.path = relative(outputDir, path).replaceAll("\\", "/");
        plan.sha256 = await sha256File(path);
      });
    }
  });

  for (const plan of plans) {
    const slide = manifest.slides[plan.slideIndex];
    const index = Math.max(
      0,
      (slide.elements ?? []).findIndex((element) => element.id === plan.elementId)
    );
    slide.elements = (slide.elements ?? [])
      .filter((element) => ![
        plan.elementId,
        `${plan.elementId}-box`
      ].includes(element.id));
    slide.elements.splice(Math.min(index, slide.elements.length), 0, {
      type: "cropped-asset",
      id: `${plan.elementId}-localized-fallback`,
      src: plan.path,
      ...plan.inches,
      replicaFallback: {
        kind: "raster",
        fullSlide: false,
        reason: plan.reason,
        nativeAlternativesAttempted: [
          "native-shape",
          "native-text",
          "native-svg"
        ]
      }
    });
    slide.replicaUnsupportedEffects = (slide.replicaUnsupportedEffects ?? [])
      .filter((effect) => effect.elementId !== plan.elementId);
  }
  return plans.map((plan, index) => ({
    id: `degradation-${String(index + 1).padStart(3, "0")}`,
    slideId: plan.slideId,
    componentId: `${plan.elementId}-localized-fallback`,
    sourceElementId: plan.elementId,
    path: plan.path,
    sha256: plan.sha256,
    reason: plan.reason,
    fullSlide: false,
    editabilityImpact: "non-editable-region",
    box: plan.inches
  }));
}

export function assertNoFullSlideRaster(manifest, fallbacks = []) {
  const violations = [];
  const size = manifest.deck?.size ?? {};
  for (const fallback of fallbacks) {
    const box = fallback.box ?? {};
    if (fallback.fullSlide === true
      || (box.w >= Number(size.width) * 0.98 && box.h >= Number(size.height) * 0.98)) {
      violations.push(fallback.componentId ?? fallback.id);
    }
  }
  for (const slide of manifest.slides ?? []) {
    const nativeElements = (slide.elements ?? [])
      .filter((element) => !["image", "cropped-asset"].includes(element.type));
    for (const element of slide.elements ?? []) {
      if (!["image", "cropped-asset"].includes(element.type)) continue;
      const coversSlide = Number(element.x) <= 0.01
        && Number(element.y) <= 0.01
        && Number(element.w) >= Number(size.width) * 0.98
        && Number(element.h) >= Number(size.height) * 0.98;
      if (coversSlide && nativeElements.length === 0) violations.push(element.id);
      if (coversSlide && element.replicaFallback) violations.push(element.id);
    }
  }
  if (violations.length > 0) {
    fail(
      "E_FULL_SLIDE_RASTER_FORBIDDEN",
      `full-slide raster fallback is forbidden: ${[...new Set(violations)].join(", ")}`
    );
  }
  return true;
}

export function validateManifestContract(manifest, outputDir) {
  const errors = [];
  if (manifest?.version !== "0.2.0") errors.push("manifest.version must be 0.2.0");
  if (!(Number(manifest?.deck?.size?.width) > 0)
    || !(Number(manifest?.deck?.size?.height) > 0)) {
    errors.push("deck.size must be positive");
  }
  if (!Array.isArray(manifest?.slides) || manifest.slides.length === 0) {
    errors.push("slides must be a non-empty array");
  }
  const ids = new Set();
  for (const [slideIndex, slide] of (manifest?.slides ?? []).entries()) {
    if (!slide.id) errors.push(`slides[${slideIndex}] has no id`);
    for (const [elementIndex, element] of (slide.elements ?? []).entries()) {
      if (!element.id) errors.push(`slides[${slideIndex}].elements[${elementIndex}] has no id`);
      else if (ids.has(element.id)) errors.push(`duplicate element id ${element.id}`);
      else ids.add(element.id);
      for (const key of ["x", "y", "w", "h"]) {
        if (!Number.isFinite(Number(element[key]))) {
          errors.push(`${element.id ?? elementIndex}.${key} must be finite`);
        }
      }
      if (["image", "cropped-asset"].includes(element.type)) {
        if (!element.src || /^https?:\/\//i.test(element.src)) {
          errors.push(`${element.id} has a missing or remote image source`);
        }
      }
    }
  }
  const report = {
    version: "1.0.0",
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    slideCount: manifest?.slides?.length ?? 0,
    elementCount: (manifest?.slides ?? [])
      .reduce((sum, slide) => sum + (slide.elements?.length ?? 0), 0),
    outputRoot: outputDir
  };
  if (errors.length > 0) fail("E_MANIFEST_CONTRACT", errors.join("; "), report);
  return report;
}

function elementLookup(manifest, slideId, elementId) {
  const slide = manifest.slides?.find((entry) => entry.id === slideId);
  const element = slide?.elements?.find((entry) => entry.id === elementId);
  return { slide, element };
}

function clampGeometry(element, size) {
  const before = JSON.stringify([element.x, element.y, element.w, element.h]);
  if (element.type === "line") {
    const endX = Math.max(0, Math.min(size.width, Number(element.x) + Number(element.w)));
    const endY = Math.max(0, Math.min(size.height, Number(element.y) + Number(element.h)));
    element.x = Math.max(0, Math.min(size.width, Number(element.x)));
    element.y = Math.max(0, Math.min(size.height, Number(element.y)));
    element.w = endX - element.x;
    element.h = endY - element.y;
  } else {
    element.x = Math.max(0, Math.min(size.width, Number(element.x)));
    element.y = Math.max(0, Math.min(size.height, Number(element.y)));
    element.w = Math.max(0.01, Math.min(Number(element.w), size.width - element.x));
    element.h = Math.max(0.01, Math.min(Number(element.h), size.height - element.y));
  }
  return before !== JSON.stringify([element.x, element.y, element.w, element.h]);
}

export function applyAutomaticRepairs(manifest, checks) {
  const next = structuredClone(manifest);
  const repairs = [];
  const size = next.deck.size;
  for (const check of checks.filter((entry) => entry.severity === "critical")) {
    const { slide, element } = elementLookup(next, check.slideId, check.target);
    if (!slide || !element) continue;
    if (check.type === "bounds" && clampGeometry(element, size)) {
      repairs.push({
        slideId: slide.id,
        elementId: element.id,
        kind: "clamp-to-slide-bounds"
      });
    } else if (check.type === "text-required-bounds"
      && Number.isFinite(Number(check.suggestion?.h))) {
      const safeHeight = Math.min(
        Number(check.suggestion.h),
        Number(size.height) - Number(element.y)
      );
      if (safeHeight > Number(element.h) + 0.001) {
        element.h = Number(safeHeight.toFixed(4));
        repairs.push({
          slideId: slide.id,
          elementId: element.id,
          kind: "expand-text-bounds",
          value: element.h
        });
      }
    } else if (check.type === "list-item-collision") {
      const nextElement = slide.elements.find((entry) => entry.id === check.relatedTarget);
      if (Number.isFinite(Number(check.suggestion?.h))) {
        element.h = Math.min(
          Number(check.suggestion.h),
          Number(size.height) - Number(element.y)
        );
      }
      if (nextElement && Number.isFinite(Number(check.suggestion?.nextY))) {
        nextElement.y = Math.min(
          Number(check.suggestion.nextY),
          Number(size.height) - Number(nextElement.h)
        );
      }
      repairs.push({
        slideId: slide.id,
        elementId: element.id,
        kind: "separate-list-items"
      });
    } else if (check.type === "connector-detached"
      && ["x", "y", "w", "h"].every((key) => Number.isFinite(Number(check.suggestion?.[key])))) {
      for (const key of ["x", "y", "w", "h"]) {
        element[key] = Number(Number(check.suggestion[key]).toFixed(4));
      }
      repairs.push({
        slideId: slide.id,
        elementId: element.id,
        kind: "reanchor-connector"
      });
    } else if (check.type === "line-height-too-loose"
      && check.suggestion?.style?.lineHeight) {
      element.style = {
        ...(element.style ?? {}),
        ...check.suggestion.style
      };
      repairs.push({
        slideId: slide.id,
        elementId: element.id,
        kind: "normalize-line-height"
      });
    }
  }
  return { manifest: next, repairs };
}

async function runNode(script, args, options = {}) {
  try {
    return await execFileAsync(process.execPath, [join(SKILL_ROOT, "scripts", script), ...args], {
      cwd: SKILL_ROOT,
      timeout: options.timeout ?? 180_000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    fail(options.code ?? "E_SUBPROCESS", `${script} failed: ${error.stderr || error.message}`);
  }
}

function pythonExecutable() {
  return process.env.HTML_TO_PPTX_PYTHON
    || process.env.PPTX_CREATOR_PYTHON
    || "python3";
}

async function renderPreview(pptxPath, outputDir) {
  const reportPath = join(outputDir, "preview-report.json");
  await mkdir(outputDir, { recursive: true });
  let processError = null;
  try {
    await execFileAsync(pythonExecutable(), [
      join(SKILL_ROOT, "scripts", "render-preview.py"),
      pptxPath,
      outputDir,
      "--report",
      reportPath
    ], {
      cwd: SKILL_ROOT,
      timeout: 240_000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    processError = error;
  }
  let report;
  try {
    report = await readJson(reportPath, "E_PREVIEW");
  } catch (error) {
    if (processError) {
      fail("E_PREVIEW", `PPTX preview rendering failed: ${processError.stderr || processError.message}`);
    }
    throw error;
  }
  if (report.status !== "ok") {
    fail("E_PREVIEW", `PPTX preview rendering did not complete: ${report.note ?? report.status}`, report);
  }
  return report;
}

async function compareDeck(sourceDir, renderDir, outputPath, threshold) {
  let processError = null;
  try {
    await execFileAsync(pythonExecutable(), [
      join(SKILL_ROOT, "scripts", "compare-deck.py"),
      sourceDir,
      renderDir,
      outputPath,
      "--threshold",
      String(threshold)
    ], {
      cwd: SKILL_ROOT,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    processError = error;
  }
  const report = await readJson(outputPath, "E_VISUAL_COMPARE");
  if (processError && !report?.summary) {
    fail("E_VISUAL_COMPARE", `visual comparison failed: ${processError.stderr || processError.message}`);
  }
  return report;
}

function countFallbackCoverage(manifest, fallbacks) {
  const deckArea = Number(manifest.deck.size.width) * Number(manifest.deck.size.height)
    * Math.max(1, manifest.slides.length);
  const fallbackArea = fallbacks.reduce(
    (sum, fallback) => sum + Number(fallback.box?.w ?? 0) * Number(fallback.box?.h ?? 0),
    0
  );
  return Number(Math.max(0, 1 - fallbackArea / deckArea).toFixed(4));
}

function editabilityReport(intermediate, manifest, fallbacks) {
  const counters = intermediate?.editabilityCounter ?? {
    text: 0,
    shape: 0,
    image: 0,
    table: 0,
    croppedAsset: 0
  };
  const level = editableLevel(counters);
  const nativeCoverage = countFallbackCoverage(manifest, fallbacks);
  return {
    version: "1.0.0",
    level,
    targetLevel: 4,
    passed: level >= 3 && nativeCoverage >= 0.9,
    nativeCoverage,
    counters,
    editable: [
      "text",
      "shapes",
      "tables",
      "supported chart primitives",
      "supported SVG primitives",
      "connectors"
    ],
    rasterizedRegions: fallbacks
  };
}

function compatibilityReport(
  manifest,
  charts,
  fallbacks,
  fontReport,
  tableDescendantSuppressions,
  nestedTextSuppressions
) {
  return {
    version: "1.0.0",
    status: "completed",
    nativeMappings: {
      text: true,
      shapes: true,
      images: true,
      svgPrimitives: true,
      tables: true,
      chartPrimitives: charts.length,
      connectors: true,
      speakerNotes: true
    },
    tableDescendantSuppressions,
    nestedTextSuppressions,
    localRasterFallbacks: fallbacks,
    unsupportedEffectsRemaining: (manifest.slides ?? [])
      .flatMap((slide) => (slide.replicaUnsupportedEffects ?? [])
        .map((effect) => ({ slideId: slide.id, ...effect }))),
    fontSubstitutions: fontReport.substitutions ?? [],
    officeRendering: {
      browser: "Chromium",
      comparisonRenderer: "LibreOffice headless",
      note: "PowerPoint and WPS may use different font metrics; inspect the reports before release."
    }
  };
}

function protocolComponentType(element) {
  if (element.type === "line") return "connector";
  if (element.type === "cropped-asset") return "image";
  if (["text", "shape", "image", "table", "chart"].includes(element.type)) return element.type;
  if (element.type === "diagram") return "group";
  if (element.type === "icon") return "shape";
  return "unknown";
}

function outputProtocolSources(input, sourceHash) {
  const sources = (input.packageManifest?.sources ?? []).map((source) => ({ ...source }));
  const sourceIds = new Set(sources.map((source) => source.id));
  let htmlSourceId = "source-html";
  let collision = 0;
  while (sourceIds.has(htmlSourceId)) {
    collision += 1;
    htmlSourceId = `source-html-input-${collision}`;
  }
  sources.push({
    id: htmlSourceId,
    kind: "file",
    label: basename(input.htmlPath),
    locator: basename(input.htmlPath),
    sha256: sourceHash,
    factStatus: "provided"
  });
  sourceIds.add(htmlSourceId);
  return { sources, sourceIds, htmlSourceId };
}

function protocolSourceRefs(values, sourceIds, fallback, path) {
  const refs = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value).trim())
    .filter(Boolean))];
  for (const ref of refs) {
    if (!sourceIds.has(ref)) {
      fail("E_PROTOCOL_SOURCE_REF", `output ${path} references an unknown source: ${ref}`);
    }
  }
  return refs.length > 0 ? refs : fallback;
}

function manifestSourceRefs(element) {
  if (Array.isArray(element?.sourceRefs)) return element.sourceRefs;
  if (Array.isArray(element?.evidence?.sourceIds)) return element.evidence.sourceIds;
  return [];
}

async function protocolAssets(manifest, outputDir, sourceRef) {
  const byPath = new Map();
  for (const slide of manifest.slides ?? []) {
    if (slide.background?.type === "image" && slide.background.src) {
      byPath.set(slide.background.src, `${slide.id}-background`);
    }
    for (const element of slide.elements ?? []) {
      if (["image", "cropped-asset"].includes(element.type) && element.src) {
        byPath.set(element.src, element.id);
      }
    }
  }
  const assets = [];
  for (const [path, id] of byPath) {
    const absolute = resolve(outputDir, path);
    const extension = extname(path).toLowerCase();
    const mime = extension === ".png" ? "image/png"
      : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg"
        : extension === ".svg" ? "image/svg+xml"
          : extension === ".gif" ? "image/gif"
            : extension === ".webp" ? "image/webp"
              : "application/octet-stream";
    assets.push({
      id: `asset-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`,
      path,
      mime,
      sha256: await sha256File(absolute),
      rights: "user-provided",
      sourceRef
    });
  }
  return assets;
}

async function materializeProtocolDesignTokens(input, outputDir) {
  const tokens = input.packageManifest?.designTokens;
  if (!tokens) return undefined;
  const target = join(outputDir, "design-tokens.json");
  if (typeof tokens === "string") {
    const source = resolve(input.packageRoot, tokens);
    if (!pathWithin(input.packageRoot, source)) {
      fail("E_PROTOCOL_PATH", `designTokens escapes the package root: ${tokens}`);
    }
    await copyFile(source, target);
  } else {
    await writeFile(target, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
  }
  return "design-tokens.json";
}

export async function buildOutputProtocol({
  input,
  manifest,
  outputDir,
  fallbacks,
  reportPaths,
  designTokens
}) {
  const sourceHash = await sha256File(input.htmlPath);
  const { sources, sourceIds, htmlSourceId } = outputProtocolSources(input, sourceHash);
  const inputSlides = new Map((input.packageManifest?.deck?.slides ?? [])
    .map((slide) => [slide.id, slide]));
  const protocol = {
    protocol: "pptx-creator.presentation-package",
    version: PROTOCOL_VERSION,
    kind: "pptx-delivery",
    producer: { skill: "html-to-pptx", version: SKILL_VERSION },
    entrypoint: "final.pptx",
    deck: {
      id: String(input.packageManifest?.deck?.id ?? "html-to-pptx-deck"),
      title: String(manifest.deck?.title || "HTML presentation"),
      language: String(manifest.deck?.language || "zh-CN"),
      size: {
        width: Number(manifest.deck.size.width),
        height: Number(manifest.deck.size.height),
        unit: "in"
      },
      slides: (manifest.slides ?? []).map((slide, slideIndex) => {
        const inputSlide = inputSlides.get(slide.id);
        const inheritedRefs = protocolSourceRefs(
          inputSlide?.sourceRefs,
          sourceIds,
          [htmlSourceId],
          `slide ${slide.id}`
        );
        const components = (slide.elements ?? []).map((element, elementIndex) => ({
          id: element.id || `${slide.id}-component-${elementIndex + 1}`,
          type: protocolComponentType(element),
          box: {
            x: Number(element.x),
            y: Number(element.y),
            w: Number(element.w),
            h: Number(element.h),
            unit: "in"
          },
          z: elementIndex,
          editableIntent: element.type !== "cropped-asset",
          sourceRefs: protocolSourceRefs(
            manifestSourceRefs(element),
            sourceIds,
            inheritedRefs,
            `component ${element.id || elementIndex + 1}`
          )
        }));
        const componentRefs = [...new Set(components.flatMap((component) => component.sourceRefs))];
        return {
          id: slide.id,
          order: slideIndex + 1,
          title: String(slide.title || `Slide ${slideIndex + 1}`),
          ...(slide.notes ? { notes: slide.notes } : {}),
          sourceRefs: inputSlide?.sourceRefs?.length
            ? inheritedRefs
            : componentRefs.length > 0 ? componentRefs : [htmlSourceId],
          components
        };
      })
    },
    ...(designTokens ? { designTokens } : {}),
    assets: await protocolAssets(manifest, outputDir, htmlSourceId),
    sources,
    validation: {
      status: "passed",
      reports: reportPaths
    },
    degradations: fallbacks.map((fallback) => ({
      id: fallback.id,
      slideId: fallback.slideId,
      componentId: fallback.componentId,
      reason: fallback.reason,
      editabilityImpact: fallback.editabilityImpact
    })),
    compatibility: {
      minReaderVersion: PROTOCOL_VERSION,
      features: [
        "editable-text",
        "editable-shapes",
        "editable-tables",
        "editable-connectors",
        "local-raster-ledger",
        "speaker-notes",
        "visual-proof"
      ]
    }
  };
  validatePresentationPackage(protocol);
  return protocol;
}

async function collectOutputFiles(outputDir, currentDir = outputDir) {
  const files = [];
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const absolute = join(currentDir, entry.name);
    const relativePath = relative(outputDir, absolute).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      fail("E_OUTPUT_SYMLINK", `output contains an unsupported symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectOutputFiles(outputDir, absolute));
      continue;
    }
    if (!entry.isFile()) {
      fail("E_OUTPUT_TYPE", `output contains an unsupported filesystem entry: ${relativePath}`);
    }
    files.push(relativePath);
  }
  return files;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function buildOutputManifest(outputDir, paths = []) {
  const discovered = await collectOutputFiles(outputDir);
  const requiredPaths = [...new Set(paths)]
    .map((path) => String(path).replaceAll("\\", "/"))
    .filter((path) => path !== "output-manifest.json")
    .sort();
  for (const path of requiredPaths) {
    const absolute = resolve(outputDir, path);
    if (!pathWithin(outputDir, absolute)) {
      fail("E_OUTPUT_PATH", `output artifact escapes the output directory: ${path}`);
    }
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        fail("E_OUTPUT_SYMLINK", `output artifact is a symbolic link: ${path}`);
      }
      if (!info.isFile()) {
        fail("E_OUTPUT_MANIFEST", `required output artifact is not a regular file: ${path}`);
      }
    } catch (error) {
      if (error instanceof HtmlToPptxError) throw error;
      if (error.code === "ENOENT") {
        fail("E_OUTPUT_MANIFEST", `required output artifact is missing: ${path}`);
      }
      throw error;
    }
  }
  const artifactPaths = [...new Set(discovered)]
    .filter((path) => path !== "output-manifest.json")
    .sort();
  const artifacts = [];
  for (const path of artifactPaths) {
    const absolute = resolve(outputDir, path);
    if (!pathWithin(outputDir, absolute)) {
      fail("E_OUTPUT_PATH", `output artifact escapes the output directory: ${path}`);
    }
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      fail("E_OUTPUT_SYMLINK", `output artifact is a symbolic link: ${path}`);
    }
    if (!info.isFile()) continue;
    artifacts.push({
      path,
      bytes: info.size,
      sha256: await sha256File(absolute)
    });
  }
  const manifest = {
    version: "1.0.0",
    producer: { skill: "html-to-pptx", version: SKILL_VERSION },
    status: "passed",
    artifacts
  };
  return {
    ...manifest,
    rootSha256: sha256Bytes(Buffer.from(canonicalJson(manifest)))
  };
}

function qaMarkdown(qa) {
  return [
    "# HTML to PPTX QA",
    "",
    `- Status: ${qa.status}`,
    `- Slides: ${qa.slideCount}`,
    `- Repair attempts: ${qa.repairAttempts}`,
    `- HTML critical findings: ${qa.gates.htmlLayout.criticalCount}`,
    `- PPTX geometry critical findings: ${qa.gates.pptxGeometry.criticalCount}`,
    `- Visual max mean channel difference: ${qa.gates.visual.maxMeanAbsChannelDiff}`,
    `- Editability level: ${qa.gates.editability.level}`,
    `- Native coverage: ${qa.gates.editability.nativeCoverage}`,
    "",
    qa.remainingIssues.length
      ? `Remaining issues:\n${qa.remainingIssues.map((issue) => `- ${issue}`).join("\n")}`
      : "Remaining issues: none.",
    ""
  ].join("\n");
}

function editableMarkdown(report) {
  return [
    "# Editability",
    "",
    `- Level: ${report.level}`,
    `- Native coverage: ${report.nativeCoverage}`,
    `- Local raster regions: ${report.rasterizedRegions.length}`,
    "",
    "Editable object families:",
    ...report.editable.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

function failureQaMarkdown(report) {
  return [
    "# HTML to PPTX QA",
    "",
    "- Status: failed",
    `- Code: ${report.code}`,
    `- Final published: ${report.finalPublished}`,
    "",
    `Failure: ${report.message}`,
    ""
  ].join("\n");
}

async function writeFailure(outputDir, error, context = {}) {
  const report = {
    version: "1.0.0",
    status: "failed",
    code: error.code ?? "E_UNKNOWN",
    message: error.message,
    details: error.details ?? null,
    ...context,
    finalPublished: false
  };
  await mkdir(outputDir, { recursive: true }).catch(() => {});
  const failedQa = {
    version: "1.0.0",
    status: "failed",
    code: report.code,
    message: report.message,
    details: report.details,
    finalPublished: false,
    ...(report.runId ? { runId: report.runId } : {}),
    ...(report.input ? { input: report.input } : {}),
    ...(report.inputKind ? { inputKind: report.inputKind } : {})
  };
  await Promise.all([
    "failure-report.json",
    "qa-report.json",
    "qa-report.md"
  ].map((name) => rm(join(outputDir, name), { recursive: true, force: true }).catch(() => {})));
  await Promise.all([
    writeFile(join(outputDir, "failure-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(join(outputDir, "qa-report.json"), `${JSON.stringify(failedQa, null, 2)}\n`, "utf8"),
    writeFile(join(outputDir, "qa-report.md"), failureQaMarkdown(report), "utf8")
  ].map((operation) => operation.catch(() => {})));
  return report;
}

export async function discardPublishedArtifacts(outputDir) {
  const removed = [];
  for (const name of ["final.pptx", "final.pptx.pending", "presentation-package.json", "output-manifest.json"]) {
    const path = join(outputDir, name);
    try {
      await lstat(path);
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      // Failure reporting must not mask the original conversion error.
    }
  }
  return removed;
}

export async function finalizeFailedOutput(outputDir, error, context = {}) {
  const removedPublishedArtifacts = await discardPublishedArtifacts(outputDir);
  return writeFailure(outputDir, error, {
    ...context,
    removedPublishedArtifacts,
    finalPublished: false
  });
}

export async function runConversion(inputPath, outputPath, options = {}) {
  const effectiveOptions = {
    maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
    browserTimeoutMs: MIN_BROWSER_TIMEOUT_MS,
    visualThreshold: DEFAULT_VISUAL_THRESHOLD,
    allowRemoteAssets: false,
    overwrite: false,
    ...options
  };
  if (effectiveOptions.browserTimeoutMs < MIN_BROWSER_TIMEOUT_MS) {
    fail("E_ARGUMENT", `browser timeout must be at least ${MIN_BROWSER_TIMEOUT_MS}ms`);
  }
  if (effectiveOptions.maxRepairAttempts > MAX_REPAIR_ATTEMPTS) {
    fail("E_ARGUMENT", `repair attempts cannot exceed ${MAX_REPAIR_ATTEMPTS}`);
  }
  const input = await resolveHtmlInput(inputPath);
  const outputDir = await prepareOutput(outputPath, effectiveOptions.overwrite);
  const runId = randomUUID();
  try {
    const prepared = await prepareBrowserHtml(input, outputDir, effectiveOptions);
    const sourceEvidenceDir = join(outputDir, "evidence", "source-html");
    const htmlLayout = await auditHtmlFile(prepared.browserHtmlPath, {
      viewportWidth: 1280,
      viewportHeight: 720,
      totalTimeoutMs: effectiveOptions.browserTimeoutMs,
      networkEnabled: false,
      profile: "replica",
      screenshots: true,
      outputDir: sourceEvidenceDir
    });
    await writeFile(
      join(outputDir, "html-layout-report.json"),
      `${JSON.stringify(htmlLayout, null, 2)}\n`,
      "utf8"
    );
    if (htmlLayout.summary.criticalCount > 0) {
      fail(
        "E_HTML_LAYOUT",
        `source HTML has ${htmlLayout.summary.criticalCount} critical layout issue(s)`,
        htmlLayout.summary
      );
    }
    const mobileLayout = await auditHtmlFile(prepared.browserHtmlPath, {
      viewportWidth: 390,
      viewportHeight: 844,
      totalTimeoutMs: effectiveOptions.browserTimeoutMs,
      networkEnabled: false,
      profile: "replica",
      screenshots: false
    });
    await writeFile(
      join(outputDir, "html-mobile-report.json"),
      `${JSON.stringify(mobileLayout, null, 2)}\n`,
      "utf8"
    );

    const measurementsPath = join(outputDir, "layout-measurements.json");
    const measurements = await writeMeasurements(
      prepared.browserHtmlPath,
      measurementsPath,
      {
        replica: true,
        viewportWidth: 1280,
        viewportHeight: 720,
        totalTimeoutMs: effectiveOptions.browserTimeoutMs,
        packageRoot: SKILL_ROOT
      }
    );
    if (measurements.elements.length === 0) {
      fail("E_HTML_EMPTY", "browser measurement found no visible convertible elements");
    }

    const designDir = join(outputDir, "design-system");
    await mkdir(designDir, { recursive: true });
    const designSource = effectiveOptions.designSystem
      ? resolve(effectiveOptions.designSystem)
      : join(SKILL_ROOT, "design-systems", "business-neutral", "DESIGN.md");
    await access(designSource);
    const outputDesignPath = join(designDir, "DESIGN.md");
    await copyFile(designSource, outputDesignPath);
    const design = await parseDesignFile(outputDesignPath);
    const manifestPath = join(outputDir, "deck.manifest.json");
    const converted = await writeManifestFromHtml(
      prepared.browserHtmlPath,
      manifestPath,
      {
        measurements,
        designSystem: "business-neutral",
        designMode: "replica",
        replicaSourcePath: input.htmlPath,
        designSystemSource: "design-system/DESIGN.md",
        designSystemName: design.name,
        packageRoot: SKILL_ROOT,
        allowRemoteAssets: false
      }
    );
    let manifest = converted.manifest;
    const tableDescendantSuppressions = suppressNativeTableDescendants(
      manifest,
      measurements
    );
    const nestedTextSuppressions = suppressDuplicateNestedTextElements(
      manifest,
      measurements
    );
    const sourceHtml = await readFile(prepared.browserHtmlPath, "utf8");
    const chartConversions = injectNativeCharts(sourceHtml, manifest, measurements);
    const localizedAssets = await localizeManifestAssets(manifest, input, outputDir);
    const fallbacks = await applyLocalizedFallbacks(
      prepared.browserHtmlPath,
      manifest,
      measurements,
      outputDir,
      effectiveOptions.browserTimeoutMs
    );
    assertNoFullSlideRaster(manifest, fallbacks);

    const fontCatalog = await createFontMetricsCatalog();
    const fontPreflight = await preflightFonts(manifest, design);
    const materializedFonts = materializeTextFonts(manifest, design.tokens, fontCatalog);
    manifest = materializedFonts.manifest;
    const fontReport = {
      ...fontPreflight,
      substitutions: materializedFonts.substitutions,
      metricsSource: fontCatalog.source
    };
    await writeFile(
      join(outputDir, "font-report.json"),
      `${JSON.stringify(fontReport, null, 2)}\n`,
      "utf8"
    );

    const contract = validateManifestContract(manifest, outputDir);
    await writeFile(
      join(outputDir, "contract-report.json"),
      `${JSON.stringify(contract, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(outputDir, "fallback-ledger.json"),
      `${JSON.stringify({
        version: "1.0.0",
        fullSlideRasterForbidden: true,
        nativeCoverage: countFallbackCoverage(manifest, fallbacks),
        entries: fallbacks
      }, null, 2)}\n`,
      "utf8"
    );

    const attempts = [];
    let success = null;
    for (let attempt = 0; attempt <= effectiveOptions.maxRepairAttempts; attempt += 1) {
      const attemptDir = join(outputDir, "evidence", `attempt-${attempt}`);
      await mkdir(attemptDir, { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const layout = preflightLayout(manifest, {
        strict: true,
        mode: "replica",
        inputType: "html",
        designTokens: design.tokens,
        fontCatalog
      });
      const layoutWire = formatReport(layout, { deckSize: manifest.deck.size });
      await writeFile(
        join(attemptDir, "layout-safety-report.json"),
        `${JSON.stringify(layoutWire, null, 2)}\n`,
        "utf8"
      );
      const candidatePath = join(attemptDir, "candidate.pptx");
      const rendered = await runNode(
        "render-pptx.mjs",
        [manifestPath, candidatePath],
        { code: "E_PPTX_RENDER", timeout: 240_000 }
      );
      const renderSummary = JSON.parse(rendered.stdout);
      const geometry = await auditPptxGeometry(candidatePath, manifest, {
        manifestPath,
        requireOrder: true,
        baseDir: outputDir
      });
      await writeFile(
        join(attemptDir, "pptx-geometry-report.json"),
        `${JSON.stringify(geometry, null, 2)}\n`,
        "utf8"
      );
      const renderDir = join(attemptDir, "render");
      const preview = await renderPreview(candidatePath, renderDir);
      const sourceScreenshots = join(sourceEvidenceDir, "html-preview");
      const visual = await compareDeck(
        sourceScreenshots,
        renderDir,
        join(attemptDir, "visual-comparison.json"),
        effectiveOptions.visualThreshold
      );
      const editability = editabilityReport(
        renderSummary.intermediate,
        manifest,
        fallbacks
      );
      const passed = layout.summary.criticalCount === 0
        && geometry.summary.criticalCount === 0
        && visual.summary.passed
        && editability.passed
        && preview.previewCount === manifest.slides.length;
      const attemptRecord = {
        attempt,
        passed,
        layout: layout.summary,
        geometry: geometry.summary,
        visual: visual.summary,
        editability: {
          level: editability.level,
          nativeCoverage: editability.nativeCoverage,
          passed: editability.passed
        },
        repairs: []
      };
      attempts.push(attemptRecord);
      if (passed) {
        success = {
          attempt,
          candidatePath,
          renderDir,
          layout,
          layoutWire,
          geometry,
          visual,
          editability,
          preview,
          renderSummary
        };
        break;
      }
      if (attempt >= effectiveOptions.maxRepairAttempts) break;
      const repaired = applyAutomaticRepairs(manifest, layout.checks);
      attemptRecord.repairs = repaired.repairs;
      if (repaired.repairs.length === 0) break;
      manifest = repaired.manifest;
    }

    if (!success) {
      const last = attempts.at(-1);
      fail(
        "E_QUALITY_GATE",
        "conversion did not pass visual, geometry, and editability gates within the repair limit",
        { attempts, last }
      );
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      join(outputDir, "layout-safety-report.json"),
      `${JSON.stringify(success.layoutWire, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(outputDir, "pptx-geometry-report.json"),
      `${JSON.stringify(success.geometry, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(outputDir, "visual-comparison.json"),
      `${JSON.stringify(success.visual, null, 2)}\n`,
      "utf8"
    );
    const finalPath = join(outputDir, "final.pptx");
    const pendingFinalPath = join(outputDir, "final.pptx.pending");
    await copyFile(success.candidatePath, pendingFinalPath);
    await cp(success.renderDir, join(outputDir, "preview"), {
      recursive: true,
      force: true
    });
    const compatibility = compatibilityReport(
      manifest,
      chartConversions,
      fallbacks,
      fontReport,
      tableDescendantSuppressions,
      nestedTextSuppressions
    );
    await writeFile(
      join(outputDir, "compatibility-report.json"),
      `${JSON.stringify(compatibility, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(outputDir, "editable-report.json"),
      `${JSON.stringify(success.editability, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(outputDir, "editable-report.md"),
      editableMarkdown(success.editability),
      "utf8"
    );
    const remainingIssues = [
      ...success.layout.checks
        .filter((check) => check.severity !== "critical")
        .map((check) => check.message),
      ...success.geometry.findings
        .filter((finding) => finding.severity !== "critical")
        .map((finding) => finding.message),
      ...(mobileLayout.summary.criticalCount > 0
        ? [`mobile source diagnostic contains ${mobileLayout.summary.criticalCount} critical finding(s)`]
        : [])
    ];
    const qa = {
      version: "1.0.0",
      runId,
      status: "passed",
      inputKind: input.inputKind,
      slideCount: manifest.slides.length,
      repairAttempts: success.attempt,
      maxRepairAttempts: effectiveOptions.maxRepairAttempts,
      browserTimeoutMs: effectiveOptions.browserTimeoutMs,
      gates: {
        htmlLayout: htmlLayout.summary,
        mobileHtmlDiagnostic: mobileLayout.summary,
        manifestContract: contract,
        layoutSafety: success.layout.summary,
        pptxGeometry: success.geometry.summary,
        visual: success.visual.summary,
        editability: {
          level: success.editability.level,
          nativeCoverage: success.editability.nativeCoverage,
          passed: success.editability.passed
        },
        fullSlideRaster: { forbidden: true, violations: 0 }
      },
      attempts,
      localizedAssets,
      chartConversions,
      tableDescendantSuppressions,
      nestedTextSuppressions,
      remainingIssues
    };
    const designTokens = await materializeProtocolDesignTokens(input, outputDir);
    const reportPaths = [
      "qa-report.json",
      "editable-report.json",
      "compatibility-report.json",
      "html-layout-report.json",
      "pptx-geometry-report.json",
      "visual-comparison.json",
      "fallback-ledger.json",
      "output-manifest.json"
    ];
    const outputProtocol = await buildOutputProtocol({
      input,
      manifest,
      outputDir,
      fallbacks,
      reportPaths,
      designTokens
    });
    await writeFile(
      join(outputDir, "qa-report.json"),
      `${JSON.stringify(qa, null, 2)}\n`,
      "utf8"
    );
    await writeFile(join(outputDir, "qa-report.md"), qaMarkdown(qa), "utf8");
    await writeFile(
      join(outputDir, "presentation-package.json"),
      `${JSON.stringify(outputProtocol, null, 2)}\n`,
      "utf8"
    );
    const artifactPaths = [
      "final.pptx",
      "deck.manifest.json",
      "presentation-package.json",
      "qa-report.json",
      "qa-report.md",
      "editable-report.json",
      "editable-report.md",
      "compatibility-report.json",
      "fallback-ledger.json",
      "font-report.json",
      "contract-report.json",
      "layout-safety-report.json",
      "pptx-geometry-report.json",
      "visual-comparison.json",
      "html-layout-report.json",
      "html-mobile-report.json",
      ...(designTokens ? [designTokens] : [])
    ];
    await rename(pendingFinalPath, finalPath);
    const index = await buildOutputManifest(outputDir, artifactPaths);
    await writeFile(
      join(outputDir, "output-manifest.json"),
      `${JSON.stringify(index, null, 2)}\n`,
      "utf8"
    );
    return {
      status: "passed",
      input: input.htmlPath,
      outputDir,
      pptx: finalPath,
      slides: manifest.slides.length,
      editabilityLevel: success.editability.level,
      nativeCoverage: success.editability.nativeCoverage,
      visual: success.visual.summary,
      repairs: success.attempt,
      protocolVersion: PROTOCOL_VERSION
    };
  } catch (error) {
    await finalizeFailedOutput(outputDir, error, {
      input: input.htmlPath,
      inputKind: input.inputKind,
      runId
    });
    throw error;
  }
}

async function main() {
  const { input, output, options } = parseArgs(process.argv.slice(2));
  if (!input || !output) {
    fail(
      "E_ARGUMENT",
      "usage: convert.mjs <input.html|directory|presentation-package.json> <output-dir> [--max-repair-attempts 0..3] [--browser-timeout-ms >=90000] [--visual-threshold 48] [--allow-remote-assets] [--overwrite]"
    );
  }
  const result = await runConversion(input, output, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

let invokedDirectly = false;
if (process.argv[1]) {
  try {
    invokedDirectly = await realpath(fileURLToPath(import.meta.url))
      === await realpath(resolve(process.argv[1]));
  } catch {
    invokedDirectly = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error.code ?? "E_UNKNOWN",
      message: error.message,
      details: error.details ?? null
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
