const POLICIES = Object.freeze({
  html: {
    fidelity: {
      ssim: { min: 0.97 }, normalizedMae: { max: 6 / 255 }, bboxP95Drift: { max: 2 },
      fontMapping: { min: 1 }, colorMapping: { min: 1 }
    }, nativeCoverage: { min: 0.95 }, editability: { min: 4 }
  },
  image: {
    fidelity: {
      ssim: { min: 0.94 }, ocrCer: { max: 0.02 }, bboxIou: { min: 0.90 },
      paletteDeltaE2000P95: { max: 3 }, nativeHighConfidenceTextRecall: { min: 0.90 }
    }, nativeCoverage: { min: 0 }, editability: { min: 3 }
  }
});

const finding = (code, detail) => `${code}: ${detail}`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validateMetric(metric, path, findings) {
  if (!metric || !["available", "unavailable"].includes(metric.status)) {
    findings.push(finding("required-metric-missing", path));
    return null;
  }
  if (metric.status === "unavailable") {
    if (metric.value !== null || typeof metric.reason !== "string" || !metric.reason.trim()) {
      findings.push(finding("invalid-unavailable-metric", `${path} unavailable requires value:null and reason`));
    } else findings.push(finding("required-metric-unavailable", `${path}: ${metric.reason}`));
    return null;
  }
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
    findings.push(finding("invalid-metric", `${path} must contain a finite numeric value`));
    return null;
  }
  return metric.value;
}

function checkThreshold(value, rule, path, findings) {
  if (value === null) return;
  if (rule.min !== undefined && value < rule.min) findings.push(finding("threshold-failed", `${path} ${value} < ${rule.min}`));
  if (rule.max !== undefined && value > rule.max) findings.push(finding("threshold-failed", `${path} ${value} > ${rule.max}`));
}

function checkFallbacks(fallbacks, path, findings) {
  if (!Array.isArray(fallbacks)) return findings.push(finding("fallback-inventory-missing", path));
  for (const [index, item] of fallbacks.entries()) {
    if (item?.fullSlide === true) findings.push(finding("full-slide-fallback", `${path}[${index}]`));
    if (!item?.reason || !item?.bbox || !Number.isInteger(item?.zOrder) || !Array.isArray(item?.nativeAlternativesAttempted)) {
      findings.push(finding("invalid-fallback", `${path}[${index}] requires reason, bbox, integer zOrder, and nativeAlternativesAttempted`));
    }
  }
}

export function replicaThresholds(route) {
  return POLICIES[route] ? structuredClone(POLICIES[route]) : null;
}

export function evaluateReplicaEvidence(raw = {}) {
  if (raw.mode !== "replica") return { applicable: false, accepted: raw.accepted === true, blockingFindings: [] };
  const evidence = structuredClone(raw);
  const findings = [];
  const policy = POLICIES[evidence.route];
  if (!policy) findings.push(finding("unsupported-route", String(evidence.route)));
  evidence.thresholds = policy ? structuredClone(policy) : {};

  for (const capability of ["sourceRenderComparison", "nativeObjectInspection"]) {
    if (evidence.capabilities?.[capability] !== true) findings.push(finding("capability-unavailable", capability));
  }
  if (!evidence.paths?.source || !evidence.paths?.render) findings.push(finding("evidence-path-missing", "source and render paths are required"));
  if (!Number.isInteger(evidence.retryCount) || evidence.retryCount < 0 || evidence.retryCount > 3) findings.push(finding("retry-limit", "retryCount must be an integer from 0 to 3"));
  const sourceCount = evidence.source?.pageCount;
  const renderCount = evidence.render?.pageCount;
  if (!Number.isInteger(sourceCount) || sourceCount < 1 || sourceCount !== renderCount) findings.push(finding("page-count-mismatch", `${sourceCount} != ${renderCount}`));
  if (!equal(evidence.source?.size, evidence.render?.size)) findings.push(finding("size-mismatch", "source and render dimensions must match exactly"));
  if (!Array.isArray(evidence.perSlide) || evidence.perSlide.length !== sourceCount) findings.push(finding("per-slide-count-mismatch", "perSlide must match source pageCount"));

  if (policy && evidence.aggregate) {
    for (const [name, rule] of Object.entries(policy.fidelity)) {
      checkThreshold(validateMetric(evidence.aggregate.fidelity?.[name], `aggregate.fidelity.${name}`, findings), rule, `aggregate.fidelity.${name}`, findings);
    }
    checkThreshold(validateMetric(evidence.aggregate.nativeCoverage, "aggregate.nativeCoverage", findings), policy.nativeCoverage, "aggregate.nativeCoverage", findings);
    const level = evidence.aggregate.editability?.level;
    if (!Number.isInteger(level) || level < policy.editability.min) findings.push(finding("editability-failed", `aggregate L${level ?? "?"} < L${policy.editability.min}`));
    checkFallbacks(evidence.aggregate.fallbacks, "aggregate.fallbacks", findings);
  } else findings.push(finding("aggregate-missing", "aggregate evidence is required"));

  for (const [index, slide] of (evidence.perSlide ?? []).entries()) {
    if (!policy) break;
    for (const [name, rule] of Object.entries(policy.fidelity)) {
      checkThreshold(validateMetric(slide.fidelity?.[name], `perSlide[${index}].fidelity.${name}`, findings), rule, `perSlide[${index}].fidelity.${name}`, findings);
    }
    checkThreshold(validateMetric(slide.nativeCoverage, `perSlide[${index}].nativeCoverage`, findings), policy.nativeCoverage, `perSlide[${index}].nativeCoverage`, findings);
    if (!Number.isInteger(slide.editability?.level) || slide.editability.level < policy.editability.min) findings.push(finding("editability-failed", `perSlide[${index}] below L${policy.editability.min}`));
    checkFallbacks(slide.fallbacks, `perSlide[${index}].fallbacks`, findings);
  }

  if (evidence.perSlide?.length && evidence.aggregate && policy) {
    for (const [name, rule] of Object.entries(policy.fidelity)) {
      const values = evidence.perSlide.map((slide) => slide.fidelity?.[name]).filter((metric) => metric?.status === "available").map((metric) => metric.value);
      const aggregate = evidence.aggregate.fidelity?.[name];
      if (values.length === evidence.perSlide.length && aggregate?.status === "available") {
        const expected = rule.min !== undefined ? Math.min(...values) : Math.max(...values);
        if (aggregate.value !== expected) findings.push(finding("aggregate-inconsistent", `fidelity.${name}`));
      }
    }
    const nativeValues = evidence.perSlide.map((slide) => slide.nativeCoverage).filter((metric) => metric?.status === "available").map((metric) => metric.value);
    if (nativeValues.length === evidence.perSlide.length && evidence.aggregate.nativeCoverage?.status === "available"
      && evidence.aggregate.nativeCoverage.value !== Math.min(...nativeValues)) findings.push(finding("aggregate-inconsistent", "nativeCoverage"));
    const levels = evidence.perSlide.map((slide) => slide.editability?.level).filter(Number.isInteger);
    if (levels.length === evidence.perSlide.length && evidence.aggregate.editability?.level !== Math.min(...levels)) findings.push(finding("aggregate-inconsistent", "editability"));
  }
  for (const prior of raw.blockingFindings ?? []) findings.push(finding("upstream-blocking-finding", typeof prior === "string" ? prior : JSON.stringify(prior)));
  evidence.applicable = true;
  evidence.blockingFindings = [...new Set(findings)];
  evidence.accepted = evidence.blockingFindings.length === 0;
  return evidence;
}
