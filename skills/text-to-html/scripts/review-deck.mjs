#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./lib/errors.mjs";
import {
  validateProvenanceRecord,
  validateReviewReport
} from "./lib/report-validation.mjs";
import { readJson } from "./lib/utils.mjs";

export async function reviewDeck(outputDir) {
  const root = resolve(outputDir);
  const [qa, narrative, pagination, review, provenance, scorecard] = await Promise.all([
    readJson(join(root, "qa-report.json")),
    readJson(join(root, "narrative-report.json")),
    readJson(join(root, "content-budget-report.json")),
    readJson(join(root, "review-report.json")),
    readJson(join(root, "provenance.json")),
    readJson(join(root, "visual-scorecard.json"))
  ]);
  validateReviewReport(review);
  validateProvenanceRecord(provenance);
  const blockers = [
    ...(qa.status === "passed" ? [] : [{ code: "E_QA_PENDING_OR_FAILED", owner: "qa" }]),
    ...(narrative.status === "failed" ? [{ code: "E_NARRATIVE_DIAGNOSTIC", owner: "host" }] : []),
    ...(pagination.status === "failed" ? [{ code: "E_PAGINATION_DIAGNOSTIC", owner: "host" }] : []),
    ...(scorecard.accepted === true ? [] : [{ code: "E_SCORECARD_FAILED", owner: "qa" }]),
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
    warnings: [],
    artifacts: {
      qa: "qa-report.json",
      narrative: "narrative-report.json",
      pagination: "content-budget-report.json",
      review: "review-report.json",
      provenance: "provenance.json",
      scorecard: "visual-scorecard.json"
    },
    nextActions: blockers.length === 0
      ? []
      : ["Resolve the listed owner-specific blockers; this command never creates or changes a Host approval."]
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    const error = new Error("usage: review-deck.mjs <output-dir>");
    error.code = "E_USAGE";
    throw error;
  }
  process.stdout.write(`${JSON.stringify(await reviewDeck(argv[0]), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
