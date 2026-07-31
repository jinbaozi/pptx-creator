import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProvenanceRecord,
  buildReviewArtifactHashes,
  hashArtifact,
  reviewInvalidations,
  validateReview
} from "../../scripts/lib/review.mjs";

const artifacts = {
  designIntent: { themeId: "editorial", proposition: "Decisions need a shared narrative." },
  assetLedger: [{ id: "hero", sha256: "a".repeat(64), rights: "licensed" }],
  renderer: { version: "2.0.0", template: "html" }
};

function reviewWith(statuses, artifactHashes = buildReviewArtifactHashes(artifacts)) {
  return Object.fromEntries(["content", "design", "rights"].map((kind) => [kind, {
    status: statuses[kind],
    artifactHashes
  }]));
}

test("accepts three separately approved reviews bound to current artifacts", () => {
  const artifactHashes = buildReviewArtifactHashes(artifacts);
  const review = reviewWith({ content: "approved", design: "approved", rights: "approved" }, artifactHashes);
  const result = validateReview(review, artifactHashes);

  assert.equal(result.status, "approved");
  assert.equal(result.approved, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.invalidations, []);
});

test("keeps a required approval distinct from approvals that are already complete", () => {
  const artifactHashes = buildReviewArtifactHashes(artifacts);
  const review = reviewWith({ content: "required", design: "approved", rights: "approved" }, artifactHashes);
  const result = validateReview(review, artifactHashes);

  assert.equal(result.status, "required");
  assert.equal(result.approved, false);
  assert.deepEqual(result.blockers, [{ approval: "content", status: "required" }]);
  assert.equal(result.approvals.design.status, "approved");
});

test("keeps a rejected approval as a blocking review result", () => {
  const artifactHashes = buildReviewArtifactHashes(artifacts);
  const review = reviewWith({ content: "approved", design: "approved", rights: "rejected" }, artifactHashes);
  const result = validateReview(review, artifactHashes);

  assert.equal(result.status, "rejected");
  assert.equal(result.approved, false);
  assert.deepEqual(result.blockers, [{ approval: "rights", status: "rejected" }]);
});

test("invalidates approved reviews when a bound artifact changes and produces stable provenance", () => {
  const originalHashes = buildReviewArtifactHashes(artifacts);
  const review = reviewWith({ content: "approved", design: "approved", rights: "approved" }, originalHashes);
  const changedArtifacts = { ...artifacts, renderer: { version: "2.0.1", template: "html" } };
  const currentHashes = buildReviewArtifactHashes(changedArtifacts);
  const invalidations = reviewInvalidations(review, currentHashes);
  const result = validateReview(review, currentHashes);
  const provenance = buildProvenanceRecord({ inputPlan: { version: "2.0.0", review }, review, ...changedArtifacts });

  assert.deepEqual(invalidations, [
    { approval: "content", changedArtifacts: ["renderer"], invalidatedBy: ["renderer"] },
    { approval: "design", changedArtifacts: ["renderer"], invalidatedBy: ["renderer"] },
    { approval: "rights", changedArtifacts: ["renderer"], invalidatedBy: ["renderer"] }
  ]);
  assert.equal(result.status, "invalidated");
  assert.deepEqual(result.blockers.map((blocker) => blocker.status), ["invalidated", "invalidated", "invalidated"]);
  assert.deepEqual(Object.keys(provenance.hashes).sort(), ["assetLedger", "designIntent", "inputPlan", "review"]);
  assert.equal(provenance.hashes.designIntent, currentHashes.designIntent);
  assert.equal(provenance.hashes.assetLedger, currentHashes.assetLock);
  assert.equal(provenance.hashes.review, hashArtifact(review));
  assert.deepEqual(buildProvenanceRecord({ inputPlan: { version: "2.0.0", review }, review, ...changedArtifacts }), provenance);
});
