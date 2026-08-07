import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MATRIX_CATEGORIES,
  MATRIX_THRESHOLDS,
  assertAssetReferences,
  assertManifestPolicy,
  routeContract,
  runMatrix,
  safeRelativePath,
  sampleOutputPath,
  selectCategory,
  validateMetrics,
  validateObjectCount
} from "./visual_benchmark_matrix_runner.mjs";

const manifestUrl = new URL("./fixtures/visual-benchmark-matrix/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const enabled = process.env.IMAGE_TO_PPTX_VISUAL_MATRIX === "1";

test("visual matrix policy rejects a lowered hard gate", () => {
  const changed = structuredClone(manifest);
  changed.thresholds.ssim.value = 0.93;
  assert.throws(() => assertManifestPolicy(changed), (error) => error.code === "E_MATRIX_POLICY");
  for (const status of ["passed", "failed", "pending"]) {
    const fakeResult = structuredClone(manifest);
    fakeResult.evaluation.status = status;
    assert.throws(() => assertManifestPolicy(fakeResult), (error) => error.code === "E_MATRIX_POLICY");
  }
  const sampleResult = structuredClone(manifest);
  sampleResult.samples[0].evaluation.status = "failed";
  assert.throws(() => assertManifestPolicy(sampleResult), (error) => error.code === "E_MATRIX_POLICY");
  const sampleMetrics = structuredClone(manifest);
  sampleMetrics.samples[0].evaluation.metrics = { ssim: 1 };
  assert.throws(() => assertManifestPolicy(sampleMetrics), (error) => error.code === "E_MATRIX_POLICY");
  const sampleVisualResults = structuredClone(manifest);
  sampleVisualResults.samples[0].evaluation.visualResults = { status: "passed" };
  assert.throws(() => assertManifestPolicy(sampleVisualResults), (error) => error.code === "E_MATRIX_POLICY");
  assert.throws(() => validateMetrics({ ssim: 0.93, ocrCer: 0.01, bboxIou: 0.95, paletteDeltaE2000P95: 1, nativeHighConfidenceTextRecall: 1, editability: 4, wholeSlideRaster: 0, ownershipOverlap: 0, ownershipConflict: 0, rasterAreaShare: 0.2 }), (error) => error.code === "E_MATRIX_METRIC");
  assert.equal(MATRIX_THRESHOLDS.ssim.value, 0.94);
});

test("visual matrix path validation rejects absolute and traversal paths", () => {
  assert.throws(() => safeRelativePath("/tmp/matrix", "../outside.png", "fixture"), (error) => error.code === "E_MATRIX_PATH");
  assert.throws(() => safeRelativePath("/tmp/matrix", "/etc/passwd", "fixture"), (error) => error.code === "E_MATRIX_PATH");
  assert.equal(safeRelativePath("/tmp/matrix", "sources/slide.png", "fixture"), "/tmp/matrix/sources/slide.png");
  assert.equal(sampleOutputPath("/tmp/matrix", "safe-id"), "/tmp/matrix/runs/safe-id");
  assert.throws(() => sampleOutputPath("/tmp/matrix", "../escape"), (error) => error.code === "E_MATRIX_PATH");
  assert.throws(() => sampleOutputPath("/tmp/matrix", "/absolute"), (error) => error.code === "E_MATRIX_PATH");
});

test("visual matrix category selection enforces the ten manifest quotas", () => {
  assert.deepEqual([...new Set(manifest.samples.map((sample) => sample.category))].sort(), [...MATRIX_CATEGORIES].sort());
  for (const category of MATRIX_CATEGORIES) {
    const samples = selectCategory(manifest, category);
    assert.equal(samples.length, manifest.quotas[category]);
  }
  assert.throws(() => selectCategory(manifest, "not-a-category"), (error) => error.code === "E_MATRIX_CATEGORY");
});

test("visual matrix route validation requires explainable winners and assets", () => {
  const sample = { id: "fake", acceptedStrategy: { route: "native-all" } };
  const analysis = { slides: [{ reconstructionPlan: { regions: [{ winnerId: "region-native", candidates: [{ id: "region-native", strategy: "native-all" }] }] } }] };
  assert.deepEqual(routeContract(sample, analysis, 0).winners, ["native-all"]);
  assert.throws(() => routeContract(sample, analysis, 1), (error) => error.code === "E_MATRIX_ROUTE");
  const mixedSample = { id: "mixed", acceptedStrategy: { route: "native-plus-local-assets" } };
  const mixedAnalysis = { slides: [{ reconstructionPlan: { regions: [
    { winnerId: "region-native", candidates: [{ id: "region-native", strategy: "native-all" }] },
    { winnerId: "region-local", candidates: [{ id: "region-local", strategy: "native-plus-local-assets" }] }
  ] } }] };
  assert.equal(routeContract(mixedSample, mixedAnalysis, 1).matched, true);
  const unknownWinner = { slides: [{ reconstructionPlan: { regions: [
    { winnerId: "region-native", candidates: [{ id: "region-native", strategy: "native-all" }] },
    { winnerId: "region-future", candidates: [{ id: "region-future", strategy: "future-route" }] }
  ] } }] };
  assert.throws(() => routeContract(mixedSample, unknownWinner, 1), (error) => error.code === "E_MATRIX_ROUTE");
  assert.throws(() => routeContract({ ...sample, acceptedStrategy: { route: "unknown" } }, analysis, 0), (error) => error.code === "E_MATRIX_ROUTE");
});

test("visual matrix asset provenance binds original and normalized source digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-matrix-assets-"));
  try {
    const sourceBytes = Buffer.from("original-source");
    const normalizedBytes = Buffer.from("normalized-source");
    const assetBytes = Buffer.from("asset");
    const maskBytes = Buffer.from("mask");
    await writeFile(join(root, "source.png"), sourceBytes);
    await writeFile(join(root, "normalized.png"), normalizedBytes);
    await writeFile(join(root, "asset.png"), assetBytes);
    await writeFile(join(root, "mask.png"), maskBytes);
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    const analysis = {
      sources: [{ id: "source-001", path: "source.png", sha256: sha(sourceBytes), normalizedPath: "normalized.png", normalizedSha256: sha(normalizedBytes) }],
      slides: [{ ownershipReport: { assets: [{ objectId: "asset-001", asset: "asset.png", mask: "mask.png", pagePixelBox: { x: 0, y: 0, w: 1, h: 1 }, originPagePixelBox: { x: 0, y: 0, w: 1, h: 1 }, assetDigest: sha(assetBytes), maskDigest: sha(maskBytes), sourceRef: "source-001", sourceDigest: sha(normalizedBytes), normalizedSourceDigest: sha(normalizedBytes) }] } }]
    };
    await assertAssetReferences(root, analysis);
    await assert.rejects(assertAssetReferences(root, { ...analysis, sources: [{ ...analysis.sources[0], sha256: "f".repeat(64) }] }), (error) => error.code === "E_MATRIX_PROVENANCE");
    await assert.rejects(assertAssetReferences(root, { ...analysis, slides: [{ ownershipReport: { assets: [{ ...analysis.slides[0].ownershipReport.assets[0], sourceDigest: "e".repeat(64) }] } }] }), (error) => error.code === "E_MATRIX_PROVENANCE");
    await assert.rejects(assertAssetReferences(root, { ...analysis, slides: [{ ownershipReport: { assets: [{ ...analysis.slides[0].ownershipReport.assets[0], normalizedSourceDigest: undefined }] } }] }), (error) => error.code === "E_MATRIX_PROVENANCE");
    await assert.rejects(assertAssetReferences(root, { ...analysis, slides: [{ ownershipReport: { assets: [{ ...analysis.slides[0].ownershipReport.assets[0], normalizedSourceDigest: "d".repeat(64) }] } }] }), (error) => error.code === "E_MATRIX_PROVENANCE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visual matrix rejects object-count explosions", () => {
  const sample = manifest.samples.find((item) => item.category === "en-info");
  assert.ok(sample);
  assert.doesNotThrow(() => validateObjectCount(sample, sample.truth.objectCount * 4 + 50));
  assert.throws(() => validateObjectCount(sample, sample.truth.objectCount * 4 + 51), (error) => error.code === "E_MATRIX_OBJECT_EXPLOSION");
});

test("visual matrix writes a failed summary when budget or build execution fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-matrix-contract-"));
  try {
    await assert.rejects(
      runMatrix({
        manifest,
        category: "en-info",
        outputRoot: root,
        budgets: { maxCommands: 0 },
        execute: async () => { throw new Error("must not execute after budget exhaustion"); }
      }),
      (error) => error.code === "E_MATRIX_FAILED" && Boolean(error.summaryPath)
    );
    const summary = JSON.parse(await readFile(join(root, "summaries", "en-info.json"), "utf8"));
    assert.equal(summary.status, "failed");
    assert.equal(summary.commandCount, 0);
    assert.equal(summary.samples.length, 5);
    assert.ok(summary.samples.every((sample) => sample.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visual matrix verifies fixture source digests before invoking the build", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-to-pptx-matrix-provenance-"));
  let invoked = false;
  try {
    const altered = structuredClone(manifest);
    altered.samples = altered.samples.map((sample) => sample.category === "en-info"
      ? { ...sample, source: { ...sample.source, sha256: "0".repeat(64) } }
      : sample);
    await assert.rejects(
      runMatrix({
        manifest: altered,
        category: "en-info",
        outputRoot: root,
        execute: async () => { invoked = true; }
      }),
      (error) => error.code === "E_MATRIX_FAILED" && Boolean(error.summaryPath)
    );
    const summary = JSON.parse(await readFile(join(root, "summaries", "en-info.json"), "utf8"));
    assert.equal(summary.status, "failed");
    assert.equal(summary.commandCount, 0);
    assert.equal(invoked, false);
    assert.ok(summary.samples.every((sample) => sample.error?.code === "E_MATRIX_PROVENANCE"));
    const committedManifestDigest = createHash("sha256").update(await readFile(manifestUrl)).digest("hex");
    assert.equal(summary.manifest.path, "<in-memory>");
    assert.notEqual(summary.manifest.sha256, committedManifestDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real visual matrix is explicitly skipped unless IMAGE_TO_PPTX_VISUAL_MATRIX=1", { skip: enabled }, () => {
  assert.notEqual(process.env.IMAGE_TO_PPTX_VISUAL_MATRIX, "1");
});

test("real visual matrix runs one manifest category with fixed budgets", { skip: !enabled, timeout: 1_260_000 }, async () => {
  const category = process.env.IMAGE_TO_PPTX_MATRIX_CATEGORY;
  assert.ok(category, "IMAGE_TO_PPTX_MATRIX_CATEGORY is required when the matrix is enabled");
  const result = await runMatrix({ category, outputRoot: process.env.IMAGE_TO_PPTX_MATRIX_OUTPUT });
  assert.equal(result.summary.status, "passed");
  assert.equal(result.summary.sampleCount, manifest.quotas[category]);
});
