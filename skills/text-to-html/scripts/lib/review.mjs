import { SkillError } from "./errors.mjs";
import { sha256Text } from "./utils.mjs";

export const APPROVAL_KINDS = Object.freeze(["content", "design", "rights"]);
export const REVIEW_ARTIFACT_KEYS = Object.freeze(["designIntent", "assetLock", "renderer"]);

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function reviewError(message, path) {
  throw new SkillError("E_REVIEW_SCHEMA", message, { path });
}

function assertAllowedKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) reviewError(`${path}.${key} is not allowed`, `${path}.${key}`);
  }
}

function assertRecord(value, path) {
  if (!isRecord(value)) reviewError(`${path} must be an object`, path);
  return value;
}

function canonicalValue(value, path) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SkillError("E_PROVENANCE_VALUE", `${path} must contain finite JSON values`, { path });
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalValue(item, `${path}[${index}]`)).join(",")}]`;
  if (!isRecord(value)) {
    throw new SkillError("E_PROVENANCE_VALUE", `${path} must contain JSON-compatible values`, { path });
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], `${path}.${key}`)}`).join(",")}}`;
}

function assertHash(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    reviewError(`${path} must be a lowercase SHA-256 digest`, path);
  }
  return value;
}

function normalizeArtifactHashes(value, path = "$.artifactHashes") {
  const hashes = assertRecord(value, path);
  assertAllowedKeys(hashes, REVIEW_ARTIFACT_KEYS, path);
  const normalized = {};
  for (const key of REVIEW_ARTIFACT_KEYS) {
    if (!(key in hashes)) reviewError(`${path}.${key} is required`, `${path}.${key}`);
    normalized[key] = assertHash(hashes[key], `${path}.${key}`);
  }
  return normalized;
}

function normalizeApproval(value, path) {
  const approval = assertRecord(value, path);
  assertAllowedKeys(approval, ["status", "reviewedAt", "artifactHashes", "invalidatedBy"], path);
  if (!["required", "approved", "rejected"].includes(approval.status)) {
    reviewError(`${path}.status must be required, approved, or rejected`, `${path}.status`);
  }
  if ("reviewedAt" in approval && (typeof approval.reviewedAt !== "string" || !approval.reviewedAt)) {
    reviewError(`${path}.reviewedAt must be a non-empty string when supplied`, `${path}.reviewedAt`);
  }
  if (!("artifactHashes" in approval)) reviewError(`${path}.artifactHashes is required`, `${path}.artifactHashes`);
  if ("invalidatedBy" in approval) {
    if (!Array.isArray(approval.invalidatedBy) || approval.invalidatedBy.some((entry) => typeof entry !== "string" || !entry)) {
      reviewError(`${path}.invalidatedBy must be an array of non-empty strings`, `${path}.invalidatedBy`);
    }
  }
  return {
    status: approval.status,
    ...(approval.reviewedAt ? { reviewedAt: approval.reviewedAt } : {}),
    artifactHashes: normalizeArtifactHashes(approval.artifactHashes, `${path}.artifactHashes`),
    ...(approval.invalidatedBy ? { invalidatedBy: [...approval.invalidatedBy] } : {})
  };
}

function normalizeReview(value) {
  const review = assertRecord(value, "$.review");
  assertAllowedKeys(review, APPROVAL_KINDS, "$.review");
  const normalized = {};
  for (const kind of APPROVAL_KINDS) {
    if (!(kind in review)) reviewError(`$.review.${kind} is required`, `$.review.${kind}`);
    normalized[kind] = normalizeApproval(review[kind], `$.review.${kind}`);
  }
  return normalized;
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Serializes a JSON value with recursively sorted object keys for reproducible hashes.
 */
export function canonicalJson(value) {
  return canonicalValue(value, "$");
}

/**
 * Returns the SHA-256 digest of canonical JSON, rather than source formatting.
 */
export function hashArtifact(value) {
  return sha256Text(canonicalJson(value));
}

/**
 * Derives the three hashes which each approval must bind before it is current.
 */
export function buildReviewArtifactHashes({ designIntent, assetLedger, renderer } = {}) {
  return {
    designIntent: hashArtifact(designIntent),
    assetLock: hashArtifact(assetLedger),
    renderer: hashArtifact(renderer)
  };
}

/**
 * Lists approval records whose declared binding no longer matches the current artifacts.
 */
export function reviewInvalidations(review, currentArtifactHashes) {
  const approvals = normalizeReview(review);
  const current = normalizeArtifactHashes(currentArtifactHashes, "$.currentArtifactHashes");
  const invalidations = [];
  for (const kind of APPROVAL_KINDS) {
    const approval = approvals[kind];
    const changedArtifacts = REVIEW_ARTIFACT_KEYS.filter((key) => approval.artifactHashes[key] !== current[key]);
    const invalidatedBy = unique([...(approval.invalidatedBy ?? []), ...changedArtifacts]);
    if (invalidatedBy.length > 0) invalidations.push({ approval: kind, changedArtifacts, invalidatedBy });
  }
  return invalidations;
}

/**
 * Validates all three independent approvals against current artifact hashes.
 * This function never approves or timestamps a review; it only reports its current gate state.
 */
export function validateReview(review, currentArtifactHashes) {
  const approvals = normalizeReview(review);
  const current = normalizeArtifactHashes(currentArtifactHashes, "$.currentArtifactHashes");
  const invalidationByApproval = new Map(reviewInvalidations(approvals, current).map((entry) => [entry.approval, entry]));
  const result = {};
  const blockers = [];

  for (const kind of APPROVAL_KINDS) {
    const approval = approvals[kind];
    const invalidation = invalidationByApproval.get(kind);
    const status = approval.status === "approved" && invalidation ? "invalidated" : approval.status;
    result[kind] = {
      status,
      ...(approval.reviewedAt ? { reviewedAt: approval.reviewedAt } : {}),
      artifactHashes: approval.artifactHashes,
      ...(invalidation ? { invalidatedBy: invalidation.invalidatedBy, changedArtifacts: invalidation.changedArtifacts } : {})
    };
    if (status !== "approved") blockers.push({ approval: kind, status, ...(invalidation ? { invalidatedBy: invalidation.invalidatedBy } : {}) });
  }

  const status = blockers.some((blocker) => blocker.status === "rejected")
    ? "rejected"
    : blockers.some((blocker) => blocker.status === "invalidated")
      ? "invalidated"
      : blockers.length > 0
        ? "required"
        : "approved";
  return { status, approved: status === "approved", approvals: result, blockers, invalidations: reviewInvalidations(approvals, current) };
}

/**
 * Produces stable provenance for a proposed plan and its review bindings.
 */
export function buildProvenanceRecord({ inputPlan, designIntent, review, assetLedger, renderer } = {}) {
  const artifactHashes = buildReviewArtifactHashes({ designIntent, assetLedger, renderer });
  const reviewResult = validateReview(review, artifactHashes);
  return {
    version: "1.0.0",
    hashes: {
      inputPlan: hashArtifact(inputPlan),
      designIntent: artifactHashes.designIntent,
      review: hashArtifact(review),
      assetLedger: artifactHashes.assetLock
    },
    review: reviewResult
  };
}
