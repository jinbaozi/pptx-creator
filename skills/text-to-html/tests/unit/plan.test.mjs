import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildDesignLock,
  buildReviewArtifactHashes,
  compilePlanForRender,
  materializeDesignTokens,
  scaffoldPlanFromSource,
  validatePlan
} from "../../scripts/lib/plan.mjs";
import { examplePlan, skillRoot } from "../helpers.mjs";

function refreshBindings(plan) {
  plan.designIntent.lock = buildDesignLock(plan);
  const hashes = buildReviewArtifactHashes(plan);
  for (const approval of Object.values(plan.review)) approval.artifactHashes = hashes;
}

test("validates reviewed V2 minimal and complex plans", async () => {
  const minimal = await examplePlan("minimal");
  const complex = await examplePlan("complex");
  assert.deepEqual(await validatePlan(minimal.plan, { planDirectory: join(skillRoot, "examples", "minimal") }), {
    version: "2.0.0",
    deckId: "knowledge-base-pilot",
    slideCount: 3,
    sourceCount: 1,
    assetCount: 0,
    plannedSeconds: 300,
    briefSeconds: 300,
    approved: true
  });
  assert.equal((await validatePlan(complex.plan, { planDirectory: join(skillRoot, "examples", "complex") })).slideCount, 9);
});

test("rejects Plan 1.x instead of guessing an input migration", async () => {
  await assert.rejects(
    () => validatePlan({ version: "1.0.0" }),
    (error) => error.code === "E_PLAN_VERSION" && error.path === "$.version"
  );
});

test("Markdown scaffolding preserves source text and remains review-required", async () => {
  const sourcePath = join(skillRoot, "examples", "minimal", "input.md");
  const draft = await scaffoldPlanFromSource(sourcePath);
  assert.equal(draft.version, "2.0.0");
  assert.equal(draft.review.content.status, "required");
  assert.match(JSON.stringify(draft.slides), /当前资料分散在三个共享目录中/);
  await validatePlan(draft, { allowUnreviewed: true });
  await assert.rejects(() => validatePlan(draft), (error) => error.code === "E_HOST_REVIEW_REQUIRED");
});

test("rejects more than three primary support points", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.slides[1].slots.points.push({
    text: "第四个独立支撑点必须拆页。",
    factStatus: "provided",
    sourceRefs: ["source-brief"]
  });
  refreshBindings(invalid);
  await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_PLAN_SCHEMA" && /at most 3/.test(error.message));
});

test("rejects unknown claim-level source references", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.slides[1].slots.points[0].sourceRefs = ["missing-source"];
  refreshBindings(invalid);
  await assert.rejects(
    () => validatePlan(invalid),
    (error) => error.code === "E_SOURCE_REF" && error.path === "$.slides[1].slots.points[0].sourceRefs[0]"
  );
});

test("runs JSON Schema before semantic reference validation", async () => {
  const { plan } = await examplePlan("minimal");
  const schemaInvalid = structuredClone(plan);
  schemaInvalid.deck.unexpected = true;
  await assert.rejects(
    () => validatePlan(schemaInvalid),
    (error) => error.code === "E_PLAN_SCHEMA" && error.path === "$.deck.unexpected"
  );

  const semanticInvalid = structuredClone(plan);
  semanticInvalid.slides[1].slots.points[0].sourceRefs = ["missing-source"];
  refreshBindings(semanticInvalid);
  await assert.rejects(
    () => validatePlan(semanticInvalid),
    (error) => error.code === "E_SOURCE_REF" && error.path === "$.slides[1].slots.points[0].sourceRefs[0]"
  );
});

test("materializes every default design token with safe supported V2 overrides", async () => {
  const defaults = JSON.parse(await readFile(join(skillRoot, "assets", "design-tokens.default.json"), "utf8"));
  const tokens = materializeDesignTokens({
    colors: { primary: "#102A43" },
    fonts: { body: "\"Noto Sans\", sans-serif" },
    type: { body: 22 },
    space: { gap: 20 },
    radius: { card: 16 },
    shadow: { card: "0 10px 24px rgba(25, 41, 78, 0.10)" }
  });

  for (const [group, defaultsForGroup] of Object.entries(defaults)) {
    if (defaultsForGroup && typeof defaultsForGroup === "object" && !Array.isArray(defaultsForGroup)) {
      assert.deepEqual(Object.keys(tokens[group]).sort(), Object.keys(defaultsForGroup).sort(), group);
    } else {
      assert.equal(tokens[group], defaultsForGroup, group);
    }
  }
  assert.equal(tokens.colors.primary, "#102A43");
  assert.equal(tokens.colors.background, defaults.colors.background);
  assert.equal(tokens.fonts.body, "\"Noto Sans\", sans-serif");
  assert.equal(tokens.fonts.display, defaults.fonts.display);

  const { plan } = await examplePlan("minimal");
  plan.designIntent.tokenOverrides = {
    colors: { primary: "#102A43" },
    fonts: { body: "\"Noto Sans\", sans-serif" },
    type: { body: 22 },
    space: { gap: 20 },
    radius: { card: 16 },
    shadow: { card: "0 10px 24px rgba(25, 41, 78, 0.10)" }
  };
  refreshBindings(plan);
  await validatePlan(plan);
});

test("rejects unsupported, unsafe, undersized, and low-contrast V2 token overrides", async () => {
  const { plan } = await examplePlan("minimal");
  const cases = [
    {
      overrides: { unknown: { value: "not-a-token" } },
      path: "$.designIntent.tokenOverrides.unknown"
    },
    {
      overrides: { colors: { background: "#ffffff; color: #000000" } },
      path: "$.designIntent.tokenOverrides.colors.background"
    },
    {
      overrides: { fonts: { body: "Arial; color: red" } },
      path: "$.designIntent.tokenOverrides.fonts.body"
    },
    {
      overrides: { type: { body: 21 } },
      path: "$.designIntent.tokenOverrides.type.body"
    }
  ];
  for (const { overrides, path } of cases) {
    const invalid = structuredClone(plan);
    invalid.designIntent.tokenOverrides = overrides;
    await assert.rejects(() => validatePlan(invalid), (error) => error.code === "E_PLAN_SCHEMA" && error.path === path);
  }

  const contrastInvalid = structuredClone(plan);
  contrastInvalid.designIntent.tokenOverrides = { colors: { text: "#FFFFFF" } };
  await assert.rejects(
    () => validatePlan(contrastInvalid),
    (error) => error.code === "E_PLAN_SCHEMA"
      && error.path === "$.designIntent.tokenOverrides.colors"
      && /contrast/.test(error.message)
  );
});

test("invalidates a completed review whenever a locked input changes", async () => {
  const { plan } = await examplePlan("minimal");
  const changed = structuredClone(plan);
  changed.designIntent.mood = ["克制", "坚定"];
  await assert.rejects(
    () => validatePlan(changed),
    (error) => error.code === "E_REVIEW_INVALIDATED" && error.path === "$.designIntent.lock.canonicalPlanSha256"
  );
});

test("requires declared continuation semantics before a page may split", async () => {
  const { plan } = await examplePlan("minimal");
  const invalid = structuredClone(plan);
  invalid.pagination.pageBudgets[1].continuationOf = "slide-cover";
  refreshBindings(invalid);
  await assert.rejects(
    () => validatePlan(invalid),
    (error) => error.code === "E_PAGINATION_CONTINUATION"
  );
});

test("compiles a canonical layout archetype through the legacy-compatible renderer adapter", async () => {
  const { plan } = await examplePlan("minimal");
  const canonical = structuredClone(plan);
  canonical.slides[1].intent = "executive-summary";
  canonical.slides[1].layoutArchetype = "executive-summary";
  refreshBindings(canonical);

  await validatePlan(canonical);
  const compiled = compilePlanForRender(canonical);
  assert.equal(compiled.slides[1].layoutArchetype, "executive-summary");
  assert.equal(compiled.slides[1].type, "bullets");
});
