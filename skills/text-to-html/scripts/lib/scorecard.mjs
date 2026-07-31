import { fail } from "./errors.mjs";

export const SCORECARD_VERSION = "1.0.0";

const DIMENSIONS = ["visual", "narrative", "pagination", "provenance"];
const SEVERITIES = new Set(["error", "warning", "info"]);
const PENALTY_BY_SEVERITY = { error: 25, warning: 10, info: 0 };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  return value === undefined ? null : structuredClone(value);
}

function reportOrMissing(value) {
  if (isRecord(value)) return value;
  return null;
}

function normalizeEvidencePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail("E_SCORECARD_EVIDENCE", "evidencePaths must contain non-empty relative paths");
  }
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.split("/").includes("..")) {
    fail("E_SCORECARD_EVIDENCE", `Unsafe evidence path: ${value}`);
  }
  return path;
}

function normalizedEvidencePaths(values) {
  return [...new Set(asArray(values).map(normalizeEvidencePath))].sort();
}

function scopeFor(raw, fallback) {
  if (typeof raw?.scope === "string" && raw.scope.trim()) return raw.scope.trim();
  if (typeof raw?.path === "string" && raw.path.trim()) return raw.path.trim();
  if (typeof raw?.slideId === "string" && raw.slideId.trim()) {
    return raw.viewport ? `slide:${raw.slideId}@${raw.viewport}` : `slide:${raw.slideId}`;
  }
  if (typeof raw?.viewport === "string" && raw.viewport.trim()) return `viewport:${raw.viewport}`;
  return fallback;
}

function measuredFor(raw) {
  if (!isRecord(raw)) return null;
  if (raw.measured !== undefined) return cloneValue(raw.measured);
  if (raw.metrics !== undefined) return cloneValue(raw.metrics);
  if (raw.details !== undefined) return cloneValue(raw.details);
  for (const key of ["ratio", "overlapArea", "componentId", "componentIds"]) {
    if (raw[key] !== undefined) return cloneValue(raw[key]);
  }
  return null;
}

function inferredRepairClass(dimension) {
  return dimension === "visual" ? "layout"
    : dimension === "provenance" ? "provenance"
      : dimension;
}

function inferredOwner(dimension) {
  return dimension === "visual" ? "renderer"
    : dimension === "provenance" ? "review"
      : "plan";
}

function validateConfidence(value) {
  const confidence = value ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail("E_SCORECARD_CONFIDENCE", "finding confidence must be between 0 and 1");
  }
  return confidence;
}

function createFinding({
  code,
  severity = "error",
  scope = "deck",
  measured = null,
  expected = null,
  evidencePaths = [],
  confidence = 1,
  repairClass = "layout",
  owner = "renderer",
  source = "probe",
  hard
}) {
  if (typeof code !== "string" || !code.trim()) fail("E_SCORECARD_FINDING", "finding code must be a non-empty string");
  if (!SEVERITIES.has(severity)) fail("E_SCORECARD_FINDING", `Unsupported finding severity: ${severity}`);
  if (typeof scope !== "string" || !scope.trim()) fail("E_SCORECARD_FINDING", "finding scope must be a non-empty string");
  if (typeof repairClass !== "string" || !repairClass.trim()) fail("E_SCORECARD_FINDING", "finding repairClass must be a non-empty string");
  if (typeof owner !== "string" || !owner.trim()) fail("E_SCORECARD_FINDING", "finding owner must be a non-empty string");
  const normalizedConfidence = validateConfidence(confidence);
  return {
    version: SCORECARD_VERSION,
    code: code.trim(),
    severity,
    scope: scope.trim(),
    measured: cloneValue(measured),
    expected: cloneValue(expected),
    evidencePaths: normalizedEvidencePaths(evidencePaths),
    confidence: normalizedConfidence,
    repairClass: repairClass.trim(),
    owner: owner.trim(),
    source,
    hard: hard === true || severity === "error"
  };
}

function evidenceIndex(qa) {
  const byViewportAndSlide = new Map();
  const bySlide = new Map();
  for (const viewport of asArray(qa?.viewports)) {
    for (const slide of asArray(viewport?.slides)) {
      if (typeof slide?.slideId !== "string" || typeof slide?.screenshot !== "string") continue;
      const path = slide.screenshot;
      const key = `${viewport?.name ?? ""}:${slide.slideId}`;
      byViewportAndSlide.set(key, path);
      const paths = bySlide.get(slide.slideId) ?? [];
      paths.push(path);
      bySlide.set(slide.slideId, paths);
    }
  }
  return { byViewportAndSlide, bySlide };
}

function evidenceForQaFinding(raw, screenshots) {
  const direct = asArray(raw?.evidencePaths);
  if (direct.length > 0) return direct;
  if (typeof raw?.slideId !== "string") return [];
  if (typeof raw?.viewport === "string") {
    const screenshot = screenshots.byViewportAndSlide.get(`${raw.viewport}:${raw.slideId}`);
    return screenshot ? [screenshot] : [];
  }
  return screenshots.bySlide.get(raw.slideId) ?? [];
}

function normalizeRawFinding(raw, { dimension, source, screenshots, defaultSeverity }) {
  if (!isRecord(raw)) fail("E_SCORECARD_FINDING", `${source} findings must be objects`);
  return {
    dimension,
    finding: createFinding({
      code: raw.code ?? `E_${source.toUpperCase()}_UNSPECIFIED`,
      severity: raw.severity ?? defaultSeverity,
      scope: scopeFor(raw, dimension),
      measured: measuredFor(raw),
      expected: raw.expected ?? null,
      evidencePaths: source === "qa" ? evidenceForQaFinding(raw, screenshots) : raw.evidencePaths ?? [],
      confidence: raw.confidence,
      repairClass: raw.repairClass ?? inferredRepairClass(dimension),
      owner: raw.owner ?? inferredOwner(dimension),
      source,
      hard: raw.hard
    })
  };
}

function findingsFromQa(qa, output) {
  const screenshots = evidenceIndex(qa);
  for (const raw of asArray(qa.findings)) {
    output.push(normalizeRawFinding(raw, { dimension: "visual", source: "qa", screenshots, defaultSeverity: "error" }));
  }
  if (qa.status && qa.status !== "passed" && !asArray(qa.findings).some((finding) => finding?.severity === "error" || !finding?.severity)) {
    output.push({
      dimension: "visual",
      finding: createFinding({
        code: "E_QA_STATUS",
        severity: "error",
        scope: "visual",
        measured: qa.status,
        expected: "passed",
        repairClass: "layout",
        owner: "renderer",
        source: "qa"
      })
    });
  }
}

function findingsFromDiagnostic(report, dimension, source, output) {
  for (const raw of asArray(report.errors)) {
    output.push(normalizeRawFinding(raw, { dimension, source, defaultSeverity: "error" }));
  }
  for (const raw of asArray(report.warnings)) {
    output.push(normalizeRawFinding(raw, { dimension, source, defaultSeverity: "warning" }));
  }
  if (report.status === "failed" && asArray(report.errors).length === 0) {
    output.push({
      dimension,
      finding: createFinding({
        code: `E_${source.toUpperCase()}_STATUS`,
        severity: "error",
        scope: dimension,
        measured: report.status,
        expected: "reported",
        repairClass: inferredRepairClass(dimension),
        owner: inferredOwner(dimension),
        source
      })
    });
  }
}

function findingsFromProvenance(provenance, output) {
  for (const raw of asArray(provenance.findings)) {
    output.push(normalizeRawFinding(raw, { dimension: "provenance", source: "provenance", defaultSeverity: "error" }));
  }
  for (const raw of asArray(provenance.errors)) {
    output.push(normalizeRawFinding(raw, { dimension: "provenance", source: "provenance", defaultSeverity: "error" }));
  }
  for (const raw of asArray(provenance.warnings)) {
    output.push(normalizeRawFinding(raw, { dimension: "provenance", source: "provenance", defaultSeverity: "warning" }));
  }
  const review = provenance.review;
  if (!isRecord(review)) return;
  for (const raw of asArray(review.blockers)) {
    const record = isRecord(raw) ? raw : { measured: raw };
    output.push(normalizeRawFinding({ code: "E_PROVENANCE_BLOCKER", ...record }, {
      dimension: "provenance",
      source: "provenance",
      defaultSeverity: "error"
    }));
  }
  for (const raw of asArray(review.invalidations)) {
    const record = isRecord(raw) ? raw : { measured: raw };
    output.push(normalizeRawFinding({ code: "E_PROVENANCE_INVALIDATED", ...record }, {
      dimension: "provenance",
      source: "provenance",
      defaultSeverity: "error"
    }));
  }
  if ((review.approved === false || (review.status && review.status !== "approved"))
    && asArray(review.blockers).length === 0 && asArray(review.invalidations).length === 0) {
    output.push({
      dimension: "provenance",
      finding: createFinding({
        code: "E_PROVENANCE_REVIEW",
        severity: "error",
        scope: "provenance.review",
        measured: review.status ?? review.approved,
        expected: "approved",
        repairClass: "provenance",
        owner: "review",
        source: "provenance"
      })
    });
  }
}

function findingsFromProbes(probes, output, probeSummary) {
  for (const [index, raw] of asArray(probes).entries()) {
    if (!isRecord(raw)) fail("E_SCORECARD_PROBE", `probes[${index}] must be an object`);
    probeSummary.total += 1;
    if (raw.passed === true) {
      probeSummary.passed += 1;
      continue;
    }
    if (raw.passed !== false && raw.severity === undefined) {
      fail("E_SCORECARD_PROBE", `probes[${index}].passed must be boolean when severity is omitted`);
    }
    probeSummary.failed += 1;
    const dimension = DIMENSIONS.includes(raw.dimension) ? raw.dimension : "visual";
    output.push(normalizeRawFinding({
      ...raw,
      code: raw.code ?? "E_PROBE_FAILED",
      severity: raw.severity ?? "error",
      expected: raw.expected ?? true,
      measured: raw.measured ?? false
    }, { dimension, source: "probe", defaultSeverity: "error" }));
  }
}

function stableFindingOrder(left, right) {
  const dimensionDelta = DIMENSIONS.indexOf(left.dimension) - DIMENSIONS.indexOf(right.dimension);
  if (dimensionDelta !== 0) return dimensionDelta;
  const severityDelta = ["error", "warning", "info"].indexOf(left.finding.severity)
    - ["error", "warning", "info"].indexOf(right.finding.severity);
  if (severityDelta !== 0) return severityDelta;
  return left.finding.code.localeCompare(right.finding.code)
    || left.finding.scope.localeCompare(right.finding.scope)
    || left.finding.source.localeCompare(right.finding.source);
}

function dimensionScores(records) {
  const scores = {};
  for (const dimension of DIMENSIONS) {
    const findings = records.filter((record) => record.dimension === dimension).map((record) => record.finding);
    const penalty = findings.reduce((total, finding) => total + PENALTY_BY_SEVERITY[finding.severity], 0);
    scores[dimension] = {
      score: Math.max(0, 100 - penalty),
      findingCount: findings.length,
      errorCount: findings.filter((finding) => finding.severity === "error").length,
      warningCount: findings.filter((finding) => finding.severity === "warning").length,
      hardErrorCount: findings.filter((finding) => finding.hard).length
    };
  }
  return scores;
}

/**
 * Summarizes already-measured QA, narrative, pagination, provenance, and explicit
 * probes. It never reads files, renders slides, or changes any input report.
 */
export function buildVisualScorecard(inputs = {}) {
  if (!isRecord(inputs)) fail("E_SCORECARD_INPUT", "scorecard input must be an object");
  const records = [];
  const probes = { total: 0, passed: 0, failed: 0 };
  const qa = reportOrMissing(inputs.qa ?? inputs.qaReport);
  const narrative = reportOrMissing(inputs.narrative ?? inputs.narrativeReport);
  const pagination = reportOrMissing(inputs.pagination ?? inputs.paginationReport);
  const provenance = reportOrMissing(inputs.provenance ?? inputs.provenanceReport);

  for (const [name, report] of [["qa", qa], ["narrative", narrative], ["pagination", pagination], ["provenance", provenance]]) {
    if (report === null) {
      records.push({
        dimension: name === "qa" ? "visual" : name,
        finding: createFinding({
          code: `E_SCORECARD_${name.toUpperCase()}_MISSING`,
          severity: "error",
          scope: name,
          measured: null,
          expected: `${name} report`,
          repairClass: "evidence",
          owner: "qa",
          source: "scorecard"
        })
      });
    }
  }
  if (qa) findingsFromQa(qa, records);
  if (narrative) findingsFromDiagnostic(narrative, "narrative", "narrative", records);
  if (pagination) findingsFromDiagnostic(pagination, "pagination", "pagination", records);
  if (provenance) findingsFromProvenance(provenance, records);
  findingsFromProbes(inputs.probes, records, probes);

  records.sort(stableFindingOrder);
  const findings = records.map((record) => record.finding);
  const hardErrors = findings.filter((finding) => finding.hard);
  const dimensions = dimensionScores(records);
  const overallScore = Number((DIMENSIONS.reduce((total, dimension) => total + dimensions[dimension].score, 0) / DIMENSIONS.length).toFixed(2));
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;

  return {
    version: SCORECARD_VERSION,
    kind: "text-to-html.visual-scorecard",
    status: hardErrors.length > 0 ? "failed" : warningCount > 0 ? "attention-required" : "passed",
    accepted: hardErrors.length === 0,
    overallScore,
    dimensions,
    findings,
    hardErrors,
    probes,
    summary: {
      findingCount: findings.length,
      hardErrorCount: hardErrors.length,
      warningCount,
      score: overallScore
    }
  };
}

export const scoreVisualQuality = buildVisualScorecard;
