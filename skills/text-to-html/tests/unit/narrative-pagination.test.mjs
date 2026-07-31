import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNarrative } from "../../scripts/lib/narrative.mjs";
import { analyzePagination, contentUnits, primarySupportCount } from "../../scripts/lib/pagination.mjs";
import { examplePlan } from "../helpers.mjs";

test("narrative diagnostics are stable and leave an already-valid Plan 2.0 unchanged", async () => {
  const { plan } = await examplePlan("minimal");
  const source = structuredClone(plan);
  const first = analyzeNarrative(plan);
  const second = analyzeNarrative(plan);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(plan, source);
  assert.equal(first.status, "reported");
  assert.deepEqual(first.errors, []);
  assert.equal(first.titleChain.matches, true);
  assert.equal(first.chapters.coverage.matches, true);
  assert.equal(first.beats.coverage.matches, true);
  assert.equal(first.attention.coverage.matches, true);
  assert.deepEqual(first.action.actionSlideIds, ["slide-closing"]);
  assert.deepEqual(first.action.attentionLevels, [{ slideId: "slide-closing", level: 5 }]);
});

test("narrative diagnostics identify title-chain and attention-coverage drift without editing content", async () => {
  const { plan } = await examplePlan("minimal");
  const changed = structuredClone(plan);
  changed.narrative.titleChain[1] = "A different title";
  changed.narrative.attentionCurve.pop();

  const report = analyzeNarrative(changed);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.errors.map((entry) => entry.code), [
    "E_NARRATIVE_TITLE_CHAIN",
    "E_NARRATIVE_ATTENTION"
  ]);
  assert.equal(report.titleChain.matches, false);
  assert.equal(report.attention.coverage.matches, false);
});

test("pagination diagnostics use stable content-unit and primary-support budgets", async () => {
  const { plan } = await examplePlan("minimal");
  const source = structuredClone(plan);
  const report = analyzePagination(plan);
  const bulletSlide = plan.slides.find((slide) => slide.id === "slide-actions");
  const bulletPage = report.pages.find((page) => page.slideId === "slide-actions");

  assert.deepEqual(plan, source);
  assert.equal(report.status, "reported");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.duration, { briefSeconds: 300, plannedSeconds: 300, deltaSeconds: 0, matches: true });
  assert.equal(bulletPage.primarySupports, 3);
  assert.equal(bulletPage.primarySupports, primarySupportCount(bulletSlide));
  assert.equal(bulletPage.contentUnits, contentUnits({
    title: bulletSlide.title,
    takeaway: bulletSlide.takeaway,
    slots: bulletSlide.slots
  }));
  assert.equal(bulletPage.withinBudget, true);
});

test("pagination diagnostics report duration, budget, and continuation violations without repaginating", async () => {
  const { plan } = await examplePlan("minimal");
  const changed = structuredClone(plan);
  const budget = changed.pagination.pageBudgets[1];
  budget.maxWords = 1;
  budget.maxPrimarySupports = 1;
  budget.timeSeconds = 99;
  budget.continuationOf = "slide-cover";

  const report = analyzePagination(changed);
  const page = report.pages[1];
  assert.equal(report.status, "failed");
  assert.deepEqual(report.errors.map((entry) => entry.code), [
    "E_PAGINATION_BUDGET",
    "E_PAGINATION_BUDGET",
    "E_PAGINATION_CONTINUATION"
  ]);
  assert.deepEqual(report.warnings.map((entry) => entry.code), ["W_PAGINATION_DURATION_MISMATCH"]);
  assert.equal(page.withinContentBudget, false);
  assert.equal(page.withinSupportBudget, false);
  assert.equal(page.continuation.valid, false);
  assert.deepEqual(page.continuation.violations, ["current-page-not-splittable", "predecessor-not-splittable", "missing-semantic-break"]);
  assert.equal(changed.slides.length, 3, "diagnostics must not add continuation pages");
});
