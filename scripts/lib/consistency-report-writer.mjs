/**
 * consistency-report-writer.mjs
 *
 * Pure-function writer for the per-deck consistency report shared by the
 * three pipeline entry points (run-deck-pipeline, run-design-first,
 * run-batch). Produces a deterministic `{json, md}` pair.
 *
 * Decisions (locked in JSDoc per the U1 plan):
 *
 *  - Deterministic ordering: `buildConsistencyReport` re-keys the output
 *    object alphabetically via `sortObjectKeys`, so the JSON produced for a
 *    given (manifest, intermediate, options) triple is byte-identical
 *    across runs. The optional `createdAt` is accepted from the caller; if
 *    absent, it is omitted entirely. The writer never injects a fresh
 *    `Date.now()`, so structurally-same inputs across runs produce
 *    byte-identical JSON.
 *
 *  - "Not measured" phrasing: when an optional field is missing (or a
 *    strict-soft measurement wasn't run), the markdown summary uses the
 *    literal string `_not measured_` (italic via Markdown emphasis). The
 *    byte-equality test for the markdown output is deliberately scoped to
 *    structural shape only — pass content and section order — not the
 *    report-level header line.
 *
 *  - Markdown structure: one `##` section per dimension (8 sections total,
 *    always present regardless of input type). Each section opens with a
 *    pass/warn/fail glyph, the dimension name, and either a one-line
 *    summary or a list of contributing element IDs.
 *
 *  - `previewDiff` policy: `status: "deferred"` is allowed without
 *    `perSlide`. `status: "ok"` requires `perSlide` (validated by the
 *    schema's `allOf` conditional).
 *
 * The writer does NOT touch the file system. Callers (later units U2, U3)
 * write the returned `{json, md}` to disk.
 */

import { validateJsonSchema } from "./schema-utils.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, "..", "..", "schemas");

const PER_DECK_SCHEMA_PATH = resolve(SCHEMA_DIR, "consistency-report.schema.json");
const BATCH_SCHEMA_PATH = resolve(SCHEMA_DIR, "consistency-report-batch.schema.json");

// Cached schema objects (loaded lazily; immutable).
let _perDeckSchema = null;
let _batchSchema = null;

export async function loadPerDeckSchema() {
  if (_perDeckSchema) return _perDeckSchema;
  _perDeckSchema = JSON.parse(await readFile(PER_DECK_SCHEMA_PATH, "utf8"));
  return _perDeckSchema;
}

export async function loadBatchSchema() {
  if (_batchSchema) return _batchSchema;
  _batchSchema = JSON.parse(await readFile(BATCH_SCHEMA_PATH, "utf8"));
  return _batchSchema;
}

// 8 dimensions, always emitted in this order.
export const DIMENSION_SECTIONS = [
  "inputSource",
  "editabilityLevel",
  "coordinateDriftPx",
  "fontFallback",
  "paletteMatch",
  "rasterizedRegions",
  "editabilityFloor",
  "previewDiff"
];

const NOT_MEASURED = "_not measured_";

// Default editability floors per input type (R14 differentiation + U10 floor).
// Image inputs default to L3 because OCR+raster often prevents L4 even when
// adapters perform perfectly; HTML/design-first default to L4 because the
// source is already semantic.
export const DEFAULT_EDITABILITY_FLOOR = Object.freeze({
  html: 4,
  image: 3,
  "design-first": 4,
  unknown: 4
});

export const OCR_CONFIDENCE_FLOOR_DEFAULT = 0.7;
export const OCR_CLEARANCE_TARGET = 0.9;

/**
 * Compute editability-floor violation. Pure function.
 *
 * @param {object} manifest  Deck manifest (only `deck.editabilityFloor` is read).
 * @param {object} intermediate  Render intermediate (editabilityLevel, editabilityCounter, sourceCausal).
 * @param {object} options
 *   - inputType: 'html' | 'image' | 'design-first' | 'unknown'
 *   - allowSourceFloorViolation: boolean (default true) — when false, source-causal
 *     gaps also return `satisfied: false`.
 *
 * @returns {{level:number, floor:number, satisfied: boolean|'with-justification',
 *            floorViolation:{pipelineCausal:object[], sourceCausal:object[]}}}
 *
 * The manifest may RAISE the floor (`deck.editabilityFloor`) but cannot lower it.
 */
export function computeFloorViolation(manifest, intermediate, options = {}) {
  const inputType = normalizeInputType(options.inputType);
  const defaultFloor = DEFAULT_EDITABILITY_FLOOR[inputType] ?? DEFAULT_EDITABILITY_FLOOR.unknown;

  const manifestFloorRaw = manifest?.deck?.editabilityFloor;
  const manifestFloor = typeof manifestFloorRaw === "number" && Number.isFinite(manifestFloorRaw) && manifestFloorRaw > 0
    ? manifestFloorRaw
    : 0;
  const floor = Math.max(defaultFloor, manifestFloor);

  const intermediateSafe = intermediate ?? {};
  const editabilityLevel = typeof intermediateSafe.editabilityLevel === "number"
    ? intermediateSafe.editabilityLevel
    : computeEditabilityLevel(intermediateSafe.editabilityCounter ?? {});

  if (editabilityLevel >= floor) {
    return {
      level: editabilityLevel,
      floor,
      satisfied: true,
      floorViolation: { pipelineCausal: [], sourceCausal: [] }
    };
  }

  const gap = floor - editabilityLevel;
  const allowSource = options.allowSourceFloorViolation !== false; // default true
  const isSourceCausal =
    intermediateSafe.sourceCausal === true ||
    intermediateSafe.rasterFallback === true ||
    inputType === "image";

  if (isSourceCausal) {
    const sourceViolations = [
      {
        reason: "source-caused-raster-fallback",
        recoverable: false,
        level: editabilityLevel,
        floor,
        gap
      }
    ];
    return {
      level: editabilityLevel,
      floor,
      satisfied: allowSource ? "with-justification" : false,
      floorViolation: { pipelineCausal: [], sourceCausal: sourceViolations }
    };
  }

  return {
    level: editabilityLevel,
    floor,
    satisfied: false,
    floorViolation: {
      pipelineCausal: [
        {
          reason: "adapter-under-perform",
          recoverable: true,
          level: editabilityLevel,
          floor,
          gap
        }
      ],
      sourceCausal: []
    }
  };
}

function normalizeInputType(value) {
  if (typeof value !== "string") return "unknown";
  if (value in DEFAULT_EDITABILITY_FLOOR) return value;
  return "unknown";
}

function buildDefaultFloorViolation(editabilityLevel) {
  // Schema-compatible shape: floorViolation is arrays of strings (element IDs
  // or short reason tokens). Rich details (recoverable/gap) live on the
  // separate `computeFloorViolation` helper for callers that want them.
  const safeLevel = typeof editabilityLevel === "number" ? editabilityLevel : 1;
  return {
    level: safeLevel,
    floorViolation: { pipelineCausal: [], sourceCausal: [] }
  };
}

/**
 * Recursively sort object keys for deterministic JSON output. Arrays keep
 * their input order — semantic ordering matters there.
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
 * Validate a candidate report against the per-deck schema. Returns
 * `{ valid, errors }`. Errors are an array of `{ path, message }` objects
 * (or strings, matching the shape produced by `validateJsonSchema`).
 */
export async function validatePerDeckReport(report) {
  const schema = await loadPerDeckSchema();
  return validateJsonSchema(report, schema);
}

/**
 * Validate a candidate report against the batch aggregate schema.
 */
export async function validateBatchReport(report) {
  const schema = await loadBatchSchema();
  return validateJsonSchema(report, schema);
}

/**
 * Pure: build the per-deck consistency report JSON.
 *
 * @param {object} manifest  The compiled deck manifest (input-only — used
 *   only for `inputSource` fallback and slide count).
 * @param {object} intermediate  The transient flags object populated by
 *   render-pptx and the adapters. Shape:
 *     {
 *       sourceCoordinates: Array<{slideId, elementId, dx, dy}>,
 *       fontNames: Array<{element, requested, fallback}>,
 *       paletteMatches: Array<{slideId, score}>,
 *       editabilityCounter: {text, shape, image, table, croppedAsset},
 *       preview: {libreofficeAvailable: boolean, perSlide: Array<object>}
 *     }
 * @param {object} options
 *   - inputType: 'html' | 'image' | 'design-first'  (required)
 *   - inputSource: string  (required; falls back to manifest.deck.title)
 *   - createdAt: optional ISO8601 string. If provided, copied verbatim.
 *     If absent, the field is omitted (so byte-equality across runs holds).
 *   - version: optional schema/doc version (default '0.1.0').
 *   - qualityTargets: optional object copied through as-is.
 *   - editabilityFloor: optional `{ level, floorViolation: { pipelineCausal, sourceCausal } }`.
 *     If omitted, an empty-arrays default is used.
 *
 * @returns {{json: string, md: string, report: object}}
 *   - `report` is the structured object before stringification (useful for
 *     downstream composition; the batch aggregator consumes this shape).
 *   - `json` is the deterministic, sorted-key JSON string (no trailing
 *     newline; callers add one if they want POSIX-conformant files).
 *   - `md` is the markdown summary.
 */
export function buildConsistencyReport(manifest, intermediate, options = {}) {
  const inputType = options.inputType;
  const inputSource =
    options.inputSource ?? manifest?.deck?.title ?? undefined;

  const intermediateSafe = intermediate ?? {};
  const editabilityCounter = intermediateSafe.editabilityCounter ?? {};
  const editabilityLevel = computeEditabilityLevel(editabilityCounter);

  const sourceCoordinates = Array.isArray(intermediateSafe.sourceCoordinates)
    ? intermediateSafe.sourceCoordinates
    : [];
  const coordinateDriftPx = options.coordinateDriftPx ?? averageDrift(sourceCoordinates);

  const fontNames = Array.isArray(intermediateSafe.fontNames) ? intermediateSafe.fontNames : [];
  const fontFallback = fontNames
    .filter((entry) => entry && entry.requested && entry.fallback && entry.requested !== entry.fallback)
    .map((entry) => ({
      element: entry.element ?? "unknown",
      requested: entry.requested,
      fallback: entry.fallback
    }));

  const paletteMatches = Array.isArray(intermediateSafe.paletteMatches) ? intermediateSafe.paletteMatches : [];
  const paletteMatch = options.paletteMatch ?? averagePalette(paletteMatches);

  const rasterizedRegions = Array.isArray(intermediateSafe.rasterizedRegions)
    ? intermediateSafe.rasterizedRegions
    : [];

  const editabilityFloor = options.editabilityFloor ?? buildDefaultFloorViolation(
    editabilityLevel
  );

  const preview = intermediateSafe.preview ?? {};
  const previewDiff = previewDiffShape(preview, options.previewDiff);

  const report = {
    version: options.version ?? "0.1.0"
  };
  if (inputType !== undefined) report.inputType = inputType;
  if (inputSource !== undefined) report.inputSource = inputSource;
  report.editabilityLevel = editabilityLevel;
  report.coordinateDriftPx = coordinateDriftPx;
  report.fontFallback = fontFallback;
  report.paletteMatch = paletteMatch;
  report.rasterizedRegions = rasterizedRegions;
  report.qualityTargets = options.qualityTargets ?? {};
  report.editabilityFloor = editabilityFloor;
  report.previewDiff = previewDiff;

  if (options.createdAt) {
    report.createdAt = options.createdAt;
  }

  const sorted = sortObjectKeys(report);
  const json = JSON.stringify(sorted, null, 2);
  const md = buildMarkdownReport(sorted, manifest, intermediateSafe);

  return { json, md, report: sorted };
}

function computeEditabilityLevel(counter) {
  const text = counter.text ?? 0;
  const shape = counter.shape ?? 0;
  const image = counter.image ?? 0;
  const table = counter.table ?? 0;
  const croppedAsset = counter.croppedAsset ?? 0;
  const nativeShapes = shape + table;
  // Level 5: only native objects, no raster
  if (text > 0 && nativeShapes > 0 && image === 0 && croppedAsset === 0) return 5;
  // Level 4: text + native shapes + at least one raster asset
  if (text > 0 && nativeShapes > 0 && (image > 0 || croppedAsset > 0)) return 4;
  // Level 3: text + raster, but no native shapes
  if (text > 0 && (image > 0 || croppedAsset > 0)) return 3;
  // Level 2: native shapes only, or no text
  if (nativeShapes > 0) return 2;
  return 1;
}

function averageDrift(sourceCoordinates) {
  if (sourceCoordinates.length === 0) return 0;
  const total = sourceCoordinates.reduce((sum, item) => {
    const dx = Math.abs(item?.dx ?? 0);
    const dy = Math.abs(item?.dy ?? 0);
    return sum + Math.sqrt(dx * dx + dy * dy);
  }, 0);
  return Number((total / sourceCoordinates.length).toFixed(3));
}

function averagePalette(paletteMatches) {
  if (paletteMatches.length === 0) return 0;
  const total = paletteMatches.reduce((sum, item) => sum + (item?.score ?? 0), 0);
  return Number((total / paletteMatches.length).toFixed(3));
}

function previewDiffShape(preview, override) {
  if (override && typeof override === "object") {
    return {
      status: override.status,
      ...(Array.isArray(override.perSlide) ? { perSlide: override.perSlide } : {})
    };
  }
  const libreofficeAvailable = preview.libreofficeAvailable === true;
  if (!libreofficeAvailable) {
    return { status: "deferred" };
  }
  const perSlide = Array.isArray(preview.perSlide) ? preview.perSlide : [];
  return { status: "ok", perSlide };
}

/**
 * Pure: build the markdown summary. Section order is fixed.
 */
export function buildMarkdownReport(report, manifest, intermediate) {
  const lines = [];
  lines.push(`# Consistency Report`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Input type: ${report.inputType}`);
  lines.push(`- Input source: ${report.inputSource}`);
  lines.push(`- Editability: Level ${report.editabilityLevel}`);
  if (manifest?.slides) lines.push(`- Slide count: ${manifest.slides.length}`);
  lines.push("");

  for (const section of DIMENSION_SECTIONS) {
    lines.push(`## ${section}`);
    lines.push("");
    lines.push(...sectionBody(section, report, intermediate));
    lines.push("");
  }

  return lines.join("\n");
}

function sectionBody(section, report, intermediate) {
  switch (section) {
    case "inputSource":
      return [`- Input type: ${report.inputType}`, `- Input source: ${report.inputSource}`];
    case "editabilityLevel":
      return [`- Editability level: ${report.editabilityLevel}`];
    case "coordinateDriftPx": {
      if (!intermediate.sourceCoordinates || intermediate.sourceCoordinates.length === 0) {
        return [NOT_MEASURED];
      }
      return [`- Average drift: ${report.coordinateDriftPx} px`];
    }
    case "fontFallback": {
      if (!report.fontFallback || report.fontFallback.length === 0) {
        return ["- No font fallbacks detected."];
      }
      return report.fontFallback.map(
        (entry) => `- ${entry.element}: ${entry.requested} -> ${entry.fallback}`
      );
    }
    case "paletteMatch": {
      if (!intermediate.paletteMatches || intermediate.paletteMatches.length === 0) {
        return [NOT_MEASURED];
      }
      return [`- Average palette match: ${report.paletteMatch}`];
    }
    case "rasterizedRegions": {
      if (!report.rasterizedRegions || report.rasterizedRegions.length === 0) {
        return ["- No rasterized regions."];
      }
      return report.rasterizedRegions.map(
        (region) =>
          `- ${region.slideId}/${region.elementId}: ${(region.areaPct * 100).toFixed(1)}% — ${region.reason}${region.recoverable ? " (recoverable)" : ""}`
      );
    }
    case "editabilityFloor": {
      const floor = report.editabilityFloor ?? { level: report.editabilityLevel, floorViolation: { pipelineCausal: [], sourceCausal: [] } };
      const out = [`- Floor level: ${floor.level}`];
      const pipeline = floor.floorViolation?.pipelineCausal ?? [];
      const source = floor.floorViolation?.sourceCausal ?? [];
      if (pipeline.length === 0 && source.length === 0) {
        out.push("- No floor violations.");
      } else {
        if (pipeline.length > 0) out.push(`- Pipeline-causal: ${pipeline.join(", ")}`);
        if (source.length > 0) out.push(`- Source-causal: ${source.join(", ")}`);
      }
      return out;
    }
    case "previewDiff": {
      const preview = report.previewDiff;
      if (preview.status === "deferred") {
        return ["- Preview diff deferred (LibreOffice not available)."];
      }
      const perSlide = preview.perSlide ?? [];
      if (perSlide.length === 0) {
        return ["- Preview diff ok; no per-slide data."];
      }
      return [`- Preview diff ok across ${perSlide.length} slides.`];
    }
    default:
      return ["- Unknown dimension."];
  }
}

/**
 * Pure: build a batch aggregate from a list of per-deck reports.
 * The shape follows `consistency-report-batch.schema.json`.
 *
 * @param {Array<{path: string, report: object}>} entries
 *   Each entry's `report` is the sorted-key object returned by
 *   `buildConsistencyReport().report`. `path` is a relative path used for
 *   `perDeckReports`.
 * @param {object} options
 *   - version: optional
 *   - createdAt: optional ISO8601 (copied through if present)
 *   - passedDecks: optional override; otherwise computed from
 *     editabilityFloor violations.
 */
export function buildConsistencyBatch(entries, options = {}) {
  const sortedEntries = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let driftTotal = 0;
  let driftCount = 0;
  let fontFallbackHits = 0;
  let fontElementCount = 0;
  let paletteTotal = 0;
  let paletteCount = 0;
  let failed = 0;

  for (const { report } of sortedEntries) {
    const level = report.editabilityLevel ?? 1;
    if (distribution[level] !== undefined) distribution[level] += 1;
    if (typeof report.coordinateDriftPx === "number") {
      driftTotal += report.coordinateDriftPx;
      driftCount += 1;
    }
    const ff = Array.isArray(report.fontFallback) ? report.fontFallback : [];
    fontFallbackHits += ff.length;
    const floor = report.editabilityFloor?.floorViolation;
    const pipelineViol = floor?.pipelineCausal?.length ?? 0;
    const sourceViol = floor?.sourceCausal?.length ?? 0;
    fontElementCount += pipelineViol + sourceViol;
    if (typeof report.paletteMatch === "number") {
      paletteTotal += report.paletteMatch;
      paletteCount += 1;
    }
    if (pipelineViol + sourceViol > 0) failed += 1;
  }

  const total = sortedEntries.length;
  const passed = options.passedDecks ?? Math.max(total - failed, 0);
  const failedDecks = options.failedDecks ?? failed;

  const batch = {
    version: options.version ?? "0.1.0",
    batch: {
      totalDecks: total,
      passedDecks: passed,
      failedDecks
    },
    editabilityDistribution: distribution,
    averageCoordinateDriftPx: driftCount === 0 ? 0 : Number((driftTotal / driftCount).toFixed(3)),
    fontFallbackRate: fontElementCount === 0 ? 0 : Number((fontFallbackHits / fontElementCount).toFixed(3)),
    paletteMatch: paletteCount === 0 ? 0 : Number((paletteTotal / paletteCount).toFixed(3)),
    perDeckReports: sortedEntries.map((entry) => entry.path)
  };

  if (options.createdAt) batch.createdAt = options.createdAt;

  return sortObjectKeys(batch);
}
