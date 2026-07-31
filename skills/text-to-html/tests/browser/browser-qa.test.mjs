import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowserQa } from "../../scripts/lib/qa.mjs";
import { buildDeck } from "../../scripts/lib/render.mjs";
import { runPipeline } from "../../scripts/run-pipeline.mjs";
import { examplePlan } from "../helpers.mjs";

test("minimal example passes every slide at standard, desktop, and mobile viewports", { timeout: 180_000 }, async () => {
  const { path } = await examplePlan("minimal");
  const output = await mkdtemp(join(tmpdir(), "text-to-html-browser-"));
  const result = await runPipeline(path, output, { maxAttempts: 3, timeoutMs: 90_000 });
  assert.equal(result.status, "passed");
  assert.equal(result.screenshotCount, 9);
  const report = JSON.parse(await readFile(join(output, "qa-report.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.viewports.map((viewport) => viewport.name), ["standard", "desktop", "mobile"]);
  assert.equal(report.navigation.passed, true);
  assert.equal(report.print.passed, true);
  assert.deepEqual(report.contactSheets, [{ path: "preview/contact-sheet.html" }]);
  assert.ok((await readFile(join(output, "preview", "contact-sheet.html"), "utf8")).includes("Deck contact sheet"));
  const packageRecord = JSON.parse(await readFile(join(output, "presentation-package.json"), "utf8"));
  for (const slide of packageRecord.deck.slides) {
    assert.ok(
      slide.components.some((component) =>
        component.id === `${slide.id}-decor-orb`
        && component.type === "shape"
        && component.editableIntent === true),
      `${slide.id} should expose an editable decoration shape`
    );
  }
});

test("browser gate blocks source-level text clipping", { timeout: 180_000 }, async () => {
  const { path, plan } = await examplePlan("minimal");
  const output = await mkdtemp(join(tmpdir(), "text-to-html-overflow-"));
  await buildDeck(plan, path, output);
  const htmlPath = join(output, "index.html");
  const html = await readFile(htmlPath, "utf8");
  await writeFile(
    htmlPath,
    html.replace("</head>", "<style>.slide-title{width:120px!important;height:30px!important;overflow:hidden!important;white-space:nowrap!important}</style></head>"),
    "utf8"
  );
  const report = await runBrowserQa(output, { timeoutMs: 90_000 });
  assert.equal(report.status, "failed");
  assert.ok(report.findings.some((finding) => finding.code === "E_TEXT_OVERFLOW"));
});

test("browser QA closes Chromium after a navigation failure", async () => {
  const output = await mkdtemp(join(tmpdir(), "text-to-html-browser-close-"));
  let closed = false;
  const browser = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        setDefaultNavigationTimeout() {},
        on() {},
        async goto() {
          throw new Error("navigation failure sentinel");
        }
      };
    },
    async close() {
      closed = true;
    }
  };

  await assert.rejects(
    () => runBrowserQa(output, { launchBrowser: async () => browser }),
    (error) => error.code === "E_BROWSER_TIMEOUT"
  );
  assert.equal(closed, true);
});
