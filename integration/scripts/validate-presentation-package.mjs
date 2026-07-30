#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const PROTOCOL = "pptx-creator.presentation-package";
export const SUPPORTED_VERSION = "1.0.0";
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMPONENT_TYPES = new Set(["text", "shape", "image", "svg", "table", "chart", "connector", "group", "unknown"]);
const SOURCE_KINDS = new Set(["user-input", "file", "url", "image", "assumption", "placeholder"]);
const FACT_STATUSES = new Set(["provided", "verified", "inferred", "unverified", "placeholder"]);
const ASSET_RIGHTS = new Set(["user-provided", "project-owned", "licensed", "public-domain", "unknown"]);
const EDITABILITY_IMPACTS = new Set(["none", "partial", "non-editable-region"]);
const schemaPath = fileURLToPath(new URL("../protocol/presentation-package.schema.json", import.meta.url));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
addFormats(schemaValidator);
const validateSchema = schemaValidator.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

function fail(code, message, path = "$") {
  const error = new Error(message);
  error.code = code;
  error.path = path;
  throw error;
}

function object(value, code, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${path} must be an object`, path);
  }
  return value;
}

function array(value, code, path) {
  if (!Array.isArray(value)) fail(code, `${path} must be an array`, path);
  return value;
}

function relativePath(value, path) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    fail("E_PROTOCOL_PATH", `${path} must be a non-empty relative path`, path);
  }
  const portable = value.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (/^[A-Za-z]:/.test(value) || posix.isAbsolute(portable) || win32.isAbsolute(value)
      || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail("E_PROTOCOL_PATH", `${path} escapes the package root`, path);
  }
}

function unique(items, select, code, path) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const value = select(item);
    if (seen.has(value)) fail(code, `${path} contains duplicate value ${value}`, `${path}[${index}]`);
    seen.add(value);
  }
}

function stableId(value, code, path) {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    fail(code, `${path} must be a stable identifier`, path);
  }
}

function optionalSha256(value, code, path) {
  if (value !== undefined && (typeof value !== "string" || !SHA256.test(value))) {
    fail(code, `${path} must be a lowercase SHA-256 digest`, path);
  }
}

function schemaIssueCode(issue) {
  const path = issue?.instancePath ?? "";
  if (issue?.schemaPath?.includes("/relativePath/")) return "E_PROTOCOL_PATH";
  if (issue?.params?.missingProperty === "entrypoint") return "E_PROTOCOL_ENTRYPOINT";
  if (path.startsWith("/validation")) return "E_PROTOCOL_VALIDATION";
  if (path.startsWith("/producer") || path === "/kind") return "E_PROTOCOL_PRODUCER";
  if (path.startsWith("/sources")) return "E_PROTOCOL_SOURCE";
  if (path.includes("/components")) return "E_PROTOCOL_COMPONENT";
  if (path.startsWith("/assets")) return "E_PROTOCOL_ASSET";
  if (path.startsWith("/degradations")) return "E_PROTOCOL_DEGRADATION";
  if (path.startsWith("/compatibility")) return "E_PROTOCOL_COMPATIBILITY";
  return "E_PROTOCOL_SCHEMA";
}

export function validatePresentationPackage(value) {
  const root = object(value, "E_PROTOCOL_ROOT", "$");
  if (root.protocol !== PROTOCOL) {
    fail("E_PROTOCOL_ID", `unsupported protocol: ${root.protocol ?? "missing"}`, "$.protocol");
  }
  if (root.version !== SUPPORTED_VERSION) {
    fail("E_PROTOCOL_VERSION", `unsupported presentation-package version: ${root.version ?? "missing"}; supported=${SUPPORTED_VERSION}`, "$.version");
  }
  if (!validateSchema(root)) {
    const issue = validateSchema.errors?.[0];
    const issuePath = issue?.instancePath ? `$${issue.instancePath}` : "$";
    const message = issue?.schemaPath?.includes("/relativePath/")
      ? `${issuePath} must be a safe relative path and cannot escape the package root`
      : `${issuePath} ${issue?.message ?? "does not match the presentation-package schema"}`;
    fail(schemaIssueCode(issue), message, issuePath);
  }
  if (!["html-presentation", "image-reconstruction", "pptx-delivery"].includes(root.kind)) {
    fail("E_PROTOCOL_KIND", `unsupported package kind: ${root.kind ?? "missing"}`, "$.kind");
  }
  const producer = object(root.producer, "E_PROTOCOL_PRODUCER", "$.producer");
  if (!["text-to-html", "html-to-pptx", "image-to-pptx"].includes(producer.skill)) {
    fail("E_PROTOCOL_PRODUCER", `unknown producer Skill: ${producer.skill ?? "missing"}`, "$.producer.skill");
  }
  if (typeof producer.version !== "string" || !producer.version) {
    fail("E_PROTOCOL_PRODUCER", "$.producer.version must be non-empty", "$.producer.version");
  }
  const kindByProducer = {
    "text-to-html": "html-presentation",
    "html-to-pptx": "pptx-delivery",
    "image-to-pptx": "image-reconstruction"
  };
  if (root.kind !== kindByProducer[producer.skill]) {
    fail(
      "E_PROTOCOL_PRODUCER",
      `${producer.skill} cannot produce package kind ${root.kind}; expected=${kindByProducer[producer.skill]}`,
      "$.kind"
    );
  }
  if (root.kind === "html-presentation" && root.entrypoint === undefined) {
    fail("E_PROTOCOL_ENTRYPOINT", "html-presentation requires an entrypoint", "$.entrypoint");
  }
  if (root.entrypoint !== undefined) relativePath(root.entrypoint, "$.entrypoint");
  if (typeof root.designTokens === "string") relativePath(root.designTokens, "$.designTokens");
  else if (root.designTokens !== undefined) object(root.designTokens, "E_PROTOCOL_DESIGN_TOKENS", "$.designTokens");

  const deck = object(root.deck, "E_PROTOCOL_DECK", "$.deck");
  stableId(deck.id, "E_PROTOCOL_DECK", "$.deck.id");
  if (typeof deck.title !== "string" || !deck.title) {
    fail("E_PROTOCOL_DECK", "$.deck requires non-empty id and title", "$.deck");
  }
  const size = object(deck.size, "E_PROTOCOL_SIZE", "$.deck.size");
  if (!(Number(size.width) > 0) || !(Number(size.height) > 0) || !["px", "in"].includes(size.unit)) {
    fail("E_PROTOCOL_SIZE", "$.deck.size requires positive width/height and unit px|in", "$.deck.size");
  }
  const slides = array(deck.slides, "E_PROTOCOL_SLIDES", "$.deck.slides");
  if (slides.length === 0) fail("E_PROTOCOL_SLIDES", "$.deck.slides cannot be empty", "$.deck.slides");
  unique(slides, (slide) => slide?.id, "E_PROTOCOL_DUPLICATE_SLIDE", "$.deck.slides");
  unique(slides, (slide) => slide?.order, "E_PROTOCOL_DUPLICATE_ORDER", "$.deck.slides");

  const sources = array(root.sources, "E_PROTOCOL_SOURCES", "$.sources");
  unique(sources, (source) => source?.id, "E_PROTOCOL_DUPLICATE_SOURCE", "$.sources");
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const [index, source] of sources.entries()) {
    const sourcePath = `$.sources[${index}]`;
    stableId(source?.id, "E_PROTOCOL_SOURCE", `${sourcePath}.id`);
    if (!SOURCE_KINDS.has(source?.kind) || typeof source?.label !== "string" || !source.label || !FACT_STATUSES.has(source.factStatus)) {
      fail("E_PROTOCOL_SOURCE", `invalid source at index ${index}`, `$.sources[${index}]`);
    }
    optionalSha256(source.sha256, "E_PROTOCOL_SOURCE", `${sourcePath}.sha256`);
  }

  const slideIds = new Set();
  const componentIdsBySlide = new Map();
  for (const [slideIndex, slide] of slides.entries()) {
    const path = `$.deck.slides[${slideIndex}]`;
    stableId(slide?.id, "E_PROTOCOL_SLIDE", `${path}.id`);
    if (!Number.isInteger(slide.order) || slide.order < 1 || typeof slide.title !== "string" || !slide.title) {
      fail("E_PROTOCOL_SLIDE", `invalid slide at index ${slideIndex}`, path);
    }
    slideIds.add(slide.id);
    const refs = array(slide.sourceRefs, "E_PROTOCOL_SOURCE_REF", `${path}.sourceRefs`);
    for (const ref of refs) {
      if (!sourceIds.has(ref)) fail("E_PROTOCOL_SOURCE_REF", `unknown source ref ${ref}`, `${path}.sourceRefs`);
    }
    const components = array(slide.components, "E_PROTOCOL_COMPONENTS", `${path}.components`);
    unique(components, (component) => component?.id, "E_PROTOCOL_DUPLICATE_COMPONENT", `${path}.components`);
    componentIdsBySlide.set(slide.id, new Set(components.map((component) => component?.id)));
    for (const [componentIndex, component] of components.entries()) {
      const componentPath = `${path}.components[${componentIndex}]`;
      stableId(component?.id, "E_PROTOCOL_COMPONENT", `${componentPath}.id`);
      if (!COMPONENT_TYPES.has(component?.type) || !component?.box || !Number.isInteger(component.z) || typeof component.editableIntent !== "boolean") {
        fail("E_PROTOCOL_COMPONENT", `invalid component ${component?.id ?? componentIndex}`, componentPath);
      }
      for (const key of ["x", "y", "w", "h"]) {
        if (!Number.isFinite(component.box[key])) fail("E_PROTOCOL_COMPONENT", `${componentPath}.box.${key} must be finite`, `${componentPath}.box.${key}`);
      }
      if (component.box.w < 0 || component.box.h < 0 || !["px", "in"].includes(component.box.unit)) {
        fail("E_PROTOCOL_COMPONENT", `${componentPath}.box is invalid`, `${componentPath}.box`);
      }
      if (component.confidence !== undefined && (!Number.isFinite(component.confidence) || component.confidence < 0 || component.confidence > 1)) {
        fail("E_PROTOCOL_COMPONENT", `${componentPath}.confidence must be between 0 and 1`, `${componentPath}.confidence`);
      }
      for (const ref of array(component.sourceRefs, "E_PROTOCOL_SOURCE_REF", `${componentPath}.sourceRefs`)) {
        if (!sourceIds.has(ref)) fail("E_PROTOCOL_SOURCE_REF", `unknown source ref ${ref}`, `${componentPath}.sourceRefs`);
      }
    }
  }

  const assets = array(root.assets, "E_PROTOCOL_ASSETS", "$.assets");
  unique(assets, (asset) => asset?.id, "E_PROTOCOL_DUPLICATE_ASSET", "$.assets");
  for (const [index, asset] of assets.entries()) {
    const assetPath = `$.assets[${index}]`;
    stableId(asset?.id, "E_PROTOCOL_ASSET", `${assetPath}.id`);
    if (typeof asset?.mime !== "string" || asset.mime.length < 3 || !ASSET_RIGHTS.has(asset?.rights)) {
      fail("E_PROTOCOL_ASSET", `invalid asset at index ${index}`, assetPath);
    }
    relativePath(asset.path, `$.assets[${index}].path`);
    optionalSha256(asset.sha256, "E_PROTOCOL_ASSET", `${assetPath}.sha256`);
    if (asset.sourceRef !== undefined && !sourceIds.has(asset.sourceRef)) {
      fail("E_PROTOCOL_SOURCE_REF", `unknown asset source ref ${asset.sourceRef}`, `$.assets[${index}].sourceRef`);
    }
  }

  const validation = object(root.validation, "E_PROTOCOL_VALIDATION", "$.validation");
  if (!["pending", "passed", "failed"].includes(validation.status)) {
    fail("E_PROTOCOL_VALIDATION", `invalid validation status ${validation.status ?? "missing"}`, "$.validation.status");
  }
  const validationReports = array(validation.reports, "E_PROTOCOL_VALIDATION", "$.validation.reports");
  if (validation.status !== "pending" && validationReports.length === 0) {
    fail("E_PROTOCOL_VALIDATION", `${validation.status} validation requires at least one report`, "$.validation.reports");
  }
  for (const [index, report] of validationReports.entries()) {
    relativePath(report, `$.validation.reports[${index}]`);
  }

  const degradations = array(root.degradations, "E_PROTOCOL_DEGRADATIONS", "$.degradations");
  unique(degradations, (item) => item?.id, "E_PROTOCOL_DUPLICATE_DEGRADATION", "$.degradations");
  for (const [index, degradation] of degradations.entries()) {
    const degradationPath = `$.degradations[${index}]`;
    stableId(degradation?.id, "E_PROTOCOL_DEGRADATION", `${degradationPath}.id`);
    if (!slideIds.has(degradation?.slideId)) {
      fail("E_PROTOCOL_DEGRADATION", `unknown degradation slide ${degradation?.slideId ?? "missing"}`, `$.degradations[${index}].slideId`);
    }
    if (degradation.componentId !== undefined) {
      stableId(degradation.componentId, "E_PROTOCOL_DEGRADATION", `${degradationPath}.componentId`);
      if (!componentIdsBySlide.get(degradation.slideId)?.has(degradation.componentId)) {
        fail("E_PROTOCOL_DEGRADATION", `unknown component ${degradation.componentId} on slide ${degradation.slideId}`, `${degradationPath}.componentId`);
      }
    }
    if (typeof degradation.reason !== "string" || !degradation.reason || !EDITABILITY_IMPACTS.has(degradation.editabilityImpact)) {
      fail("E_PROTOCOL_DEGRADATION", `invalid degradation ${degradation?.id ?? index}`, `$.degradations[${index}]`);
    }
  }

  const compatibility = object(root.compatibility, "E_PROTOCOL_COMPATIBILITY", "$.compatibility");
  if (compatibility.minReaderVersion !== SUPPORTED_VERSION || !Array.isArray(compatibility.features)
      || compatibility.features.some((feature) => typeof feature !== "string" || !feature)
      || new Set(compatibility.features).size !== compatibility.features.length) {
    fail("E_PROTOCOL_COMPATIBILITY", `minReaderVersion must be ${SUPPORTED_VERSION} and features must be an array`, "$.compatibility");
  }

  return {
    protocol: root.protocol,
    version: root.version,
    kind: root.kind,
    producer: producer.skill,
    slideCount: slides.length,
    componentCount: slides.reduce((sum, slide) => sum + slide.components.length, 0),
    assetCount: assets.length,
    sourceCount: sources.length,
    degradationCount: degradations.length,
    validationStatus: validation.status
  };
}

export async function validatePresentationPackageFile(filePath) {
  const source = JSON.parse(await readFile(resolve(filePath), "utf8"));
  return validatePresentationPackage(source);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const result = await validatePresentationPackageFile(process.argv[2]);
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error.code ?? "E_PROTOCOL_UNKNOWN",
      path: error.path ?? "$",
      message: error.message
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
