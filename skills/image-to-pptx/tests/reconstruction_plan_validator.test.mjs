import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { reconstructionGeometryDigest, validateReconstructionPlan } from "../scripts/validate_output.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);
const planError = (error) => error.code === "E_RECONSTRUCTION_PLAN" || error.code === "E_RECONSTRUCTION_OWNERSHIP";

async function writePlanReport(root, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(root, "reconstruction-plan.json"), serialized);
  return { path: "reconstruction-plan.json", sha256: digest(serialized) };
}

function candidate(strategy) {
  const weights = { visualMismatch: 4, ocrCer: 3, bboxIoU: 2, normalizedMAE: 1.5, rasterAreaShare: 1, objectComplexity: 0.5, overlapPenalty: 1, provenancePenalty: 1 };
  const valuesByStrategy = {
    "native-all": { visualMismatch: 0.06, ocrCer: 0, bboxIoU: 0.96, normalizedMAE: 0.04, rasterAreaShare: 0, objectComplexity: 0, overlapPenalty: 0, provenancePenalty: 0 },
    "native-plus-local-assets": { visualMismatch: 0.09, ocrCer: 0, bboxIoU: 0.95, normalizedMAE: 0.05, rasterAreaShare: 0, objectComplexity: 0, overlapPenalty: 0, provenancePenalty: 0 },
    "bounded-raster": { visualMismatch: 0.22, ocrCer: 0, bboxIoU: 0.9, normalizedMAE: 0.08, rasterAreaShare: 0, objectComplexity: 0, overlapPenalty: 0, provenancePenalty: 0 }
  };
  const values = valuesByStrategy[strategy];
  const total = Number((weights.visualMismatch * values.visualMismatch
    + weights.ocrCer * values.ocrCer
    + weights.bboxIoU * (1 - values.bboxIoU)
    + weights.normalizedMAE * values.normalizedMAE).toFixed(8));
  const gateIds = [
    "ownership-conflict", "unassigned-pixel-budget", "route-object-coverage", "hybrid-asset-present",
    "bounded-asset-present", "near-whole-slide-raster", "large-region-raster",
    "raster-high-confidence-text-overlap", "native-image-decomposition", "observed-content-only",
    "structured-content-traceability", "asset-provenance"
  ];
  const passed = {
    "ownership-conflict": true,
    "unassigned-pixel-budget": true,
    "route-object-coverage": strategy !== "bounded-raster",
    "hybrid-asset-present": strategy !== "native-plus-local-assets",
    "bounded-asset-present": strategy !== "bounded-raster",
    "near-whole-slide-raster": true,
    "large-region-raster": true,
    "raster-high-confidence-text-overlap": true,
    "native-image-decomposition": true,
    "observed-content-only": true,
    "structured-content-traceability": true,
    "asset-provenance": true
  };
  return {
    id: `region-001-${strategy}`,
    strategy,
    objectRefs: ["shape-001"],
    assetRefs: [],
    pixelBox: { x: 20, y: 20, w: 100, h: 80 },
    ownershipClasses: ["native_shape"],
    maskRefs: [],
    zRange: { min: 0, max: 0 },
    geometryDigest: reconstructionGeometryDigest([{
      id: "shape-001",
      type: "shape",
      pixelBox: { x: 20, y: 20, w: 100, h: 80 },
      z: 0,
      factStatus: "observed",
      sourceRef: "source-001"
    }], []),
    provenance: { sourceRefs: ["source-001"], sourceDigests: ["a".repeat(64)], assetDigests: [], status: "observed-or-recognized-source-bound" },
    editability: {
      level: strategy === "native-all" ? 5 : strategy === "native-plus-local-assets" ? 4 : 2,
      mode: strategy === "native-all" ? "fully-native" : strategy === "native-plus-local-assets" ? "native-plus-transparent-local-assets" : "bounded-transparent-local-asset",
      rasterObjectCount: 0
    },
    metrics: {
      estimatedFrom: "analysis",
      regionSSIM: Number((1 - values.visualMismatch).toFixed(6)),
      ocrCER: values.ocrCer,
      bboxIoU: values.bboxIoU,
      normalizedMAE: values.normalizedMAE
    },
    lossBreakdown: {
      version: "1.0.0",
      estimatedFrom: "analysis",
      values,
      weights,
      total
    },
    gateResults: gateIds.map((id) => ({ id, passed: passed[id], blocking: true, detail: "test" })),
    eligible: Object.values(passed).every(Boolean)
  };
}

function analysisForPlan(plan, ref, regionProfiles = [{ id: "region-001", role: "decor", pixelBox: { x: 20, y: 20, w: 100, h: 80 }, objectRefs: ["shape-001"] }]) {
  return {
    reconstructionPlan: plan,
    reconstructionPlanRef: ref,
    sources: [{ id: "source-001", normalizedSha256: "a".repeat(64), sha256: "a".repeat(64) }],
    slides: [{
    id: "slide-001",
      sourceRef: "source-001",
      sizePx: { width: 1280, height: 720 },
      regionProfiles,
      objects: [{ id: "shape-001", type: "shape", pixelBox: { x: 20, y: 20, w: 100, h: 80 }, z: 0, factStatus: "observed", sourceRef: "source-001" }],
      ownershipReport: { assets: [] },
      reconstructionPlan: plan.pages[0]
    }]
  };
}

function plan() {
  const weights = { visualMismatch: 4, ocrCer: 3, bboxIoU: 2, normalizedMAE: 1.5, rasterAreaShare: 1, objectComplexity: 0.5, overlapPenalty: 1, provenancePenalty: 1 };
  const candidates = [candidate("native-all"), candidate("native-plus-local-assets"), candidate("bounded-raster")];
  const pageGateIds = [
    "region-ownership-unique", "page-object-coverage", "page-asset-coverage",
    "selected-object-coverage", "selected-asset-coverage"
  ];
  return {
    version: "1.0.0",
    kind: "image-reconstruction-plan",
    pages: [{
      version: "1.0.0",
      slideId: "slide-001",
      lossConfig: { version: "1.0.0", weights, estimatedFrom: "analysis", regionRasterMaxShare: 0.35, nearWholeRasterShare: 0.65 },
      regions: [{ id: "region-001", role: "decor", pixelBox: { x: 20, y: 20, w: 100, h: 80 }, assignedObjectRefs: ["shape-001"], assignedAssetRefs: [], unassignedObjectRefs: [], candidates, winnerId: "region-001-native-all" }],
      pageGates: pageGateIds.map((id) => ({ id, passed: true, blocking: true, detail: "test" })),
      selectedObjectRefs: ["shape-001"],
      selectedAssetRefs: [],
      coverage: { objectRefs: ["shape-001"], assetRefs: [], unassignedObjectRefs: [], unassignedAssetRefs: [], duplicateObjectRefs: [], duplicateAssetRefs: [] },
      repairSafety: {
        status: "passed",
        outOfBoundsObjectRefs: [],
        rasterNativeOverlapObjectRefs: [],
        duplicateRouteClaims: [],
        ownershipConflict: false,
        checkedObjectCount: 1,
        checkedAssetCount: 0
      },
      provenance: { sourceRefs: ["source-001"], sourceDigests: ["a".repeat(64)], ownershipVersion: "1.0.0" }
    }],
    lossConfig: { version: "1.0.0", estimatedFrom: "analysis" },
    provenance: { sourceRefs: ["source-001"], planner: "deterministic-region-candidate-selector" }
  };
}

test("reconstruction validator rejects plan/report tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-validator-"));
  const value = plan();
  const ref = await writePlanReport(root, value);
  await assert.doesNotReject(validateReconstructionPlan(root, analysisForPlan(value, ref)));

  const tampered = structuredClone(value);
  tampered.pages[0].regions[0].winnerId = "region-001-bounded-raster";
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(tampered, ref)), (error) => error.code === "E_RECONSTRUCTION_PLAN");
});

test("reconstruction validator requires repair safety and geometry digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-required-evidence-"));
  const missingSafety = plan();
  delete missingSafety.pages[0].repairSafety;
  const missingSafetyRef = await writePlanReport(root, missingSafety);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(missingSafety, missingSafetyRef)), (error) => error.code === "E_RECONSTRUCTION_OWNERSHIP" || error.code === "E_RECONSTRUCTION_PLAN");

  const missingDigest = plan();
  delete missingDigest.pages[0].regions[0].candidates[0].geometryDigest;
  const missingDigestRef = await writePlanReport(root, missingDigest);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(missingDigest, missingDigestRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");
});

test("geometry digest canonicalization matches Python across ECMAScript exponent boundaries", async () => {
  const objects = [{
    id: "text-中文",
    type: "text",
    z: 12.0,
    pixelBox: { x: 10.0, y: -0.0, w: 240.0, h: 48.5 },
    renderBox: { x: 10, y: 12.0, w: 240, h: 60 },
    text: "中文标题",
    style: { fontSizePt: 12.0, nested: {
      lineHeightPt: 18.0,
      decimalBoundary: 1e-6,
      decimalBoundaryFraction: 1.2e-6,
      small: 1e-7,
      largeDecimal: 1e20,
      large: 1e21,
      negZero: -0.0,
      colors: ["#112233", "#445566"]
    } }
  }];
  const assets = [{ objectId: "image-001", pagePixelBox: { x: 1.0, y: 2, w: 30.0, h: 40 }, originPagePixelBox: { x: 1.0, y: 2, w: 30.0, h: 40 }, sourceRef: "source-中文", sourceDigest: "a".repeat(64), normalizedSourceDigest: "a".repeat(64) }];
  const pythonCode = [
    "import json, sys",
    "from reconstruction_planner import _geometry_digest",
    "value=json.loads(sys.argv[1])",
    "print(_geometry_digest(value['objects'], value['assets']))"
  ].join(";");
  const { stdout } = await execFileAsync(process.env.IMAGE_TO_PPTX_PYTHON || "python3", ["-c", pythonCode, JSON.stringify({ objects, assets })], {
    cwd: new URL("../scripts/", import.meta.url).pathname
  });
  assert.equal(reconstructionGeometryDigest(objects, assets), stdout.trim());
});

test("reconstruction validator rejects digest, gate, loss, and duplicate ownership tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-negative-"));
  const value = plan();
  const validRef = await writePlanReport(root, value);
  await assert.rejects(
    validateReconstructionPlan(root, analysisForPlan(value, { ...validRef, sha256: "f".repeat(64) })),
    (error) => error.code === "E_RECONSTRUCTION_PLAN"
  );

  const gateTampered = structuredClone(value);
  gateTampered.pages[0].regions[0].candidates[0].gateResults[0].passed = false;
  gateTampered.pages[0].regions[0].candidates[0].eligible = true;
  const gateRef = await writePlanReport(root, gateTampered);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(gateTampered, gateRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const lossTampered = structuredClone(value);
  lossTampered.pages[0].regions[0].candidates[0].lossBreakdown.total = 1;
  const lossRef = await writePlanReport(root, lossTampered);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(lossTampered, lossRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const valueAndTotalTampered = structuredClone(value);
  valueAndTotalTampered.pages[0].regions[0].candidates[0].lossBreakdown.values.visualMismatch = 0.99;
  valueAndTotalTampered.pages[0].regions[0].candidates[0].lossBreakdown.total = 99;
  const valueAndTotalRef = await writePlanReport(root, valueAndTotalTampered);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(valueAndTotalTampered, valueAndTotalRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const weightAndTotalTampered = structuredClone(value);
  weightAndTotalTampered.pages[0].regions[0].candidates[0].lossBreakdown.weights.visualMismatch = 99;
  weightAndTotalTampered.pages[0].regions[0].candidates[0].lossBreakdown.total = 99;
  const weightAndTotalRef = await writePlanReport(root, weightAndTotalTampered);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(weightAndTotalTampered, weightAndTotalRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const metricsTampered = structuredClone(value);
  metricsTampered.pages[0].regions[0].candidates[0].metrics.regionSSIM = 0.01;
  const metricsRef = await writePlanReport(root, metricsTampered);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(metricsTampered, metricsRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const rasterCountTampered = structuredClone(value);
  rasterCountTampered.pages[0].regions[0].candidates[0].editability.rasterObjectCount = 7;
  const rasterCountRef = await writePlanReport(root, rasterCountTampered);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(rasterCountTampered, rasterCountRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const duplicateSelected = structuredClone(value);
  duplicateSelected.pages[0].selectedObjectRefs = ["shape-001", "shape-001"];
  const duplicateRef = await writePlanReport(root, duplicateSelected);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(duplicateSelected, duplicateRef)), (error) => error.code === "E_RECONSTRUCTION_PLAN");

  const crossRegion = structuredClone(value);
  const second = structuredClone(crossRegion.pages[0].regions[0]);
  second.id = "region-002";
  second.winnerId = "region-002-native-all";
  second.candidates = second.candidates.map((candidate) => ({ ...candidate, id: candidate.id.replace("region-001", "region-002") }));
  crossRegion.pages[0].regions.push(second);
  const crossRegionRef = await writePlanReport(root, crossRegion);
  await assert.rejects(validateReconstructionPlan(root, analysisForPlan(crossRegion, crossRegionRef)), planError);
});

test("reconstruction validator independently locks page gates, coverage, provenance, and gate status", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-page-gates-"));
  const base = plan();
  const mutations = [
    (value) => { value.pages[0].pageGates[0].id = "page-object-coverage"; },
    (value) => { value.pages[0].pageGates[0].passed = false; },
    (value) => { value.pages[0].coverage.objectRefs = []; },
    (value) => { value.pages[0].coverage.unassignedObjectRefs = ["shape-001"]; },
    (value) => { value.pages[0].provenance.sourceDigests = ["b".repeat(64)]; },
    (value) => { value.provenance.sourceRefs = ["forged-source"]; },
    (value) => { value.provenance.planner = "nondeterministic-planner"; },
    (value) => { value.pages[0].regions[0].candidates[0].provenance.status = "unbound"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(base);
    mutate(value);
    const ref = await writePlanReport(root, value);
    await assert.rejects(validateReconstructionPlan(root, analysisForPlan(value, ref)), planError);
  }
  const failedOwnership = structuredClone(base);
  const failedAnalysis = analysisForPlan(failedOwnership, await writePlanReport(root, failedOwnership));
  failedAnalysis.slides[0].ownershipReport.status = "failed";
  await assert.rejects(validateReconstructionPlan(root, failedAnalysis), planError);
});

test("reconstruction validator accepts planner ownership assignment for overlapping region profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-overlap-"));
  const value = plan();
  const page = value.pages[0];
  const small = page.regions[0];
  small.id = "region-small";
  small.winnerId = "region-small-native-all";
  small.candidates = small.candidates.map((item) => ({ ...item, id: item.id.replace("region-001", "region-small") }));
  const largePixelBox = { x: 0, y: 0, w: 500, h: 400 };
  const largeCandidates = ["native-all", "native-plus-local-assets", "bounded-raster"].map((strategy) => {
    const item = candidate(strategy);
    item.id = `region-large-${strategy}`;
    item.objectRefs = [];
    item.pixelBox = largePixelBox;
    item.ownershipClasses = [];
    item.zRange = { min: 0, max: 0 };
    item.geometryDigest = reconstructionGeometryDigest([], []);
    item.eligible = strategy === "native-all";
    return item;
  });
  page.regions = [{
    id: "region-large",
    role: "decor",
    pixelBox: largePixelBox,
    assignedObjectRefs: [],
    assignedAssetRefs: [],
    unassignedObjectRefs: ["shape-001"],
    candidates: largeCandidates,
    winnerId: "region-large-native-all"
  }, small];
  page.selectedObjectRefs = ["shape-001"];
  page.coverage.objectRefs = ["shape-001"];
  page.coverage.unassignedObjectRefs = [];
  page.pageGates = page.pageGates.map((gate) => ({ ...gate, passed: true }));
  const profiles = [
    { id: "region-large", role: "decor", pixelBox: largePixelBox, objectRefs: ["shape-001"] },
    { id: "region-small", role: "decor", pixelBox: small.pixelBox, objectRefs: ["shape-001"] }
  ];
  const ref = await writePlanReport(root, value);
  await assert.doesNotReject(validateReconstructionPlan(root, analysisForPlan(value, ref, profiles)));
});

test("reconstruction validator keeps page provenance local while report provenance is global", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-page-provenance-"));
  const value = plan();
  const secondPage = structuredClone(value.pages[0]);
  secondPage.slideId = "slide-002";
  secondPage.provenance = { sourceRefs: ["source-002"], sourceDigests: ["b".repeat(64)], ownershipVersion: "1.0.0" };
  secondPage.selectedObjectRefs = ["shape-002"];
  secondPage.coverage.objectRefs = ["shape-002"];
  secondPage.regions = secondPage.regions.map((region) => ({
    ...region,
    id: "region-002",
    assignedObjectRefs: ["shape-002"],
    candidates: region.candidates.map((item) => ({
      ...item,
      id: item.id.replace("region-001", "region-002"),
      objectRefs: ["shape-002"],
      geometryDigest: reconstructionGeometryDigest([{
        id: "shape-002",
        type: "shape",
        pixelBox: { x: 20, y: 20, w: 100, h: 80 },
        z: 0,
        factStatus: "observed",
        sourceRef: "source-002"
      }], []),
      provenance: { ...item.provenance, sourceRefs: ["source-002"], sourceDigests: ["b".repeat(64)] }
    })),
    winnerId: "region-002-native-all"
  }));
  value.pages.push(secondPage);
  value.provenance.sourceRefs = ["source-001", "source-002"];
  const ref = await writePlanReport(root, value);
  const analysis = analysisForPlan(value, ref);
  analysis.sources.push({ id: "source-002", normalizedSha256: "b".repeat(64), sha256: "b".repeat(64) });
  analysis.slides[1] = {
    id: "slide-002",
    sourceRef: "source-002",
    sizePx: { width: 1280, height: 720 },
    regionProfiles: [{ id: "region-002", role: "decor", pixelBox: { x: 20, y: 20, w: 100, h: 80 }, objectRefs: ["shape-002"] }],
    objects: [{ id: "shape-002", type: "shape", pixelBox: { x: 20, y: 20, w: 100, h: 80 }, z: 0, factStatus: "observed", sourceRef: "source-002" }],
    ownershipReport: { assets: [] },
    reconstructionPlan: secondPage
  };
  await assert.doesNotReject(validateReconstructionPlan(root, analysis));
});

test("reconstruction validator rejects asset traversal and digest/source tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-plan-assets-"));
  const value = plan();
  for (const candidate of value.pages[0].regions[0].candidates) {
    candidate.assetRefs = ["asset-001"];
    candidate.provenance.assetDigests = ["b".repeat(64)];
  }
  value.pages[0].selectedAssetRefs = ["asset-001"];
  value.pages[0].coverage.assetRefs = ["asset-001"];
  const analysis = analysisForPlan(value, null);
  analysis.reconstructionPlanRef = await writePlanReport(root, value);
  analysis.sources[0].normalizedSha256 = "a".repeat(64);
  analysis.slides[0].ownershipReport.assets = [{
    objectId: "asset-001",
    asset: "../escape.png",
    mask: "mask.png",
    assetDigest: "b".repeat(64),
    maskDigest: "c".repeat(64),
    sourceRef: "source-001",
    sourceDigest: "a".repeat(64),
    normalizedSourceDigest: "a".repeat(64)
  }];
  await assert.rejects(validateReconstructionPlan(root, analysis), (error) => error.code === "E_CONTRACT" || planError(error));

  const safe = structuredClone(analysis);
  safe.slides[0].ownershipReport.assets[0].asset = "asset.png";
  safe.slides[0].ownershipReport.assets[0].mask = "mask.png";
  await writeFile(join(root, "asset.png"), "asset");
  await writeFile(join(root, "mask.png"), "mask");
  safe.slides[0].ownershipReport.assets[0].assetDigest = digest("asset");
  safe.slides[0].ownershipReport.assets[0].maskDigest = "d".repeat(64);
  safe.reconstructionPlanRef = await writePlanReport(root, safe.reconstructionPlan);
  await assert.rejects(validateReconstructionPlan(root, safe), planError);
});
