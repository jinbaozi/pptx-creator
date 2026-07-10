import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVERTISED_ARCHETYPES,
  compileDeckPlan,
  geometrySignature,
  getArchetypeRegistry,
  validateDeckPlan
} from "../scripts/lib/deck-plan.mjs";
import {
  applyContextualTaste,
  buildContextualTasteProfile,
  evaluateCreativeGate
} from "../scripts/lib/contextual-taste.mjs";
import { escapePreviewHtml } from "../scripts/run-deck-pipeline.mjs";

const fixturePath = path.join("examples", "text-input", "creative", "deck.plan.json");
const loadPlan = () => JSON.parse(fs.readFileSync(fixturePath, "utf8"));

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
  });

  it("rejects family-specific content that does not satisfy its schema", () => {
    const plan = loadPlan();
    plan.slides.find((slide) => slide.layoutFamily === "architecture").content = { headline: "Missing layers" };
    const result = validateDeckPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/architecture.*layers/i);
  });
});

describe("contextual creative taste gate", () => {
  it("passes clean, blocks risky, and blocks a threshold-borderline calibration", () => {
    const fixtures = JSON.parse(fs.readFileSync("examples/text-input/quality-calibration.json", "utf8"));
    expect(evaluateCreativeGate(fixtures.clean)).toMatchObject({ passed: true });
    expect(evaluateCreativeGate(fixtures.risky)).toMatchObject({ passed: false });
    expect(evaluateCreativeGate(fixtures.borderline)).toMatchObject({ passed: false });
  });

  it("derives anti-default checks from the plan dials and honors explicit source/brand intent", () => {
    const plan = loadPlan();
    const profile = buildContextualTasteProfile(plan);
    expect(profile.checks).toContain("composition-variance");
    expect(profile.checks).toContain("density-fit");
    expect(profile.checks).toContain("energy-fit");
    expect(profile.checks).toContain("editorial-hierarchy");
    expect(profile.checks).toContain("restraint");
    plan.intentOverride = { sourceLocked: true, brandLocked: true };
    expect(buildContextualTasteProfile(plan).genericHeuristicsSuppressed).toBe(true);
    const contextual = applyContextualTaste({ deckScore: 80, slopRisk: 10, slides: [{ id: "s1", score: 70, issues: [{ severity: "medium", type: "layout-repetition" }] }] }, { slides: [{ type: "cover", elements: [] }] }, plan);
    expect(contextual.slides[0].issues).toEqual([]);
    expect(contextual.slides[0].score).toBe(80);
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

  it("ships 24 deterministic bilingual fixtures across six deck domains", () => {
    const corpus = JSON.parse(fs.readFileSync("examples/text-input/bilingual-briefs.json", "utf8"));
    expect(corpus).toHaveLength(24);
    expect(new Set(corpus.map((item) => item.domain))).toEqual(new Set([
      "business", "editorial", "technical", "public-sector", "data", "narrative"
    ]));
    expect(corpus.filter((item) => item.language === "zh-CN")).toHaveLength(12);
    expect(corpus.filter((item) => item.language === "en-US")).toHaveLength(12);
    expect(corpus.every((item) => item.expected.layoutFamily && item.expected.tasteBand)).toBe(true);
  });

  it("creative CLI smoke emits the plan, manifest, deck, quality reports, package index, and preview index", () => {
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
    expect(path.isAbsolute(manifest.designSystem.source)).toBe(false);
    expect(fs.existsSync(path.resolve(output, manifest.designSystem.source))).toBe(true);
    const outputManifest = JSON.parse(fs.readFileSync(path.join(output, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).toEqual(expect.arrayContaining(["final.pptx", "deck.manifest.json", "deck.plan.json", "quality-report.json", "quality-report.md", "preview"]));
  }, 60000);
});
