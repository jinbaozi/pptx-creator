import assert from "node:assert/strict";
import test from "node:test";
import { validatePlan } from "../../scripts/lib/plan.mjs";
import { validatePresentationPackage } from "../../scripts/validate-presentation-package.mjs";
import { runPipeline } from "../../scripts/run-pipeline.mjs";
import { examplePlan } from "../helpers.mjs";

test("rejects unreviewed plans", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.hostReview.status = "required";
  delete invalid.hostReview.reviewedAt;
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_HOST_REVIEW_REQUIRED");
});

test("rejects traversal before checking asset bytes", async () => {
  const { plan } = await examplePlan("complex");
  const invalid = structuredClone(plan);
  invalid.assets[0].path = "../outside.svg";
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_ASSET_PATH");
});

test("rejects incompatible protocol versions", () => {
  assert.throws(
    () => validatePresentationPackage({ protocol: "pptx-creator.presentation-package", version: "2.0.0" }),
    (error) => error.code === "E_PROTOCOL_VERSION"
  );
});

test("caps the deterministic regeneration loop at three attempts", async () => {
  await assert.rejects(
    () => runPipeline("missing-plan.json", "unsafe-output", { maxAttempts: 4 }),
    (error) => error.code === "E_USAGE"
  );
});
