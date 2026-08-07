#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import {
  validateProvenanceRecord,
  validateReviewReport,
  validateVisualScorecard
} from "./lib/report-validation.mjs";
import { readJson } from "./lib/utils.mjs";
import { assessVisualReview } from "./lib/visual-review.mjs";

export async function reviewDeck(outputDir, options = {}) {
  const root = resolve(outputDir);
  const visualReviewPath = options.visualReviewPath ? resolve(options.visualReviewPath) : null;
  const [qa, narrative, pagination, review, provenance, scorecard, visualReview] = await Promise.all([
    readJson(join(root, "qa-report.json")),
    readJson(join(root, "narrative-report.json")),
    readJson(join(root, "content-budget-report.json")),
    readJson(join(root, "review-report.json")),
    readJson(join(root, "provenance.json")),
    readJson(join(root, "visual-scorecard.json")),
    visualReviewPath ? readJson(visualReviewPath, "E_VISUAL_REVIEW_READ") : null
  ]);
  validateReviewReport(review);
  validateProvenanceRecord(provenance);
  validateVisualScorecard(scorecard);
  const visualAssessment = await assessVisualReview({
    outputDir: root,
    qaReport: qa,
    scorecard,
    visualReview
  });
  const blockers = [
    ...(qa.status === "passed" ? [] : [{ code: "E_QA_PENDING_OR_FAILED", owner: "qa" }]),
    ...(narrative.status === "failed" ? [{ code: "E_NARRATIVE_DIAGNOSTIC", owner: "host" }] : []),
    ...(pagination.status === "failed" ? [{ code: "E_PAGINATION_DIAGNOSTIC", owner: "host" }] : []),
    ...(scorecard.accepted === true ? [] : [{ code: "E_SCORECARD_FAILED", owner: "qa" }]),
    ...visualAssessment.blockers,
    ...(review.status === "approved" && provenance.review.status === "approved"
      ? []
      : [{ code: "E_HOST_REVIEW_REQUIRED", owner: "host" }])
  ];
  return {
    schemaVersion: "1.0.0",
    command: "review",
    status: blockers.length === 0 ? "passed" : "awaiting-host-review",
    stage: "review",
    errors: blockers,
    warnings: visualAssessment.warnings.map(({ code, scope, source }) => ({ code, scope, source })),
    artifacts: {
      qa: "qa-report.json",
      narrative: "narrative-report.json",
      pagination: "content-budget-report.json",
      review: "review-report.json",
      provenance: "provenance.json",
      scorecard: "visual-scorecard.json",
      ...(visualReviewPath ? { visualReview: visualReviewPath } : {})
    },
    visualReview: {
      status: visualAssessment.status,
      required: visualAssessment.required,
      ...(visualAssessment.evidence ? { expectedBindings: {
        scorecardSha256: visualAssessment.evidence.scorecardSha256,
        previewDigest: visualAssessment.evidence.previewDigest
      } } : {})
    },
    nextActions: blockers.length === 0
      ? []
      : ["Resolve the listed owner-specific blockers and supply a current Host-authored visual-review.json when warnings remain; this command never creates or changes an approval."]
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length < 1 || argv.length > 2) {
    const error = new Error("usage: review-deck.mjs <output-dir> [visual-review.json]");
    error.code = "E_USAGE";
    throw error;
  }
  process.stdout.write(`${JSON.stringify(await reviewDeck(argv[0], { visualReviewPath: argv[1] }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
