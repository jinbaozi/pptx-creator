import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePresentationPackage } from "../../scripts/validate-presentation-package.mjs";
import { buildDeck } from "../../scripts/lib/render.mjs";
import { examplePlan, skillRoot } from "../helpers.mjs";

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
  assert.equal((html.match(/data-layout-role="decoration"/g) ?? []).length, 5);
  assert.match(html, /data-pptx-id="slide-cover-decor-orb" data-pptx-kind="shape"/);
  assert.match(html, /data-pptx-id="slide-closing-decor-band" data-pptx-kind="shape"/);
  assert.doesNotMatch(css, /\.pptx-slide\s*\{[^}]*gradient/s);
  assert.doesNotMatch(css, /\.cover-slide\s*\{[^}]*gradient/s);
  assert.doesNotMatch(css, /\.closing-slide\s*\{[^}]*gradient/s);
  assert.doesNotMatch(html, /https?:\/\//);
  const packageRecord = JSON.parse(await readFile(join(output, "presentation-package.json"), "utf8"));
  assert.equal(validatePresentationPackage(packageRecord).validationStatus, "pending");
  assert.equal(packageRecord.producer.skill, "text-to-html");
});

test("bundled protocol schema is the frozen canonical 1.0.0 contract", async () => {
  const schema = JSON.parse(await readFile(join(skillRoot, "schemas", "presentation-package.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://github.com/jinbaozi/pptx-creator/schemas/presentation-package/1.0.0");
  assert.equal(schema.properties.protocol.const, "pptx-creator.presentation-package");
  assert.equal(schema.properties.version.const, "1.0.0");
  assert.deepEqual(schema.properties.producer.properties.skill.enum, ["text-to-html", "html-to-pptx", "image-to-pptx"]);
});
