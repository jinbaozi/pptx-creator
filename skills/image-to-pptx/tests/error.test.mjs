import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderPptx } from "../scripts/render_pptx.mjs";
import { applyCalibration, boundedRepairBeam, localMetricsImproved, removeIncompleteDelivery, repairHasProgress, summarizeBeamEvaluations } from "../scripts/image-to-pptx.mjs";

const execFileAsync = promisify(execFile);

test("CLI rejects a build without any source image", async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-empty-"));
  const outputDir = join(output, "out");
  let error;
  try {
    await execFileAsync(process.execPath, ["scripts/image-to-pptx.mjs", "build", "--output", outputDir], {
      cwd: new URL("..", import.meta.url).pathname
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "build without inputs must fail");
  assert.equal(error.code, 1);
  // Nested Node processes in the restricted test runner can lose piped
  // stderr; when it is present, retain the stable application error assertion.
  if (error.stderr) assert.match(error.stderr, /E_INPUT_REQUIRED/);
  await assert.rejects(access(outputDir));
});

test("renderer rejects a whole-slide raster fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-raster-"));
  const analysis = {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: { id: "deck", title: "Bad", size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 } },
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Bad",
      sourceRef: "source-001",
      background: "#FFFFFF",
      objects: [{
        id: "cheat",
        type: "image",
        asset: "cheat.png",
        pixelBox: { x: 0, y: 0, w: 1280, h: 720 },
        z: 0
      }],
      reconstructionPlan: { selectedObjectRefs: ["cheat"] }
    }]
  };
  const source = join(directory, "analysis.json");
  await writeFile(source, JSON.stringify(analysis));
  await assert.rejects(
    renderPptx(source, join(directory, "bad.pptx"), null, directory),
    (error) => error.code === "E_WHOLE_SLIDE_FALLBACK"
  );
});

test("renderer rejects a near-whole-slide raster disguised by a small inset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-near-raster-"));
  const analysis = {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: { id: "deck", title: "Bad", size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 } },
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Bad",
      sourceRef: "source-001",
      background: "#FFFFFF",
      objects: [{
        id: "inset-cheat",
        type: "image",
        asset: "cheat.png",
        pixelBox: { x: 16, y: 12, w: 1248, h: 696 },
        z: 0
      }],
      reconstructionPlan: { selectedObjectRefs: ["inset-cheat"] }
    }]
  };
  const source = join(directory, "analysis.json");
  await writeFile(source, JSON.stringify(analysis));
  await assert.rejects(
    renderPptx(source, join(directory, "bad.pptx"), null, directory),
    (error) => error.code === "E_WHOLE_SLIDE_FALLBACK"
  );
});

test("bounded calibration accepts text, shape, image, background, and z-order repairs", () => {
  const analysis = {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: { size: { widthPx: 1280, heightPx: 720 } },
    slides: [{
      id: "slide-001",
      sizePx: { width: 1280, height: 720 },
      background: "#FFFFFF",
      objects: [
        { id: "text-001", type: "text", pixelBox: { x: 100, y: 100, w: 120, h: 24 }, renderBox: { x: 90, y: 90, w: 220, h: 40 }, style: { fontSizePt: 20, charSpacingPt: 0 }, z: 1 },
        { id: "shape-001", type: "shape", pixelBox: { x: 200, y: 200, w: 100, h: 80 }, color: "#112233", z: 2 },
        { id: "image-001", type: "image", pixelBox: { x: 400, y: 200, w: 100, h: 80 }, z: 3 }
      ]
    }]
  };
  const result = applyCalibration(analysis, {
    calibration: [{
      slideId: "slide-001",
      adjustments: [
        { id: "text-001", category: "text", sourceBound: true, dx: 1000, dy: -1000, fontScale: 9, charSpacingDeltaPt: 99 },
        { id: "shape-001", category: "shape", sourceBound: true, dx: 1000, dy: -1000, dw: 1000, dh: -1000, color: "#ABCDEF" },
        { id: "image-001", category: "image", sourceBound: true, dx: 1000, dy: -1000, dw: 1000, dh: -1000 },
        { id: "__background__", category: "background", sourceBound: true, backgroundColor: "#AABBCC" },
        { id: "__z-order__", category: "z-order", sourceBound: true, objectId: "shape-001", zDelta: -99 }
      ]
    }]
  });
  const slide = result.analysis.slides[0];
  assert.equal(slide.background, "#AABBCC");
  assert.ok(slide.objects[0].renderBox.x >= 0);
  assert.ok(slide.objects[0].style.fontSizePt <= 22.8);
  assert.ok(slide.objects[1].pixelBox.x <= 1280 && slide.objects[1].pixelBox.y >= 0);
  assert.equal(slide.objects[1].color, "#ABCDEF");
  assert.ok(slide.objects[2].pixelBox.x <= 1280 && slide.objects[2].pixelBox.y >= 0);
  assert.equal(slide.objects[1].z, 0);
  assert.deepEqual([...slide.objects].sort((left, right) => left.z - right.z).map((item) => item.id), ["shape-001", "text-001", "image-001"]);
});

test("calibration refuses actions without explicit source-bound evidence", () => {
  const analysis = {
    deck: { size: { widthPx: 100, heightPx: 100 } },
    slides: [{ id: "slide-001", sizePx: { width: 100, height: 100 }, background: "#FFFFFF", objects: [{ id: "shape-001", type: "shape", pixelBox: { x: 10, y: 10, w: 20, h: 20 }, color: "#111111", z: 0 }] }]
  };
  const result = applyCalibration(analysis, { calibration: [{ slideId: "slide-001", adjustments: [{ id: "shape-001", category: "shape", dx: 5 }] }] });
  assert.equal(result.changes, 0);
  assert.equal(result.appliedActions.length, 0);
});

test("region-bound background and z-order diagnostics execute through calibration", () => {
  const analysis = {
    deck: { size: { widthPx: 100, heightPx: 100 } },
    slides: [{
      id: "slide-001",
      sizePx: { width: 100, height: 100 },
      background: "#FFFFFF",
      objects: [
        { id: "shape-001", type: "shape", pixelBox: { x: 10, y: 10, w: 20, h: 20 }, color: "#111111", z: 0 },
        { id: "shape-002", type: "shape", pixelBox: { x: 40, y: 40, w: 20, h: 20 }, color: "#222222", z: 1 }
      ]
    }]
  };
  const result = applyCalibration(analysis, {
    calibration: [{
      slideId: "slide-001",
      topRegionIds: ["region-bg", "region-shape"],
      adjustments: [
        { id: "__background__", regionId: "region-bg", category: "background", sourceBound: true, backgroundColor: "#AABBCC" },
        { id: "__z-order__", regionId: "region-shape", category: "z-order", sourceBound: true, objectId: "shape-001", zDelta: 1 }
      ]
    }]
  });
  const slide = result.analysis.slides[0];
  assert.equal(result.changes, 2);
  assert.equal(slide.background, "#AABBCC");
  assert.deepEqual([...slide.objects].sort((left, right) => left.z - right.z).map((item) => item.id), ["shape-002", "shape-001"]);
});

test("image calibration moves pagePixelBox without rewriting immutable origin", () => {
  const origin = { x: 10, y: 10, w: 20, h: 20 };
  const analysis = {
    deck: { size: { widthPx: 100, heightPx: 100 } },
    slides: [{
      id: "slide-001",
      sizePx: { width: 100, height: 100 },
      objects: [{ id: "image-001", type: "image", pixelBox: { ...origin }, z: 0 }],
      ownershipReport: { assets: [{ objectId: "image-001", pagePixelBox: { ...origin }, originPagePixelBox: { ...origin } }] }
    }]
  };
  const result = applyCalibration(analysis, {
    calibration: [{ slideId: "slide-001", adjustments: [{ id: "image-001", category: "image", regionId: "region-001", sourceBound: true, dx: 4 }] }]
  });
  assert.equal(result.changes, 1);
  assert.deepEqual(result.analysis.slides[0].ownershipReport.assets[0].originPagePixelBox, origin);
  assert.deepEqual(result.analysis.slides[0].ownershipReport.assets[0].pagePixelBox, { x: 14, y: 10, w: 20, h: 20 });
});

test("repair loop may take one bounded Pareto step without relaxing thresholds", () => {
  const current = {
    accepted: false,
    score: 0.6,
    visual: { aggregate: { ssim: 0.95, ocrCer: 0.01, bboxIou: 0.82, paletteDeltaE2000P95: 0, nativeHighConfidenceTextRecall: 1 } },
    editability: { level: 4 }
  };
  const geometryProgress = {
    accepted: false,
    score: 0.7,
    visual: { aggregate: { ssim: 0.95, ocrCer: 0.01, bboxIou: 0.95, paletteDeltaE2000P95: 0, nativeHighConfidenceTextRecall: 0.86 } },
    editability: { level: 4 }
  };
  const noProgress = structuredClone(current);
  noProgress.score = 0.7;
  assert.equal(repairHasProgress(current, geometryProgress), true);
  assert.equal(repairHasProgress(current, noProgress), false);
});

test("regional repair rejects full-page hard regressions even when one metric improves", () => {
  const current = {
    accepted: false,
    score: 1,
    visual: {
      aggregate: { ssim: 0.91, ocrCer: 0.03, bboxIou: 0.91, paletteDeltaE2000P95: 2, nativeHighConfidenceTextRecall: 0.95 },
      slides: [{ repairQueue: ["region-001"], regionMeasurements: [{ id: "region-001", regionSSIM: 0.70, ocrCER: 0.08, bboxIoU: 0.70, normalizedMAE: 0.20, paletteDeltaE2000P95: 8 }] }]
    },
    editability: { level: 4, wholeSlideRasterCount: 0 }
  };
  const hardRegression = {
    accepted: false,
    score: 0.8,
    visual: {
      aggregate: { ssim: 0.90, ocrCer: 0.02, bboxIou: 0.92, paletteDeltaE2000P95: 2, nativeHighConfidenceTextRecall: 0.95 },
      slides: [{ repairQueue: ["region-001"], regionMeasurements: [{ id: "region-001", regionSSIM: 0.75, ocrCER: 0.06, bboxIoU: 0.72, normalizedMAE: 0.18, paletteDeltaE2000P95: 7 }] }]
    },
    editability: { level: 4, wholeSlideRasterCount: 0 }
  };
  assert.equal(repairHasProgress(current, hardRegression), false);
});

test("regional metrics use slide plus region identity and beam samples each high-impact region", () => {
  const current = {
    slides: [
      { slideId: "slide-001", repairQueue: ["region-001"], regionMeasurements: [{ id: "region-001", regionSSIM: 0.40 }] },
      { slideId: "slide-002", repairQueue: [], regionMeasurements: [{ id: "region-001", regionSSIM: 0.80 }] }
    ]
  };
  const wrongPageOnly = {
    slides: [
      { slideId: "slide-001", regionMeasurements: [{ id: "region-001", regionSSIM: 0.40 }] },
      { slideId: "slide-002", regionMeasurements: [{ id: "region-001", regionSSIM: 0.90 }] }
    ]
  };
  assert.equal(localMetricsImproved(current, wrongPageOnly), false);

  const visual = {
    slides: ["slide-001", "slide-002"].map((slideId) => ({
      slideId,
      regionMeasurements: [1, 2, 3, 4].map((number) => ({ id: `region-${number}`, impact: 1 - number / 10 })),
      repairCandidates: [1, 2, 3, 4].flatMap((number) => [
        { candidateId: `${slideId}-region-${number}-adjust`, regionId: `region-${number}`, status: "proposed", actions: [{ id: `shape-${number}`, category: "shape" }] },
        { candidateId: `${slideId}-region-${number}-route`, regionId: `region-${number}`, status: "unavailable", actions: [] }
      ])
    }))
  };
  const beam = boundedRepairBeam(visual);
  assert.equal(beam.length, 4);
  assert.equal(new Set(beam.map((item) => `${item.slideId}/${item.regionId}`)).size, 4);
  assert.ok(beam.every((item) => item.status === "proposed"));
});

test("regional acceptance only credits the candidate action's region", () => {
  const current = {
    accepted: false,
    score: 1,
    visual: {
      aggregate: { ssim: 0.80, ocrCer: 0.10, bboxIou: 0.80, paletteDeltaE2000P95: 5, nativeHighConfidenceTextRecall: 0.90 },
      slides: [{ slideId: "slide-001", repairQueue: ["region-a", "region-b"], regionMeasurements: [
        { id: "region-a", regionSSIM: 0.70, ocrCER: 0.10, bboxIoU: 0.70, normalizedMAE: 0.20, paletteDeltaE2000P95: 5 },
        { id: "region-b", regionSSIM: 0.70, ocrCER: 0.10, bboxIoU: 0.70, normalizedMAE: 0.20, paletteDeltaE2000P95: 5 }
      ] }]
    },
    editability: { level: 4, wholeSlideRasterCount: 0 }
  };
  const candidate = {
    accepted: false,
    score: 0.9,
    appliedActions: [{ slideId: "slide-001", regionId: "region-a", action: "shape" }],
    visual: {
      aggregate: { ssim: 0.81, ocrCer: 0.10, bboxIou: 0.80, paletteDeltaE2000P95: 5, nativeHighConfidenceTextRecall: 0.90 },
      slides: [{ slideId: "slide-001", repairQueue: ["region-a", "region-b"], regionMeasurements: [
        { id: "region-a", regionSSIM: 0.70, ocrCER: 0.10, bboxIoU: 0.70, normalizedMAE: 0.20, paletteDeltaE2000P95: 5 },
        { id: "region-b", regionSSIM: 0.80, ocrCER: 0.10, bboxIoU: 0.70, normalizedMAE: 0.20, paletteDeltaE2000P95: 5 }
      ] }]
    },
    editability: { level: 4, wholeSlideRasterCount: 0 }
  };
  assert.equal(repairHasProgress(current, candidate), false);
});

test("failed beam rounds retain every candidate evaluation for history", async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-beam-evidence-"));
  const candidatePath = join(output, "reports", "attempt-1-candidate-1", "candidate.pptx");
  await mkdir(join(output, "reports", "attempt-1-candidate-1"), { recursive: true });
  await writeFile(candidatePath, "candidate-evidence");
  const evaluated = await summarizeBeamEvaluations(output, [
    {
      candidateId: "shape-001",
      regionId: "region-001",
      action: "shape",
      pptxPath: candidatePath,
      stepAccepted: false,
      finalQualityPassed: false,
      rejectionReason: "no-local-hard-metric-improvement"
    },
    {
      candidateId: "route-001",
      regionId: "region-001",
      action: "route-switch",
      stepAccepted: false,
      finalQualityPassed: false,
      rejectionReason: "no-applicable-source-bound-action"
    }
  ]);
  const current = { beamEvaluations: [] };
  current.beamEvaluations.push(...evaluated);
  assert.equal(current.beamEvaluations.length, 2);
  assert.equal(current.beamEvaluations[0].candidateRef.path, "reports/attempt-1-candidate-1/candidate.pptx");
  assert.match(current.beamEvaluations[0].candidateRef.sha256, /^[0-9a-f]{64}$/);
  assert.equal(current.beamEvaluations[0].selectedForNextRound, false);
  assert.equal(current.beamEvaluations[1].candidateRef, null);
  assert.equal(current.beamEvaluations[1].rejectionReason, "no-applicable-source-bound-action");
});

test("viable beam summaries mark exactly the selected accepted step", async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-beam-selected-"));
  const summary = await summarizeBeamEvaluations(output, [
    { candidateId: "candidate-a", regionId: "region-a", action: "shape", stepAccepted: true, accepted: true, selectedForNextRound: true, finalQualityPassed: false },
    { candidateId: "candidate-b", regionId: "region-b", action: "shape", stepAccepted: false, accepted: false, selectedForNextRound: false, finalQualityPassed: false, rejectionReason: "no-local-hard-metric-improvement" }
  ]);
  assert.equal(summary.filter((item) => item.selectedForNextRound).length, 1);
  assert.equal(summary[0].selectedForNextRound, true);
  assert.equal(summary[0].stepAccepted, true);
  assert.equal(summary[1].selectedForNextRound, false);
});

test("internal publication failure removes complete delivery markers but keeps evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-cleanup-"));
  await writeFile(join(directory, "final.pptx"), "partial-final");
  await mkdir(join(directory, "preview"));
  await mkdir(join(directory, "html-package"));
  await writeFile(join(directory, "run.json"), "{}");
  await writeFile(join(directory, "qa-report.json"), "{}");
  await writeFile(join(directory, "analysis.json"), "source-bound-evidence");
  await removeIncompleteDelivery(directory);
  for (const name of ["final.pptx", "preview", "html-package", "run.json", "qa-report.json"]) {
    await assert.rejects(access(join(directory, name)));
  }
  await access(join(directory, "analysis.json"));
});
