import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const POLICIES = Object.freeze({
  html: { fidelity: { ssim: { min: 0.97 }, normalizedMae: { max: 6 / 255 }, bboxP95Drift: { max: 2 }, fontMapping: { min: 1 }, colorMapping: { min: 1 } }, nativeCoverage: { min: 0.95 }, editability: { min: 4 } },
  image: { fidelity: { ssim: { min: 0.94 }, ocrCer: { max: 0.02 }, bboxIou: { min: 0.90 }, paletteDeltaE2000P95: { max: 3 }, nativeHighConfidenceTextRecall: { min: 0.90 } }, nativeCoverage: { min: 0 }, editability: { min: 3 } }
});
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
function checkFallbacks(fallbacks, path, findings) {
  if (!Array.isArray(fallbacks)) { findings.push(finding("fallback-inventory-missing", path)); return; }
  for (const [index, item] of fallbacks.entries()) {
    if (item?.fullSlide === true) findings.push(finding("full-slide-fallback", `${path}[${index}]`));
    if (!item?.reason || !item?.bbox || !Number.isInteger(item?.zOrder) || !Array.isArray(item?.nativeAlternativesAttempted)) findings.push(finding("invalid-fallback", `${path}[${index}]`));
  }
}

export function replicaThresholds(route) { return POLICIES[route] ? structuredClone(POLICIES[route]) : null; }

function evaluate(raw, authoritative) {
  if (raw.mode !== "replica") return { applicable: false, accepted: raw.accepted === true, blockingFindings: [] };
  const evidence = structuredClone(raw); const findings = [...(raw.__artifactFindings ?? [])]; delete evidence.__artifactFindings;
  const policy = POLICIES[evidence.route];
  if (!authoritative) findings.push(finding("artifact-verification-required", "use verifyReplicaEvidence"));
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
    checkFallbacks(evidence.aggregate.fallbacks, "aggregate.fallbacks", findings);
  } else findings.push(finding("aggregate-missing", "aggregate evidence is required"));
  for (const [index, slide] of (evidence.perSlide ?? []).entries()) {
    if (!policy) break;
    for (const [name, rule] of Object.entries(policy.fidelity)) checkThreshold(validateMetric(slide.fidelity?.[name], `perSlide[${index}].fidelity.${name}`, findings), rule, `perSlide[${index}].fidelity.${name}`, findings);
    checkThreshold(validateMetric(slide.nativeCoverage, `perSlide[${index}].nativeCoverage`, findings), policy.nativeCoverage, `perSlide[${index}].nativeCoverage`, findings);
    if (!Number.isInteger(slide.editability?.level) || slide.editability.level < policy.editability.min) findings.push(finding("editability-failed", `perSlide[${index}] below L${policy.editability.min}`));
    checkFallbacks(slide.fallbacks, `perSlide[${index}].fallbacks`, findings);
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

export function evaluateReplicaEvidence(raw = {}) { return evaluate(raw, false); }
export async function verifyReplicaEvidence(raw = {}) {
  if (raw.mode !== "replica") return evaluate(raw, true);
  const findings = [];
  const source = await verifyPath(raw.paths?.source, "source", findings);
  const render = await verifyPath(raw.paths?.render, "render", findings);
  return evaluate({ ...raw, paths: { source, render }, __artifactFindings: findings }, true);
}
