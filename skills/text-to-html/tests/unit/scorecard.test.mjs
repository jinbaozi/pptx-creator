import assert from "node:assert/strict";
import test from "node:test";
import { SCORECARD_VERSION, buildVisualScorecard, scoreVisualQuality } from "../../scripts/lib/scorecard.mjs";

function passingInputs() {
  return {
    qa: {
      status: "passed",
      findings: [],
      viewports: [{
        name: "standard",
        slides: [{ slideId: "slide-001", screenshot: "preview/standard/slide-001.png" }]
      }]
    },
    narrative: { status: "reported", errors: [], warnings: [] },
    pagination: { status: "reported", errors: [], warnings: [] },
    provenance: { review: { status: "approved", approved: true, blockers: [], invalidations: [] } }
  };
}

test("scorecard is deterministic and records a clean measured pass", () => {
  const input = passingInputs();
  const source = structuredClone(input);
  const first = buildVisualScorecard(input);
  const second = scoreVisualQuality(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, source);
  assert.equal(first.version, SCORECARD_VERSION);
  assert.equal(first.status, "passed");
  assert.equal(first.accepted, true);
  assert.equal(first.overallScore, 100);
  assert.deepEqual(first.hardErrors, []);
  assert.deepEqual(Object.fromEntries(Object.entries(first.dimensions).map(([name, result]) => [name, result.score])), {
    visual: 100,
    narrative: 100,
    pagination: 100,
    provenance: 100
  });
});

test("failed QA carries supplied screenshot evidence into a versioned visual finding", () => {
  const input = passingInputs();
  input.qa = {
    status: "failed",
    findings: [{
      code: "E_TEXT_OVERFLOW",
      severity: "error",
      slideId: "slide-001",
      viewport: "standard",
      metrics: { scrollHeight: 120, clientHeight: 96 }
    }],
    viewports: [{
      name: "standard",
      slides: [{ slideId: "slide-001", screenshot: "preview/standard/slide-001.png" }]
    }]
  };

  const scorecard = buildVisualScorecard(input);
  const [finding] = scorecard.findings;
  assert.deepEqual(finding, {
    version: SCORECARD_VERSION,
    code: "E_TEXT_OVERFLOW",
    severity: "error",
    scope: "slide:slide-001@standard",
    measured: { scrollHeight: 120, clientHeight: 96 },
    expected: null,
    evidencePaths: ["preview/standard/slide-001.png"],
    confidence: 1,
    repairClass: "layout",
    owner: "renderer",
    source: "qa",
    hard: true
  });
  assert.equal(scorecard.dimensions.visual.score, 75);
});

test("a hard error cannot be masked by high scores in other dimensions", () => {
  const input = passingInputs();
  input.probes = [{
    passed: false,
    code: "E_PROBE_LAYOUT",
    dimension: "visual",
    scope: "slide:slide-001",
    measured: { overlapArea: 64 },
    expected: { overlapArea: 0 },
    evidencePaths: ["preview/standard/slide-001.png"],
    confidence: 0.9,
    repairClass: "layout",
    owner: "renderer"
  }];

  const scorecard = buildVisualScorecard(input);
  assert.equal(scorecard.overallScore, 93.75, "three dimensions remain at 100");
  assert.equal(scorecard.dimensions.visual.score, 75);
  assert.equal(scorecard.status, "failed");
  assert.equal(scorecard.accepted, false);
  assert.equal(scorecard.hardErrors.length, 1);
  assert.equal(scorecard.hardErrors[0].code, "E_PROBE_LAYOUT");
});

test("narrative, pagination, provenance, and warning probes remain independently scored", () => {
  const input = passingInputs();
  input.narrative = {
    status: "failed",
    errors: [{ code: "E_NARRATIVE_TITLE_CHAIN", path: "$.narrative.titleChain", details: { expected: ["A"], declared: ["B"] } }],
    warnings: []
  };
  input.pagination = {
    status: "attention-required",
    errors: [],
    warnings: [{ code: "W_PAGINATION_DURATION_MISMATCH", path: "$.pagination.pageBudgets", details: { deltaSeconds: 12 } }]
  };
  input.provenance = {
    review: { status: "approved", approved: true, blockers: [], invalidations: [] },
    warnings: [{ code: "W_PROVENANCE_AGE", scope: "provenance", measured: "stale", expected: "current" }]
  };
  input.probes = [{ passed: false, code: "W_VISUAL_DENSITY", severity: "warning", dimension: "visual" }];

  const scorecard = buildVisualScorecard(input);
  assert.equal(scorecard.dimensions.narrative.score, 75);
  assert.equal(scorecard.dimensions.pagination.score, 90);
  assert.equal(scorecard.dimensions.provenance.score, 90);
  assert.equal(scorecard.dimensions.visual.score, 90);
  assert.equal(scorecard.status, "failed");
  assert.equal(scorecard.hardErrors[0].code, "E_NARRATIVE_TITLE_CHAIN");
  assert.equal(scorecard.findings.every((finding) => [
    "code", "severity", "scope", "measured", "expected", "evidencePaths", "confidence", "repairClass", "owner"
  ].every((key) => Object.hasOwn(finding, key))), true);
});

test("missing measured reports and unsafe evidence are rejected rather than reported as a pass", () => {
  const incomplete = buildVisualScorecard({});
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.hardErrors.length, 4);

  const input = passingInputs();
  input.probes = [{ passed: false, code: "E_UNSAFE_EVIDENCE", evidencePaths: ["../outside.png"] }];
  assert.throws(() => buildVisualScorecard(input), (error) => error.code === "E_SCORECARD_EVIDENCE");
});
