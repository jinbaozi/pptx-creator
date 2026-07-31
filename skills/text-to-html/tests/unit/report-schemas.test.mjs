import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaDirectory = resolveSchemaDirectory();

function resolveSchemaDirectory() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
}

async function schema(name) {
  return JSON.parse(await readFile(join(schemaDirectory, name), "utf8"));
}

function compile(value) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(value);
}

const sha = (character) => character.repeat(64);

function designIntent() {
  return {
    proposition: "A shared narrative makes the decision actionable.",
    counterProposition: "A feature inventory does not align a decision.",
    mood: ["calm", "decisive"],
    referenceSignals: ["editorial", "high-contrast"],
    themeId: "editorial",
    compositionDiversity: "high",
    motionIntensity: "subtle",
    informationDensity: "balanced",
    imageryStrategy: "Use one factual diagram only where it clarifies the decision.",
    allowedTechniques: ["editorial-grid"],
    forbiddenTechniques: ["decorative-noise"],
    tokenOverrides: {
      colors: { primary: "#102A43" },
      type: { body: 24 }
    },
    lock: {
      canonicalPlanSha256: sha("a"),
      themeManifestSha256: sha("b"),
      tokenSha256: sha("c"),
      archetypeRegistrySha256: sha("d"),
      assetLockSha256: sha("e"),
      rendererVersion: "text-to-html@2.0.0"
    }
  };
}

function artifactHashes() {
  return {
    designIntent: sha("a"),
    assetLock: sha("b"),
    renderer: sha("c")
  };
}

function approvals() {
  return Object.fromEntries(["content", "design", "rights"].map((kind) => [kind, {
    status: "approved",
    reviewedAt: "2026-07-31T00:00:00.000Z",
    artifactHashes: artifactHashes()
  }]));
}

function hashes() {
  return {
    inputPlan: sha("1"),
    designIntent: sha("2"),
    review: sha("3"),
    assetLedger: sha("4")
  };
}

function reviewReport() {
  return {
    version: "2.0.0",
    status: "approved",
    hashes: hashes(),
    approvals: approvals(),
    blockers: [],
    invalidations: []
  };
}

function provenance() {
  return {
    version: "1.0.0",
    hashes: hashes(),
    review: {
      status: "approved",
      approved: true,
      approvals: approvals(),
      blockers: [],
      invalidations: []
    }
  };
}

test("strict report schemas accept current valid design intent, review, and provenance outputs", async () => {
  const [designIntentSchema, reviewReportSchema, provenanceSchema] = await Promise.all([
    schema("design-intent.schema.json"),
    schema("review-report.schema.json"),
    schema("provenance.schema.json")
  ]);

  assert.equal(compile(designIntentSchema)(designIntent()), true);
  assert.equal(compile(reviewReportSchema)(reviewReport()), true);
  assert.equal(compile(provenanceSchema)(provenance()), true);
});

test("strict report schemas reject malformed SHA-256 locks and bindings", async () => {
  const [designIntentSchema, reviewReportSchema, provenanceSchema] = await Promise.all([
    schema("design-intent.schema.json"),
    schema("review-report.schema.json"),
    schema("provenance.schema.json")
  ]);
  const invalidDesignIntent = designIntent();
  invalidDesignIntent.lock.assetLockSha256 = sha("E");
  const invalidReviewReport = reviewReport();
  invalidReviewReport.approvals.rights.artifactHashes.renderer = "not-a-hash";
  const invalidProvenance = provenance();
  invalidProvenance.hashes.review = sha("F");

  assert.equal(compile(designIntentSchema)(invalidDesignIntent), false);
  assert.equal(compile(reviewReportSchema)(invalidReviewReport), false);
  assert.equal(compile(provenanceSchema)(invalidProvenance), false);
});

test("strict report schemas reject undeclared properties", async () => {
  const [designIntentSchema, reviewReportSchema, provenanceSchema] = await Promise.all([
    schema("design-intent.schema.json"),
    schema("review-report.schema.json"),
    schema("provenance.schema.json")
  ]);
  const invalidDesignIntent = designIntent();
  invalidDesignIntent.unreviewedTheme = "fallback";
  const invalidReviewReport = reviewReport();
  invalidReviewReport.approvals.content.autoApproved = true;
  const invalidProvenance = provenance();
  invalidProvenance.review.untracked = true;

  assert.equal(compile(designIntentSchema)(invalidDesignIntent), false);
  assert.equal(compile(reviewReportSchema)(invalidReviewReport), false);
  assert.equal(compile(provenanceSchema)(invalidProvenance), false);
});
