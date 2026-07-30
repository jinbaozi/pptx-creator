import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../scripts/image-to-pptx.mjs";
import { validateOutput } from "../scripts/validate_output.mjs";

const enabled = process.env.IMAGE_TO_PPTX_VISUAL === "1";
const root = resolve(new URL("..", import.meta.url).pathname);

test("replica-golden calibration clears the unchanged 0.90 bbox IoU gate", { skip: !enabled, timeout: 180_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-golden-test-"));
  const result = await build({
    output,
    title: "Replica golden calibration",
    langs: "eng",
    ocrThreshold: 0.70,
    maxRepairs: 3,
    htmlPackage: true,
    inputs: [join(root, "examples", "complex", "slide-01-replica-golden.png")]
  });
  const qa = JSON.parse(await readFile(result.qaReport, "utf8"));
  assert.equal(qa.status, "passed");
  assert.ok(qa.visual.aggregate.bboxIou >= 0.90);
  assert.ok(qa.visual.aggregate.ssim >= 0.94);
  assert.ok(qa.attemptsUsed > 0 && qa.attemptsUsed <= 3);
  assert.equal(qa.editability.level, 4);
  assert.equal(qa.editability.wholeSlideRasterCount, 0);
  assert.equal(qa.degradations.length, 1);
  assert.equal((await validateOutput(output)).deliveryStatus, "passed");
});

test("two ordered images become one two-slide native-first PPTX", { skip: !enabled, timeout: 180_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-multi-test-"));
  const result = await build({
    output,
    title: "Two-page reconstruction",
    langs: "eng",
    ocrThreshold: 0.70,
    maxRepairs: 3,
    htmlPackage: true,
    inputs: [
      join(root, "examples", "complex", "slide-01-replica-golden.png"),
      join(root, "examples", "complex", "slide-02-chart.png")
    ]
  });
  const qa = JSON.parse(await readFile(result.qaReport, "utf8"));
  assert.equal(qa.slideCount, 2);
  assert.equal(qa.status, "passed");
  assert.ok(qa.visual.aggregate.bboxIou >= 0.90);
  assert.ok(qa.editability.nativeObjectCount > 20);
  const validated = await validateOutput(output);
  assert.equal(validated.slideCount, 2);
  assert.equal(validated.protocol.version, "1.0.0");
});
