import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { runPython } from "./python-utils.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_WORST_TILE_MAE = 0.20;

const POLICIES = Object.freeze({
  html: { fidelity: { ssim: { min: 0.97 }, normalizedMae: { max: 6 / 255 }, bboxP95Drift: { max: 2 }, fontMapping: { min: 1 }, colorMapping: { min: 1 } }, nativeCoverage: { min: 0.95 }, editability: { min: 4 } },
  image: { fidelity: { ssim: { min: 0.94 }, ocrCer: { max: 0.02 }, bboxIou: { min: 0.90 }, paletteDeltaE2000P95: { max: 3 }, nativeHighConfidenceTextRecall: { min: 0.90 } }, nativeCoverage: { min: 0 }, editability: { min: 3 } }
});
const MEASUREMENT_RECEIPT = Symbol("replica-measurement-receipt");
const finding = (code, detail) => `${code}: ${detail}`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const stable = (value) => JSON.stringify(canonical(value));

async function digestArtifact(path) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isFile()) {
    const data = await readFile(absolute);
    return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
  }
  if (!info.isDirectory()) throw new Error("not a regular file or directory");
  const hash = createHash("sha256");
  let bytes = 0;
  async function walk(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) {
        const data = await readFile(resolve(directory, entry.name));
        hash.update(`${relative}\0${data.length}\0`); hash.update(data); bytes += data.length;
      }
    }
  }
  await walk(absolute);
  return { sha256: hash.digest("hex"), bytes };
}

async function verifyPath(candidate, label, findings) {
  const path = candidate?.status === "available" ? candidate.path : candidate?.path;
  if (!path) {
    const reason = candidate?.reason || `${label}-artifact-not-generated`;
    findings.push(finding("artifact-unavailable", `${label}: ${reason}`));
    return { status: "unavailable", path: null, sha256: null, bytes: null, reason };
  }
  try {
    const actual = await digestArtifact(path);
    if (Object.prototype.hasOwnProperty.call(candidate, "sha256") && candidate.sha256 !== actual.sha256) findings.push(finding("artifact-digest-mismatch", label));
    if (Object.prototype.hasOwnProperty.call(candidate, "bytes") && candidate.bytes !== actual.bytes) findings.push(finding("artifact-size-mismatch", label));
    return { status: "available", path: resolve(path), ...actual };
  } catch (error) {
    findings.push(finding("artifact-unavailable", `${label}: ${error.code ?? error.message}`));
    return { status: "unavailable", path: null, sha256: null, bytes: null, reason: `${label}-artifact-not-readable` };
  }
}

function validateMetric(metric, path, findings) {
  if (!metric || !["available", "unavailable"].includes(metric.status)) { findings.push(finding("required-metric-missing", path)); return null; }
  if (metric.status === "unavailable") {
    if (metric.value !== null || typeof metric.reason !== "string" || !metric.reason.trim()) findings.push(finding("invalid-unavailable-metric", `${path} unavailable requires value:null and reason`));
    else findings.push(finding("required-metric-unavailable", `${path}: ${metric.reason}`));
    return null;
  }
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) { findings.push(finding("invalid-metric", `${path} must contain a finite numeric value`)); return null; }
  return metric.value;
}
function checkThreshold(value, rule, path, findings) {
  if (value === null) return;
  if (rule.min !== undefined && value < rule.min) findings.push(finding("threshold-failed", `${path} ${value} < ${rule.min}`));
  if (rule.max !== undefined && value > rule.max) findings.push(finding("threshold-failed", `${path} ${value} > ${rule.max}`));
}
function fallbackKey(item) { return stable(item); }
function fallbackCoversSlide(item, size) {
  return Number(item?.bbox?.x ?? 0) <= 0.01 && Number(item?.bbox?.y ?? 0) <= 0.01
    && Number(item?.bbox?.width ?? 0) >= Number(size?.width ?? Infinity) * 0.98
    && Number(item?.bbox?.height ?? 0) >= Number(size?.height ?? Infinity) * 0.98;
}
function checkFallbacks(fallbacks, path, findings, size) {
  if (!Array.isArray(fallbacks)) { findings.push(finding("fallback-inventory-missing", path)); return; }
  for (const [index, item] of fallbacks.entries()) {
    if (item?.fullSlide === true || fallbackCoversSlide(item, size)) findings.push(finding("full-slide-fallback", `${path}[${index}]`));
    if (!item?.reason || !item?.bbox || !Number.isInteger(item?.zOrder) || !Array.isArray(item?.nativeAlternativesAttempted)) findings.push(finding("invalid-fallback", `${path}[${index}]`));
  }
}

export function replicaThresholds(route) { return POLICIES[route] ? structuredClone(POLICIES[route]) : null; }
export function isCatastrophicLocalDifference(pixel = {}) {
  return Number.isFinite(pixel.worstTileMae) && Number.isFinite(pixel.worstTileBadPixelRatio)
    && pixel.worstTileMae > MAX_WORST_TILE_MAE && pixel.worstTileBadPixelRatio > 0.80;
}

function evaluate(raw, { artifactsVerified = false, measurementsTrusted = false } = {}) {
  if (raw.mode !== "replica") return { applicable: false, accepted: raw.accepted === true, blockingFindings: [] };
  const evidence = structuredClone(raw); const findings = [...(raw.__artifactFindings ?? [])]; delete evidence.__artifactFindings;
  const policy = POLICIES[evidence.route];
  if (!artifactsVerified) findings.push(finding("artifact-verification-required", "use verifyReplicaEvidence"));
  if (!measurementsTrusted) findings.push(finding("trusted-measurement-unavailable", "metrics must come from a receipt-bound measurement adapter"));
  if (!policy) findings.push(finding("unsupported-route", String(evidence.route)));
  evidence.thresholds = policy ? structuredClone(policy) : {};
  for (const capability of ["sourceRenderComparison", "nativeObjectInspection", "fallbackInventory"]) if (evidence.capabilities?.[capability] !== true) findings.push(finding("capability-unavailable", capability));
  if (evidence.paths?.source?.status !== "available" || evidence.paths?.render?.status !== "available") findings.push(finding("evidence-path-unavailable", "source and render artifacts must be verified"));
  if (evidence.retry?.status !== "available") findings.push(finding("retry-capability-unavailable", evidence.retry?.reason ?? "missing"));
  else if (!Array.isArray(evidence.retry.attempts) || evidence.retry.attempts.length > 3) findings.push(finding("retry-limit", "at most three attempts"));
  const sourceCount = evidence.source?.pageCount; const renderCount = evidence.render?.pageCount;
  if (!Number.isInteger(sourceCount) || sourceCount < 1 || sourceCount !== renderCount) findings.push(finding("page-count-mismatch", `${sourceCount} != ${renderCount}`));
  if (stable(evidence.source?.size) !== stable(evidence.render?.size)) findings.push(finding("size-mismatch", "source and render dimensions must match exactly"));
  if (!Array.isArray(evidence.perSlide) || evidence.perSlide.length !== sourceCount) findings.push(finding("per-slide-count-mismatch", "perSlide must match source pageCount"));
  const indexes = (evidence.perSlide ?? []).map((slide) => slide.slideIndex);
  if (indexes.some((value, index) => value !== index)) findings.push(finding("slide-index-invalid", "slideIndex must be unique and exactly 0..N-1 in order"));
  if (policy && evidence.aggregate) {
    for (const [name, rule] of Object.entries(policy.fidelity)) checkThreshold(validateMetric(evidence.aggregate.fidelity?.[name], `aggregate.fidelity.${name}`, findings), rule, `aggregate.fidelity.${name}`, findings);
    checkThreshold(validateMetric(evidence.aggregate.nativeCoverage, "aggregate.nativeCoverage", findings), policy.nativeCoverage, "aggregate.nativeCoverage", findings);
    if (!Number.isInteger(evidence.aggregate.editability?.level) || evidence.aggregate.editability.level < policy.editability.min) findings.push(finding("editability-failed", `aggregate below L${policy.editability.min}`));
    checkFallbacks(evidence.aggregate.fallbacks, "aggregate.fallbacks", findings, evidence.source?.size);
  } else findings.push(finding("aggregate-missing", "aggregate evidence is required"));
  for (const [index, slide] of (evidence.perSlide ?? []).entries()) {
    if (!policy) break;
    for (const [name, rule] of Object.entries(policy.fidelity)) checkThreshold(validateMetric(slide.fidelity?.[name], `perSlide[${index}].fidelity.${name}`, findings), rule, `perSlide[${index}].fidelity.${name}`, findings);
    checkThreshold(validateMetric(slide.nativeCoverage, `perSlide[${index}].nativeCoverage`, findings), policy.nativeCoverage, `perSlide[${index}].nativeCoverage`, findings);
    if (!Number.isInteger(slide.editability?.level) || slide.editability.level < policy.editability.min) findings.push(finding("editability-failed", `perSlide[${index}] below L${policy.editability.min}`));
    checkFallbacks(slide.fallbacks, `perSlide[${index}].fallbacks`, findings, evidence.source?.size);
  }
  if (evidence.perSlide?.length && evidence.aggregate && policy) {
    for (const [name, rule] of Object.entries(policy.fidelity)) {
      const values = evidence.perSlide.map((slide) => slide.fidelity?.[name]).filter((m) => m?.status === "available").map((m) => m.value);
      const aggregate = evidence.aggregate.fidelity?.[name];
      if (values.length === evidence.perSlide.length && aggregate?.status === "available" && aggregate.value !== (rule.min !== undefined ? Math.min(...values) : Math.max(...values))) findings.push(finding("aggregate-inconsistent", `fidelity.${name}`));
    }
    const native = evidence.perSlide.map((slide) => slide.nativeCoverage?.value);
    if (native.every(Number.isFinite) && evidence.aggregate.nativeCoverage?.value !== Math.min(...native)) findings.push(finding("aggregate-inconsistent", "nativeCoverage"));
    const levels = evidence.perSlide.map((slide) => slide.editability?.level);
    if (levels.every(Number.isInteger) && evidence.aggregate.editability?.level !== Math.min(...levels)) findings.push(finding("aggregate-inconsistent", "editability"));
    const union = evidence.perSlide.flatMap((slide) => slide.fallbacks ?? []).map(fallbackKey).sort();
    const aggregateFallbacks = (evidence.aggregate.fallbacks ?? []).map(fallbackKey).sort();
    if (stable(union) !== stable(aggregateFallbacks)) findings.push(finding("aggregate-inconsistent", "fallbacks"));
  }
  for (const prior of raw.blockingFindings ?? []) findings.push(finding("upstream-blocking-finding", typeof prior === "string" ? prior : JSON.stringify(prior)));
  evidence.applicable = true; evidence.blockingFindings = [...new Set(findings)]; evidence.accepted = evidence.blockingFindings.length === 0; return evidence;
}

export function evaluateReplicaEvidence(raw = {}) { return evaluate(raw); }
export async function verifyReplicaEvidence(raw = {}) {
  if (raw.mode !== "replica") return evaluate(raw, { artifactsVerified: true });
  const findings = [];
  const source = await verifyPath(raw.paths?.source, "source", findings);
  const render = await verifyPath(raw.paths?.render, "render", findings);
  return evaluate({ ...raw, paths: { source, render }, __artifactFindings: findings }, { artifactsVerified: true });
}

export async function evaluateMeasuredReplicaEvidence(raw = {}, measuredBundle = {}) {
  const verified = await verifyReplicaEvidence(raw);
  const trusted = measuredBundle?.[MEASUREMENT_RECEIPT] === true
    && measuredBundle.sourceSha256 === verified.paths?.source?.sha256
    && measuredBundle.renderSha256 === verified.paths?.render?.sha256;
  if (!trusted) return verified;
  const merged = {
    ...verified,
    perSlide: measuredBundle.perSlide,
    aggregate: measuredBundle.aggregate,
    capabilities: { ...verified.capabilities, sourceRenderComparison: true },
    blockingFindings: [
      ...(raw.blockingFindings ?? []),
      ...(verified.blockingFindings ?? []).filter((item) => /^(?:artifact-|evidence-path-|candidate-reference-alias)/.test(item))
    ]
  };
  return evaluate(merged, { artifactsVerified: true, measurementsTrusted: true });
}

/** Bind externally computed metrics to the exact artifacts after independently
 * digesting them. The unforgeable receipt stays private to this module. */
const metric = (value) => ({ status: "available", value });
const unavailable = (reason) => ({ status: "unavailable", value: null, reason });

function xmlDecode(value = "") {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

async function inspectPptxObjects(pptxPath, manifest, measurements) {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const viewport = measurements.viewport;
  const size = manifest.deck.size;
  const perSlide = [];
  for (const [slideIndex] of (manifest.slides ?? []).entries()) {
    const xml = await zip.file(`ppt/slides/slide${slideIndex + 1}.xml`)?.async("string") ?? "";
    const objects = new Map();
    for (const match of xml.matchAll(/<(?:p:sp|p:pic|p:graphicFrame)\b[\s\S]*?<p:cNvPr\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<a:xfrm[^>]*>[\s\S]*?<a:off\b[^>]*\bx="(\d+)"[^>]*\by="(\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>[\s\S]*?<\/(?:p:sp|p:pic|p:graphicFrame)>/g)) {
      const [block, encodedName, x, y, w, h] = match;
      objects.set(xmlDecode(encodedName), { block, x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
    }
    const source = (measurements.elements ?? []).filter((item) => item.slideIndex === slideIndex);
    const drifts = []; let fontTotal = 0; let fontMapped = 0; let colorTotal = 0; let colorMapped = 0;
    for (const item of source) {
      const target = objects.get(item.id) ?? objects.get(`${item.id}-box`) ?? objects.get(`${item.id}-localized-fallback`);
      if (!target) {
        drifts.push(Math.max(viewport.width, viewport.height));
      } else {
        const actual = { x: target.x / 914400 / size.width * viewport.width, y: target.y / 914400 / size.height * viewport.height, w: target.w / 914400 / size.width * viewport.width, h: target.h / 914400 / size.height * viewport.height };
        drifts.push(Math.max(...["x", "y", "w", "h"].map((key) => Math.abs(Number(item.px[key]) - actual[key]))));
      }
      if (item.kind === "text" && item.style?.fontFamily) {
        fontTotal += 1;
        const family = String(item.style.fontFamily).split(",")[0].replace(/["']/g, "").trim().toLowerCase();
        const actualTypeface = target?.block.match(/typeface="([^"]+)"/i)?.[1];
        const actualFamily = String(actualTypeface ?? "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();
        if (family && family === actualFamily) fontMapped += 1;
      }
      const colors = [];
      if (!item.replica?.hasUnsupportedEffects) {
        if (item.kind === "text" && item.style?.color) colors.push(item.style.color);
        if (item.style?.backgroundColor && item.style.backgroundTransparency !== 100) colors.push(item.style.backgroundColor);
        if (Number(item.style?.borderWidth) > 0 && item.style?.borderColor) colors.push(item.style.borderColor);
        colors.push(...String(item.style?.backgroundImage ?? "").match(/#[0-9a-f]{6}/gi) ?? []);
      }
      colorTotal += colors.length;
      if (target) colorMapped += colors.filter((color) => target.block.toLowerCase().includes(String(color).replace("#", "").toLowerCase())).length;
    }
    drifts.sort((a, b) => a - b);
    perSlide.push({
      bboxP95Drift: drifts.length ? metric(Number(drifts[Math.max(0, Math.ceil(drifts.length * 0.95) - 1)].toFixed(4))) : unavailable("no-visible-elements"),
      fontMapping: fontTotal ? metric(fontMapped / fontTotal) : unavailable("no-font-bearing-elements"),
      colorMapping: colorTotal ? metric(colorMapped / colorTotal) : unavailable("no-color-bearing-elements")
    });
  }
  return perSlide;
}

/** Authoritative HTML adapter. Callers provide artifacts, never metric values;
 * this module runs the fixed pixel comparator and inspects rendered OOXML before
 * minting its private receipt. */
export async function measureHtmlReplicaEvidence(raw, { sourceArtifactPath, renderArtifactPath, pptxPath, manifest, measurements } = {}) {
  async function pagesWithin(rootPath) {
    try {
      const entries = (await readdir(resolve(rootPath), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^slide-\d+\.png$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
      return entries.map((entry) => join(resolve(rootPath), entry.name));
    } catch {
      return [];
    }
  }
  const boundSourcePaths = await pagesWithin(sourceArtifactPath);
  const boundRenderPaths = await pagesWithin(renderArtifactPath);
  if (boundSourcePaths.length === 0 || boundSourcePaths.length !== boundRenderPaths.length) {
    return verifyReplicaEvidence(raw);
  }
  const mapped = await inspectPptxObjects(pptxPath, manifest, measurements);
  const pages = [];
  const measurementFindings = [];
  for (let index = 0; index < boundSourcePaths.length; index += 1) {
    const sourcePageDigest = await digestArtifact(boundSourcePaths[index]);
    const renderPageDigest = await digestArtifact(boundRenderPaths[index]);
    if (sourcePageDigest.sha256 === renderPageDigest.sha256) measurementFindings.push(`candidate-reference-alias: slide ${index + 1}`);
    const pixel = JSON.parse((await runPython([join(PACKAGE_ROOT, "scripts/measure-replica.py"), boundSourcePaths[index], boundRenderPaths[index]], { cwd: PACKAGE_ROOT })).stdout);
    const fidelity = pixel.sizeMatch ? {
      ssim: metric(pixel.ssim), normalizedMae: metric(pixel.normalizedMae), ...mapped[index]
    } : {
      ssim: unavailable("source-render-size-mismatch"), normalizedMae: unavailable("source-render-size-mismatch"), ...mapped[index]
    };
    if (!pixel.sizeMatch) measurementFindings.push(`source-render-size-mismatch: slide ${index + 1}`);
    if (isCatastrophicLocalDifference(pixel)) {
      measurementFindings.push(`worst-region-omission: slide ${index + 1} tile MAE ${pixel.worstTileMae}; bad-pixel ratio ${pixel.worstTileBadPixelRatio}`);
    }
    pages.push({ ...raw.perSlide[index], slideIndex: index, fidelity });
  }
  const aggregateFidelity = {};
  for (const [name, rule] of Object.entries(POLICIES.html.fidelity)) {
    const values = pages.map((page) => page.fidelity[name]);
    aggregateFidelity[name] = values.every((item) => item.status === "available")
      ? metric(rule.min !== undefined ? Math.min(...values.map((item) => item.value)) : Math.max(...values.map((item) => item.value)))
      : unavailable(values.find((item) => item.status === "unavailable")?.reason ?? "metric-unavailable");
  }
  const aggregate = {
    fidelity: aggregateFidelity,
    nativeCoverage: metric(Math.min(...pages.map((page) => page.nativeCoverage.value))),
    editability: { level: Math.min(...pages.map((page) => page.editability.level)) },
    fallbacks: pages.flatMap((page) => page.fallbacks ?? [])
  };
  const sourceDigest = await digestArtifact(sourceArtifactPath);
  const renderDigest = await digestArtifact(renderArtifactPath);
  const verifiedRaw = {
    ...raw,
    paths: { source: { status: "available", path: sourceArtifactPath }, render: { status: "available", path: renderArtifactPath } },
    source: { pageCount: pages.length, size: { width: measurements.viewport.width, height: measurements.viewport.height } },
    render: { pageCount: pages.length, size: { width: measurements.viewport.width, height: measurements.viewport.height } },
    perSlide: pages, aggregate,
    capabilities: { ...raw.capabilities, sourceRenderComparison: true },
    blockingFindings: [...(raw.blockingFindings ?? []), ...measurementFindings]
  };
  if (sourceDigest.sha256 === renderDigest.sha256) verifiedRaw.blockingFindings.push("candidate-reference-alias: source and render artifact sets are identical");
  const receipt = { perSlide: pages, aggregate, sourceSha256: sourceDigest.sha256, renderSha256: renderDigest.sha256, [MEASUREMENT_RECEIPT]: true };
  return evaluateMeasuredReplicaEvidence(verifiedRaw, receipt);
}
