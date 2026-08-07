import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const schemaPath = new URL("../schemas/analysis.schema.json", import.meta.url);
const fixtureManifestPath = new URL("./fixtures/object-level-benchmark/manifest.json", import.meta.url);
const fixtureTruthPath = new URL("./fixtures/object-level-benchmark/ground-truth.json", import.meta.url);
const plannerScriptsDir = fileURLToPath(new URL("../scripts/", import.meta.url));

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

function box(x, y, w, h) {
  return { x, y, w, h };
}

function base(id, type, pixelBox, z = 0) {
  return { id, type, pixelBox, confidence: 1, z, factStatus: "observed" };
}

function ownershipReport() {
  const classRecord = {
    pixelCount: 0,
    share: 0,
    maskDigest: "a".repeat(64),
    path: "reports/ownership/slide-001-background.png"
  };
  return {
    version: "1.0.0",
    status: "passed",
    coordinateSpace: "normalized-page-px",
    sizePx: { width: 1280, height: 720 },
    tolerancePx: 2,
    algorithm: "native-claims-then-residual-components",
    backgroundColor: "#F7F9FC",
    sourceRef: "source-001",
    source: "observed-ocr-lines-shapes-connectors-candidates",
    totalPixels: 1280 * 720,
    classes: {
      background: classRecord,
      native_text: { ...classRecord, path: "reports/ownership/slide-001-native_text.png" },
      native_shape: { ...classRecord, path: "reports/ownership/slide-001-native_shape.png" },
      raster_asset: { ...classRecord, path: "reports/ownership/slide-001-raster_asset.png" },
      unresolved: { ...classRecord, path: "reports/ownership/slide-001-unresolved.png" }
    },
    conflictPixels: 0,
    rasterNativeOverlapPixels: 0,
    duplicateVisibleContent: 0,
    unassignedPixels: 0,
    unassignedShare: 0,
    unassignedBudget: 0,
    unionPixels: 1280 * 720,
    assets: []
  };
}

function fontEvidence() {
  return {
    version: "font-fit-v1",
    metricVersion: "font-fit-metrics-v1",
    dpi: 96,
    ptToPx: 96 / 72,
    tier: "Display Title",
    tierEvidence: "role:title",
    representativeReuse: false,
    representativeTierRef: "Display Title",
    representativeObjectId: "text-001",
    alignmentProxy: "left",
    alignmentSource: "explicit",
    alignmentEvidence: "line.align",
    candidateCaps: { families: 6, sizes: 5, weights: 3, spacing: 3, lineHeight: 4, boxWidth: 4, layoutTuples: 4 },
    budget: { pageLimit: 180, pageEvaluated: 1, lineLimit: 36, lineEvaluated: 1 },
    selected: {
      family: "Arial",
      selectionFamily: "Arial",
      actualFamily: "Arial",
      faceId: "face-test",
      faceDigest: "a".repeat(64),
      fontSizePt: 24,
      requestedWeight: 700,
      weight: 700,
      actualWeightClass: 700,
      charSpacingPt: 0,
      lineHeightPt: 30,
      textBoxWidthScale: 1,
      textBoxWidthPx: 420,
      renderedLineCount: 2,
      lineBreaks: ["Two lines", "remain editable"],
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
    },
    evaluatedCandidates: 1,
    evaluatedFamilies: ["Arial"],
    evaluatedFaceIds: ["face-test"],
    evaluatedSizes: [24],
    evaluatedRequestedWeights: [700],
    evaluatedSpacings: [0],
    evaluatedLineHeights: [30],
    evaluatedTextBoxWidthScales: [1],
    layout: {
      renderedLineCount: 2,
      lineBreaks: ["Two lines", "remain editable"],
      textBoxWidthPx: 420,
      lineHeightPt: 30,
      provenance: "selected-font-layout"
    },
    targetMetrics: { targetInkDensity: 0.1, targetInkBboxRatio: 0.5, provenance: "current-line-observation" },
    deferredCandidates: 0,
    deferredReason: null
  };
}

function fontInventoryRef() {
  return { path: "reports/font-inventory.json", sha256: "f".repeat(64) };
}

function reconstructionPlan() {
  const objectRefs = ["shape-001", "text-001", "connector-001", "table-001", "chart-001", "icon-001", "image-001", "group-001"];
  const weights = { visualMismatch: 4, ocrCer: 3, bboxIoU: 2, normalizedMAE: 1.5, rasterAreaShare: 1, objectComplexity: 0.5, overlapPenalty: 1, provenancePenalty: 1 };
  const candidate = (strategy, eligible = true) => ({
    id: `slide-001-region-001-${strategy}`,
    strategy,
    objectRefs,
    assetRefs: [],
    pixelBox: box(0, 0, 1280, 720),
    ownershipClasses: ["native_shape", "native_text"],
    maskRefs: [],
    zRange: { min: 0, max: 7 },
    geometryDigest: "0".repeat(64),
    provenance: { sourceRefs: ["source-001"], sourceDigests: ["1".repeat(64)], assetDigests: [], status: "observed-or-recognized-source-bound" },
    editability: { level: strategy === "native-all" ? 5 : strategy === "native-plus-local-assets" ? 4 : 2, mode: "test", rasterObjectCount: strategy === "native-all" ? 0 : 1 },
    metrics: { estimatedFrom: "analysis", regionSSIM: 0.9, ocrCER: 0, bboxIoU: 0.9, normalizedMAE: 0.1 },
    lossBreakdown: { version: "1.0.0", estimatedFrom: "analysis", values: { visualMismatch: 0.1, ocrCer: 0, bboxIoU: 0.9, normalizedMAE: 0.1, rasterAreaShare: 0, objectComplexity: 0.1, overlapPenalty: 0, provenancePenalty: 0 }, weights, total: 0.9 },
    gateResults: [
      "ownership-conflict", "unassigned-pixel-budget", "route-object-coverage", "hybrid-asset-present",
      "bounded-asset-present", "near-whole-slide-raster", "large-region-raster",
      "raster-high-confidence-text-overlap", "native-image-decomposition", "observed-content-only",
      "structured-content-traceability", "asset-provenance"
    ].map((id) => ({ id, passed: eligible, blocking: true, detail: "test" })),
    eligible
  });
  const page = {
    version: "1.0.0",
    slideId: "slide-001",
    lossConfig: { version: "1.0.0", weights, estimatedFrom: "analysis", regionRasterMaxShare: 0.35, nearWholeRasterShare: 0.65 },
    regions: [{ id: "slide-001-region-001", role: "card-or-native-group", pixelBox: box(0, 0, 1280, 720), assignedObjectRefs: objectRefs, assignedAssetRefs: [], unassignedObjectRefs: [], candidates: [candidate("native-all"), candidate("native-plus-local-assets"), candidate("bounded-raster")], winnerId: "slide-001-region-001-native-all" }],
    pageGates: [
      "region-ownership-unique", "page-object-coverage", "page-asset-coverage",
      "selected-object-coverage", "selected-asset-coverage"
    ].map((id) => ({ id, passed: true, blocking: true, detail: "test" })),
    selectedObjectRefs: objectRefs,
    selectedAssetRefs: [],
    coverage: { objectRefs, assetRefs: [], unassignedObjectRefs: [], unassignedAssetRefs: [], duplicateObjectRefs: [], duplicateAssetRefs: [] },
    repairSafety: {
      status: "passed",
      outOfBoundsObjectRefs: [],
      rasterNativeOverlapObjectRefs: [],
      duplicateRouteClaims: [],
      ownershipConflict: false,
      checkedObjectCount: objectRefs.length,
      checkedAssetCount: 0
    },
    provenance: { sourceRefs: ["source-001"], sourceDigests: ["1".repeat(64)], ownershipVersion: "1.0.0" }
  };
  return page;
}

function analysisFixture() {
  const shape = {
    ...base("shape-001", "shape", box(0, 0, 1280, 720)),
    shape: "rect",
    fill: true,
    color: "#12263A",
    borderWidthPx: 0,
    rotationDeg: 12,
    opacity: 0.62,
    transparency: 38,
    gradient: {
      type: "linear",
      angle: 135,
      stops: [{ position: 0, color: "#12263A" }, { position: 100, color: "#2F80ED", transparency: 20 }]
    },
    relations: { contains: [], overlaps: ["text-001"], occludes: ["text-001"], anchors: [] },
    recoverability: {
      status: "native",
      confidence: 0.93,
      renderedAs: "native-shape",
      reason: "bounded vector geometry"
    }
  };
  const text = {
    ...base("text-001", "text", box(64, 40, 420, 70), 1),
    text: "Two lines\nremain editable",
    runs: [
      { text: "Two lines", bold: true },
      { text: "\nremain editable", italic: true }
    ],
    renderBox: box(64, 36, 500, 90),
    style: {
      fontFamily: "Arial",
      fontSizePt: 24,
      color: "#FFFFFF",
      bold: true,
      charSpacingPt: 0,
      lineCount: 2,
      lineHeightPt: 30,
      align: "left",
      valign: "top",
      wrap: true
    },
    fontSolver: fontEvidence(),
    fontInventoryRef: "reports/font-inventory.json",
    typographyTierRef: "typography-tier-display-title"
  };
  const connector = {
    ...base("connector-001", "connector", box(580, 120, 220, 4), 2),
    color: "#829AB1",
    widthPx: 2,
    direction: "horizontal",
    sourceId: "shape-001",
    targetId: "table-001"
  };
  const table = {
    ...base("table-001", "table", box(64, 200, 420, 180), 3),
    rows: [["Region", "Share"], ["North", "42%"]],
    headerRows: 1,
    columns: 2,
    color: "#64748B",
    fillColor: "#FFFFFF",
    textColor: "#172033",
    fontFamily: "Arial",
    fontSizePt: 12
  };
  const chart = {
    ...base("chart-001", "chart", box(600, 180, 560, 280), 4),
    chartType: "bar",
    series: [{ id: "series-001", label: "Visible bars", factStatus: "inferred" }],
    dataPolicy: "source-provided",
    sourceData: true,
    sourceRef: "source-001",
    sourceSha256: "1".repeat(64),
    data: [{ name: "Visible bars", labels: ["Q1", "Q2"], values: [12, 18] }],
    categories: ["Q1", "Q2"],
    legend: false
  };
  const icon = {
    ...base("icon-001", "icon", box(500, 40, 48, 48), 5),
    iconKind: "star",
    color: "#F6C85F",
    filled: true
  };
  const image = {
    ...base("image-001", "image", box(900, 40, 180, 100), 6),
    asset: "assets/local.png",
    reason: "bounded-complex-region",
    crop: { type: "crop", x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    transparency: 15
  };
  const group = {
    ...base("group-001", "group", box(40, 20, 520, 120), 7),
    children: ["shape-001", "text-001"]
  };
  const plan = reconstructionPlan();
  return {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: {
      id: "deck-001",
      title: "Strict scene IR",
      size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 }
    },
    ocr: {
      engine: "test",
      version: "1",
      langs: "eng",
      threshold: 0.7,
      policy: "visible text only",
      provider: {
        name: "tesseract",
        contract: "OcrProvider",
        wholePagePsm: 11,
        regionPsms: [6, 7, 8, 10, 13],
        optionalProviders: [{ name: "paddle-layout", contract: "LayoutProvider", status: "not-installed", network: false }]
      }
    },
    sources: [{
      id: "source-001",
      kind: "user-image",
      path: "sources/source.png",
      sha256: "0".repeat(64),
      normalizedPath: "evidence/reference/source.png",
      normalizedSha256: "1".repeat(64)
    }],
    reconstructionPlan: {
      version: "1.0.0",
      kind: "image-reconstruction-plan",
      pages: [plan],
      lossConfig: { version: "1.0.0", estimatedFrom: "analysis" },
      provenance: { sourceRefs: ["source-001"], planner: "deterministic-region-candidate-selector" }
    },
    reconstructionPlanRef: { path: "reports/reconstruction-plan.json", sha256: "2".repeat(64) },
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Strict scene IR",
      sourceRef: "source-001",
      background: "#F7F9FC",
      sizePx: { width: 1280, height: 720 },
      ownershipReport: ownershipReport(),
      fontInventoryRef: fontInventoryRef(),
      reconstructionPlan: plan,
      typographyTiers: [{
        id: "typography-tier-display-title",
        name: "Display Title",
        memberRefs: ["text-001"],
        fontFamily: "Arial",
        fontWeight: 700,
        baseFontSizePt: 24,
        lineHeightPt: 30,
        textBoxWidthScale: 1,
        align: "left",
        faceId: "face-test",
        evidence: {
          signals: [{ name: "role:title", count: 1 }],
          memberCount: 1,
          stableOrder: "object-id-ascending",
          heightDistribution: { min: 70, median: 70, max: 70 },
          inkStrokeProxy: { inkBboxIouMedian: 0.8, localSsimMedian: 0.8, widthErrorMedian: 0.1, targetInkDensityMedian: 0.1, targetInkBboxRatioMedian: 0.5 },
          styleColors: [{ value: "#FFFFFF", count: 1 }],
          alignmentProxy: [{ value: "left", count: 1 }],
          alignmentSources: [{ value: "explicit", count: 1 }],
          layoutGroupRefs: [],
          repeatedGroupRefs: []
        }
      }],
      objects: [shape, text, connector, table, chart, icon, image, group],
      pageProfile: {
        version: "1.0.0",
        pageType: "data-report",
        confidence: 0.82,
        textDensity: 0.08,
        flatColorRatio: 0.22,
        photoRatio: 0,
        repeatedComponentScore: 0.2,
        layoutComplexity: 0.52,
        metricEvidence: [{ signal: "classification", value: "table-chart-evidence", source: "test" }],
        density: { score: 0.3, textAreaShare: 0.08, objectAreaShare: 0.22, boundedRasterAreaShare: 0, objectCount: 8, textLineCount: 2 },
        complexity: { score: 0.52, level: "medium", evidence: [{ signal: "objectCount", value: 8, source: "test" }] },
        evidence: [{ signal: "classification", value: "table-chart-evidence", source: "test" }],
        recommendedStrategies: ["native-all"],
        factStatus: "inferred",
        provenance: "test"
      },
      regionProfiles: [{
        id: "slide-001-region-001",
        role: "card-or-native-group",
        box: box(40, 20, 520, 120),
        pixelBox: box(40, 20, 520, 120),
        memberIds: ["shape-001", "text-001"],
        objectRefs: ["shape-001", "text-001"],
        layoutGroupRef: "layout-group-001",
        objectCount: 2,
        density: { score: 0.2, areaShare: 0.08, objectCount: 2, memberAreaShare: 0.1 },
        complexity: { score: 0.5, level: "medium", evidence: [{ signal: "memberIds", value: ["shape-001", "text-001"], source: "test" }] },
        confidence: 0.8,
        candidateStrategies: ["native-all"],
        sourceRef: "source-001",
        factStatus: "inferred",
        provenance: "test"
      }],
      degradations: []
    }],
    designTokens: {
      version: "1.0.0",
      source: "test",
      colors: { background: "#F7F9FC", primary: "#12263A", palette: ["#F7F9FC", "#12263A"] },
      typography: { primary: "Arial", fallbacks: ["Noto Sans"], solver: { version: "font-fit-v1" } },
      page: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 }
    },
    fontInventoryRef: fontInventoryRef(),
    degradations: [],
    editabilityTarget: { minimumLevel: 3, wholeSlideRasterAllowed: false }
  };
}

test("object benchmark manifest and truth are stable and source-bound", async () => {
  const manifest = await readJson(fixtureManifestPath);
  const truth = await readJson(fixtureTruthPath);
  assert.equal(manifest.kind, "image-to-pptx-object-benchmark");
  assert.equal(manifest.id, truth.id);
  assert.equal(manifest.fixture.image, "reference.png");
  assert.equal(manifest.fixture.groundTruth, "ground-truth.json");
  assert.equal(manifest.deterministic.network, false);
  assert.equal(manifest.deterministic.model, null);
  assert.ok(truth.objects.length >= 15);
  const ids = truth.objects.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of truth.objects) {
    assert.match(item.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(["shape", "text", "chart", "table", "icon"].includes(item.type));
    assert.deepEqual(Object.keys(item.box).sort(), ["h", "unit", "w", "x", "y"]);
    assert.equal(item.box.unit, "px");
    assert.ok(item.box.w > 0 && item.box.h > 0);
    assert.ok(Number.isInteger(item.z) && item.z >= 0);
    assert.equal(typeof item.style, "object");
    assert.equal(typeof item.relations, "object");
    assert.equal(typeof item.recoverability, "object");
  }
});

test("analysis schema accepts current objects and rich scene attributes", async () => {
  const schema = await readJson(schemaPath);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  const value = analysisFixture();
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));

  const unknown = structuredClone(value);
  unknown.slides[0].objects[0].unexpected = true;
  assert.equal(validate(unknown), false);

  const invalidRotation = structuredClone(value);
  invalidRotation.slides[0].objects[0].rotationDeg = 361;
  assert.equal(validate(invalidRotation), false);

  const unboundChart = structuredClone(value);
  delete unboundChart.slides[0].objects.find((item) => item.type === "chart").sourceSha256;
  assert.equal(validate(unboundChart), false);

  const nullRepresentativeRef = structuredClone(value);
  nullRepresentativeRef.slides[0].objects.find((item) => item.type === "text").fontSolver.representativeTierRef = null;
  assert.equal(validate(nullRepresentativeRef), false);

  const missingLayout = structuredClone(value);
  delete missingLayout.slides[0].objects.find((item) => item.type === "text").fontSolver.layout;
  assert.equal(validate(missingLayout), false);

  const incompleteTier = structuredClone(value);
  delete incompleteTier.slides[0].typographyTiers[0].faceId;
  assert.equal(validate(incompleteTier), false);

  const missingPlan = structuredClone(value);
  delete missingPlan.reconstructionPlan;
  assert.equal(validate(missingPlan), false);

  const extraPlanField = structuredClone(value);
  extraPlanField.reconstructionPlan.unexpected = true;
  assert.equal(validate(extraPlanField), false);
});

test("analysis schema accepts a complete page emitted by the deterministic Python planner", async (t) => {
  const schema = await readJson(schemaPath);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  const digest = "1".repeat(64);
  const plannerInput = {
    slideId: "slide-001",
    pageSize: [1280, 720],
    regionProfiles: [{
      id: "slide-001-region-001",
      role: "decor",
      pixelBox: box(40, 20, 520, 120),
      objectRefs: ["shape-001"],
      complexity: { score: 0 }
    }],
    objects: [{
      id: "shape-001",
      type: "shape",
      pixelBox: box(40, 20, 520, 120),
      z: 0,
      factStatus: "observed",
      sourceRef: "source-001"
    }],
    ownershipReport: {
      version: "1.0.0",
      status: "passed",
      conflictPixels: 0,
      rasterNativeOverlapPixels: 0,
      duplicateVisibleContent: 0,
      unassignedShare: 0,
      unassignedBudget: 0,
      assets: [],
      classes: {}
    },
    sources: [{ id: "source-001", sha256: digest, normalizedSha256: digest }]
  };
  const plannerCode = [
    "import json, sys",
    "from reconstruction_planner import build_reconstruction_plan",
    "value = json.load(open(sys.argv[1], encoding='utf-8'))",
    "print(json.dumps(build_reconstruction_plan(value['slideId'], tuple(value['pageSize']), value['regionProfiles'], value['objects'], value['ownershipReport'], value['sources']), sort_keys=True))"
  ].join("; ");
  const temporary = await mkdtemp(join(tmpdir(), "image-to-pptx-planner-schema-"));
  const inputPath = join(temporary, "planner-input.json");
  await writeFile(inputPath, JSON.stringify(plannerInput));
  let plan;
  try {
    plan = JSON.parse(execFileSync("python3", ["-c", plannerCode, inputPath], {
      cwd: plannerScriptsDir,
      encoding: "utf8"
    }));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error?.code === "EPERM") {
      t.skip("Python child processes are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  await rm(temporary, { recursive: true, force: true });
  const value = analysisFixture();
  value.reconstructionPlan.pages = [plan];
  value.slides[0].reconstructionPlan = plan;
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
});
