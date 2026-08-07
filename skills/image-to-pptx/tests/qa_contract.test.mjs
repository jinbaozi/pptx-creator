import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateRenderSize, validateRuntimeReport } from "../scripts/validate_output.mjs";

const schemaPath = fileURLToPath(new URL("../schemas/qa-report.schema.json", import.meta.url));
const validator = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(validator);
const validateQa = validator.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

function runtime() {
  const versioned = (version) => ({ status: "available", version });
  return {
    renderer: { name: "render_preview", version: "2.0", engine: "libreoffice+pdftoppm" },
    libreoffice: { command: "/usr/bin/soffice", ...versioned("LibreOffice 24.2") },
    poppler: { command: "/usr/bin/pdftoppm", ...versioned("pdftoppm version 24.2") },
    tesseract: { command: "/usr/bin/tesseract", ...versioned("tesseract 5.3") },
    python: { status: "available", executable: "/usr/bin/python3", version: "3.12.0" },
    libraries: {
      Pillow: versioned("10.4.0"),
      pytesseract: versioned("0.3.13"),
      numpy: versioned("2.1.0"),
      "scikit-image": versioned("0.24.0"),
      fontTools: versioned("4.55.0")
    }
  };
}

function qa() {
  const runtimeReport = runtime();
  return {
    version: "1.0.0",
    status: "passed",
    gate: "image-native-reconstruction",
    thresholds: {},
    slideCount: 1,
    attemptsUsed: 0,
    maxRepairAttempts: 3,
    reconstructionPlanRef: { path: "reports/reconstruction-plan.json", sha256: "e".repeat(64) },
    render: {
      engine: "libreoffice+pdftoppm",
      requestedSize: { width: 1280, height: 720, unit: "px" },
      report: "reports/render-report.json"
    },
    visual: {
      status: "passed",
      aggregate: { ssim: 0.95 },
      ssim: {
        metric: "pptx-creator-ssim",
        version: "2.0",
        configuration: {
          implementation: "skimage.structural_similarity",
          dataRange: 255,
          gaussianWeights: true,
          sigma: 1.5,
          useSampleCovariance: false,
          channelAxis: 2
        }
      },
      report: "reports/visual-report.json"
    },
    runtime: runtimeReport,
    fonts: [{ requested: "Arial", status: "unavailable", matched: null }],
    fontInventory: { path: "reports/font-inventory.json", sha256: "f".repeat(64) },
    editability: {},
    ownership: {
      status: "passed",
      report: "analysis.json",
      conflictPixels: 0,
      rasterNativeOverlapPixels: 0,
      duplicateVisibleContent: 0,
      unassignedPixels: 0
    },
    repairSafety: {
      status: "passed",
      report: "analysis.json",
      pages: [{
        slideId: "slide-001",
        status: "passed",
        outOfBoundsObjectRefs: [],
        rasterNativeOverlapObjectRefs: [],
        duplicateRouteClaims: [],
        ownershipConflict: false,
        checkedObjectCount: 0,
        checkedAssetCount: 0
      }]
    },
    repairHistory: [{
      round: 0,
      iteration: 0,
      actions: [],
      stepAccepted: false,
      selectedForNextRound: false,
      finalQualityPassed: true,
      accepted: false,
      rejectionReason: null,
      candidateRef: { path: "reports/attempt-0/candidate.pptx", sha256: "a".repeat(64) },
      analysisRef: { path: "reports/attempt-0/analysis.json", sha256: "d".repeat(64) },
      visualReportRef: { path: "reports/attempt-0/visual-report.json", sha256: "b".repeat(64) },
      renderReportRef: { path: "reports/attempt-0/render-report.json", sha256: "e".repeat(64) },
      editabilityReportRef: { path: "reports/attempt-0/editability-report.json", sha256: "c".repeat(64) },
      reconstructionPlanRef: { path: "reports/reconstruction-plan.json", sha256: "e".repeat(64) },
      score: 0,
      visualStatus: "passed",
      editabilityLevel: 3,
      status: "baseline",
      beamEvaluations: []
    }],
    degradations: [],
    findings: [],
    artifacts: {}
  };
}

test("QA schema requires SSIM v2 metadata and structured runtime evidence", () => {
  const value = qa();
  assert.equal(validateQa(value), true);

  const missingSsim = qa();
  delete missingSsim.visual.ssim;
  assert.equal(validateQa(missingSsim), false);

  const missingRuntime = qa();
  delete missingRuntime.runtime.libraries.numpy;
  assert.equal(validateQa(missingRuntime), false);

  const missingPlanLineage = qa();
  delete missingPlanLineage.reconstructionPlanRef;
  assert.equal(validateQa(missingPlanLineage), false);

  const missingAttemptLineage = qa();
  delete missingAttemptLineage.repairHistory[0].analysisRef;
  assert.equal(validateQa(missingAttemptLineage), false);

  const missingActionEvidence = qa();
  missingActionEvidence.repairHistory[0].actions = [{ sourceBound: false }];
  assert.equal(validateQa(missingActionEvidence), false);
});

test("output contract rejects incomplete runtime and exact-size mismatches", () => {
  assert.throws(
    () => validateRuntimeReport({ renderer: { name: "render_preview", version: "2.0", engine: "libreoffice+pdftoppm" } }),
    (error) => error.code === "E_CONTRACT"
  );
  const analysis = { deck: { size: { widthPx: 1280, heightPx: 720 } } };
  assert.throws(
    () => validateRenderSize({ requestedSize: { width: 1279, height: 720, unit: "px" } }, analysis),
    (error) => error.code === "E_RENDER_SIZE_MISMATCH"
  );
});
