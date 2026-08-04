import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderPptx } from "../scripts/render_pptx.mjs";
import { applyCalibration, removeIncompleteDelivery, repairHasProgress } from "../scripts/image-to-pptx.mjs";

const execFileAsync = promisify(execFile);

test("CLI rejects a build without any source image", async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-empty-"));
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/image-to-pptx.mjs", "build", "--output", join(output, "out")], {
      cwd: new URL("..", import.meta.url).pathname
    }),
    (error) => /E_INPUT_REQUIRED/.test(error.stderr)
  );
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
      }]
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
      }]
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
        { id: "text-001", category: "text", dx: 1000, dy: -1000, fontScale: 9, charSpacingDeltaPt: 99 },
        { id: "shape-001", category: "shape", dx: 1000, dy: -1000, dw: 1000, dh: -1000, color: "#ABCDEF" },
        { id: "image-001", category: "image", dx: 1000, dy: -1000, dw: 1000, dh: -1000 },
        { id: "__background__", category: "background", backgroundColor: "#AABBCC" },
        { id: "__z-order__", category: "z-order", objectId: "shape-001", zDelta: -99 }
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
