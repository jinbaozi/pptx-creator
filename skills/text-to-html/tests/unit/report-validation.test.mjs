import assert from "node:assert/strict";
import test from "node:test";
import {
  validateDesignIntent,
  validateProvenanceRecord,
  validateReportArtifact,
  validateReviewReport,
  validateVisualReview,
  validateVisualScorecard
} from "../../scripts/lib/report-validation.mjs";
import { buildVisualScorecard } from "../../scripts/lib/scorecard.mjs";

const sha = (character) => character.repeat(64);

function designIntent() {
  return {
    proposition: "A shared narrative makes the decision actionable.",
    counterProposition: "A feature inventory does not align a decision.",
    mood: ["calm", "decisive"],
    referenceSignals: ["editorial", "high-contrast"],
    themeId: "editorial",
    compositionDiversity: "high",
    motionIntensity: "subtle",
    informationDensity: "balanced",
    imageryStrategy: "Use one factual diagram only where it clarifies the decision.",
    allowedTechniques: ["editorial-grid"],
    forbiddenTechniques: ["decorative-noise"],
    tokenOverrides: {
      colors: { primary: "#102A43" },
      type: { body: 24 }
    },
    lock: {
      canonicalPlanSha256: sha("a"),
      themeManifestSha256: sha("b"),
      tokenSha256: sha("c"),
      archetypeRegistrySha256: sha("d"),
      assetLockSha256: sha("e"),
      rendererVersion: "text-to-html@2.0.0"
    }
  };
}

function artifactHashes() {
  return {
    designIntent: sha("a"),
    assetLock: sha("b"),
    renderer: sha("c")
  };
}

function approvals() {
  return Object.fromEntries(["content", "design", "rights"].map((kind) => [kind, {
    status: "approved",
    reviewedAt: "2026-07-31T00:00:00.000Z",
    artifactHashes: artifactHashes()
  }]));
}

function hashes() {
  return {
    inputPlan: sha("1"),
    designIntent: sha("2"),
    review: sha("3"),
    assetLedger: sha("4")
  };
}

function reviewReport() {
  return {
    version: "2.0.0",
    status: "approved",
    hashes: hashes(),
    approvals: approvals(),
    blockers: [],
    invalidations: []
  };
}

function provenance() {
  return {
    version: "1.0.0",
    hashes: hashes(),
    review: {
      status: "approved",
      approved: true,
      approvals: approvals(),
      blockers: [],
      invalidations: []
    }
  };
}

function scorecard() {
  return buildVisualScorecard({
    qa: { status: "passed", findings: [], viewports: [] },
    narrative: { status: "reported", errors: [], warnings: [] },
    pagination: { status: "reported", errors: [], warnings: [] },
    provenance: provenance()
  });
}

function visualReview() {
  return {
    version: "1.0.0",
    kind: "text-to-html.visual-review",
    status: "approved",
    reviewedAt: "2026-08-07T00:00:00.000Z",
    bindings: { scorecardSha256: sha("a"), previewDigest: sha("b") },
    decisions: [{
      code: "W_TITLE_ORPHAN",
      scope: "slide:slide-cover",
      source: "probe",
      resolution: "waived",
      reason: "Host accepted the measured title balance after full-size inspection."
    }]
  };
}

test("runtime report validators accept current-shaped records without mutation", () => {
  const intent = designIntent();
  const review = reviewReport();
  const record = provenance();
  const visual = scorecard();

  assert.equal(validateDesignIntent(intent), intent);
  assert.equal(validateReviewReport(review), review);
  assert.equal(validateProvenanceRecord(record), record);
  assert.equal(validateVisualScorecard(visual), visual);
  assert.equal(validateVisualReview(visualReview()).status, "approved");
  assert.equal(validateReportArtifact("reviewReport", review), review);
});

test("runtime report validators reject malformed locks and bindings with stable codes and paths", () => {
  const invalidIntent = designIntent();
  invalidIntent.lock.assetLockSha256 = sha("E");
  assert.throws(
    () => validateDesignIntent(invalidIntent),
    (error) => error.code === "E_DESIGN_INTENT_SCHEMA"
      && error.path === "$.lock.assetLockSha256"
      && error.details.keyword === "pattern"
  );

  const invalidScorecard = scorecard();
  invalidScorecard.summary.extra = true;
  assert.throws(
    () => validateVisualScorecard(invalidScorecard),
    (error) => error.code === "E_VISUAL_SCORECARD_SCHEMA"
      && error.path === "$.summary.extra"
      && error.details.keyword === "additionalProperties"
  );

  const invalidReview = reviewReport();
  invalidReview.approvals.rights.artifactHashes.renderer = "not-a-hash";
  assert.throws(
    () => validateReviewReport(invalidReview),
    (error) => error.code === "E_REVIEW_REPORT_SCHEMA"
      && error.path === "$.approvals.rights.artifactHashes.renderer"
      && error.details.keyword === "pattern"
  );

  const invalidProvenance = provenance();
  invalidProvenance.hashes.review = sha("F");
  assert.throws(
    () => validateProvenanceRecord(invalidProvenance),
    (error) => error.code === "E_PROVENANCE_SCHEMA"
      && error.path === "$.hashes.review"
      && error.details.keyword === "pattern"
  );
  assert.equal(validateReportArtifact("visualScorecard", scorecard()).status, "passed");
  assert.equal(validateReportArtifact("visualReview", visualReview()).status, "approved");
});

test("runtime report validators reject undeclared data and unknown artifact kinds", () => {
  const invalidReview = reviewReport();
  invalidReview.approvals.content.autoApproved = true;
  assert.throws(
    () => validateReviewReport(invalidReview),
    (error) => error.code === "E_REVIEW_REPORT_SCHEMA"
      && error.path === "$.approvals.content.autoApproved"
      && error.details.keyword === "additionalProperties"
  );

  const invalidVisualReview = visualReview();
  invalidVisualReview.decisions[0].autoApproved = true;
  assert.throws(
    () => validateVisualReview(invalidVisualReview),
    (error) => error.code === "E_VISUAL_REVIEW_SCHEMA"
      && error.path === "$.decisions[0].autoApproved"
      && error.details.keyword === "additionalProperties"
  );

  assert.throws(
    () => validateReportArtifact("qaReport", {}),
    (error) => error.code === "E_REPORT_KIND" && error.path === "$.kind"
  );
});
