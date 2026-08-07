import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDesignLock, buildReviewArtifactHashes } from "../../scripts/lib/plan.mjs";
import { runBrowserQa } from "../../scripts/lib/qa.mjs";
import { buildDeck } from "../../scripts/lib/render.mjs";
import { examplePlan, skillRoot } from "../helpers.mjs";

const goldenPath = join(skillRoot, "tests", "visual", "goldens", "framework-fixtures.json");
const cases = [
  { id: "long-title", viewport: "standard", order: 1, slideId: "slide-cover" },
  { id: "footer-safe-area", viewport: "standard", order: 5, slideId: "slide-scope" },
  { id: "five-step-process", viewport: "standard", order: 6, slideId: "slide-process" },
  { id: "dense-timeline", viewport: "standard", order: 7, slideId: "slide-timeline" },
  { id: "mobile-reader", viewport: "mobile", order: 2, slideId: "slide-thesis" },
  { id: "source-wrapping", viewport: "desktop", order: 5, slideId: "slide-scope" }
];

function refreshBindings(plan) {
  plan.designIntent.lock = buildDesignLock(plan);
  const hashes = buildReviewArtifactHashes(plan);
  for (const approval of Object.values(plan.review)) approval.artifactHashes = hashes;
}

async function fixturePlan() {
  const { path, plan } = await examplePlan("complex");
  const fixture = structuredClone(plan);
  const cover = fixture.slides.find((slide) => slide.id === "slide-cover");
  cover.title = "企业知识库迁移试点必须先统一批准版本责任链再迁移高频内容";
  fixture.narrative.titleChain[0] = cover.title;
  fixture.sources[0].label = "input.md（视觉回归夹具：覆盖长标题、五步流程、密集时间线、移动阅读器和完整来源换行）";

  const process = fixture.slides.find((slide) => slide.id === "slide-process");
  process.title = "五步路径把范围、版本、责任、迁移与验收串成闭环";
  process.focalPoint = "五个过程模块和锚定连接线";
  process.visualRole = "五个过程模块和锚定连接线";
  process.transitionPurpose = "把五步路径映射到十天里程碑";
  process.slots.steps.push({
    label: "复盘固化",
    claim: { text: "固化验收结论。", factStatus: "provided", sourceRefs: ["source-brief"] }
  });
  fixture.pagination.pageBudgets.find((budget) => budget.slideId === "slide-process").maxPrimarySupports = 5;
  fixture.narrative.titleChain[5] = process.title;

  const timeline = fixture.slides.find((slide) => slide.id === "slide-timeline");
  timeline.focalPoint = "五节点时间轴";
  timeline.slots.milestones.push({
    when: "第 10 天后",
    label: "固化复盘",
    claim: { text: "固化复盘结论。", factStatus: "provided", sourceRefs: ["source-brief"] }
  });
  fixture.pagination.pageBudgets.find((budget) => budget.slideId === "slide-timeline").maxPrimarySupports = 5;
  refreshBindings(fixture);
  return { path, plan: fixture };
}

function hammingDistance(left, right) {
  assert.equal(left.length, right.length, "average hashes must have the same length");
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const xor = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    distance += xor.toString(2).replaceAll("0", "").length;
  }
  return distance;
}

function colorMeanAbsoluteError(left, right) {
  assert.equal(left.length, right.length, "color grids must have the same length");
  return left.reduce((total, value, index) => total + Math.abs(value - right[index]), 0) / left.length;
}

function selectedSlides(report) {
  return Object.fromEntries(cases.map((fixture) => {
    const viewport = report.viewports.find((entry) => entry.name === fixture.viewport);
    const slide = viewport?.slides.find((entry) => entry.order === fixture.order);
    assert.equal(slide?.slideId, fixture.slideId, `${fixture.id} must resolve its declared slide`);
    return [fixture.id, slide];
  }));
}

test("framework visual fixtures stay within persistent perceptual goldens", { timeout: 240_000 }, async (t) => {
  const { path, plan } = await fixturePlan();
  const output = await mkdtemp(join(tmpdir(), "text-to-html-golden-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await buildDeck(plan, path, output);
  const report = await runBrowserQa(output, { timeoutMs: 90_000 });
  assert.equal(report.status, "passed", JSON.stringify(report.findings, null, 2));
  const actual = selectedSlides(report);

  assert.equal(actual["long-title"].titleLineCount, 2);
  assert.equal(actual["footer-safe-area"].sourceLineCount, 2);
  assert.equal(actual["five-step-process"].silhouette, "process-staggered");
  assert.equal(actual["dense-timeline"].silhouette, "timeline-alternating");
  assert.ok(actual["mobile-reader"].visualFingerprint.averageHash);
  assert.equal(actual["source-wrapping"].sourceLineCount, 2);

  const generated = {
    version: "1.0.0",
    comparator: { maximumHashDistance: 22, maximumColorMae: 14 },
    cases: Object.fromEntries(cases.map(({ id }) => [id, actual[id].visualFingerprint]))
  };
  if (process.env.VISUAL_GOLDEN_OUTPUT) {
    await writeFile(process.env.VISUAL_GOLDEN_OUTPUT, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    return;
  }

  const golden = JSON.parse(await readFile(goldenPath, "utf8"));
  assert.equal(golden.version, generated.version);
  for (const { id } of cases) {
    const expected = golden.cases[id];
    const fingerprint = generated.cases[id];
    const hashDistance = hammingDistance(fingerprint.averageHash, expected.averageHash);
    const colorMae = colorMeanAbsoluteError(fingerprint.colorGrid, expected.colorGrid);
    assert.ok(hashDistance <= golden.comparator.maximumHashDistance, `${id} average-hash distance ${hashDistance} exceeds the golden threshold`);
    assert.ok(colorMae <= golden.comparator.maximumColorMae, `${id} color MAE ${colorMae.toFixed(3)} exceeds the golden threshold`);
  }
});
