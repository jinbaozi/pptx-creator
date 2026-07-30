import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scaffoldPlanFromSource, validatePlan } from "../../scripts/lib/plan.mjs";
import { examplePlan, skillRoot } from "../helpers.mjs";

test("validates the reviewed minimal and complex plans", async () => {
  const minimal = await examplePlan("minimal");
  const complex = await examplePlan("complex");
  assert.deepEqual(await validatePlan(minimal.plan, { planDirectory: join(skillRoot, "examples", "minimal") }), {
    version: "1.0.0",
    deckId: "knowledge-base-pilot",
    slideCount: 3,
    sourceCount: 1,
    assetCount: 0,
    approved: true
  });
  assert.equal((await validatePlan(complex.plan, { planDirectory: join(skillRoot, "examples", "complex") })).slideCount, 9);
});

test("Markdown scaffolding preserves source text and requires Host review", async () => {
  const sourcePath = join(skillRoot, "examples", "minimal", "input.md");
  const draft = await scaffoldPlanFromSource(sourcePath);
  assert.equal(draft.hostReview.status, "required");
  assert.match(JSON.stringify(draft.slides), /当前资料分散在三个共享目录中/);
  await assert.rejects(() => validatePlan(draft), (error) => error.code === "E_HOST_REVIEW_REQUIRED");
});

test("rejects more than three primary support points", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.slides[1].content.points.push({
    text: "第四个独立支撑点必须拆页。",
    factStatus: "provided",
    sourceRefs: ["source-brief"]
  });
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_PLAN_SCHEMA" && /at most 3/.test(error.message));
});

test("rejects unknown source references", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.slides[1].content.points[0].sourceRefs = ["missing-source"];
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_SOURCE_REF");
});
