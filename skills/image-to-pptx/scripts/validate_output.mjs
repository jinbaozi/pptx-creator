#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import JSZip from "jszip";
import { inflateSync } from "node:zlib";
import { validatePresentationPackageFile } from "./validate-presentation-package.mjs";

const analysisSchemaPath = fileURLToPath(new URL("../schemas/analysis.schema.json", import.meta.url));
const qaSchemaPath = fileURLToPath(new URL("../schemas/qa-report.schema.json", import.meta.url));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(schemaValidator);
const validateAnalysisSchema = schemaValidator.compile(JSON.parse(readFileSync(analysisSchemaPath, "utf8")));
const validateQaSchema = schemaValidator.compile(JSON.parse(readFileSync(qaSchemaPath, "utf8")));

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readable(path, label) {
  try {
    await access(path);
  } catch {
    fail("E_CONTRACT", `${label} is missing: ${path}`);
  }
}

async function present(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function schemaCheck(validate, value, label) {
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ");
  fail("E_SCHEMA", `${label} schema validation failed${details ? `: ${details}` : ""}`);
}

function pngDimensions(buffer, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    fail("E_CONTRACT", `${label} is not a valid PNG`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function decodeMaskAlpha(buffer, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) fail("E_CONTRACT", `${label} is not a valid PNG mask`);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) fail("E_CONTRACT", `${label} PNG chunk is truncated`);
    const data = buffer.subarray(start, end);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (!width || !height || bitDepth !== 8 || ![0, 4].includes(colorType) || interlace !== 0 || !idat.length) {
    fail("E_CONTRACT", `${label} mask PNG must be non-interlaced 8-bit grayscale`);
  }
  const channels = colorType === 4 ? 2 : 1;
  const rowBytes = width * channels;
  const decoded = inflateSync(Buffer.concat(idat));
  if (decoded.length !== (rowBytes + 1) * height) fail("E_CONTRACT", `${label} mask PNG scanline size is invalid`);
  const rows = Buffer.alloc(rowBytes * height);
  const paeth = (left, up, upperLeft) => {
    const estimate = left + up - upperLeft;
    const distanceLeft = Math.abs(estimate - left);
    const distanceUp = Math.abs(estimate - up);
    const distanceUpperLeft = Math.abs(estimate - upperLeft);
    if (distanceLeft <= distanceUp && distanceLeft <= distanceUpperLeft) return left;
    if (distanceUp <= distanceUpperLeft) return up;
    return upperLeft;
  };
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = decoded[sourceOffset++];
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = decoded[sourceOffset++];
      const left = x >= channels ? rows[rowOffset + x - channels] : 0;
      const up = y > 0 ? rows[rowOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? rows[rowOffset - rowBytes + x - channels] : 0;
      let value = raw;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upperLeft);
      else if (filter !== 0) fail("E_CONTRACT", `${label} mask PNG uses an unsupported filter`);
      rows[rowOffset + x] = value & 0xff;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rows[index * channels + (colorType === 4 ? 1 : 0)];
  return { width, height, alpha };
}

export function validateRuntimeReport(runtime) {
  const required = ["renderer", "libreoffice", "poppler", "tesseract", "python", "libraries"];
  if (!runtime || typeof runtime !== "object" || required.some((name) => !runtime[name] || typeof runtime[name] !== "object")) {
    fail("E_CONTRACT", "render runtime report is incomplete");
  }
  if (runtime.renderer.name !== "render_preview" || runtime.renderer.version !== "2.0") {
    fail("E_CONTRACT", "unsupported render_preview runtime version");
  }
  if (runtime.renderer.engine !== "libreoffice+pdftoppm") {
    fail("E_CONTRACT", "render runtime engine is incomplete");
  }
  for (const name of ["libreoffice", "poppler", "tesseract"]) {
    const item = runtime[name];
    if (item.status !== "available" || typeof item.command !== "string" || !item.command
        || typeof item.version !== "string" || !item.version) {
      fail("E_CONTRACT", `${name} runtime evidence is incomplete`);
    }
  }
  if (runtime.python.status !== "available" || typeof runtime.python.executable !== "string"
      || !runtime.python.executable || typeof runtime.python.version !== "string" || !runtime.python.version) {
    fail("E_CONTRACT", "python runtime evidence is incomplete");
  }
  for (const name of ["Pillow", "pytesseract", "numpy", "scikit-image", "fontTools"]) {
    const item = runtime.libraries[name];
    if (!item || item.status !== "available" || typeof item.version !== "string" || !item.version) {
      fail("E_CONTRACT", `${name} library runtime evidence is incomplete`);
    }
  }
}

export async function validateFontInventory(root, analysis, qa, renderReport = null) {
  const reference = analysis?.fontInventoryRef;
  if (!reference || typeof reference !== "object") fail("E_FONT_INVENTORY", "analysis font inventory reference is missing");
  const inventoryPath = local(root, reference.path, "analysis.fontInventoryRef.path");
  await readable(inventoryPath, "font inventory");
  if (await digest(inventoryPath) !== reference.sha256) fail("E_FONT_INVENTORY", "font inventory digest mismatch");
  if (!qa?.fontInventory || JSON.stringify(qa.fontInventory) !== JSON.stringify(reference)) {
    fail("E_FONT_INVENTORY", "QA font inventory lineage mismatch");
  }
  if (renderReport && renderReport.fontInventory
      && JSON.stringify(renderReport.fontInventory) !== JSON.stringify(reference)) {
    fail("E_FONT_INVENTORY", "render font inventory lineage mismatch");
  }
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch (error) {
    fail("E_FONT_INVENTORY", `font inventory is invalid JSON: ${error.message}`);
  }
  if (inventory.version !== "1.0.0" || inventory.kind !== "offline-font-inventory" || inventory.offline !== true) {
    fail("E_FONT_INVENTORY", "font inventory contract is incomplete");
  }
  if (!Array.isArray(inventory.candidateFamilies) || inventory.candidateFamilies.length < 1 || inventory.candidateFamilies.length > 6) {
    fail("E_FONT_INVENTORY", "font inventory family cap is invalid");
  }
  const faces = Array.isArray(inventory.faces) ? inventory.faces : [];
  const faceIds = new Set();
  const faceById = new Map();
  for (const face of faces) {
    if (!face || typeof face.faceId !== "string" || faceIds.has(face.faceId)
      || typeof face.family !== "string" || typeof face.selectionFamily !== "string"
      || (face.actualFamily !== null && face.actualFamily !== undefined && typeof face.actualFamily !== "string")
      || typeof face.pathEvidence !== "string"
      || typeof face.runtimeIdentity !== "string" || !face.runtimeIdentity
      || !/^[0-9a-f]{64}$/iu.test(face.pathDigest ?? "")
      || (face.os2WeightClass !== null && (!Number.isInteger(face.os2WeightClass) || face.os2WeightClass < 100 || face.os2WeightClass > 900))
      || !["OS/2", "fontconfig"].includes(face.weightSource)
      || !face.coverage || typeof face.coverage !== "object"
      || !["latin", "han", "digits"].every((name) => typeof face.coverage[name] === "boolean")
      || !Array.isArray(face.requiredGlyphs) || !Array.isArray(face.missingGlyphs)) {
      fail("E_FONT_INVENTORY", "font inventory face evidence is incomplete");
    }
    faceIds.add(face.faceId);
    faceById.set(face.faceId, face);
  }
  if (inventory.runtime?.fontTools?.status !== "available") {
    fail("E_FONT_INVENTORY", "fontTools runtime is unavailable");
  }
  for (const slide of analysis.slides ?? []) {
    if (JSON.stringify(slide.fontInventoryRef) !== JSON.stringify(reference)) {
      fail("E_FONT_INVENTORY", `${slide.id} font inventory lineage mismatch`);
    }
    const tiers = new Map((slide.typographyTiers ?? []).map((tier) => [tier.id, tier]));
    const textObjects = (slide.objects ?? []).filter((object) => object.type === "text");
    const textById = new Map(textObjects.map((object) => [object.id, object]));
    const memberOwner = new Map();
    for (const tier of slide.typographyTiers ?? []) {
      const refs = Array.isArray(tier.memberRefs) ? tier.memberRefs : [];
      if (new Set(refs).size !== refs.length || refs.length < 1) fail("E_FONT_INVENTORY", `${tier.id} typography members are not unique`);
      for (const ref of refs) {
        if (!textById.has(ref) || memberOwner.has(ref)) fail("E_FONT_INVENTORY", `${tier.id} typography member lineage is incomplete`);
        memberOwner.set(ref, tier.id);
      }
    }
    if (memberOwner.size !== textObjects.length) fail("E_FONT_INVENTORY", `${slide.id} typography tier membership is not bidirectional`);
    const measuredByTier = new Map();
    const reuseObjects = [];
    for (const object of textObjects) {
      if (object.type !== "text") continue;
      if (object.fontInventoryRef !== reference.path) fail("E_FONT_INVENTORY", `${object.id} font inventory path mismatch`);
      const selected = object.fontSolver?.selected;
      const face = faceById.get(selected?.faceId);
      if (!selected || !faceIds.has(selected.faceId) || !inventory.candidateFamilies.includes(selected.selectionFamily)
        || face?.family !== selected.family
        || face?.actualFamily !== selected.actualFamily
        || face?.selectionFamily !== selected.selectionFamily
        || !/^[0-9a-f]{64}$/iu.test(selected.faceDigest ?? "")
        || selected.faceDigest !== face?.pathDigest
        || !Number.isInteger(selected.weight)
        || selected.weight !== face?.os2WeightClass
        || selected.actualWeightClass !== face?.os2WeightClass
        || face?.weightSource !== "OS/2") {
        fail("E_FONT_INVENTORY", `${object.id} selected font face is not in inventory`);
      }
      if (Array.isArray(selected.missingGlyphs) && selected.missingGlyphs.length > 0) {
        fail("E_FONT_RUNTIME", `${object.id} selected font face is missing required glyphs`);
      }
      if (!Number.isInteger(selected.renderedLineCount) || selected.renderedLineCount < 1
        || !Array.isArray(selected.lineBreaks) || selected.lineBreaks.length !== selected.renderedLineCount
        || !Number.isFinite(Number(selected.textBoxWidthPx)) || Number(selected.textBoxWidthPx) <= 0) {
        fail("E_FONT_RUNTIME", `${object.id} rendered font layout evidence is inconsistent`);
      }
      const evidence = object.fontSolver ?? {};
      if (typeof evidence.tierEvidence !== "string" || typeof evidence.representativeReuse !== "boolean"
        || typeof evidence.representativeTierRef !== "string" || typeof evidence.representativeObjectId !== "string"
        || typeof evidence.alignmentProxy !== "string" || typeof evidence.alignmentSource !== "string"
        || typeof evidence.alignmentEvidence !== "string" || evidence.targetMetrics?.provenance !== "current-line-observation") {
        fail("E_FONT_RUNTIME", `${object.id} font evidence is incomplete`);
      }
      const layout = evidence.layout;
      const layoutLines = Array.isArray(layout?.lineBreaks) ? layout.lineBreaks : [];
      if (!layout || layout.provenance !== "selected-font-layout"
        || !Number.isInteger(layout.renderedLineCount) || layout.renderedLineCount < 1
        || layoutLines.length !== layout.renderedLineCount
        || !Number.isFinite(Number(layout.textBoxWidthPx)) || Number(layout.textBoxWidthPx) <= 0
        || !Number.isFinite(Number(layout.lineHeightPt)) || Number(layout.lineHeightPt) <= 0
        || Number(layout.lineHeightPt) !== Number(selected.lineHeightPt)
        || (object.style?.lineHeightPt !== undefined && Number(object.style.lineHeightPt) !== Number(layout.lineHeightPt))
        || (object.style?.textBoxWidthPx !== undefined && Number(object.style.textBoxWidthPx) !== Number(layout.textBoxWidthPx))
        || (object.style?.lineCount !== undefined && Number(object.style.lineCount) !== Number(layout.renderedLineCount))
        || (object.renderBox && Number(object.renderBox.h) + 2 < layout.renderedLineCount * Number(layout.lineHeightPt) * (Number(evidence.ptToPx) || 96 / 72))) {
        fail("E_FONT_RUNTIME", `${object.id} current font layout evidence is inconsistent`);
      }
      if (typeof object.text === "string") {
        const normalizeText = (value) => String(value).replace(/\s+/gu, "");
        if (normalizeText(layoutLines.join("")) !== normalizeText(object.text)) {
          fail("E_FONT_RUNTIME", `${object.id} layout line breaks do not preserve text`);
        }
      }
      if (evidence.representativeReuse) {
        if (evidence.evaluatedCandidates !== 0 || evidence.deferredReason !== "representative-reuse"
          || evidence.budget?.lineEvaluated !== 0 || evidence.selected?.metricProvenance !== "tier-representative"
          || evidence.selected?.metrics?.provenance !== "line-measurement"
          || evidence.evaluatedFamilies?.length !== 0 || evidence.evaluatedFaceIds?.length !== 0
          || evidence.evaluatedSizes?.length !== 0 || evidence.evaluatedRequestedWeights?.length !== 0
          || evidence.evaluatedSpacings?.length !== 0 || evidence.evaluatedLineHeights?.length !== 0
          || evidence.evaluatedTextBoxWidthScales?.length !== 0) {
          fail("E_FONT_RUNTIME", `${object.id} representative reuse evidence is invalid`);
        }
        if (evidence.representativeTierRef !== evidence.tier || evidence.representativeObjectId === object.id) {
          fail("E_FONT_RUNTIME", `${object.id} representative reference is invalid`);
        }
        reuseObjects.push(object);
      } else if (evidence.evaluatedCandidates < 1 || evidence.selected?.metricProvenance !== "line-measurement"
        || evidence.selected?.metrics?.provenance !== "line-measurement"
        || evidence.evaluatedFamilies?.length < 1 || evidence.evaluatedFaceIds?.length < 1
        || evidence.evaluatedSizes?.length < 1 || evidence.evaluatedRequestedWeights?.length < 1
        || evidence.evaluatedSpacings?.length < 1 || evidence.evaluatedLineHeights?.length < 1
        || evidence.evaluatedTextBoxWidthScales?.length < 1
        || evidence.representativeTierRef !== evidence.tier || evidence.representativeObjectId !== object.id) {
        fail("E_FONT_RUNTIME", `${object.id} measured font evidence is invalid`);
      } else {
        if (measuredByTier.has(evidence.tier)) fail("E_FONT_RUNTIME", `${object.id} duplicates measured tier representative`);
        measuredByTier.set(evidence.tier, object.id);
      }
      const tier = tiers.get(object.typographyTierRef);
      if (!tier || memberOwner.get(object.id) !== object.typographyTierRef || !tier.memberRefs.includes(object.id)
        || tier.name !== evidence.tier
        || tier.fontFamily !== object.style?.fontFamily
        || tier.fontFamily !== selected.family
        || tier.fontWeight !== selected.weight
        || (tier.faceId && tier.faceId !== selected.faceId)
        || object.style?.fontWeight !== selected.weight
        || (Number.isFinite(Number(selected.charSpacingPt)) && Number(object.style?.charSpacingPt) !== Number(selected.charSpacingPt))
        || Number(tier.baseFontSizePt) !== Number(selected.fontSizePt)
        || Number(object.style?.fontSizePt) !== Number(selected.fontSizePt)
        || Number(tier.lineHeightPt) !== Number(selected.lineHeightPt)
        || Number(object.style?.lineHeightPt) !== Number(selected.lineHeightPt)
        || Number(tier.textBoxWidthScale) !== Number(selected.textBoxWidthScale)
        || Number(object.style?.textBoxWidthScale) !== Number(selected.textBoxWidthScale)) {
        fail("E_FONT_INVENTORY", `${object.id} typography tier lineage is invalid`);
      }
    }
    for (const object of reuseObjects) {
      const evidence = object.fontSolver;
      const representative = textById.get(evidence.representativeObjectId);
      if (measuredByTier.get(evidence.tier) !== evidence.representativeObjectId || !representative
        || representative.fontSolver?.representativeReuse) {
        fail("E_FONT_RUNTIME", `${object.id} representative object does not resolve to measured tier member`);
      }
      const selected = object.fontSolver?.selected ?? {};
      const representativeSelected = representative.fontSolver?.selected ?? {};
      for (const key of [
        "family", "selectionFamily", "actualFamily", "faceId", "faceDigest", "fontSizePt",
        "requestedWeight", "weight", "actualWeightClass", "charSpacingPt", "lineHeightPt",
        "textBoxWidthScale", "textBoxWidthPx", "renderedLineCount", "lineBreaks", "score",
        "scoreDirection", "missingGlyphs", "metrics"
      ]) {
        if (JSON.stringify(selected[key]) !== JSON.stringify(representativeSelected[key])) {
          fail("E_FONT_RUNTIME", `${object.id} representative selected truth was altered`);
        }
      }
    }
    for (const tier of slide.typographyTiers ?? []) {
      if (!measuredByTier.has(tier.name)) fail("E_FONT_RUNTIME", `${tier.id} has no measured representative`);
    }
  }
  return inventory;
}

export function validateRenderSize(renderReport, analysis) {
  const requestedWidth = Number(analysis.deck?.size?.widthPx);
  const requestedHeight = Number(analysis.deck?.size?.heightPx);
  if (!Number.isInteger(requestedWidth) || !Number.isInteger(requestedHeight) || requestedWidth <= 0 || requestedHeight <= 0) {
    fail("E_CONTRACT", "analysis deck has no valid pixel dimensions");
  }
  if (renderReport.requestedSize?.width !== requestedWidth || renderReport.requestedSize?.height !== requestedHeight
      || renderReport.requestedSize?.unit !== "px") {
    fail("E_RENDER_SIZE_MISMATCH", "render report requested size does not match analysis deck");
  }
  return { width: requestedWidth, height: requestedHeight };
}

function local(root, path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path)) fail("E_CONTRACT", `${label} must be relative`);
  if (path.includes("\0") || path.split(/[\\/]+/u).includes("..")) fail("E_CONTRACT", `${label} contains traversal`);
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) fail("E_CONTRACT", `${label} escapes output`);
  return resolved;
}

function boxIntersection(left, right) {
  return Math.max(0, Math.min(Number(left.x) + Number(left.w), Number(right.x) + Number(right.w)) - Math.max(Number(left.x), Number(right.x)))
    * Math.max(0, Math.min(Number(left.y) + Number(left.h), Number(right.y) + Number(right.h)) - Math.max(Number(left.y), Number(right.y)));
}

function boxArea(box) {
  return Math.max(0, Number(box?.w ?? 0)) * Math.max(0, Number(box?.h ?? 0));
}

async function assetTextOverlap(asset, textBoxes, root = null) {
  const pageBox = asset?.pagePixelBox ?? {};
  const origin = asset?.originPagePixelBox ?? {};
  if (!(Number(origin.w) > 0) || !(Number(origin.h) > 0)) return { overlap: true, ratio: 1 };
  const fallback = Math.max(0, ...textBoxes.map((box) => boxIntersection(pageBox, box) / Math.max(1, Math.min(boxArea(pageBox), boxArea(box)))));
  if (!root || !textBoxes.length) return { overlap: fallback > 0, ratio: fallback };
  let mask;
  try {
    const maskPath = local(root, asset.mask, `${asset.objectId}.mask`);
    const bytes = await readFile(maskPath);
    if (await digest(maskPath) !== asset.maskDigest) return { overlap: fallback > 0, ratio: fallback };
    mask = decodeMaskAlpha(bytes, asset.mask);
    const origin = asset.originPagePixelBox ?? {};
    if (mask.width !== Math.max(1, Math.round(Number(origin.w)))
        || mask.height !== Math.max(1, Math.round(Number(origin.h)))) {
      return { overlap: fallback > 0, ratio: fallback };
    }
  } catch {
    return { overlap: fallback > 0, ratio: fallback };
  }
  const pageWidth = Number(pageBox.w);
  const pageHeight = Number(pageBox.h);
  if (!(pageWidth > 0) || !(pageHeight > 0)) return { overlap: false, ratio: 0 };
  let overlapArea = 0;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.alpha[y * mask.width + x] < 128) continue;
      const cell = {
        x: Number(pageBox.x) + x * pageWidth / mask.width,
        y: Number(pageBox.y) + y * pageHeight / mask.height,
        w: pageWidth / mask.width,
        h: pageHeight / mask.height
      };
      overlapArea += Math.max(...textBoxes.map((box) => boxIntersection(cell, box)), 0);
    }
  }
  const denominator = Math.max(1, Math.min(boxArea(pageBox), ...textBoxes.map(boxArea)));
  return { overlap: overlapArea > 0, ratio: overlapArea / denominator };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(digestCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${digestCanonical(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    if (Object.is(value, -0)) return "0";
    if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
    const text = String(value);
    if (/e/iu.test(text)) {
      const [mantissa, exponent] = text.toLowerCase().split("e");
      return `${mantissa}e${Number(exponent) >= 0 ? "+" : ""}${Number(exponent)}`;
    }
    return text;
  }
  return JSON.stringify(value);
}

export function reconstructionGeometryDigest(objects, assets) {
  const objectKeys = [
    "id", "type", "z", "pixelBox", "renderBox", "style", "color", "fill",
    "borderColor", "borderWidthPx", "fillOpacity", "transparency", "opacity",
    "rotation", "rotationDeg", "rotate", "flipH", "flipV", "sizing", "crop",
    "asset", "src", "path", "imageShape", "rounding", "text", "fontFamily",
    "fontSizePt", "fontWeight", "bold", "italic", "charSpacingPt", "lineHeightPt",
    "textBoxWidthPx", "lineCount", "paragraph", "paragraphs", "runs", "align",
    "verticalAlign", "margin", "shape", "gradient", "shadow", "line"
  ];
  const payload = {
    objects: [...objects].map((item) => Object.fromEntries(objectKeys.map((key) => [key, key === "id" ? String(item?.[key]) : key === "z" ? (item?.[key] ?? 0) : item?.[key] ?? null]))).sort((left, right) => left.id.localeCompare(right.id)),
    assets: [...assets].map((item) => Object.fromEntries(["objectId", "pagePixelBox", "originPagePixelBox", "asset", "mask", "assetDigest", "maskDigest", "sourceRef", "sourceDigest", "normalizedSourceDigest"].map((key) => [key, key === "objectId" ? String(item?.[key]) : item?.[key] ?? null]))).sort((left, right) => left.objectId.localeCompare(right.objectId))
  };
  return createHash("sha256").update(digestCanonical(payload)).digest("hex");
}

export async function reconstructionRepairSafety(slide, root = null) {
  const width = Number(slide?.sizePx?.width ?? slide?.sizePx?.widthPx ?? 0);
  const height = Number(slide?.sizePx?.height ?? slide?.sizePx?.heightPx ?? 0);
  const objects = slide?.objects ?? [];
  const assets = slide?.ownershipReport?.assets ?? [];
  const outOfBounds = [];
  const boxOf = (object) => object?.type === "text" ? (object?.renderBox ?? object?.pixelBox) : object?.pixelBox;
  for (const object of objects) {
    const box = boxOf(object);
    if (!box) continue;
    const left = Number(box.x); const top = Number(box.y);
    const right = left + Number(box.w); const bottom = top + Number(box.h);
    if (left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) outOfBounds.push(String(object.id));
  }
  const textBoxes = objects.filter((object) => object?.type === "text" && Number(object.confidence ?? 0) >= 0.7).map(boxOf).filter(Boolean);
  const ownership = slide?.ownershipReport ?? {};
  const overlapRefs = [];
  for (const asset of assets) {
    const pageBox = asset.pagePixelBox ?? {};
    const originBox = asset.originPagePixelBox ?? {};
    const baseline = ["x", "y", "w", "h"].every((key) => Math.abs(Number(pageBox[key]) - Number(originBox[key])) <= 1e-9);
    if (baseline && Number(ownership.rasterNativeOverlapPixels ?? 0) === 0) continue;
    if ((await assetTextOverlap(asset, textBoxes, root)).overlap) overlapRefs.push(String(asset.objectId));
  }
  const ownershipConflict = ownership.status === "failed"
    || Number(ownership.conflictPixels ?? 0) > 0
    || Number(ownership.rasterNativeOverlapPixels ?? 0) > 0
    || Number(ownership.duplicateVisibleContent ?? 0) > 0
    || Number(ownership.unassignedShare ?? 0) > Number(ownership.unassignedBudget ?? 0);
  const winnerRefs = (slide?.reconstructionPlan?.regions ?? []).flatMap((region) => region.assignedObjectRefs ?? []);
  const duplicateRouteClaims = [...new Set(winnerRefs.filter((ref, index) => winnerRefs.indexOf(ref) !== index).map(String))].sort();
  const failures = [...new Set([...outOfBounds, ...overlapRefs, ...duplicateRouteClaims])];
  return {
    status: !failures.length && !ownershipConflict ? "passed" : "failed",
    outOfBoundsObjectRefs: [...new Set(outOfBounds)].sort(),
    rasterNativeOverlapObjectRefs: [...new Set(overlapRefs)].sort(),
    duplicateRouteClaims,
    ownershipConflict: Boolean(ownershipConflict),
    checkedObjectCount: objects.length,
    checkedAssetCount: assets.length
  };
}

export function assertReconstructionPlanLineage(analysisRef, ...references) {
  if (!analysisRef || typeof analysisRef !== "object") {
    fail("E_RECONSTRUCTION_PLAN", "analysis reconstruction plan reference is missing");
  }
  for (const [index, reference] of references.entries()) {
    if (!reference || canonical(reference) !== canonical(analysisRef)) {
      fail("E_RECONSTRUCTION_PLAN", `reconstruction plan lineage mismatch at reference ${index + 1}`);
    }
  }
}

function measured(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function repairMetricSnapshot(region) {
  if (!region) return null;
  const measuredOrNull = (value) => measured(value) ? value : null;
  return {
    regionId: String(region.id),
    measurement: region.measurement ?? "source-render-crop",
    metricStatus: region.metricStatus ?? {},
    impactStatus: region.impactStatus ?? {},
    impact: measuredOrNull(region.impact),
    regionSSIM: measuredOrNull(region.regionSSIM),
    ocrCER: measuredOrNull(region.ocrCER),
    bboxIoU: measuredOrNull(region.bboxIoU),
    normalizedMAE: measuredOrNull(region.normalizedMAE),
    paletteDeltaE2000P95: measuredOrNull(region.paletteDeltaE2000P95),
    sourceCropDigest: typeof region.sourceCropDigest === "string" ? region.sourceCropDigest : null,
    renderCropDigest: typeof region.renderCropDigest === "string" ? region.renderCropDigest : null
  };
}

function repairMetricDelta(before, after) {
  const delta = {};
  for (const name of ["regionSSIM", "ocrCER", "bboxIoU", "normalizedMAE", "paletteDeltaE2000P95"]) {
    if (measured(before?.[name]) && measured(after?.[name])) delta[name] = Number((after[name] - before[name]).toFixed(8));
  }
  return delta;
}

function hardVisualNoRegression(before, after, beforeEditability, afterEditability) {
  if (Boolean(before?.thresholds) !== Boolean(after?.thresholds)
      || Boolean(before?.ssim) !== Boolean(after?.ssim)) return false;
  if (before?.thresholds && after?.thresholds && canonical(before.thresholds) !== canonical(after.thresholds)) return false;
  if (before?.ssim && after?.ssim && canonical(before.ssim) !== canonical(after.ssim)) return false;
  for (const name of ["ssim", "bboxIou", "nativeHighConfidenceTextRecall"]) {
    if (measured(before?.aggregate?.[name]) && (!measured(after?.aggregate?.[name]) || after.aggregate[name] + 1e-9 < before.aggregate[name])) return false;
  }
  for (const name of ["ocrCer", "paletteDeltaE2000P95"]) {
    if (measured(before?.aggregate?.[name]) && (!measured(after?.aggregate?.[name]) || after.aggregate[name] - 1e-9 > before.aggregate[name])) return false;
  }
  if (measured(beforeEditability?.rasterAreaShare)
      && (!measured(afterEditability?.rasterAreaShare) || afterEditability.rasterAreaShare - 1e-9 > beforeEditability.rasterAreaShare)) return false;
  if (measured(beforeEditability?.level) && measured(afterEditability?.level) && afterEditability.level < beforeEditability.level) return false;
  if (measured(beforeEditability?.wholeSlideRasterCount) && measured(afterEditability?.wholeSlideRasterCount)
      && afterEditability.wholeSlideRasterCount > beforeEditability.wholeSlideRasterCount) return false;
  return true;
}

function repairLocalImprovement(beforeVisual, afterVisual, regionIds) {
  const keyOf = (slideId, regionId) => `${String(slideId)}\u0000${String(regionId)}`;
  const before = new Map((beforeVisual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [keyOf(slide.slideId, item.id), item])));
  const after = new Map((afterVisual?.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((item) => [keyOf(slide.slideId, item.id), item])));
  let local = false;
  for (const regionId of regionIds) {
    const left = before.get(String(regionId));
    const right = after.get(String(regionId));
    if (!left || !right) continue;
    const improvements = [];
    if (measured(left.regionSSIM) && measured(right.regionSSIM)) improvements.push(right.regionSSIM - left.regionSSIM);
    if (measured(left.ocrCER) && measured(right.ocrCER)) improvements.push(left.ocrCER - right.ocrCER);
    if (measured(left.bboxIoU) && measured(right.bboxIoU)) improvements.push(right.bboxIoU - left.bboxIoU);
    if (measured(left.normalizedMAE) && measured(right.normalizedMAE)) improvements.push(left.normalizedMAE - right.normalizedMAE);
    if (measured(left.paletteDeltaE2000P95) && measured(right.paletteDeltaE2000P95)) improvements.push(left.paletteDeltaE2000P95 - right.paletteDeltaE2000P95);
    if (improvements.some((value) => value >= 0.005)) local = true;
  }
  const beforeAggregate = beforeVisual?.aggregate ?? {};
  const afterAggregate = afterVisual?.aggregate ?? {};
  const aggregate = [
    Number(afterAggregate.ssim) - Number(beforeAggregate.ssim),
    Number(beforeAggregate.ocrCer) - Number(afterAggregate.ocrCer),
    Number(afterAggregate.bboxIou) - Number(beforeAggregate.bboxIou),
    Number(beforeAggregate.paletteDeltaE2000P95) - Number(afterAggregate.paletteDeltaE2000P95),
    Number(afterAggregate.nativeHighConfidenceTextRecall) - Number(beforeAggregate.nativeHighConfidenceTextRecall)
  ].filter(Number.isFinite);
  return local && aggregate.some((value) => value >= 0.005);
}

export async function validateReconstructionPlanRef(root, reference, label = "reconstruction plan") {
  if (!reference || typeof reference !== "object") fail("E_RECONSTRUCTION_PLAN", `${label} reference is missing`);
  const reportPath = local(root, reference.path, `${label}.path`);
  await readable(reportPath, label);
  if (await digest(reportPath) !== reference.sha256) fail("E_RECONSTRUCTION_PLAN", `${label} digest mismatch`);
  return reportPath;
}

const RECONSTRUCTION_ROUTE_PRIORITY = {
  "native-all": 0,
  "native-plus-local-assets": 1,
  "bounded-raster": 2
};
const RECONSTRUCTION_GATE_IDS = [
  "ownership-conflict",
  "unassigned-pixel-budget",
  "route-object-coverage",
  "hybrid-asset-present",
  "bounded-asset-present",
  "near-whole-slide-raster",
  "large-region-raster",
  "raster-high-confidence-text-overlap",
  "native-image-decomposition",
  "observed-content-only",
  "structured-content-traceability",
  "asset-provenance"
];
const RECONSTRUCTION_PAGE_GATE_IDS = [
  "region-ownership-unique",
  "page-object-coverage",
  "page-asset-coverage",
  "selected-object-coverage",
  "selected-asset-coverage"
];
const RECONSTRUCTION_PROVENANCE_STATUS = "observed-or-recognized-source-bound";
const RECONSTRUCTION_LOSS_VERSION = "1.0.0";
const RECONSTRUCTION_LOSS_WEIGHTS = Object.freeze({
  visualMismatch: 4,
  ocrCer: 3,
  bboxIoU: 2,
  normalizedMAE: 1.5,
  rasterAreaShare: 1,
  objectComplexity: 0.5,
  overlapPenalty: 1,
  provenancePenalty: 1
});
const RECONSTRUCTION_REGION_RASTER_MAX_SHARE = 0.35;
const RECONSTRUCTION_NEAR_WHOLE_RASTER_SHARE = 0.65;

function reconstructionLossTotal(loss) {
  const values = loss?.values ?? {};
  const weights = loss?.weights ?? {};
  return [
    ["visualMismatch", Number(values.visualMismatch)],
    ["ocrCer", Number(values.ocrCer)],
    ["bboxIoU", Math.max(0, 1 - Number(values.bboxIoU))],
    ["normalizedMAE", Number(values.normalizedMAE)],
    ["rasterAreaShare", Number(values.rasterAreaShare)],
    ["objectComplexity", Number(values.objectComplexity)],
    ["overlapPenalty", Number(values.overlapPenalty)],
    ["provenancePenalty", Number(values.provenancePenalty)]
  ].reduce((sum, [key, value]) => sum + Number(weights[key]) * value, 0);
}

function reconstructionExpected(strategy, profile, objects, assets, pageArea) {
  const role = String(profile?.role ?? "decor");
  const complexity = Math.min(1, Math.max(0, Number(profile?.complexity?.score ?? 0)));
  const hasText = objects.some((object) => object?.type === "text");
  const imageOnly = role === "image" && !hasText;
  let ssim;
  let cer;
  let bbox;
  let mae;
  if (strategy === "native-all") {
    ssim = assets.length ? 0.72 : 0.94 - 0.10 * complexity;
    cer = 0;
    bbox = 0.96;
    mae = 0.04 + 0.06 * complexity;
  } else if (strategy === "native-plus-local-assets") {
    ssim = imageOnly ? 0.74 : 0.91 - 0.04 * complexity;
    cer = 0;
    bbox = 0.95;
    mae = 0.05 + 0.04 * complexity;
  } else {
    ssim = imageOnly ? 0.90 : 0.78;
    cer = hasText ? 1 : 0;
    bbox = 0.90;
    mae = 0.08;
  }
  const values = {
    visualMismatch: Number(Math.max(0, 1 - ssim).toFixed(6)),
    ocrCer: Number(cer.toFixed(6)),
    bboxIoU: Number(bbox.toFixed(6)),
    normalizedMAE: Number(mae.toFixed(6)),
    rasterAreaShare: Number((assets.reduce((sum, asset) => sum + Number(asset?.pagePixelBox?.w ?? 0) * Number(asset?.pagePixelBox?.h ?? 0), 0) / Math.max(1, pageArea)).toFixed(6)),
    objectComplexity: Number(complexity.toFixed(6)),
    overlapPenalty: 0,
    provenancePenalty: 0
  };
  const lossBreakdown = {
    version: RECONSTRUCTION_LOSS_VERSION,
    estimatedFrom: "analysis",
    values,
    weights: RECONSTRUCTION_LOSS_WEIGHTS,
    total: Number(reconstructionLossTotal({ values, weights: RECONSTRUCTION_LOSS_WEIGHTS }).toFixed(8))
  };
  const rasterObjectCount = strategy === "native-all" ? 0 : assets.length;
  return {
    lossBreakdown,
    values,
    total: lossBreakdown.total,
    metrics: {
      estimatedFrom: "analysis",
      regionSSIM: Number((1 - values.visualMismatch).toFixed(6)),
      ocrCER: values.ocrCer,
      bboxIoU: values.bboxIoU,
      normalizedMAE: values.normalizedMAE
    },
    editability: strategy === "native-all"
      ? { level: 5, mode: "fully-native", rasterObjectCount }
      : strategy === "native-plus-local-assets"
        ? { level: 4, mode: "native-plus-transparent-local-assets", rasterObjectCount }
        : { level: 2, mode: "bounded-transparent-local-asset", rasterObjectCount }
  };
}

export async function validateReconstructionPlan(root, analysis) {
  const reference = analysis?.reconstructionPlanRef;
  const reportPath = await validateReconstructionPlanRef(root, reference, "reconstruction plan report");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    fail("E_RECONSTRUCTION_PLAN", `reconstruction plan report is invalid JSON: ${error.message}`);
  }
  if (canonical(report) !== canonical(analysis.reconstructionPlan)) {
    fail("E_RECONSTRUCTION_PLAN", "analysis reconstruction plan differs from independent report");
  }
  if (!Array.isArray(report.pages) || report.pages.length !== analysis.slides.length) {
    fail("E_RECONSTRUCTION_PLAN", "reconstruction plan page count mismatch");
  }
  const sourceIds = new Set((analysis.sources ?? []).map((source) => String(source.id)));
  const expectedReportProvenance = {
    sourceRefs: [...sourceIds].sort(),
    planner: "deterministic-region-candidate-selector"
  };
  if (canonical(report.provenance) !== canonical(expectedReportProvenance)) {
    fail("E_RECONSTRUCTION_PLAN", "reconstruction plan report provenance is not source-complete or planner-bound");
  }
  for (const [index, slide] of analysis.slides.entries()) {
    const page = slide.reconstructionPlan;
    const reportPage = report.pages[index];
    if (!page || canonical(page) !== canonical(reportPage) || page.slideId !== slide.id) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} reconstruction plan lineage mismatch`);
    }
    const objectById = new Map((slide.objects ?? []).map((object) => [String(object.id), object]));
    const assetById = new Map((slide.ownershipReport?.assets ?? []).map((asset) => [String(asset.objectId), asset]));
    const sourceById = new Map((analysis.sources ?? []).map((source) => [String(source.id), source]));
    const pageSourceRefs = new Set([String(slide.sourceRef)]);
    for (const object of slide.objects ?? []) if (sourceIds.has(String(object.sourceRef))) pageSourceRefs.add(String(object.sourceRef));
    for (const asset of slide.ownershipReport?.assets ?? []) if (sourceIds.has(String(asset.sourceRef))) pageSourceRefs.add(String(asset.sourceRef));
    const expectedPageProvenance = {
      sourceRefs: [...pageSourceRefs].sort(),
      sourceDigests: [...new Set([...pageSourceRefs].map((ref) => String(sourceById.get(ref)?.normalizedSha256 || sourceById.get(ref)?.sha256 || "")))].sort(),
      ownershipVersion: slide.ownershipReport?.version ?? "1.0.0"
    };
    if (canonical(page.provenance) !== canonical(expectedPageProvenance)) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} page provenance is not independently source-bound`);
    }
    const expectedLossConfig = {
      version: RECONSTRUCTION_LOSS_VERSION,
      weights: RECONSTRUCTION_LOSS_WEIGHTS,
      estimatedFrom: "analysis",
      regionRasterMaxShare: RECONSTRUCTION_REGION_RASTER_MAX_SHARE,
      nearWholeRasterShare: RECONSTRUCTION_NEAR_WHOLE_RASTER_SHARE
    };
    if (canonical(page.lossConfig) !== canonical(expectedLossConfig)) fail("E_RECONSTRUCTION_PLAN", `${slide.id} lossConfig is not the versioned deterministic configuration`);
    if (canonical(page.repairSafety) !== canonical(await reconstructionRepairSafety(slide, root))) {
      fail("E_RECONSTRUCTION_OWNERSHIP", `${slide.id} repair safety evidence does not match current geometry/ownership`);
    }
    if (page.repairSafety.status !== "passed") {
      fail("E_RECONSTRUCTION_OWNERSHIP", `${slide.id} repair safety gate failed`);
    }
    const pageTextBoxes = (slide.objects ?? [])
      .filter((object) => object?.type === "text" && Number(object.confidence ?? 0) >= 0.7)
      .map((object) => object?.renderBox ?? object?.pixelBox)
      .filter(Boolean);
    const assetOverlapById = new Map();
    for (const asset of slide.ownershipReport?.assets ?? []) {
      const pageBox = asset.pagePixelBox ?? {};
      const originBox = asset.originPagePixelBox ?? {};
      const baseline = ["x", "y", "w", "h"].every((key) => Math.abs(Number(pageBox[key]) - Number(originBox[key])) <= 1e-9);
      assetOverlapById.set(String(asset.objectId), baseline && Number(slide.ownershipReport?.rasterNativeOverlapPixels ?? 0) === 0
        ? { overlap: false, ratio: 0 }
        : await assetTextOverlap(asset, pageTextBoxes, root));
    }
    const selectedObjects = (page.selectedObjectRefs ?? []).map(String);
    const selectedAssets = (page.selectedAssetRefs ?? []).map(String);
    if (new Set(selectedObjects).size !== selectedObjects.length || new Set(selectedAssets).size !== selectedAssets.length) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} selected object or asset refs are not unique`);
    }
    const winnerObjects = [];
    const winnerAssets = [];
    const regionIds = new Set();
    const profileById = new Map((slide.regionProfiles ?? []).map((profile) => [String(profile.id), profile]));
    for (const [regionId, strategy] of Object.entries(page.routeOverrides ?? {})) {
      if (!profileById.has(String(regionId)) || !Object.prototype.hasOwnProperty.call(RECONSTRUCTION_ROUTE_PRIORITY, strategy)) {
        fail("E_RECONSTRUCTION_ROUTE", `${slide.id} route override references an unknown region or route`);
      }
    }
    const roleRank = { title: 0, "text-block": 1, "card-or-native-group": 2, image: 3, chart: 4, table: 5, background: 6, decor: 7 };
    const profilesByObject = new Map();
    for (const profile of slide.regionProfiles ?? []) {
      for (const ref of profile.objectRefs ?? []) {
        const key = String(ref);
        const records = profilesByObject.get(key) ?? [];
        records.push(profile);
        profilesByObject.set(key, records);
      }
    }
    const assignment = new Map();
    for (const [ref, profiles] of profilesByObject.entries()) {
      const ranked = profiles.slice().sort((left, right) => {
        const area = (profile) => Math.max(0, Number(profile.pixelBox?.w ?? 0)) * Math.max(0, Number(profile.pixelBox?.h ?? 0));
        return area(left) - area(right)
          || (roleRank[String(left.role ?? "decor")] ?? 99) - (roleRank[String(right.role ?? "decor")] ?? 99)
          || String(left.id).localeCompare(String(right.id));
      });
      if (ranked.length) assignment.set(ref, String(ranked[0].id));
    }
    if ((page.regions ?? []).length !== profileById.size) fail("E_RECONSTRUCTION_PLAN", `${slide.id} reconstruction regions do not match regionProfiles`);
    for (const region of page.regions ?? []) {
      if (regionIds.has(region.id)) fail("E_RECONSTRUCTION_PLAN", `${slide.id} duplicate reconstruction region ${region.id}`);
      regionIds.add(region.id);
      const profile = profileById.get(String(region.id));
      if (!profile || canonical(region.pixelBox) !== canonical(profile.pixelBox)) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} pixelBox does not match regionProfile`);
      const assignedObjects = (region.assignedObjectRefs ?? []).map(String);
      const assignedAssets = (region.assignedAssetRefs ?? []).map(String);
      if (profile && region.role !== profile.role) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} role does not match regionProfile`);
      if (new Set(assignedObjects).size !== assignedObjects.length || new Set(assignedAssets).size !== assignedAssets.length) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} assigned refs are not unique`);
      const expectedAssignedObjects = (profile?.objectRefs ?? []).map(String).filter((ref) => assignment.get(ref) === String(region.id)).sort();
      if (canonical([...assignedObjects].sort()) !== canonical(expectedAssignedObjects)) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} assigned objects differ from deterministic ownership assignment`);
      const expectedUnassignedObjects = [...new Set((profile?.objectRefs ?? []).map(String))].filter((ref) => !expectedAssignedObjects.includes(ref)).sort();
      if (canonical([...(region.unassignedObjectRefs ?? [])].map(String).sort()) !== canonical(expectedUnassignedObjects)) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} unassigned objects differ from deterministic ownership assignment`);
      const expectedAssignedAssets = expectedAssignedObjects.filter((ref) => assetById.has(ref)).sort();
      if (canonical([...assignedAssets].sort()) !== canonical(expectedAssignedAssets)) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} assigned assets differ from ownership assets`);
      const assignedObjectRecords = assignedObjects.map((ref) => objectById.get(ref));
      const assignedAssetRecords = assignedAssets.map((ref) => assetById.get(ref));
      if (assignedObjectRecords.some((object) => !object) || assignedAssetRecords.some((asset) => !asset)) {
        fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} assigned refs do not resolve to analysis records`);
      }
      const candidates = Array.isArray(region.candidates) ? region.candidates : [];
      if (candidates.length !== 3) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} must have exactly three candidates`);
      const byStrategy = new Map(candidates.map((candidate) => [candidate.strategy, candidate]));
      if (byStrategy.size !== 3 || new Set(candidates.map((candidate) => String(candidate.id))).size !== 3) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} candidate strategy/id values are not unique`);
      for (const strategy of Object.keys(RECONSTRUCTION_ROUTE_PRIORITY)) {
        if (!byStrategy.has(strategy)) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} is missing ${strategy} candidate`);
      }
      for (const candidate of candidates) {
        if (!Array.isArray(candidate.objectRefs) || !Array.isArray(candidate.assetRefs)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} refs are incomplete`);
        if (new Set(candidate.objectRefs.map(String)).size !== candidate.objectRefs.length
            || new Set(candidate.assetRefs.map(String)).size !== candidate.assetRefs.length) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} contains duplicate refs`);
        }
        if (String(candidate.id) !== `${region.id}-${candidate.strategy}`) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} is not the stable id for its region and strategy`);
        if (canonical(candidate.pixelBox) !== canonical(region.pixelBox)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} pixelBox does not match its region`);
        const zValues = assignedObjectRecords.map((object) => Number(object?.z)).filter(Number.isInteger);
        const expectedZRange = { min: zValues.length ? Math.min(...zValues) : 0, max: zValues.length ? Math.max(...zValues) : 0 };
        if (canonical(candidate.zRange) !== canonical(expectedZRange)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} zRange does not match assigned object order`);
        if (candidate.geometryDigest !== reconstructionGeometryDigest(assignedObjectRecords, assignedAssetRecords)) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} geometry digest does not match current object/asset geometry`);
        }
        const expectedMetrics = reconstructionExpected(candidate.strategy, profile, assignedObjectRecords, assignedAssetRecords, Number(slide.sizePx?.width) * Number(slide.sizePx?.height));
        if (canonical(candidate.lossBreakdown) !== canonical(expectedMetrics.lossBreakdown)
            || canonical(candidate.metrics) !== canonical(expectedMetrics.metrics)
            || canonical(candidate.editability) !== canonical(expectedMetrics.editability)) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} metrics, editability, or deterministic loss was altered`);
        }
        if (canonical([...candidate.objectRefs].map(String).sort()) !== canonical([...assignedObjects].sort())) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} objectRefs do not preserve assigned objects`);
        if (canonical([...candidate.assetRefs].map(String).sort()) !== canonical([...assignedAssets].sort())) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} assetRefs do not preserve assigned assets`);
        const candidateGateIds = (candidate.gateResults ?? []).map((gate) => String(gate.id));
        if (candidateGateIds.length !== RECONSTRUCTION_GATE_IDS.length
            || new Set(candidateGateIds).size !== candidateGateIds.length
            || canonical(candidateGateIds) !== canonical(RECONSTRUCTION_GATE_IDS)
            || (candidate.gateResults ?? []).some((gate) => gate.blocking !== true)) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} gate universe is incomplete, duplicated, reordered, or non-blocking`);
        }
        const ownership = slide.ownershipReport ?? {};
        const expectedOwnership = ownership.status !== "failed"
          && Number(ownership.conflictPixels ?? 0) === 0
          && Number(ownership.rasterNativeOverlapPixels ?? 0) === 0
          && Number(ownership.duplicateVisibleContent ?? 0) === 0;
        const expectedUnassigned = Number(ownership.unassignedShare ?? 0) <= Number(ownership.unassignedBudget ?? 0);
        const gateMap = new Map((candidate.gateResults ?? []).map((gate) => [String(gate.id), gate]));
        if (gateMap.get("ownership-conflict")?.passed !== expectedOwnership || gateMap.get("unassigned-pixel-budget")?.passed !== expectedUnassigned) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} ownership gate result is inconsistent with the report`);
        }
        const unboundObjects = assignedObjectRecords.filter((object) => !["provided", "observed", "recognized"].includes(String(object?.factStatus ?? "unknown")));
        if (gateMap.get("observed-content-only")?.passed !== (unboundObjects.length === 0)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} invented-content gate result is inconsistent`);
        const structured = assignedObjectRecords.filter((object) => ["chart", "table"].includes(object?.type));
        const structuredTraceable = structured.every((object) => Boolean(object && object.sourceData && object.sourceRef && object.sourceSha256));
        if (gateMap.get("structured-content-traceability")?.passed !== structuredTraceable) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} structured-content gate result is inconsistent`);
        const candidateAssets = assignedAssetRecords.filter(Boolean);
        const boundedBinding = candidateAssets.length > 0
          && assignedObjectRecords.every((object) => object?.type === "image")
          && candidateAssets.length === assignedObjectRecords.length
          && new Set(candidateAssets.map((asset) => String(asset.objectId))).size === assignedObjectRecords.length
          && new Set(candidateAssets.map((asset) => String(asset.objectId))).size === new Set(assignedObjects).size;
        if (gateMap.get("route-object-coverage")?.passed !== (candidate.objectRefs.length === assignedObjects.length && canonical([...candidate.objectRefs].map(String).sort()) === canonical([...assignedObjects].sort()) && (candidate.strategy !== "bounded-raster" || boundedBinding))) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} route-object-coverage gate result is inconsistent`);
        if (gateMap.get("hybrid-asset-present")?.passed !== (candidate.strategy !== "native-plus-local-assets" || assignedAssets.length > 0)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} hybrid asset gate result is inconsistent`);
        if (gateMap.get("bounded-asset-present")?.passed !== (candidate.strategy !== "bounded-raster" || boundedBinding)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} bounded asset gate result is inconsistent`);
        const assetShare = candidateAssets.reduce((sum, asset) => sum + Number(asset.pagePixelBox?.w ?? 0) * Number(asset.pagePixelBox?.h ?? 0), 0)
            / Math.max(1, Number(slide.sizePx?.width) * Number(slide.sizePx?.height));
        if (gateMap.get("near-whole-slide-raster")?.passed !== (assetShare < Number(page.lossConfig?.nearWholeRasterShare))) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} near-whole gate result is inconsistent`);
        if (gateMap.get("large-region-raster")?.passed !== (assetShare <= Number(page.lossConfig?.regionRasterMaxShare))) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} large-region gate result is inconsistent`);
        const overlap = Math.max(...candidateAssets.map((asset) => assetOverlapById.get(String(asset.objectId))?.ratio ?? 0), 0);
        if (gateMap.get("raster-high-confidence-text-overlap")?.passed !== (overlap === 0)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} raster/text overlap gate result is inconsistent`);
        if (gateMap.get("native-image-decomposition")?.passed !== (candidate.strategy !== "native-all" || assignedAssets.length === 0)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} native-image decomposition gate result is inconsistent`);
        for (const ref of candidate.objectRefs) if (!objectById.has(String(ref))) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} references missing object ${ref}`);
        for (const ref of candidate.assetRefs) {
          const asset = assetById.get(String(ref));
          if (!asset) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} references missing asset ${ref}`);
          const assetPath = local(root, asset.asset, `${candidate.id}.asset`);
          const maskPath = local(root, asset.mask, `${candidate.id}.mask`);
          await readable(assetPath, `${candidate.id}.asset`);
          await readable(maskPath, `${candidate.id}.mask`);
          if (await digest(assetPath) !== asset.assetDigest || await digest(maskPath) !== asset.maskDigest) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} asset provenance digest mismatch`);
          if (!sourceIds.has(String(asset.sourceRef))) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} asset source is unbound`);
          const source = sourceById.get(String(asset.sourceRef));
          if (source?.normalizedSha256 && (asset.sourceDigest !== asset.normalizedSourceDigest || asset.normalizedSourceDigest !== source.normalizedSha256)) {
            fail("E_RECONSTRUCTION_PLAN", `${candidate.id} asset source digest is inconsistent`);
          }
        }
        const assetProvenanceExpected = assignedAssetRecords.length === assignedAssets.length
          && assignedAssetRecords.every((asset) => asset && sourceIds.has(String(asset.sourceRef))
            && /^[0-9a-f]{64}$/iu.test(String(asset.assetDigest ?? ""))
            && /^[0-9a-f]{64}$/iu.test(String(asset.maskDigest ?? "")));
        if (gateMap.get("asset-provenance")?.passed !== assetProvenanceExpected) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} asset-provenance gate result is inconsistent`);
        const expectedSourceRefs = [...new Set([
          String(slide.sourceRef),
          ...assignedObjectRecords.map((object) => String(object?.sourceRef ?? "")).filter((ref) => pageSourceRefs.has(ref)),
          ...assignedAssetRecords.map((asset) => String(asset?.sourceRef ?? "")).filter((ref) => pageSourceRefs.has(ref))
        ])].sort();
        const expectedSourceDigests = [...new Set(expectedSourceRefs.map((ref) => String(sourceById.get(ref)?.normalizedSha256 ?? sourceById.get(ref)?.sha256 ?? "")).filter((value) => /^[0-9a-f]{64}$/iu.test(value)))].sort();
        const expectedAssetDigests = assignedAssetRecords.map((asset) => String(asset?.assetDigest ?? "")).filter((value) => /^[0-9a-f]{64}$/iu.test(value)).sort();
        const provenance = candidate.provenance ?? {};
        if (provenance.status !== RECONSTRUCTION_PROVENANCE_STATUS) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} provenance status is not the required source-bound status`);
        }
        if (canonical([...new Set((provenance.sourceRefs ?? []).map(String))].sort()) !== canonical(expectedSourceRefs)
            || canonical([...new Set((provenance.sourceDigests ?? []).map(String))].sort()) !== canonical(expectedSourceDigests)
            || canonical([...new Set((provenance.assetDigests ?? []).map(String))].sort()) !== canonical(expectedAssetDigests)) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} provenance lineage is incomplete or fabricated`);
        }
        for (const sourceRef of candidate.provenance?.sourceRefs ?? []) if (!sourceIds.has(String(sourceRef))) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} provenance source is unbound`);
        for (const mask of candidate.maskRefs ?? []) {
          const maskPath = local(root, mask.path, `${candidate.id}.maskRef`);
          await readable(maskPath, `${candidate.id}.maskRef`);
          if (await digest(maskPath) !== mask.digest) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} mask reference digest mismatch`);
        }
        const expectedClasses = [...new Set([
          ...assignedObjectRecords.map((object) => object?.type === "image" ? "raster_asset" : object?.type === "text" ? "native_text" : "native_shape"),
          ...(assignedAssets.length ? ["raster_asset"] : [])
        ])].sort();
        if (canonical([...(candidate.ownershipClasses ?? [])].map(String).sort()) !== canonical(expectedClasses)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} ownership classes do not match assigned refs`);
        const expectedMasks = expectedClasses.map((className) => {
          const record = slide.ownershipReport?.classes?.[className];
          return record ? { class: className, path: record.path, digest: record.maskDigest } : null;
        }).filter(Boolean);
        if (canonical([...(candidate.maskRefs ?? [])].sort((left, right) => String(left.class).localeCompare(String(right.class)))) !== canonical(expectedMasks)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} mask refs do not match ownership classes`);
        const blockingFailures = (candidate.gateResults ?? []).filter((gate) => gate.blocking && !gate.passed);
        const computedLoss = reconstructionLossTotal(expectedMetrics.lossBreakdown);
        if (!Number.isFinite(computedLoss) || Math.abs(computedLoss - expectedMetrics.lossBreakdown.total) > 1e-8
            || Number(candidate.lossBreakdown?.total) !== expectedMetrics.lossBreakdown.total) {
          fail("E_RECONSTRUCTION_PLAN", `${candidate.id} deterministic loss mismatch`);
        }
        if (candidate.eligible !== (blockingFailures.length === 0)) fail("E_RECONSTRUCTION_PLAN", `${candidate.id} gate eligibility mismatch`);
      }
      const winner = candidates.find((candidate) => candidate.id === region.winnerId);
      if (!winner || !winner.eligible) fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} winner is not an eligible candidate`);
      const eligible = candidates.filter((candidate) => candidate.eligible);
      eligible.sort((left, right) => {
        const loss = Number(left.lossBreakdown.total) - Number(right.lossBreakdown.total);
        if (Math.abs(loss) > 1e-8) return loss;
        const editability = Number(right.editability.level) - Number(left.editability.level);
        if (editability !== 0) return editability;
        const route = RECONSTRUCTION_ROUTE_PRIORITY[left.strategy] - RECONSTRUCTION_ROUTE_PRIORITY[right.strategy];
        return route || String(left.id).localeCompare(String(right.id));
      });
      const requestedStrategy = page.routeOverrides?.[String(region.id)];
      if (requestedStrategy) {
        const requested = candidates.find((candidate) => candidate.strategy === requestedStrategy);
        if (!requested || !requested.eligible || winner.id !== requested.id) {
          fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} route override is not an eligible selected candidate`);
        }
      } else if (eligible[0]?.id !== winner.id) {
        fail("E_RECONSTRUCTION_PLAN", `${slide.id}/${region.id} winner violates deterministic tie-break`);
      }
      winnerObjects.push(...winner.objectRefs.map(String));
      winnerAssets.push(...winner.assetRefs.map(String));
    }
    if (new Set(winnerObjects).size !== winnerObjects.length || new Set(winnerAssets).size !== winnerAssets.length) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} winner ownership is duplicated`);
    }
    if (canonical([...new Set(winnerObjects)].sort()) !== canonical([...selectedObjects].sort())
        || canonical([...new Set(winnerAssets)].sort()) !== canonical([...selectedAssets].sort())) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} selected refs do not match winner coverage`);
    }
    if (selectedObjects.length !== objectById.size || selectedObjects.some((ref) => !objectById.has(ref))) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} reconstruction plan does not cover every renderable object`);
    }
    const selectedObjectSet = [...new Set(winnerObjects)].sort();
    const selectedAssetSet = [...new Set(winnerAssets)].sort();
    const duplicateObjectRefs = [...new Set(winnerObjects.filter((ref, offset) => winnerObjects.indexOf(ref) !== offset))].sort();
    const duplicateAssetRefs = [...new Set(winnerAssets.filter((ref, offset) => winnerAssets.indexOf(ref) !== offset))].sort();
    const assignedObjectRefs = [...new Set((page.regions ?? []).flatMap((region) => (region.assignedObjectRefs ?? []).map(String)))].sort();
    const assignedAssetRefs = [...new Set((page.regions ?? []).flatMap((region) => (region.assignedAssetRefs ?? []).map(String)))].sort();
    const unassignedObjectRefs = [...objectById.keys()].filter((ref) => !assignedObjectRefs.includes(ref)).sort();
    const unassignedAssetRefs = [...assetById.keys()].filter((ref) => !assignedAssetRefs.includes(ref)).sort();
    const expectedCoverage = {
      objectRefs: selectedObjectSet,
      assetRefs: selectedAssetSet,
      unassignedObjectRefs,
      unassignedAssetRefs,
      duplicateObjectRefs,
      duplicateAssetRefs
    };
    const coverage = page.coverage ?? {};
    for (const key of Object.keys(expectedCoverage)) {
      if (!Array.isArray(coverage[key]) || new Set(coverage[key].map(String)).size !== coverage[key].length
          || canonical(coverage[key].map(String).sort()) !== canonical(expectedCoverage[key])) {
        fail("E_RECONSTRUCTION_PLAN", `${slide.id} reconstruction coverage ${key} does not match winners and full-page ownership`);
      }
    }
    if (canonical(selectedObjects.slice().sort()) !== canonical(selectedObjectSet)
        || canonical(selectedAssets.slice().sort()) !== canonical(selectedAssetSet)) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} selected refs are not the independently recomputed winner sets`);
    }
    const fullObjectRefs = [...objectById.keys()].sort();
    const fullAssetRefs = [...assetById.keys()].sort();
    const expectedPageGatePassed = [
      duplicateObjectRefs.length === 0 && duplicateAssetRefs.length === 0,
      unassignedObjectRefs.length === 0,
      unassignedAssetRefs.length === 0,
      canonical(selectedObjectSet) === canonical(fullObjectRefs) && duplicateObjectRefs.length === 0,
      canonical(selectedAssetSet) === canonical(fullAssetRefs) && duplicateAssetRefs.length === 0
    ];
    const pageGateIds = Array.isArray(page.pageGates) ? page.pageGates.map((gate) => String(gate.id)) : [];
    if (pageGateIds.length !== RECONSTRUCTION_PAGE_GATE_IDS.length
        || new Set(pageGateIds).size !== pageGateIds.length
        || canonical(pageGateIds) !== canonical(RECONSTRUCTION_PAGE_GATE_IDS)
        || (page.pageGates ?? []).some((gate, gateIndex) => gate.blocking !== true || gate.passed !== expectedPageGatePassed[gateIndex])) {
      fail("E_RECONSTRUCTION_PLAN", `${slide.id} page gate universe or independently recomputed result is invalid`);
    }
  }
}

export async function validateOwnershipReport(report, root, slide, sourceRecords = []) {
  if (!report || typeof report !== "object") fail("E_PIXEL_OWNERSHIP_CONFLICT", `${slide.id} ownership report is missing`);
  if (report.status !== "passed") fail("E_PIXEL_OWNERSHIP_CONFLICT", `${slide.id} ownership report is not passed`);
  const expectedWidth = Number(slide.sizePx?.width);
  const expectedHeight = Number(slide.sizePx?.height);
  if (report.coordinateSpace !== "normalized-page-px"
      || report.sizePx?.width !== expectedWidth || report.sizePx?.height !== expectedHeight) {
    fail("E_CONTRACT", `${slide.id} ownership coordinate space or size is invalid`);
  }
  if (report.sourceRef !== slide.sourceRef) fail("E_CONTRACT", `${slide.id} ownership sourceRef mismatch`);
  if (Number(report.conflictPixels ?? 0) > 0) fail("E_PIXEL_OWNERSHIP_CONFLICT", `${slide.id} ownership masks conflict`);
  if (Number(report.rasterNativeOverlapPixels ?? 0) > 0) {
    fail("E_RASTER_NATIVE_TEXT_OVERLAP", `${slide.id} raster ownership overlaps native content`);
  }
  if (Number(report.duplicateVisibleContent ?? 0) > 0) {
    fail("E_DUPLICATE_VISIBLE_CONTENT", `${slide.id} ownership contains duplicate visible content`);
  }
  const unassignedBudget = Number(report.unassignedBudget ?? 0);
  const unassignedPixels = Number(report.unassignedPixels ?? 0);
  const totalPixels = Number(report.totalPixels ?? 0);
  if (Number(report.unassignedShare ?? 0) > unassignedBudget
      || unassignedPixels > totalPixels * unassignedBudget + 0.5) {
    fail("E_UNASSIGNED_PIXEL_BUDGET", `${slide.id} ownership leaves unassigned pixels`);
  }
  const classNames = ["background", "native_text", "native_shape", "raster_asset", "unresolved"];
  const classes = report.classes ?? {};
  for (const name of classNames) {
    const item = classes[name];
    if (!item) fail("E_CONTRACT", `${slide.id} ownership class is missing: ${name}`);
    const path = local(root, item.path, `${slide.id}.ownership.${name}`);
    await readable(path, `${slide.id}.ownership.${name}`);
    if (await digest(path) !== item.maskDigest) fail("E_CONTRACT", `${slide.id} ownership mask digest mismatch: ${name}`);
    const dimensions = pngDimensions(await readFile(path), item.path);
    if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
      fail("E_CONTRACT", `${slide.id} ownership mask dimensions mismatch: ${name}`);
    }
  }
  const seenAssets = new Set();
  for (const asset of report.assets ?? []) {
    const assetPath = local(root, asset.asset, `${asset.objectId}.asset`);
    const maskPath = local(root, asset.mask, `${asset.objectId}.mask`);
    await readable(assetPath, `${asset.objectId}.asset`);
    await readable(maskPath, `${asset.objectId}.mask`);
    if (await digest(assetPath) !== asset.assetDigest) fail("E_CONTRACT", `${asset.objectId} asset digest mismatch`);
    if (await digest(maskPath) !== asset.maskDigest) fail("E_CONTRACT", `${asset.objectId} mask digest mismatch`);
    const assetDimensions = pngDimensions(await readFile(assetPath), asset.asset);
    const maskDimensions = pngDimensions(await readFile(maskPath), asset.mask);
    if (!asset.originPagePixelBox
        || Number(asset.originPagePixelBox.w) <= 0
        || Number(asset.originPagePixelBox.h) <= 0) {
      fail("E_CONTRACT", `${asset.objectId} immutable originPagePixelBox is missing or invalid`);
    }
    const expectedOriginWidth = Math.round(Number(asset.originPagePixelBox.w));
    const expectedOriginHeight = Math.round(Number(asset.originPagePixelBox.h));
    if (!(Number(asset.pagePixelBox?.w) > 0) || !(Number(asset.pagePixelBox?.h) > 0)
        || assetDimensions.width !== expectedOriginWidth || assetDimensions.height !== expectedOriginHeight
        || maskDimensions.width !== expectedOriginWidth || maskDimensions.height !== expectedOriginHeight) {
      fail("E_CONTRACT", `${asset.objectId} residual asset/mask dimensions do not match immutable originPagePixelBox`);
    }
    const claimKey = JSON.stringify({
      pagePixelBox: {
        x: asset.pagePixelBox?.x,
        y: asset.pagePixelBox?.y,
        w: asset.pagePixelBox?.w,
        h: asset.pagePixelBox?.h
      },
      maskDigest: asset.maskDigest
    });
    if (seenAssets.has(claimKey)) fail("E_DUPLICATE_VISIBLE_CONTENT", `${asset.objectId} duplicates a page ownership claim`);
    seenAssets.add(claimKey);
    const source = sourceRecords.find((item) => item.id === asset.sourceRef);
    if (!source) fail("E_CONTRACT", `${asset.objectId} sourceRef is missing`);
    if (asset.sourceDigest !== asset.normalizedSourceDigest
        || asset.normalizedSourceDigest !== source.normalizedSha256) {
      fail("E_CONTRACT", `${asset.objectId} normalized source digest mismatch`);
    }
  }
}

export async function validateOutput(outputDir) {
  const root = resolve(outputDir);
  const analysisPath = join(root, "analysis.json");
  const qaPath = join(root, "qa-report.json");
  const runPath = join(root, "run.json");
  await Promise.all([
    readable(analysisPath, "analysis"),
    readable(qaPath, "qa report"),
    readable(runPath, "run index")
  ]);
  let analysis;
  let qa;
  let run;
  try {
    analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    qa = JSON.parse(await readFile(qaPath, "utf8"));
    run = JSON.parse(await readFile(runPath, "utf8"));
  } catch (error) {
    fail("E_SCHEMA", `output JSON is invalid: ${error.message}`);
  }
  schemaCheck(validateAnalysisSchema, analysis, "analysis");
  schemaCheck(validateQaSchema, qa, "qa report");
  if (analysis.version !== "1.0.0" || analysis.kind !== "image-reconstruction-analysis") {
    fail("E_CONTRACT", "unsupported analysis contract");
  }
  const reconstructionPlanRef = analysis.reconstructionPlanRef;
  assertReconstructionPlanLineage(reconstructionPlanRef, qa.reconstructionPlanRef);
  await validateReconstructionPlan(root, analysis);
  const repairSafetyPages = await Promise.all((analysis.slides ?? []).map(async (slide) => ({
    slideId: String(slide.id),
    ...(await reconstructionRepairSafety(slide, root))
  })));
  const expectedRepairSafety = {
    status: repairSafetyPages.every((page) => page.status === "passed") ? "passed" : "failed",
    report: "analysis.json",
    pages: repairSafetyPages
  };
  if (canonical(qa.repairSafety) !== canonical(expectedRepairSafety)) {
    fail("E_RECONSTRUCTION_OWNERSHIP", "QA repair safety evidence is not bound to independently recomputed analysis safety");
  }
  if (qa.repairSafety.status !== "passed") {
    fail("E_RECONSTRUCTION_OWNERSHIP", "QA repair safety gate failed");
  }
  const history = qa.repairHistory;
  if (!Array.isArray(history) || history.length !== Number(qa.attemptsUsed) + 1
      || history.length > Number(qa.maxRepairAttempts) + 1 || history.length > 4) {
    fail("E_REPAIR_HISTORY", "repair history length is inconsistent with bounded attempts");
  }
  const loadedHistory = [];
  for (const [index, item] of history.entries()) {
    if (item.round !== index || item.iteration !== index || item.status !== (index === 0 ? "baseline" : "applied")) {
      fail("E_REPAIR_HISTORY", "repair history rounds are not contiguous or baseline is not explicit");
    }
    if (item.selectedForNextRound !== (index > 0)) {
      fail("E_REPAIR_HISTORY", "repair history selectedForNextRound state is inconsistent");
    }
    const refs = [
      [item.candidateRef, "candidate"],
      [item.analysisRef, "analysis"],
      [item.visualReportRef, "visual report"],
      [item.renderReportRef, "render report"],
      [item.editabilityReportRef, "editability report"],
      [item.reconstructionPlanRef, "candidate reconstruction plan"]
    ];
    for (const [reference, label] of refs) {
      const path = local(root, reference.path, `${label} history reference`);
      await readable(path, label);
      if (await digest(path) !== reference.sha256) fail("E_REPAIR_HISTORY", `${label} history digest mismatch`);
    }
    let visualReport;
    let candidateAnalysis;
    let attemptRenderReport;
    let editabilityReport;
    try {
      candidateAnalysis = JSON.parse(await readFile(local(root, item.analysisRef.path, "analysis history reference"), "utf8"));
      visualReport = JSON.parse(await readFile(local(root, item.visualReportRef.path, "visual report history reference"), "utf8"));
      attemptRenderReport = JSON.parse(await readFile(local(root, item.renderReportRef.path, "render report history reference"), "utf8"));
      editabilityReport = JSON.parse(await readFile(local(root, item.editabilityReportRef.path, "editability report history reference"), "utf8"));
    } catch (error) {
      fail("E_REPAIR_HISTORY", `repair history report is invalid JSON: ${error.message}`);
    }
    if (item.visualStatus !== visualReport.status || Number(item.editabilityLevel) !== Number(editabilityReport.level)) {
      fail("E_REPAIR_HISTORY", "repair history summary does not match attempt reports");
    }
    schemaCheck(validateAnalysisSchema, candidateAnalysis, `repair history analysis attempt ${index}`);
    if (canonical(candidateAnalysis.reconstructionPlanRef) !== canonical(item.reconstructionPlanRef)) {
      fail("E_REPAIR_HISTORY", `attempt ${index} analysis and plan references differ`);
    }
    await validateReconstructionPlan(root, candidateAnalysis);
    for (const slide of candidateAnalysis.slides ?? []) {
      await validateOwnershipReport(slide.ownershipReport, root, slide, candidateAnalysis.sources ?? []);
    }
    const candidatePlanPath = local(root, item.reconstructionPlanRef.path, "candidate reconstruction plan history reference");
    let candidatePlan;
    try {
      candidatePlan = JSON.parse(await readFile(candidatePlanPath, "utf8"));
    } catch (error) {
      fail("E_REPAIR_HISTORY", `candidate reconstruction plan is invalid JSON: ${error.message}`);
    }
    if (item.candidatePlanDigest && item.candidatePlanDigest !== item.reconstructionPlanRef.sha256) {
      fail("E_REPAIR_HISTORY", "candidate plan digest does not match its reference");
    }
    const selectedBeam = (item.beamEvaluations ?? []).filter((evaluation) => evaluation.selectedForNextRound === true);
    if (selectedBeam.length > 1 || (selectedBeam.length === 1 && selectedBeam[0].stepAccepted !== true)) {
      fail("E_REPAIR_HISTORY", `attempt ${index} beam selection is inconsistent`);
    }
    for (const evaluation of item.beamEvaluations ?? []) {
      for (const reference of [evaluation.candidateRef, evaluation.reconstructionPlanRef].filter(Boolean)) {
        const path = local(root, reference.path, "beam evaluation reference");
        await readable(path, "beam evaluation reference");
        if (await digest(path) !== reference.sha256) fail("E_REPAIR_HISTORY", `attempt ${index} beam evaluation digest mismatch`);
      }
    }
    loadedHistory.push({ item, analysis: candidateAnalysis, visual: visualReport, editability: editabilityReport, render: attemptRenderReport, plan: candidatePlan });
  }
  const baseline = loadedHistory[0];
  const lastHistory = loadedHistory[loadedHistory.length - 1];
  if (qa.status !== (lastHistory.item.finalQualityPassed ? "passed" : "failed")) {
    fail("E_REPAIR_HISTORY", "QA status is not bound to the final candidate quality result");
  }
  if (canonical(qa.reconstructionPlanRef) !== canonical(lastHistory.item.reconstructionPlanRef)) {
    fail("E_REPAIR_HISTORY", "QA reconstruction plan reference is not bound to the final candidate");
  }
  const publishedPptxPath = join(root, qa.status === "passed" ? "final.pptx" : "failed-candidate.pptx");
  await readable(publishedPptxPath, "published candidate PPTX");
  if (await digest(publishedPptxPath) !== lastHistory.item.candidateRef.sha256) {
    fail("E_REPAIR_HISTORY", "published candidate PPTX is not the final history candidate");
  }
  const publishedAnalysisPath = join(root, "analysis.json");
  const publishedVisualPath = join(root, "reports", "visual-report.json");
  const publishedEditabilityPath = join(root, "reports", "editability-report.json");
  if (await digest(publishedAnalysisPath) !== lastHistory.item.analysisRef.sha256
      || await digest(publishedVisualPath) !== lastHistory.item.visualReportRef.sha256
      || await digest(publishedEditabilityPath) !== lastHistory.item.editabilityReportRef.sha256) {
    fail("E_REPAIR_HISTORY", "published analysis/visual/editability reports are not the final history attempt");
  }
  if (canonical(analysis) !== canonical(lastHistory.analysis)) {
    fail("E_REPAIR_HISTORY", "published analysis differs from final history analysis");
  }
  const publishedRenderPath = join(root, "reports", "render-report.json");
  try {
    const publishedRender = JSON.parse(await readFile(publishedRenderPath, "utf8"));
    if (canonical(publishedRender.lineage?.reconstructionPlanRef) !== canonical(lastHistory.item.reconstructionPlanRef)) {
      fail("E_REPAIR_HISTORY", "published render report is not bound to the final history plan");
    }
  } catch (error) {
    if (error.code === "E_REPAIR_HISTORY") throw error;
    fail("E_REPAIR_HISTORY", `published render report is invalid: ${error.message}`);
  }
  const baselineOwnershipPassed = (baseline.analysis.slides ?? []).every((slide) => {
    const ownership = slide.ownershipReport;
    return Boolean(ownership) && ownership.status === "passed"
      && Number(ownership.conflictPixels ?? 0) === 0
      && Number(ownership.rasterNativeOverlapPixels ?? 0) === 0
      && Number(ownership.duplicateVisibleContent ?? 0) === 0
      && Number(ownership.unassignedShare ?? 0) <= Number(ownership.unassignedBudget ?? 0);
  });
  const baselineQuality = baseline.visual.status === "passed"
    && baseline.editability.status === "passed"
    && Number(baseline.editability.level) >= 3
    && Number.isFinite(Number(baseline.editability.wholeSlideRasterCount))
    && Number(baseline.editability.wholeSlideRasterCount) === 0
    && baselineOwnershipPassed
    && (!Array.isArray(baseline.render.fonts) || baseline.render.fonts.every((font) => font?.status === "available"));
  if (baseline.item.actions.length !== 0 || baseline.item.beforeMetrics !== null || baseline.item.afterMetrics !== null
      || baseline.item.stepAccepted !== false || baseline.item.finalQualityPassed !== baselineQuality
      || baseline.item.accepted !== baseline.item.stepAccepted) {
    fail("E_REPAIR_HISTORY", "baseline repair history semantics are invalid");
  }
  for (let index = 1; index < loadedHistory.length; index += 1) {
    const previous = loadedHistory[index - 1];
    const current = loadedHistory[index];
    const actions = current.item.actions;
    if (!Array.isArray(actions) || actions.length < 1 || current.item.accepted !== current.item.stepAccepted) {
      fail("E_REPAIR_HISTORY", `attempt ${index} does not record a strict source-bound step`);
    }
    const regionKey = (slideId, regionId) => `${String(slideId)}\u0000${String(regionId)}`;
    const beforeRegions = new Map((previous.visual.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((region) => [regionKey(slide.slideId, region.id), region])));
    const afterRegions = new Map((current.visual.slides ?? []).flatMap((slide) => (slide.regionMeasurements ?? []).map((region) => [regionKey(slide.slideId, region.id), region])));
    const regionIds = [];
    for (const action of actions) {
      if (action.sourceBound !== true || !action.regionId) fail("E_REPAIR_HISTORY", `attempt ${index} contains an unbound action`);
      const beforeRegion = beforeRegions.get(regionKey(action.slideId, action.regionId));
      const afterRegion = afterRegions.get(regionKey(action.slideId, action.regionId));
      const expectedBefore = repairMetricSnapshot(beforeRegion);
      const expectedAfter = repairMetricSnapshot(afterRegion);
      if (canonical(action.beforeMetrics) !== canonical(expectedBefore)
          || canonical(action.afterMetrics) !== canonical(expectedAfter)
          || canonical(action.deltaMetrics) !== canonical(repairMetricDelta(expectedBefore, expectedAfter))) {
        fail("E_REPAIR_HISTORY", `attempt ${index}/${action.regionId} metrics are not copied from adjacent visual reports`);
      }
      regionIds.push(regionKey(action.slideId, action.regionId));
    }
    const first = actions[0];
    if (canonical(current.item.beforeMetrics) !== canonical(first.beforeMetrics)
        || canonical(current.item.afterMetrics) !== canonical(first.afterMetrics)
        || canonical(current.item.deltaMetrics) !== canonical(first.deltaMetrics)) {
      fail("E_REPAIR_HISTORY", `attempt ${index} summary metrics do not match its first action`);
    }
    const strict = hardVisualNoRegression(previous.visual, current.visual, previous.editability, current.editability)
      && repairLocalImprovement(previous.visual, current.visual, regionIds);
    if (current.item.stepAccepted !== strict) fail("E_REPAIR_HISTORY", `attempt ${index} strict acceptance does not match measured evidence`);
    if (strict && current.item.rejectionReason !== null) fail("E_REPAIR_HISTORY", `attempt ${index} accepted step has a rejection reason`);
    if (!strict && !current.item.rejectionReason) fail("E_REPAIR_HISTORY", `attempt ${index} rejected step has no rejection reason`);
    const ownershipPassed = (current.analysis.slides ?? []).every((slide) => {
      const ownership = slide.ownershipReport;
      return Boolean(ownership) && ownership.status === "passed"
        && Number(ownership.conflictPixels ?? 0) === 0
        && Number(ownership.rasterNativeOverlapPixels ?? 0) === 0
        && Number(ownership.duplicateVisibleContent ?? 0) === 0
        && Number(ownership.unassignedShare ?? 0) <= Number(ownership.unassignedBudget ?? 0);
    });
    if (current.item.finalQualityPassed !== (current.visual.status === "passed"
      && current.editability.status === "passed"
      && Number(current.editability.level) >= 3
      && Number.isFinite(Number(current.editability.wholeSlideRasterCount))
      && Number(current.editability.wholeSlideRasterCount) === 0
      && ownershipPassed
      && (!Array.isArray(current.render.fonts) || current.render.fonts.every((font) => font?.status === "available")))) {
      fail("E_REPAIR_HISTORY", `attempt ${index} final quality status is inconsistent with reports`);
    }
  }
  for (const slide of analysis.slides ?? []) {
    for (const [regionId, strategy] of Object.entries(slide.reconstructionPlan?.routeOverrides ?? {})) {
      const routeEntry = loadedHistory.slice(1).find((entry) => entry.item.selectedForNextRound
        && entry.item.stepAccepted
        && entry.item.actions.some((action) => String(action.slideId) === String(slide.id)
          && String(action.regionId) === String(regionId)
          && (action.category === "route" || action.action === "route-switch")
          && action.targetStrategy === strategy));
      const routeAction = routeEntry?.item.actions.find((action) => String(action.slideId) === String(slide.id)
        && String(action.regionId) === String(regionId)
        && (action.category === "route" || action.action === "route-switch")
        && action.targetStrategy === strategy);
      const routeImproved = routeAction && ["regionSSIM", "ocrCER", "bboxIoU", "normalizedMAE", "paletteDeltaE2000P95"].some((name) => {
        const delta = routeAction.deltaMetrics?.[name];
        return typeof delta === "number" && Number.isFinite(delta)
          && (["regionSSIM", "bboxIoU"].includes(name) ? delta >= 0.005 : ["ocrCER", "normalizedMAE", "paletteDeltaE2000P95"].includes(name) ? delta <= -0.005 : false);
      });
      if (!routeEntry || !routeAction || !routeImproved || routeAction.beforeStrategy === routeAction.afterStrategy) {
        fail("E_RECONSTRUCTION_ROUTE", `${slide.id}/${regionId} final route override lacks a selected measured source-bound improvement`);
      }
    }
  }
  if (run.version !== "1.0.0" || run.producer?.skill !== "image-to-pptx") {
    fail("E_CONTRACT", "unsupported run index contract");
  }
  if (run.status !== qa.status) fail("E_CONTRACT", "run/QA status mismatch");
  if (!Array.isArray(analysis.slides) || analysis.slides.length < 1) fail("E_CONTRACT", "analysis has no slides");
  const slideIds = new Set();
  for (const slide of analysis.slides) {
    if (slideIds.has(slide.id)) fail("E_CONTRACT", `duplicate slide id ${slide.id}`);
    slideIds.add(slide.id);
    if (!slide.ownershipReport) fail("E_PIXEL_OWNERSHIP_CONFLICT", `${slide.id} ownership report is missing`);
    await validateOwnershipReport(slide.ownershipReport, root, slide, analysis.sources ?? []);
    for (const object of slide.objects ?? []) {
      const box = object.pixelBox;
      if (!box || !["x", "y", "w", "h"].every((key) => Number.isFinite(box[key]))) {
        fail("E_CONTRACT", `${object.id} has invalid geometry`);
      }
      const slideWidth = Number(slide.sizePx?.width ?? slide.sizePx?.widthPx);
      const slideHeight = Number(slide.sizePx?.height ?? slide.sizePx?.heightPx);
      if (box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0
        || box.x + box.w > slideWidth + 0.1 || box.y + box.h > slideHeight + 0.1) {
        fail("E_CONTRACT", `${object.id} is outside the slide`);
      }
      if (object.type === "text" && object.renderBox) {
        const renderBox = object.renderBox;
        if (!["x", "y", "w", "h"].every((key) => Number.isFinite(renderBox[key]))
          || renderBox.x < 0 || renderBox.y < 0 || renderBox.w <= 0 || renderBox.h <= 0
          || renderBox.x + renderBox.w > slideWidth + 0.1 || renderBox.y + renderBox.h > slideHeight + 0.1) {
          fail("E_CONTRACT", `${object.id} has invalid render geometry`);
        }
      }
      if (object.type === "image") {
        const areaShare = (box.w * box.h) / (slideWidth * slideHeight);
        if ((box.x <= slideWidth * 0.05 && box.y <= slideHeight * 0.05
            && box.w >= slideWidth * 0.90 && box.h >= slideHeight * 0.90)
          || areaShare >= 0.80) {
          fail("E_WHOLE_SLIDE_FALLBACK", `${object.id} covers the slide`);
        }
        await readable(local(root, object.asset, `${object.id}.asset`), `${object.id}.asset`);
        if (object.assetDigest && await digest(local(root, object.asset, `${object.id}.asset`)) !== object.assetDigest) {
          fail("E_CONTRACT", `${object.id} asset digest mismatch`);
        }
        if (object.normalizedSourceDigest) {
          const source = (analysis.sources ?? []).find((item) => item.id === object.sourceRef);
          if (!source || object.normalizedSourceDigest !== source.normalizedSha256
              || object.sourceDigest !== object.normalizedSourceDigest) {
            fail("E_CONTRACT", `${object.id} normalized source digest mismatch`);
          }
        }
      }
    }
    if (slide.annotation) await readable(local(root, slide.annotation, `${slide.id}.annotation`), `${slide.id}.annotation`);
  }
  for (const source of analysis.sources ?? []) {
    const path = local(root, source.path, `${source.id}.path`);
    await readable(path, `${source.id}.path`);
    if (await digest(path) !== source.sha256) fail("E_CONTRACT", `${source.id} digest mismatch`);
    const normalizedPath = local(root, source.normalizedPath, `${source.id}.normalizedPath`);
    await readable(normalizedPath, `${source.id}.normalizedPath`);
    if (await digest(normalizedPath) !== source.normalizedSha256) fail("E_CONTRACT", `${source.id} normalized digest mismatch`);
  }
  const passed = qa.status === "passed";
  if (!qa.ownership || qa.ownership.status !== "passed") {
    fail("E_PIXEL_OWNERSHIP_CONFLICT", "QA ownership gate is not passed");
  }
  if (qa.ownership.report !== "analysis.json") fail("E_CONTRACT", "QA ownership report lineage mismatch");
  const pptxPath = join(root, passed ? "final.pptx" : "failed-candidate.pptx");
  if (!passed && (await present(join(root, "final.pptx")) || await present(join(root, "preview")) || await present(join(root, "html-package")))) {
    fail("E_CONTRACT", "failed delivery must not retain final/preview/html artifacts");
  }
  if (passed && await present(join(root, "failed-candidate.pptx"))) {
    fail("E_CONTRACT", "passed delivery must not retain failed candidate");
  }
  await readable(pptxPath, "PPTX candidate");
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const pptSlides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (pptSlides.length !== analysis.slides.length) fail("E_CONTRACT", "PPTX slide count mismatch");
  if (passed && (qa.visual?.status !== "passed"
      || qa.editability?.level < 3
      || qa.editability?.wholeSlideRasterCount !== 0
      || Number(qa.editability?.rasterAreaShare ?? 1) > 0.65)) {
    fail("E_CONTRACT", "passed QA lacks visual/editability evidence");
  }
  const sourceDigests = new Map((run.sourceDigests ?? []).map((item) => [item.id, item]));
  if (sourceDigests.size !== (analysis.sources ?? []).length) fail("E_CONTRACT", "run source digest summary is incomplete");
  for (const source of analysis.sources ?? []) {
    const summary = sourceDigests.get(source.id);
    if (!summary || summary.path !== source.path || summary.sha256 !== source.sha256) {
      fail("E_CONTRACT", `run source digest summary mismatch: ${source.id}`);
    }
  }
  for (const artifact of run.artifacts ?? []) {
    if (!artifact || typeof artifact.path !== "string" || !Number.isInteger(artifact.bytes) || typeof artifact.sha256 !== "string") {
      fail("E_CONTRACT", "run artifact summary is invalid");
    }
    const path = local(root, artifact.path, `run.artifacts.${artifact.path}`);
    await readable(path, artifact.path);
    const info = await stat(path);
    if (info.size !== artifact.bytes || await digest(path) !== artifact.sha256) {
      fail("E_CONTRACT", `run artifact mismatch: ${artifact.path}`);
    }
  }
  if (!Array.isArray(run.artifacts) || run.artifacts.length < 1) fail("E_CONTRACT", "run artifact summary is empty");
  const renderReportPath = local(root, "reports/render-report.json", "render report");
  await readable(renderReportPath, "render report");
  let renderReport;
  try {
    renderReport = JSON.parse(await readFile(renderReportPath, "utf8"));
  } catch (error) {
    fail("E_SCHEMA", `render report is invalid: ${error.message}`);
  }
  validateRuntimeReport(renderReport.runtime);
  if (JSON.stringify(qa.runtime) !== JSON.stringify(renderReport.runtime)) {
    fail("E_CONTRACT", "QA/runtime report mismatch");
  }
  if (qa.render?.engine !== renderReport.engine
      || JSON.stringify(qa.render?.requestedSize) !== JSON.stringify(renderReport.requestedSize)
      || qa.render?.report !== "reports/render-report.json") {
    fail("E_CONTRACT", "QA/render report mismatch");
  }
  if (!Array.isArray(renderReport.fonts) || JSON.stringify(qa.fonts) !== JSON.stringify(renderReport.fonts)) {
    fail("E_CONTRACT", "QA/font diagnostics mismatch");
  }
  if (qa.status === "passed" && renderReport.fonts.some((font) => font?.status !== "available")) {
    fail("E_FONT_RUNTIME", "a requested render font is missing or substituted");
  }
  await validateFontInventory(root, analysis, qa, renderReport);
  const { width: requestedWidth, height: requestedHeight } = validateRenderSize(renderReport, analysis);
  const lineage = renderReport.lineage;
  if (!lineage?.sourcePptx || !lineage?.preview || !lineage?.reconstructionPlanRef) fail("E_CONTRACT", "preview lineage is missing");
  assertReconstructionPlanLineage(reconstructionPlanRef, lineage.reconstructionPlanRef);
  await validateReconstructionPlanRef(root, lineage.reconstructionPlanRef, "render report reconstruction plan");
  if (lineage.sourcePptx.path !== (passed ? "final.pptx" : "failed-candidate.pptx")) {
    fail("E_CONTRACT", "preview source PPTX lineage mismatch");
  }
  if (lineage.sourcePptx.sha256 !== await digest(pptxPath)) fail("E_CONTRACT", "preview source PPTX digest mismatch");
  const lineagePages = [];
  for (const page of lineage.preview.pages ?? []) {
    const pagePath = local(root, page.path, `preview lineage ${page.path}`);
    await readable(pagePath, `preview page ${page.path}`);
    if (await digest(pagePath) !== page.sha256) fail("E_CONTRACT", `preview page digest mismatch: ${page.path}`);
    const dimensions = pngDimensions(await readFile(pagePath), page.path);
    if (dimensions.width !== requestedWidth || dimensions.height !== requestedHeight) {
      fail("E_RENDER_SIZE_MISMATCH", `${page.path} is ${dimensions.width}x${dimensions.height}; expected ${requestedWidth}x${requestedHeight}`);
    }
    lineagePages.push({ path: page.path, sha256: page.sha256 });
  }
  if (lineagePages.length !== analysis.slides.length) fail("E_CONTRACT", "preview page count mismatch");
  const expectedPreviewDir = passed ? "preview/" : "failed-preview/";
  if (lineage.preview.directory !== expectedPreviewDir) fail("E_CONTRACT", "preview directory lineage mismatch");
  const summary = run.summary;
  if (!summary?.qa || !summary?.pptx || !summary?.preview || !summary?.renderReport || !summary?.reconstructionPlanRef) {
    fail("E_CONTRACT", "run summary is incomplete");
  }
  if (summary.qa.path !== "qa-report.json" || summary.qa.sha256 !== await digest(qaPath)) fail("E_CONTRACT", "run QA summary mismatch");
  if (summary.pptx.path !== (passed ? "final.pptx" : "failed-candidate.pptx") || summary.pptx.sha256 !== await digest(pptxPath)) {
    fail("E_CONTRACT", "run PPTX summary mismatch");
  }
  if (summary.preview.directory !== expectedPreviewDir || summary.preview.pageCount !== lineagePages.length
      || JSON.stringify(summary.preview.pages) !== JSON.stringify(lineagePages)) {
    fail("E_CONTRACT", "run preview summary mismatch");
  }
  if (summary.renderReport.path !== "reports/render-report.json" || summary.renderReport.sha256 !== await digest(renderReportPath)) {
    fail("E_CONTRACT", "run render report summary mismatch");
  }
  assertReconstructionPlanLineage(reconstructionPlanRef, summary.reconstructionPlanRef);
  await validateReconstructionPlanRef(root, summary.reconstructionPlanRef, "run summary reconstruction plan");
  let protocol = null;
  if (run.protocol) {
    protocol = await validatePresentationPackageFile(local(root, run.protocol.path, "run.protocol.path"));
  }
  return {
    status: "passed",
    deliveryStatus: qa.status,
    slideCount: analysis.slides.length,
    pptx: pptxPath,
    editabilityLevel: qa.editability?.level,
    previewPages: lineagePages.length,
    summary,
    protocol
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  validateOutput(process.argv[2]).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "E_CONTRACT", message: error.message }, null, 2)}\n`);
      process.exitCode = 1;
    }
  );
}
