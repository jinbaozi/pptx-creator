import assert from "node:assert/strict";
import test from "node:test";
import { buildVisualProbes } from "../../scripts/lib/visual-probes.mjs";

test("visual probes pass a varied, low-decoration deck", () => {
  const report = buildVisualProbes([
    { family: "cover", decorationCount: 1, nestedCardCount: 0, sourceTruncated: false },
    { family: "summary", decorationCount: 0, nestedCardCount: 0, sourceTruncated: false },
    { family: "comparison", decorationCount: 0, nestedCardCount: 0, sourceTruncated: false }
  ], { renderControls: { maxConsecutiveFamily: 2 } });
  assert.equal(report.probes.every((item) => item.passed), true);
  assert.ok(Math.abs(report.metrics.decorationRatio - (1 / 3)) < 1e-9);
});

test("visual probes expose repetition, nested cards, and title orphans", () => {
  const report = buildVisualProbes([
    { family: "metrics", decorationCount: 1, nestedCardCount: 1, sourceTruncated: true, titleOrphan: true },
    { family: "metrics", decorationCount: 1, nestedCardCount: 0, sourceTruncated: false },
    { family: "metrics", decorationCount: 1, nestedCardCount: 0, sourceTruncated: false }
  ], { renderControls: { maxConsecutiveFamily: 2 } });
  assert.equal(report.probes.find((item) => item.code === "W_LAYOUT_FAMILY_STREAK").passed, false);
  assert.equal(report.probes.find((item) => item.code === "W_LAYOUT_SILHOUETTE_STREAK").passed, false);
  assert.equal(report.probes.find((item) => item.code === "W_NESTED_CARD").passed, false);
  assert.equal(report.probes.find((item) => item.code === "W_TITLE_ORPHAN").passed, false);
  assert.equal(report.metrics.sourceTruncationCount, 1);
});
