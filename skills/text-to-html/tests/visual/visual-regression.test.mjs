import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowserQa } from "../../scripts/lib/qa.mjs";
import { runPipeline } from "../../scripts/run-pipeline.mjs";
import { sha256File } from "../../scripts/lib/utils.mjs";
import { examplePlan } from "../helpers.mjs";

async function standardHashes(output, slideCount) {
  const hashes = [];
  for (let index = 1; index <= slideCount; index += 1) {
    hashes.push(await sha256File(join(output, "preview", "standard", `slide-${String(index).padStart(3, "0")}.png`)));
  }
  return hashes;
}

test("complex nine-slide rendering is visually deterministic in the pinned browser", { timeout: 240_000 }, async () => {
  const { path } = await examplePlan("complex");
  const output = await mkdtemp(join(tmpdir(), "text-to-html-visual-"));
  const result = await runPipeline(path, output, { maxAttempts: 3, timeoutMs: 90_000 });
  assert.equal(result.status, "passed");
  assert.equal(result.screenshotCount, 27);
  const first = await standardHashes(output, 9);
  const secondReport = await runBrowserQa(output, { timeoutMs: 90_000 });
  assert.equal(secondReport.status, "passed");
  const second = await standardHashes(output, 9);
  assert.deepEqual(second, first);
});
