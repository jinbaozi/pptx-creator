import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { validatePlan } from "../../scripts/lib/plan.mjs";
import { buildDeck } from "../../scripts/lib/render.mjs";
import { sha256Text, writeJson } from "../../scripts/lib/utils.mjs";
import { validatePresentationPackage } from "../../scripts/validate-presentation-package.mjs";
import { runPipeline } from "../../scripts/run-pipeline.mjs";
import { runQaDeck } from "../../scripts/qa-deck.mjs";
import { examplePlan } from "../helpers.mjs";

function qaReport(slideCount, status = "passed") {
  const passed = status === "passed";
  return {
    version: "1.0.0",
    status,
    timeoutMs: 90_000,
    slideCount,
    viewports: [
      { name: "standard", width: 1280, height: 720, slides: [] },
      { name: "desktop", width: 1440, height: 900, slides: [] },
      { name: "mobile", width: 390, height: 844, slides: [] }
    ],
    navigation: { passed },
    print: { passed },
    findings: passed ? [] : [{ code: "E_QA_FIXTURE", message: "Fixture QA failure" }],
    measurements: [],
    summary: { passed, errorCount: passed ? 0 : 1, screenshotCount: 0 }
  };
}

async function tempOutput(t) {
  const output = await mkdtemp(join(tmpdir(), "text-to-html-finalization-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  return output;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("rejects unreviewed plans", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.review.content.status = "required";
  delete invalid.review.content.reviewedAt;
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_HOST_REVIEW_REQUIRED");
});

test("rejects traversal before checking asset bytes", async () => {
  const { plan } = await examplePlan("complex");
  const invalid = structuredClone(plan);
  invalid.assets[0].selectedLocator = "../outside.svg";
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_ASSET_PATH");
});

test("rejects incompatible protocol versions", () => {
  assert.throws(
    () => validatePresentationPackage({ protocol: "pptx-creator.presentation-package", version: "2.0.0" }),
    (error) => error.code === "E_PROTOCOL_VERSION"
  );
});

test("caps the deterministic regeneration loop at three attempts", async () => {
  await assert.rejects(
    () => runPipeline("missing-plan.json", "unsafe-output", { maxAttempts: 4 }),
    (error) => error.code === "E_USAGE"
  );
});

test("draft mode creates a pending preview and never publishes final QA evidence", async (t) => {
  const { plan } = await examplePlan("minimal");
  for (const approval of Object.values(plan.review)) {
    approval.status = "required";
    delete approval.reviewedAt;
  }
  const root = await mkdtemp(join(tmpdir(), "text-to-html-draft-"));
  const planPath = join(root, "draft-plan.json");
  const output = join(root, "preview");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(planPath, plan);

  const result = await runPipeline(planPath, output, { mode: "draft" });
  assert.equal(result.status, "pending");
  const packageRecord = await readJson(join(output, "presentation-package.json"));
  assert.equal(packageRecord.validation.status, "pending");
  assert.equal((await readJson(join(output, "review-report.json"))).status, "required");
  await assert.rejects(() => readFile(join(output, "output-manifest.json"), "utf8"));
});

test("pipeline records failed QA evidence and never leaves a passed package", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const output = await tempOutput(t);
  await assert.rejects(
    () => runPipeline(path, output, {}, {
      runBrowserQa: async () => qaReport(plan.slides.length, "failed")
    }),
    (error) => error.code === "E_QA_FAILED"
  );
  const report = await readJson(join(output, "qa-report.json"));
  const packageRecord = await readJson(join(output, "presentation-package.json"));
  const manifest = await readJson(join(output, "output-manifest.json"));
  assert.equal(report.status, "failed");
  assert.equal(packageRecord.validation.status, "failed");
  assert.equal(manifest.status, "failed");
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.path),
    [...manifest.artifacts.map((artifact) => artifact.path)].sort()
  );
  assert.equal(manifest.rootDigest, sha256Text(JSON.stringify(manifest.artifacts)));
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "qa/attempt-01.json"));
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "generation-report.json"));
});

test("standalone QA failure replaces stale accepted evidence with a failed package", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const output = await tempOutput(t);
  await buildDeck(plan, path, output);
  const packagePath = join(output, "presentation-package.json");
  const packageRecord = await readJson(packagePath);
  packageRecord.validation = { status: "passed", reports: ["qa-report.json"] };
  await writeJson(packagePath, packageRecord);
  await writeJson(join(output, "output-manifest.json"), { status: "passed", artifacts: [] });
  const browserError = new Error("Chromium fixture unavailable");
  browserError.code = "E_BROWSER_UNAVAILABLE";
  await assert.rejects(
    () => runQaDeck(output, {}, { runBrowserQa: async () => { throw browserError; } }),
    (error) => error.code === "E_BROWSER_UNAVAILABLE"
  );
  const report = await readJson(join(output, "qa-report.json"));
  const failure = await readJson(join(output, "failure-report.json"));
  const failedPackage = await readJson(packagePath);
  const manifest = await readJson(join(output, "output-manifest.json"));
  assert.equal(report.status, "failed");
  assert.equal(failure.error.code, "E_BROWSER_UNAVAILABLE");
  assert.equal(failedPackage.validation.status, "failed");
  assert.equal(manifest.status, "failed");
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "failure-report.json"));
});

test("report write failures leave failure evidence and no accepted package", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const output = await tempOutput(t);
  await buildDeck(plan, path, output);
  const failingWriter = async (filePath, value) => {
    if (basename(filePath) === "qa-report.json") {
      const error = new Error("fixture report write failure");
      error.code = "E_TEST_REPORT_WRITE";
      throw error;
    }
    await writeJson(filePath, value);
  };
  await assert.rejects(
    () => runQaDeck(output, {}, {
      runBrowserQa: async () => qaReport(plan.slides.length),
      finalization: { writeJson: failingWriter }
    }),
    (error) => error.code === "E_REPORT_WRITE"
  );
  const failure = await readJson(join(output, "failure-report.json"));
  const packageRecord = await readJson(join(output, "presentation-package.json"));
  const manifest = await readJson(join(output, "output-manifest.json"));
  assert.equal(failure.error.code, "E_REPORT_WRITE");
  assert.equal(packageRecord.validation.status, "failed");
  assert.equal(manifest.status, "failed");
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "failure-report.json"));
  await assert.rejects(() => readFile(join(output, "qa-report.json"), "utf8"));
});

test("shared finalization validates the QA report schema before publication", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const output = await tempOutput(t);
  await buildDeck(plan, path, output);
  const invalid = qaReport(plan.slides.length);
  invalid.viewports = [];
  await assert.rejects(
    () => runQaDeck(output, {}, { runBrowserQa: async () => invalid }),
    (error) => error.code === "E_QA_REPORT_SCHEMA"
  );
  const packageRecord = await readJson(join(output, "presentation-package.json"));
  assert.equal(packageRecord.validation.status, "failed");
});

test("stale output files block QA finalization instead of entering a passed manifest", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const output = await tempOutput(t);
  await buildDeck(plan, path, output);
  await writeFile(join(output, "stale-artifact.txt"), "stale\n", "utf8");
  await assert.rejects(
    () => runQaDeck(output, {}, { runBrowserQa: async () => qaReport(plan.slides.length) }),
    (error) => error.code === "E_OUTPUT_STALE"
  );
  const failure = await readJson(join(output, "failure-report.json"));
  const packageRecord = await readJson(join(output, "presentation-package.json"));
  assert.equal(failure.error.code, "E_OUTPUT_STALE");
  assert.equal(packageRecord.validation.status, "failed");
  await assert.rejects(() => readFile(join(output, "output-manifest.json"), "utf8"));
});

test("output symlinks block QA finalization instead of entering a passed manifest", async (t) => {
  const { path, plan } = await examplePlan("minimal");
  const output = await tempOutput(t);
  await buildDeck(plan, path, output);
  await symlink("index.html", join(output, "unexpected-link"));
  await assert.rejects(
    () => runQaDeck(output, {}, { runBrowserQa: async () => qaReport(plan.slides.length) }),
    (error) => error.code === "E_OUTPUT_SYMLINK"
  );
  const failure = await readJson(join(output, "failure-report.json"));
  const packageRecord = await readJson(join(output, "presentation-package.json"));
  assert.equal(failure.error.code, "E_OUTPUT_SYMLINK");
  assert.equal(packageRecord.validation.status, "failed");
  await assert.rejects(() => readFile(join(output, "output-manifest.json"), "utf8"));
});
