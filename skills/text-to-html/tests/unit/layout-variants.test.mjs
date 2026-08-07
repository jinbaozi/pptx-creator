import assert from "node:assert/strict";
import test from "node:test";
import { buildLayoutVariantPlan, layoutVariantCatalog } from "../../scripts/lib/layout-variants.mjs";

test("layout variants cover every canonical archetype", () => {
  const catalog = layoutVariantCatalog();
  for (const id of [
    "closing-action", "comparison-matrix", "cover", "dashboard", "editorial-split",
    "evidence-image", "executive-summary", "hero-statement", "metric-focus", "process-flow",
    "quote-story", "section-break", "table-chart-diagram", "timeline-roadmap"
  ]) {
    assert.ok(Array.isArray(catalog[id]) && catalog[id].length > 0, `${id} must have a variant`);
  }
});

test("variant selection is stable and avoids repetitive adjacent families", () => {
  const slides = [
    { id: "s1", order: 1, type: "metrics", layoutArchetype: "dashboard" },
    { id: "s2", order: 2, type: "comparison", layoutArchetype: "editorial-split" },
    { id: "s3", order: 3, type: "metrics", layoutArchetype: "metric-focus" },
    { id: "s4", order: 4, type: "statement", layoutArchetype: "section-break" }
  ];
  const policy = { renderControls: { variantPool: 3, maxConsecutiveFamily: 1 } };
  const first = buildLayoutVariantPlan(slides, policy);
  const second = buildLayoutVariantPlan(slides, policy);
  assert.deepEqual([...first.entries()], [...second.entries()]);
  assert.notEqual(first.get("s1").family, first.get("s2").family);
  assert.match(first.get("s2").id, /split|flat/);
});

test("finite scoring selects real silhouettes for dense process, timeline, and comparison slides", () => {
  const slides = [
    { id: "process", order: 1, type: "process", layoutArchetype: "process-flow", content: { steps: Array.from({ length: 5 }, () => ({})) } },
    { id: "timeline", order: 2, type: "timeline", layoutArchetype: "timeline-roadmap", content: { milestones: Array.from({ length: 5 }, () => ({})) } },
    {
      id: "comparison",
      order: 3,
      type: "comparison",
      layoutArchetype: "comparison-matrix",
      content: { left: { points: [{}] }, right: { points: [{}, {}, {}] } }
    }
  ];
  const plan = buildLayoutVariantPlan(slides, { renderControls: { variantPool: 3, maxConsecutiveFamily: 2 } });
  assert.equal(plan.get("process").id, "process-staggered");
  assert.equal(plan.get("process").silhouette, "process-staggered");
  assert.equal(plan.get("timeline").id, "timeline-alternating");
  assert.equal(plan.get("timeline").silhouette, "timeline-alternating");
  assert.equal(plan.get("comparison").id, "focus-right");
  assert.equal(plan.get("comparison").silhouette, "comparison-right-emphasis");
});
