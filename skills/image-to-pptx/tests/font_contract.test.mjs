import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFontInventory } from "../scripts/validate_output.mjs";
import { applyCalibration } from "../scripts/image-to-pptx.mjs";

function inventory() {
  return {
    version: "1.0.0",
    kind: "offline-font-inventory",
    offline: true,
    runtime: { fontTools: { status: "available", version: "4.63.0" } },
    candidateFamilies: ["Noto Sans"],
    faces: [{
      faceId: "face-test",
      family: "Noto Sans",
      selectionFamily: "Noto Sans",
      actualFamily: "Noto Sans",
      subfamily: "Regular",
      pathEvidence: "/usr/share/fonts/noto.ttf",
      pathDigest: "a".repeat(64),
      runtimeIdentity: "Noto Sans|Regular|" + "a".repeat(64),
      os2WeightClass: 400,
      weightSource: "OS/2",
      coverage: { latin: true, han: true, digits: true },
      requiredGlyphs: [],
      missingGlyphs: []
    }]
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value, null, 2) + "\n").digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "font-contract-"));
  await mkdir(join(root, "reports"), { recursive: true });
  const value = inventory();
  await writeFile(join(root, "reports/font-inventory.json"), `${JSON.stringify(value, null, 2)}\n`);
  const ref = { path: "reports/font-inventory.json", sha256: digest(value) };
  const analysis = { fontInventoryRef: ref, slides: [{ id: "slide-001", fontInventoryRef: ref, typographyTiers: [], objects: [] }] };
  const qa = { fontInventory: ref };
  const render = { fontInventory: ref };
  return { root, value, ref, analysis, qa, render };
}

function validTextAnalysis(value) {
  const selected = {
    family: "Noto Sans",
    selectionFamily: "Noto Sans",
    actualFamily: "Noto Sans",
    faceId: "face-test",
    faceDigest: "a".repeat(64),
    fontSizePt: 12,
    requestedWeight: 400,
    weight: 400,
    actualWeightClass: 400,
    charSpacingPt: 0,
    lineHeightPt: 14,
    textBoxWidthScale: 1,
    textBoxWidthPx: 100,
    renderedLineCount: 1,
    lineBreaks: ["hello"],
    score: 0.8,
    scoreDirection: "higher-is-better",
    missingGlyphs: [],
    metrics: {
      inkBboxIou: 0.8,
      localSsim: 0.8,
      widthError: 0.1,
      heightError: 0.1,
      baselineError: 0.1,
      lineCountConsistency: 1,
      ocrContentConsistency: 1,
      provenance: "line-measurement"
    },
    metricProvenance: "line-measurement"
  };
  const evidence = {
    version: "font-fit-v1",
    metricVersion: "font-fit-metrics-v1",
    dpi: 96,
    ptToPx: 96 / 72,
    tier: "Body",
    tierEvidence: "role:body",
    representativeReuse: false,
    representativeTierRef: "Body",
    representativeObjectId: "text-001",
    alignmentProxy: "left",
    alignmentSource: "explicit",
    alignmentEvidence: "line.align",
    candidateCaps: { families: 6, sizes: 5, weights: 3, spacing: 3, lineHeight: 4, boxWidth: 4, layoutTuples: 4 },
    budget: { pageLimit: 180, pageEvaluated: 1, lineLimit: 36, lineEvaluated: 1 },
    selected,
    targetMetrics: { targetInkDensity: 0.1, targetInkBboxRatio: 0.5, provenance: "current-line-observation" },
    layout: {
      renderedLineCount: 1,
      lineBreaks: ["hello"],
      textBoxWidthPx: 100,
      lineHeightPt: 14,
      provenance: "selected-font-layout"
    },
    evaluatedCandidates: 1,
    evaluatedFamilies: ["Noto Sans"],
    evaluatedFaceIds: ["face-test"],
    evaluatedSizes: [12],
    evaluatedRequestedWeights: [400],
    evaluatedSpacings: [0],
    evaluatedLineHeights: [14],
    evaluatedTextBoxWidthScales: [1],
    deferredCandidates: 0,
    deferredReason: null
  };
  const object = {
    id: "text-001",
    type: "text",
    fontInventoryRef: value.ref.path,
    typographyTierRef: "tier-001",
    pixelBox: { x: 10, y: 10, w: 100, h: 20 },
    style: {
      fontFamily: "Noto Sans",
      fontSizePt: 12,
      fontWeight: 400,
      charSpacingPt: 0,
      lineHeightPt: 14,
      textBoxWidthScale: 1
    },
    fontSolver: evidence
  };
  const tier = {
    id: "tier-001",
    name: "Body",
    memberRefs: ["text-001"],
    fontFamily: "Noto Sans",
    fontWeight: 400,
    baseFontSizePt: 12,
    lineHeightPt: 14,
    textBoxWidthScale: 1,
    align: "left",
    faceId: "face-test",
    evidence: {
      signals: [],
      memberCount: 1,
      stableOrder: "object-id-ascending",
      heightDistribution: { min: 20, median: 20, max: 20 },
      inkStrokeProxy: { inkBboxIouMedian: 0.8, localSsimMedian: 0.8, widthErrorMedian: 0.1, targetInkDensityMedian: 0.1, targetInkBboxRatioMedian: 0.5 },
      styleColors: [],
      alignmentProxy: [{ value: "left", count: 1 }],
      alignmentSources: [{ value: "explicit", count: 1 }],
      layoutGroupRefs: [],
      repeatedGroupRefs: []
    }
  };
  return {
    ...value.analysis,
    slides: [{ ...value.analysis.slides[0], typographyTiers: [tier], objects: [object] }]
  };
}

test("font inventory lineage and digest pass", async () => {
  const value = await fixture();
  await assert.doesNotReject(validateFontInventory(value.root, value.analysis, value.qa, value.render));
});

test("validator rejects missing inventory digest, face, and tier references", async () => {
  const value = await fixture();
  const badDigest = { ...value.analysis, fontInventoryRef: { ...value.ref, sha256: "b".repeat(64) } };
  await assert.rejects(validateFontInventory(value.root, badDigest, value.qa), (error) => error.code === "E_FONT_INVENTORY");

  const object = {
      id: "text-001",
    type: "text",
    fontInventoryRef: value.ref.path,
    typographyTierRef: "tier-001",
    style: { fontFamily: "Noto Sans", fontWeight: 400 },
    fontSolver: { tier: "Body", evaluatedCandidates: 1, selected: {
      faceId: "face-missing", family: "Noto Sans", selectionFamily: "Noto Sans", actualFamily: "Noto Sans", faceDigest: "b".repeat(64),
      fontSizePt: 12, charSpacingPt: 0, weight: 400, actualWeightClass: 400, requestedWeight: 400,
      metricProvenance: "line-measurement", metrics: { provenance: "line-measurement" }
    } }
  };
  const badFace = { ...value.analysis, slides: [{ ...value.analysis.slides[0], objects: [object] }] };
  await assert.rejects(validateFontInventory(value.root, badFace, value.qa), (error) => error.code === "E_FONT_INVENTORY");

  object.fontSolver.selected.faceId = "face-test";
  object.fontSolver.selected.faceDigest = "a".repeat(64);
  object.fontSolver.selected.selectionFamily = "Noto Sans";
  object.fontSolver.selected.actualFamily = "Noto Sans";
  const badTier = { ...value.analysis, slides: [{ ...value.analysis.slides[0], objects: [object] }] };
  await assert.rejects(validateFontInventory(value.root, badTier, value.qa), (error) => error.code === "E_FONT_INVENTORY");

  object.fontSolver.selected.missingGlyphs = ["U+4E00"];
  const missingGlyph = {
    ...value.analysis,
      slides: [{ ...value.analysis.slides[0], typographyTiers: [{
      id: "tier-001", name: "Body", memberRefs: ["text-001"], fontFamily: "Noto Sans", fontWeight: 400,
      baseFontSizePt: 12, evidence: {
        signals: [], memberCount: 1, stableOrder: "object-id-ascending",
        heightDistribution: { min: 12, median: 12, max: 12 },
        inkStrokeProxy: { inkBboxIouMedian: null, localSsimMedian: null, widthErrorMedian: null, targetInkDensityMedian: null, targetInkBboxRatioMedian: null },
        styleColors: [], alignmentProxy: [], alignmentSources: [], layoutGroupRefs: [], repeatedGroupRefs: []
      }
      }], objects: [{ ...object, typographyTierRef: "tier-001", style: { fontFamily: "Noto Sans", fontWeight: 400 }, fontSolver: { ...object.fontSolver, tier: "Body" } }] }]
  };
  await assert.rejects(validateFontInventory(value.root, missingGlyph, value.qa), (error) => error.code === "E_FONT_RUNTIME");
});

test("validator rejects font truth, representative, and evaluated-array tampering", async () => {
  const value = await fixture();
  const mutations = [
    (analysis) => { analysis.slides[0].objects[0].fontSolver.selected.fontSizePt = 13; },
    (analysis) => { analysis.slides[0].objects[0].fontSolver.selected.weight = 500; },
    (analysis) => { analysis.slides[0].objects[0].fontSolver.selected.charSpacingPt = 1; },
    (analysis) => { analysis.slides[0].objects[0].fontSolver.selected.lineHeightPt = 15; },
    (analysis) => { analysis.slides[0].objects[0].fontSolver.selected.textBoxWidthScale = 1.2; },
    (analysis) => { analysis.slides[0].objects[0].fontSolver.representativeObjectId = "text-other"; },
    (analysis) => { analysis.slides[0].objects[0].fontSolver.evaluatedSizes = []; },
    (analysis) => { analysis.slides[0].typographyTiers[0].memberRefs = []; }
  ];
  for (const mutate of mutations) {
    const analysis = validTextAnalysis(value);
    mutate(analysis);
    await assert.rejects(validateFontInventory(value.root, analysis, value.qa, value.render), (error) => ["E_FONT_INVENTORY", "E_FONT_RUNTIME"].includes(error.code));
  }
});

test("validator accepts a selection alias whose face renders with actual family truth", async () => {
  const value = await fixture();
  const alias = "Selection Alias";
  value.value.candidateFamilies = [alias];
  value.value.faces[0].selectionFamily = alias;
  await writeFile(join(value.root, "reports/font-inventory.json"), `${JSON.stringify(value.value, null, 2)}\n`);
  const ref = { path: value.ref.path, sha256: digest(value.value) };
  const analysis = validTextAnalysis({ ...value, ref });
  analysis.fontInventoryRef = ref;
  analysis.slides[0].fontInventoryRef = ref;
  analysis.slides[0].objects[0].fontSolver.selected.selectionFamily = alias;
  value.qa.fontInventory = ref;
  value.render.fontInventory = ref;
  await assert.doesNotReject(validateFontInventory(value.root, analysis, value.qa, value.render));
});

test("calibration applies measured text box deltas without a fixed width multiplier", () => {
  const analysis = {
    deck: { size: { widthPx: 320, heightPx: 180 } },
    slides: [{
      id: "slide-001",
      sizePx: { width: 320, height: 180 },
      objects: [{
        id: "text-001",
        type: "text",
        pixelBox: { x: 20, y: 20, w: 100, h: 30 },
        renderBox: { x: 20, y: 20, w: 100, h: 30 },
        style: { fontSizePt: 12, charSpacingPt: 0 }
      }]
    }]
  };
  const result = applyCalibration(analysis, {
    calibration: [{ slideId: "slide-001", adjustments: [{ id: "text-001", category: "text", sourceBound: true, dw: 12, dh: 4 }] }]
  });
  assert.equal(result.changes, 1);
  assert.deepEqual(result.analysis.slides[0].objects[0].renderBox, { x: 20, y: 20, w: 112, h: 34 });
});
