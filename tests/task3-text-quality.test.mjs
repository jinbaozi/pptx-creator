import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVERTISED_ARCHETYPES,
  buildPlanFromBriefFixture,
  compileDeckPlan,
  geometrySignature,
  getArchetypeRegistry,
  validateDeckPlan
} from "../scripts/lib/deck-plan.mjs";
import {
  applyContextualTaste,
  buildContextualTasteProfile,
  evaluateCreativeGate,
  qualityFromReview
} from "../scripts/lib/contextual-taste.mjs";
import { escapePreviewHtml } from "../scripts/run-deck-pipeline.mjs";
import { reviewManifest } from "../scripts/lib/visual-critic.mjs";
import { parseDesignFile } from "../scripts/parse-design-md.mjs";

const fixturePath = path.join("examples", "text-input", "creative", "deck.plan.json");
const loadPlan = () => JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const walkFiles = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(root, entry.name);
  return entry.isDirectory() ? walkFiles(target) : [target];
});
const actualQuality = (plan) => {
  expect(validateDeckPlan(plan)).toEqual({ valid: true, errors: [] });
  const manifest = compileDeckPlan(plan);
  const review = applyContextualTaste(reviewManifest(manifest, { mode: "creative" }), manifest, plan);
  return qualityFromReview(review, 5, { source: "fontkit", fallback: [] });
};

describe("deck.plan 0.1 creative intermediate", () => {
  it("validates the single coordinate-free creative plan", () => {
    const plan = loadPlan();
    expect(validateDeckPlan(plan)).toEqual({ valid: true, errors: [] });
    expect(plan.version).toBe("0.1.0");
    expect(JSON.stringify(plan)).not.toMatch(/\"[xywh]\"\s*:/);
  });

  it("compiles all advertised families through distinct validators and compilers", () => {
    expect(ADVERTISED_ARCHETYPES).toEqual([
      "cover", "architecture", "comparison", "process", "dashboard", "quote", "matrix", "closing"
    ]);
    const registry = getArchetypeRegistry();
    expect(new Set(Object.values(registry).map((entry) => entry.schema.$id)).size).toBe(8);
    expect(new Set(Object.values(registry).map((entry) => entry.validate)).size).toBe(8);
    expect(new Set(Object.values(registry).map((entry) => entry.compile)).size).toBe(8);
    const manifest = compileDeckPlan(loadPlan());
    expect(manifest.slides).toHaveLength(8);
    expect(new Set(manifest.slides.map(geometrySignature)).size).toBe(8);
    const golden = JSON.parse(fs.readFileSync("tests/golden/deck-plan-archetype-geometry.json", "utf8"));
    expect(Object.fromEntries(manifest.slides.map((slide) => [slide.type, geometrySignature(slide)]))).toEqual(golden);
    for (const slide of manifest.slides) {
      expect(slide.elements.length).toBeGreaterThanOrEqual(2);
      expect(slide.elements.every((element) => ["text", "shape", "line", "table", "chart"].includes(element.type))).toBe(true);
    }
    for (const [family, entry] of Object.entries(registry)) {
      expect(entry.schema, family).toMatchObject({ type: "object", additionalProperties: false });
      expect(entry.schema.required.length, family).toBeGreaterThan(0);
      expect(Object.keys(entry.schema.properties), family).toEqual(expect.arrayContaining(entry.schema.required));
    }
  });

  it("rejects family-specific content that does not satisfy its schema", () => {
    const plan = loadPlan();
    plan.slides.find((slide) => slide.layoutFamily === "architecture").content = { headline: "Missing layers" };
    const result = validateDeckPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/architecture.*layers/i);
  });

  it("recursively rejects coordinate and layout primitive keys anywhere in a plan", () => {
    for (const key of ["x", "y", "w", "h", "left", "top", "right", "bottom", "width", "height"]) {
      const plan = loadPlan();
      plan.slides[0].content.nested = { [key]: 1 };
      expect(validateDeckPlan(plan).errors.join(" "), key).toMatch(new RegExp(`prohibited.*${key}`, "i"));
      expect(() => compileDeckPlan(plan), key).toThrow(new RegExp(key, "i"));
    }
  });

  it("rejects family overflow instead of truncating content", () => {
    const cases = [
      ["architecture", "layers", ["1", "2", "3", "4", "5"]],
      ["process", "steps", ["1", "2", "3", "4", "5", "6"]],
      ["dashboard", "metrics", Array.from({ length: 5 }, (_, index) => ({ label: `M${index}`, value: index }))]
    ];
    for (const [family, field, value] of cases) {
      const plan = loadPlan();
      plan.slides.find((slide) => slide.layoutFamily === family).content[field] = value;
      expect(validateDeckPlan(plan).errors.join(" "), family).toMatch(new RegExp(`${family}.*${field}.*max`, "i"));
    }
  });
});

describe("contextual creative taste gate", () => {
  it("compiles and scores real clean/risky/borderline deck plans before gating", () => {
    const results = Object.fromEntries(["clean", "risky", "borderline"].map((name) => {
      const plan = JSON.parse(fs.readFileSync(`examples/text-input/calibration/${name}.deck.plan.json`, "utf8"));
      return [name, actualQuality(plan)];
    }));
    expect(results.clean.gate.passed).toBe(true);
    expect(results.risky.gate.passed).toBe(false);
    expect(results.risky.contextualTaste.findings.length).toBeGreaterThan(0);
    expect(results.borderline.gate.passed).toBe(false);
  });

  it("fails closed when any required creative metric is missing, NaN, or non-numeric", () => {
    const valid = { deckScore: 90, slides: [{ id: "s1", score: 85 }], slopRisk: 10, criticalFindings: 0, editabilityLevel: 5 };
    for (const mutate of [
      (q) => { delete q.deckScore; }, (q) => { q.deckScore = Number.NaN; },
      (q) => { delete q.slides[0].score; }, (q) => { q.slides[0].score = "85"; },
      (q) => { delete q.slopRisk; }, (q) => { q.slopRisk = Number.NaN; },
      (q) => { delete q.criticalFindings; }, (q) => { q.criticalFindings = Number.NaN; },
      (q) => { delete q.editabilityLevel; }, (q) => { q.editabilityLevel = Number.NaN; }
    ]) {
      const quality = structuredClone(valid);
      mutate(quality);
      expect(evaluateCreativeGate(quality).passed).toBe(false);
    }
  });

  it("derives anti-default checks from the plan dials and honors explicit source/brand intent", () => {
    const plan = loadPlan();
    const profile = buildContextualTasteProfile(plan);
    expect(profile.checks).toContain("composition-variance");
    expect(profile.checks).toContain("density-fit");
    expect(profile.checks).toContain("energy-fit");
    expect(profile.checks).toContain("editorial-hierarchy");
    plan.designRead = "Brand-defined visual system";
    plan.dials = { compositionVariance: 20, visualDensity: 50, visualEnergy: 50 };
    plan.intentOverride = { sourceLocked: true, brandLocked: true };
    expect(buildContextualTasteProfile(plan).genericHeuristicsSuppressed).toBe(true);
    const contextual = applyContextualTaste({ deckScore: 80, slopRisk: 10, slides: [{ id: "s1", score: 70, issues: [{ severity: "medium", type: "layout-repetition" }] }] }, { slides: [{ type: "cover", elements: [] }] }, plan);
    expect(contextual.slides[0].issues).toEqual([]);
    expect(contextual.slides[0].score).toBe(80);
  });

  it("implements energy, editorial hierarchy, and restraint as scoring findings", () => {
    const baseReview = { deckScore: 100, slopRisk: 0, slides: [{ id: "s1", score: 100, issues: [] }] };
    const cases = [
      [{ designRead: "High-energy launch", dials: { compositionVariance: 20, visualDensity: 50, visualEnergy: 90 } }, { slides: [{ type: "cover", elements: [{ type: "text", style: { fontSize: 30 } }] }] }, "context-energy-fit"],
      [{ designRead: "Editorial narrative", dials: { compositionVariance: 20, visualDensity: 50, visualEnergy: 50 } }, { slides: [{ type: "quote", elements: [{ type: "text", style: { fontSize: 16 } }, { type: "text", style: { fontSize: 16 } }] }] }, "context-editorial-hierarchy"],
      [{ designRead: "Restrained and calm", dials: { compositionVariance: 20, visualDensity: 50, visualEnergy: 20 } }, { slides: [{ type: "dashboard", elements: Array.from({ length: 6 }, (_, i) => ({ type: "shape", id: `s${i}`, style: { fill: "#2563EB" } })) }] }, "context-restraint"]
    ];
    for (const [plan, manifest, finding] of cases) {
      const contextual = applyContextualTaste(structuredClone(baseReview), manifest, plan);
      expect(contextual.contextualTaste.findings.map((item) => item.type)).toContain(finding);
      expect(qualityFromReview(contextual, 5, { source: "fontkit", fallback: [] }).gate.passed).toBe(false);
    }
  });

  it("brand/source override removes generic taste only and preserves hard readability findings", () => {
    const plan = { designRead: "Brand locked", dials: { compositionVariance: 20, visualDensity: 50, visualEnergy: 50 }, intentOverride: { brandLocked: true } };
    const review = { deckScore: 72, slopRisk: 0, slides: [{ id: "s1", score: 72, issues: [{ severity: "medium", type: "layout-repetition" }, { severity: "high", type: "text-contrast" }] }] };
    const contextual = applyContextualTaste(review, { slides: [{ type: "cover", elements: [] }] }, plan);
    expect(contextual.slides[0].issues.map((item) => item.type)).toEqual(["text-contrast"]);
    expect(qualityFromReview(contextual, 5, { source: "fontkit", fallback: [] }).gate.passed).toBe(false);
  });

  it("uses real font preflight compatibility and does not apply to direct/replica", () => {
    const base = { deckScore: 90, slides: [{ score: 85 }], slopRisk: 10, criticalFindings: 0, editabilityLevel: 5 };
    expect(evaluateCreativeGate(base, { mode: "creative", fontPreflight: { source: "fontkit", fallback: [] } }).passed).toBe(true);
    const measured = evaluateCreativeGate(base, { mode: "creative", fontPreflight: { source: "fontkit", fallback: [{ requested: "Missing", fallback: "system-default" }] } });
    expect(measured.passed).toBe(true);
    expect(measured.compatibility).toEqual({ source: "fontkit", fallbackCount: 1, score: 85 });
    expect(evaluateCreativeGate({}, { mode: "direct" })).toEqual({ applicable: false, passed: true, reasons: [] });
    expect(evaluateCreativeGate({}, { mode: "replica" })).toEqual({ applicable: false, passed: true, reasons: [] });
  });
});

describe("stable bilingual brief corpus and text output contract", () => {
  it("escapes authored text before placing it in preview HTML", () => {
    expect(escapePreviewHtml(`<script>alert("x")</script>&`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;");
  });

  it("documents one deck plan, optional direction candidates, and the human maintenance protocol", () => {
    for (const relative of ["references/design-first-workflow.md", "references/routes/text.md", "SKILL.md"]) {
      const content = fs.readFileSync(relative, "utf8");
      expect(content, relative).toContain("deck.plan.json");
      expect(content, relative).not.toMatch(/deck\.storyboard\.json|deck\.design-direction\.json|slide-design-specs\.json/);
    }
    const maintenance = fs.readFileSync("references/text-quality-maintenance.md", "utf8");
    expect(maintenance).toMatch(/blind pairwise/i);
    expect(maintenance).toMatch(/win rate.*70%/i);
    for (const dimension of ["hierarchy", "spacing", "density", "consistency", "originality"]) {
      expect(maintenance).toMatch(new RegExp(`${dimension}.*4/5`, "i"));
    }
    expect(maintenance).toMatch(/material ambiguity|high risk/i);
  });

  it("retires every executable/public triple-artifact entry", () => {
    for (const retired of [
      "scripts/compile-design-first.mjs", "scripts/lib/design-first-loader.mjs", "scripts/lib/manifest-compiler.mjs",
      "schemas/storyboard.schema.json", "schemas/design-direction.schema.json", "schemas/slide-design-spec.schema.json",
      "tests/manifest-compiler.test.mjs"
    ]) expect(fs.existsSync(retired), retired).toBe(false);
    const retiredExample = "examples/design-first/compiler-roadshow";
    expect(!fs.existsSync(retiredExample) || fs.readdirSync(retiredExample).length === 0).toBe(true);
    const publicEntries = ["README.md", "README.en.md", "AGENTS.md", "SKILL.md", ...["references", "scripts", "schemas", "examples", "layout-archetypes", "slide-archetypes"].flatMap(walkFiles)]
      .filter((relative) => /\.(?:md|mjs|json|html)$/.test(relative));
    for (const relative of publicEntries) {
      expect(fs.readFileSync(relative, "utf8"), relative).not.toMatch(/storyboard|design[ -]direction|slide[ -]design[ -]specs|compile-design-first|design-first-loader/i);
    }
    const agents = fs.readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("examples/text-input/creative/deck.plan.json");
    expect(agents).not.toContain("examples/design-first/compiler-roadshow");
    const showcase = fs.readFileSync("examples/design-first/compiler-roadshow-html/deck.html", "utf8");
    expect(showcase).not.toMatch(/ships through the design-first path/i);
  });

  it("derives a plan from fixture input without consulting the expected oracle", () => {
    const fixture = JSON.parse(fs.readFileSync("examples/text-input/bilingual-briefs.json", "utf8"))[0];
    const original = buildPlanFromBriefFixture(fixture);
    const mutated = structuredClone(fixture);
    mutated.expected = { domain: "wrong", layoutFamily: "quote", tasteBand: "risky", tasteTraits: [] };
    expect(buildPlanFromBriefFixture(mutated)).toEqual(original);
  });

  it("ships 24 deterministic bilingual fixtures across six deck domains", () => {
    const corpus = JSON.parse(fs.readFileSync("examples/text-input/bilingual-briefs.json", "utf8"));
    expect(corpus).toHaveLength(24);
    expect(new Set(corpus.map((item) => item.domain))).toEqual(new Set([
      "business", "editorial", "technical", "public-sector", "data", "narrative"
    ]));
    expect(corpus.filter((item) => item.language === "zh-CN")).toHaveLength(12);
    expect(corpus.filter((item) => item.language === "en-US")).toHaveLength(12);
    for (const item of corpus) {
      expect(item.input?.intent, item.id).toBeTruthy();
      expect(item.expected.domain, item.id).toBe(item.domain);
      const plan = buildPlanFromBriefFixture(item);
      expect(validateDeckPlan(plan), item.id).toEqual({ valid: true, errors: [] });
      const manifest = compileDeckPlan(plan);
      expect(manifest.slides[0].type, item.id).toBe(item.expected.layoutFamily);
      const profile = buildContextualTasteProfile(plan);
      expect(profile.checks, item.id).toEqual(expect.arrayContaining(item.expected.tasteTraits));
      expect(actualQuality(plan).gate.passed, item.id).toBe(item.expected.tasteBand === "clean");
    }
  });

  it("creative CLI smoke emits the plan, manifest, deck, quality reports, package index, and preview index", async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-task3-text-"));
    execFileSync("node", ["scripts/pptx.mjs", "text", fixturePath, output, "--creative"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });
    for (const relative of [
      "final.pptx", "deck.manifest.json", "deck.plan.json", "quality-report.json", "quality-report.md",
      "output-manifest.json", "preview/index.html"
    ]) expect(fs.existsSync(path.join(output, relative)), relative).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "deck.manifest.json"), "utf8"));
    expect(manifest.designSystem.source).toBe("design-system/DESIGN.md");
    expect(fs.existsSync(path.resolve(output, manifest.designSystem.source))).toBe(true);
    expect(path.resolve(output, manifest.designSystem.source).startsWith(path.resolve(output))).toBe(true);
    const standalone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pptx-task3-standalone-")), "deck-output");
    fs.cpSync(output, standalone, { recursive: true });
    const standaloneManifest = JSON.parse(fs.readFileSync(path.join(standalone, "deck.manifest.json"), "utf8"));
    const standaloneDesign = path.resolve(standalone, standaloneManifest.designSystem.source);
    expect(fs.readFileSync(standaloneDesign, "utf8").length).toBeGreaterThan(100);
    expect((await parseDesignFile(standaloneDesign)).tokens).toBeTruthy();
    const outputManifest = JSON.parse(fs.readFileSync(path.join(output, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).toEqual(expect.arrayContaining(["final.pptx", "deck.manifest.json", "deck.plan.json", "design-system", "quality-report.json", "quality-report.md", "preview"]));
  }, 60000);
});
