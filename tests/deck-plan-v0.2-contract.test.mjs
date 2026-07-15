import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileDeckPlan, validateDeckPlan } from "../scripts/lib/deck-plan.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const legacyFixture = "tests/fixtures/deck-plan/legacy-0.1.deck.plan.json";

function validPlanV02() {
  return {
    version: "0.2.0",
    context: {
      title: "Creative Director Contract",
      language: "en-US",
      audience: { primary: "Product and engineering leaders", knowledgeLevel: "informed" },
      decisionGoal: "Approve the native-first creative workflow",
      durationMinutes: 12,
      environment: { viewingMode: "hybrid", presentedOrReadAlone: "both" },
      tone: "Confident, precise, and evidence-led",
      mustRemember: ["Intent remains visible through compilation"],
      brand: { references: ["project:brand-system"], antiReferences: ["generic-template-stack"] },
      qualityProfile: "premium",
      targetSuites: [
        { suite: "libreoffice", required: true },
        { suite: "powerpoint", required: true }
      ],
      editabilityFloor: 5,
      assetIntensity: 60,
      visualAmbition: 75
    },
    designIntent: {
      designRead: "Editorial-technical direction with decisive native geometry.",
      typography: "Decisive grotesk hierarchy",
      palette: "Ink, cobalt, and warm white",
      material: "Flat editorial planes",
      imagery: "Evidence-led diagrams and documentary photography",
      composition: { direction: "Rhythmic asymmetry", visibleGrid: false },
      dials: { compositionVariance: 72, visualDensity: 54, visualEnergy: 62 },
      locks: {
        sourceLocked: false,
        brandLocked: true,
        protectedTokens: ["colors.primary"],
        protectedAssets: ["asset-hero"]
      }
    },
    story: {
      narrativeBeats: ["Frame", "Explain", "Decide"],
      sections: [
        { id: "section-main", title: "Decision story", slideIds: ["slide-cover", "slide-decision", "slide-appendix"] }
      ],
      decisionPath: ["slide-cover", "slide-decision"]
    },
    assets: [
      {
        id: "asset-hero",
        kind: "photo",
        role: "hero evidence",
        description: "A localized documentary image",
        provenance: {
          origin: "project",
          sourceRef: "assets/hero.png",
          sourceUrl: "https://example.com/project/hero",
          rights: { status: "allowed", license: "project-owned" },
          contentHash: `sha256:${"a".repeat(64)}`
        },
        focalPoint: "center",
        cropPolicy: "cover",
        altText: "Team reviewing a presentation system",
        fallback: { strategy: "placeholder", description: "Use a native neutral placeholder" }
      }
    ],
    slides: [
      {
        id: "slide-cover",
        pageRole: "single-point",
        message: "Intent remains visible through compilation",
        contentModel: {
          kind: "cover",
          data: { headline: "Creative Director Contract", subtitle: "One coordinate-free source of intent" }
        },
        attentionTarget: { kind: "message", ref: "intent-visible" },
        compositionIntent: { strategy: "asymmetric", whitespace: "spacious", emphasis: "message" },
        assetIds: [],
        routePolicy: { preferred: "native", allowed: ["native"], fullSlideRaster: false }
      },
      {
        id: "slide-decision",
        pageRole: "decision",
        message: "Native-first preserves editability",
        contentModel: {
          kind: "process",
          data: { headline: "A bounded workflow", steps: ["Plan", "Compile", "Prove"] }
        },
        attentionTarget: { kind: "asset", ref: "asset-hero" },
        compositionIntent: { strategy: "split", whitespace: "balanced", emphasis: "asset" },
        assetIds: ["asset-hero"],
        routePolicy: { preferred: "native", allowed: ["native", "html-assisted"], fullSlideRaster: false }
      },
      {
        id: "slide-appendix",
        pageRole: "appendix",
        message: "The migration shell remains explicit",
        contentModel: {
          kind: "closing",
          data: { headline: "Contract locked", callToAction: "Proceed to Semantic Slide IR." }
        },
        attentionTarget: { kind: "content", ref: "migration-shell" },
        compositionIntent: { strategy: "editorial", whitespace: "compact", emphasis: "evidence" },
        assetIds: [],
        routePolicy: { preferred: "native", allowed: ["native", "local-raster"], fullSlideRaster: false }
      }
    ]
  };
}

const errorsFor = (plan) => validateDeckPlan(plan).errors.join(" ");

describe("deck.plan 0.2 canonical contract", () => {
  it("accepts the exact required top-level contract through both schema and runtime validation", () => {
    const plan = validPlanV02();
    expect(Object.keys(plan).sort()).toEqual(["assets", "context", "designIntent", "slides", "story", "version"]);
    const schema = JSON.parse(fs.readFileSync("schemas/deck-plan.schema.json", "utf8"));
    expect(validateJsonSchema(plan, schema)).toEqual({ valid: true, errors: [] });
    expect(validateDeckPlan(plan)).toEqual({ valid: true, errors: [] });

    plan.unexpected = true;
    expect(validateDeckPlan(plan).valid).toBe(false);
  });

  it("rejects slide IDs that cannot satisfy the manifest contract", () => {
    const plan = validPlanV02();
    plan.slides[0].id = "cover";
    plan.story.sections[0].slideIds[0] = "cover";
    plan.story.decisionPath[0] = "cover";
    const planSchema = JSON.parse(fs.readFileSync("schemas/deck-plan.schema.json", "utf8"));
    const manifestSchema = JSON.parse(fs.readFileSync("schemas/deck.schema.json", "utf8"));
    const planValidation = validateJsonSchema(plan, planSchema);
    const manifestValidation = planValidation.valid
      ? validateJsonSchema(compileDeckPlan(plan), manifestSchema)
      : { valid: true, errors: [] };

    expect(planValidation.valid && !manifestValidation.valid).toBe(false);
    expect(planValidation.valid).toBe(false);
    expect(planValidation.errors.map((error) => `${error.path} ${error.message}`).join(" ")).toMatch(/slides\[0\]\.id.*pattern/i);
    expect(validateDeckPlan(plan).valid).toBe(false);
    expect(() => compileDeckPlan(plan)).toThrow(/slides\[0\]\.id.*pattern/i);
  });

  it("retires 0.1 explicitly and compileDeckPlan surfaces the same invalid-plan error", () => {
    const legacy = JSON.parse(fs.readFileSync(legacyFixture, "utf8"));
    const result = validateDeckPlan(legacy);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/deck\.plan 0\.1\.0 is retired; expected 0\.2\.0/);
    expect(() => compileDeckPlan(legacy)).toThrow(/deck\.plan invalid: deck\.plan 0\.1\.0 is retired; expected 0\.2\.0/);
  });

  it("makes the public creative CLI fail closed for the retired plan", () => {
    const outputDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pptx-plan-legacy-")), "output");
    const result = spawnSync(process.execPath, ["scripts/pptx.mjs", "text", legacyFixture, outputDir, "--native"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/deck\.plan 0\.1\.0 is retired; expected 0\.2\.0/);
    for (const relative of ["final.pptx", "deck.manifest.json", "quality-report.json", "quality-report.md", "output-manifest.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it("rejects manifest geometry and elements recursively", () => {
    for (const key of ["x", "y", "w", "h", "left", "top", "right", "bottom", "width", "height", "elements"]) {
      const plan = validPlanV02();
      plan.slides[0].contentModel.data[key] = key === "elements" ? [] : 1;
      expect(validateDeckPlan(plan).valid, key).toBe(false);
      expect(errorsFor(plan), key).toMatch(new RegExp(key, "i"));
    }
  });

  it("rejects whitespace-only values at representative non-empty string boundaries", () => {
    const mutations = [
      ["provenance sourceRef", (plan) => { plan.assets[0].provenance.sourceRef = "   "; }],
      ["context title", (plan) => { plan.context.title = "\t  "; }],
      ["slide message", (plan) => { plan.slides[0].message = "  \n"; }],
      ["attention ref", (plan) => { plan.slides[0].attentionTarget.ref = "   "; }]
    ];
    for (const [label, mutate] of mutations) {
      const plan = validPlanV02();
      mutate(plan);
      expect(validateDeckPlan(plan).valid, label).toBe(false);
      expect(errorsFor(plan), label).toMatch(/string does not match pattern/i);
    }

    const meaningful = validPlanV02();
    meaningful.context.title = "  Meaningful title  ";
    meaningful.slides[0].message = "\tMeaningful message ";
    expect(validateDeckPlan(meaningful)).toEqual({ valid: true, errors: [] });
  });

  it("enforces unique IDs and every cross-reference", () => {
    const mutations = [
      ["duplicate slide", (plan) => { plan.slides[1].id = plan.slides[0].id; }, /slide.*unique|duplicate.*slide/i],
      ["duplicate asset", (plan) => { plan.assets.push(structuredClone(plan.assets[0])); }, /asset.*unique|duplicate.*asset/i],
      ["section slide", (plan) => { plan.story.sections[0].slideIds.push("slide-missing"); }, /section.*slide-missing/i],
      ["decision path", (plan) => { plan.story.decisionPath.push("slide-missing"); }, /decision.*slide-missing/i],
      ["attention asset", (plan) => { plan.slides[1].attentionTarget.ref = "asset-missing"; }, /attention.*asset-missing/i],
      ["slide asset", (plan) => { plan.slides[0].assetIds.push("asset-missing"); }, /assetIds.*asset-missing|slide.*asset-missing/i],
      ["target suite", (plan) => { plan.context.targetSuites.push({ suite: "libreoffice", required: true }); }, /suite.*unique|duplicate.*suite/i]
    ];
    for (const [label, mutate, pattern] of mutations) {
      const plan = validPlanV02();
      mutate(plan);
      expect(validateDeckPlan(plan).valid, label).toBe(false);
      expect(errorsFor(plan), label).toMatch(pattern);
    }
  });

  it("uses one closed rights authority and enforces generated provenance", () => {
    const schema = JSON.parse(fs.readFileSync("schemas/deck-plan.schema.json", "utf8"));
    const complete = validPlanV02();
    expect(validateJsonSchema(complete, schema)).toEqual({ valid: true, errors: [] });

    const oldLicense = validPlanV02();
    oldLicense.assets[0].provenance.license = "competing-authority";
    expect(validateDeckPlan(oldLicense).valid).toBe(false);

    const missingAttribution = validPlanV02();
    missingAttribution.assets[0].provenance.rights = {
      status: "allowed-with-attribution",
      license: "CC BY 4.0"
    };
    expect(errorsFor(missingAttribution)).toMatch(/attribution/i);

    const generated = validPlanV02();
    generated.assets[0].provenance = {
      origin: "generated",
      sourceRef: "assets/generated-hero.png",
      rights: { status: "allowed", license: "Provider output terms" },
      generation: { model: "image-model-2", promptSummary: "Editorial infrastructure illustration" }
    };
    expect(validateDeckPlan(generated)).toEqual({ valid: true, errors: [] });

    const missingGeneration = structuredClone(generated);
    delete missingGeneration.assets[0].provenance.generation;
    expect(errorsFor(missingGeneration)).toMatch(/generation/i);

    for (const field of ["model", "promptSummary"]) {
      const blankGeneration = structuredClone(generated);
      blankGeneration.assets[0].provenance.generation[field] = "   ";
      expect(errorsFor(blankGeneration), field).toMatch(/string|pattern|generation/i);
    }

    const inventedGeneration = validPlanV02();
    inventedGeneration.assets[0].provenance.generation = {
      model: "image-model-2",
      promptSummary: "Invented provenance"
    };
    expect(errorsFor(inventedGeneration)).toMatch(/generation/i);
  });

  it("enforces native routing, required LibreOffice, and composition ordering", () => {
    const noNative = validPlanV02();
    noNative.slides[0].routePolicy.allowed = ["html-assisted"];
    expect(errorsFor(noNative)).toMatch(/native|preferred.*allowed/i);

    const noLibreOffice = validPlanV02();
    noLibreOffice.context.targetSuites = [{ suite: "powerpoint", required: true }];
    expect(errorsFor(noLibreOffice)).toMatch(/libreoffice.*required|required.*libreoffice/i);

    const repeated = validPlanV02();
    repeated.slides.forEach((slide) => { slide.compositionIntent.strategy = "focus"; });
    expect(errorsFor(repeated)).toMatch(/three consecutive|repeat.*composition/i);
  });
});

describe("deck.plan 0.2 compilation provenance", () => {
  it("compiles context and semantic provenance while retaining creative manifest quality mode", () => {
    const plan = validPlanV02();
    const manifest = compileDeckPlan(plan);
    expect(manifest.metadata.qualityProfile).toBe("creative");
    expect(manifest.metadata.designIntent).toMatchObject({
      source: "deck.plan",
      read: plan.designIntent.designRead,
      dials: plan.designIntent.dials,
      visibleGrid: false,
      intentOverride: plan.designIntent.locks,
      qualityProfile: "premium",
      context: plan.context,
      story: plan.story
    });
    expect(manifest.deck).toMatchObject({ title: plan.context.title, language: "en-US", editabilityFloor: 5 });
    expect(manifest.slides.map((slide) => slide.pageRole)).toEqual(["point", "evidence", "section"]);
    expect(manifest.slides.map((slide) => slide.semanticPageRole)).toEqual(["single-point", "decision", "appendix"]);
    expect(manifest.slides[1]).toMatchObject({
      attentionTarget: plan.slides[1].attentionTarget,
      compositionIntent: plan.slides[1].compositionIntent,
      routePolicy: plan.slides[1].routePolicy
    });
  });

  it("materializes full plan asset contracts with nested and flattened provenance", () => {
    const manifest = compileDeckPlan(validPlanV02());
    expect(manifest.assets).toEqual([
      {
        id: "asset-hero",
        kind: "photo",
        role: "hero evidence",
        description: "A localized documentary image",
        provenance: {
          origin: "project",
          sourceRef: "assets/hero.png",
          sourceUrl: "https://example.com/project/hero",
          rights: { status: "allowed", license: "project-owned" },
          contentHash: `sha256:${"a".repeat(64)}`
        },
        focalPoint: "center",
        cropPolicy: "cover",
        altText: "Team reviewing a presentation system",
        fallback: { strategy: "placeholder", description: "Use a native neutral placeholder" },
        src: "assets/hero.png",
        origin: "project",
        sourceRef: "assets/hero.png",
        sourceUrl: "https://example.com/project/hero",
        rights: { status: "allowed", license: "project-owned" },
        contentHash: `sha256:${"a".repeat(64)}`
      }
    ]);

    const empty = validPlanV02();
    empty.assets = [];
    empty.designIntent.locks.protectedAssets = [];
    empty.slides[1].assetIds = [];
    empty.slides[1].attentionTarget = { kind: "message", ref: "native-first" };
    empty.slides[1].compositionIntent.emphasis = "message";
    expect(validateDeckPlan(empty)).toEqual({ valid: true, errors: [] });
    expect(compileDeckPlan(empty).assets).toEqual([]);
  });
});
