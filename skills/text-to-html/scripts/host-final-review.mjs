#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SkillError, runCli } from "./lib/errors.mjs";
import { reviewDeck } from "./review-deck.mjs";

export async function verifyHostFinalReview(outputDir) {
  const review = await reviewDeck(outputDir);
  if (review.status !== "passed") {
    throw new SkillError("E_HOST_REVIEW_REQUIRED", "Final delivery remains blocked; inspect the review envelope and complete the required Host decision", {
      details: { blockers: review.errors }
    });
  }
  return {
    ...review,
    command: "host-final-review",
    stage: "host-final-review",
    nextActions: []
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    const error = new Error("usage: host-final-review.mjs <output-dir>");
    error.code = "E_USAGE";
    throw error;
  }
  process.stdout.write(`${JSON.stringify(await verifyHostFinalReview(argv[0]), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
