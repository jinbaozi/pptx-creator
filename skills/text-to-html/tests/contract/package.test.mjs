import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePresentationPackage } from "../../scripts/validate-presentation-package.mjs";
import { buildDesignLock, buildReviewArtifactHashes } from "../../scripts/lib/plan.mjs";
import { buildDeck } from "../../scripts/lib/render.mjs";
import { loadTheme } from "../../scripts/lib/themes.mjs";
import { examplePlan, skillRoot } from "../helpers.mjs";

function refreshBindings(plan) {
  plan.designIntent.lock = buildDesignLock(plan);
  const hashes = buildReviewArtifactHashes(plan);
  for (const approval of Object.values(plan.review)) approval.artifactHashes = hashes;
}

test("build emits the complete pending offline contract without sibling dependencies", async () => {
  const { path, plan } = await examplePlan("minimal");
  const output = await mkdtemp(join(tmpdir(), "text-to-html-contract-"));
  await buildDeck(plan, path, output);
  const expected = [
    "index.html",
    "presentation-plan.json",
    "presentation-plan.source.json",
    "deck-manifest.json",
    "presentation-package.json",
    "design-tokens.json",
    "design-intent.json",
    "content-budget-report.json",
    "narrative-report.json",
    "review-report.json",
    "visual-scorecard.json",
    "asset-ledger.json",
    "license-report.json",
    "provenance.json",
    "NOTICE",
    "speaker-notes.md",
    "sources.json",
    "qa-report.json",
    "assets/deck.css",
    "assets/deck.js",
    "assets/design-tokens.css"
  ];
  for (const artifact of expected) assert.ok((await readFile(join(output, artifact))).length > 0, artifact);
  const html = await readFile(join(output, "index.html"), "utf8");
  const css = await readFile(join(output, "assets", "deck.css"), "utf8");
  assert.match(html, /class="pptx-deck"/);
  assert.equal((html.match(/class="pptx-slide /g) ?? []).length, 3);
  assert.equal((html.match(/data-layout-role="decoration"/g) ?? []).length, 4);
  assert.match(html, /data-pptx-id="slide-cover-decor-orb" data-pptx-kind="shape"/);
  assert.doesNotMatch(html, /data-pptx-id="slide-actions-decor-orb"/);
  assert.match(html, /data-pptx-id="slide-closing-decor-band" data-pptx-kind="shape"/);
  assert.doesNotMatch(css, /\.pptx-slide\s*\{[^}]*gradient/s);
  assert.doesNotMatch(css, /\.cover-slide\s*\{[^}]*gradient/s);
  assert.doesNotMatch(css, /\.closing-slide\s*\{[^}]*gradient/s);
  assert.doesNotMatch(html, /https?:\/\//);
  const packageRecord = JSON.parse(await readFile(join(output, "presentation-package.json"), "utf8"));
  assert.equal(validatePresentationPackage(packageRecord).validationStatus, "pending");
  assert.equal(packageRecord.producer.skill, "text-to-html");
  const extension = packageRecord.extensions["pptx-creator.text-to-html/v2"];
  assert.equal(extension.version, "2.0.0");
  assert.equal(extension.plan.version, "2.0.0");
  assert.equal(extension.plan.reviewStatus, "approved");
  assert.match(extension.reports.review.sha256, /^[a-f0-9]{64}$/);
  assert.match(extension.reports.visualScorecard.sha256, /^[a-f0-9]{64}$/);
});

test("build emits static process connector geometry for script-stripped conversion", async () => {
  const { path, plan } = await examplePlan("complex");
  const output = await mkdtemp(join(tmpdir(), "text-to-html-process-"));
  await buildDeck(plan, path, output);
  const html = await readFile(join(output, "index.html"), "utf8");
  assert.match(html, /<svg class="connector-layer" viewBox="0 0 1136 720" preserveAspectRatio="none"/);
  const paths = [...html.matchAll(/data-pptx-id="slide-process-connector-\d+"[\s\S]*?\sd="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(paths, [
    "M 252.5 360 L 273.5 360 L 273.5 360 L 294.5 360",
    "M 547 360 L 568 360 L 568 360 L 589 360",
    "M 841.5 360 L 862.5 360 L 862.5 360 L 883.5 360"
  ]);
});

test("renders reviewed table and chart archetypes as structured editable markers", async () => {
  const { path, plan } = await examplePlan("minimal");
  const variant = structuredClone(plan);
  const slide = variant.slides[1];
  slide.intent = "table-chart-diagram";
  slide.layoutArchetype = "table-chart-diagram";
  slide.visualRole = "结构化表格与原生图表";
  slide.focalPoint = "一张表与一个图表说明试点信号";
  slide.slots = {
    chart: {
      kind: "horizontalBar",
      data: [{
        label: "试点覆盖",
        value: 42,
        claim: { text: "试点覆盖达到批准范围。", factStatus: "provided", sourceRefs: ["source-brief"] }
      }]
    },
    caption: { text: "图表显示批准的试点信号。", factStatus: "provided", sourceRefs: ["source-brief"] }
  };
  refreshBindings(variant);
  const output = await mkdtemp(join(tmpdir(), "text-to-html-structured-"));
  await buildDeck(variant, path, output);
  const html = await readFile(join(output, "index.html"), "utf8");
  assert.match(html, /data-pptx-kind="chart"/);
  assert.match(html, /data-pptx-chart="\{&quot;kind&quot;:&quot;horizontalBar&quot;/);
  assert.match(html, /data-chart-label="horizontalBar/);
  assert.doesNotMatch(html, /data-pptx-kind="image"/);
});

test("metric values retain claim-level sources and show uncertainty labels", async () => {
  const { path, plan } = await examplePlan("complex");
  const metric = plan.slides.find((slide) => slide.layoutArchetype === "metrics").slots.metrics[0];
  const expectedLabels = {
    provided: null,
    verified: null,
    inferred: "假设",
    unverified: "待核验",
    placeholder: "占位"
  };

  for (const [factStatus, expectedLabel] of Object.entries(expectedLabels)) {
    const variant = structuredClone(plan);
    const variantMetric = variant.slides.find((slide) => slide.layoutArchetype === "metrics").slots.metrics[0];
    variantMetric.claim.factStatus = factStatus;
    variantMetric.claim.sourceRefs = ["source-brief"];
    refreshBindings(variant);
    const output = await mkdtemp(join(tmpdir(), `text-to-html-metric-${factStatus}-`));
    await buildDeck(variant, path, output);
    const html = await readFile(join(output, "index.html"), "utf8");
    const valueMatch = html.match(new RegExp(`<div class="metric-value"[^>]*data-pptx-id="slide-metrics-metric-value-1"[^>]*data-fact-status="${factStatus}"[^>]*data-source-ids="source-brief"[^>]*>([\\s\\S]*?)</div>`));
    assert.ok(valueMatch, `${factStatus} metric value should retain claim attributes`);
    assert.match(valueMatch[1], new RegExp(`<span>${metric.value}</span>`));
    if (expectedLabel) assert.match(valueMatch[1], new RegExp(`class="status-label">${expectedLabel}</span>`));
    else assert.doesNotMatch(valueMatch[1], /class="status-label"/);
  }
});

test("bundled protocol schema is the frozen canonical 1.0.0 contract", async () => {
  const schema = JSON.parse(await readFile(join(skillRoot, "schemas", "presentation-package.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://github.com/jinbaozi/pptx-creator/schemas/presentation-package/1.0.0");
  assert.equal(schema.properties.protocol.const, "pptx-creator.presentation-package");
  assert.equal(schema.properties.version.const, "1.0.0");
  assert.deepEqual(schema.properties.producer.properties.skill.enum, ["text-to-html", "html-to-pptx", "image-to-pptx"]);
});

test("build materializes every complete registered theme without changing the reviewed plan semantics", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const themeIds = [
    "restrained-business",
    "accessible-high-contrast",
    "editorial-magazine",
    "dark-technical",
    "warm-humanist",
    "swiss-data"
  ];

  for (const themeId of themeIds) {
    const themed = structuredClone(plan);
    themed.designIntent.themeId = themeId;
    refreshBindings(themed);
    const output = await mkdtemp(join(tmpdir(), `text-to-html-theme-${themeId}-`));
    t.after(() => rm(output, { recursive: true, force: true }));
    await buildDeck(themed, path, output);
    const tokens = JSON.parse(await readFile(join(output, "design-tokens.json"), "utf8"));
    const license = JSON.parse(await readFile(join(output, "license-report.json"), "utf8"));
    assert.deepEqual(tokens, loadTheme(themeId).tokens, themeId);
    assert.equal(license.theme.id, themeId);
    assert.equal(themed.slides[1].layoutArchetype, plan.slides[1].layoutArchetype, themeId);
  }
});
