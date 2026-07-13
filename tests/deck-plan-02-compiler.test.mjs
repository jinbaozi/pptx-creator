import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compileDeckPlan, validateDeckPlan } from "../scripts/lib/deck-plan.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import { fitManifestText } from "../scripts/lib/text-fit.mjs";
import { parseDesignFile } from "../scripts/parse-design-md.mjs";

const root = process.cwd();
const fixturePath = path.join(root, "examples/text-input/creative/deck.plan.json");
const manifestSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas/deck.schema.json"), "utf8"));
const loadPlan = () => JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const digest = (manifest) => JSON.stringify(manifest.slides.map((slide) => ({ background: slide.background, elements: slide.elements })));
const SECONDARY_MARKERS = new Set(["role-marker", "section-eyebrow", "decision-marker"]);
const coreDigest = (manifest, slideIndex = 0) => JSON.stringify(manifest.slides[slideIndex].elements
  .filter((element) => !SECONDARY_MARKERS.has(element.id)));
let business;
let dark;

const optionsFor = (design, request = null, extra = {}) => ({
  designTokens: design.tokens,
  designSystemName: design.name,
  designSystemSource: "design-system/DESIGN.md",
  designSystemSelection: { request, resolvedSource: design.source },
  ...extra
});

function compileMutation(mutate, options = optionsFor(business)) {
  const plan = loadPlan();
  mutate(plan);
  expect(validateDeckPlan(plan)).toEqual({ valid: true, errors: [] });
  return compileDeckPlan(plan, options);
}

function expectMaterialChange(label, lowMutation, highMutation) {
  const low = compileMutation(lowMutation);
  const high = compileMutation(highMutation);
  expect(digest(high), label).not.toBe(digest(low));
}

function visualAsset(id, kind = "photo") {
  return {
    id,
    kind,
    role: `${id} evidence`,
    description: `${id} localized evidence`,
    provenance: { origin: "project", sourceRef: `source/${id}.png`, license: "project-owned" },
    focalPoint: "center",
    cropPolicy: "cover",
    altText: `${id} evidence image`,
    fallback: { strategy: "placeholder", description: `Use a native placeholder for ${id}` }
  };
}

function rectanglesOverlap(left, right, gap = 0) {
  return left.x < right.x + right.w + gap
    && left.x + left.w + gap > right.x
    && left.y < right.y + right.h + gap
    && left.y + left.h + gap > right.y;
}

describe("deck.plan 0.2 semantic compiler", () => {
  beforeAll(async () => {
    [business, dark] = await Promise.all([
      parseDesignFile(path.join(root, "design-systems/business-neutral/DESIGN.md")),
      parseDesignFile(path.join(root, "design-systems/dark-tech/DESIGN.md"))
    ]);
  });

  it("materializes the resolved design tokens and portable selection provenance", () => {
    const plan = loadPlan();
    const businessManifest = compileDeckPlan(plan, optionsFor(business, "business-neutral"));
    const darkManifest = compileDeckPlan(plan, optionsFor(dark, "dark-tech"));

    expect(businessManifest.designSystem).toMatchObject({ source: "design-system/DESIGN.md", name: "Business Neutral" });
    expect(darkManifest.designSystem).toMatchObject({ source: "design-system/DESIGN.md", name: "Dark Tech" });
    expect(darkManifest.metadata.designIntent.designSystemSelection).toEqual({ request: "dark-tech", resolvedSource: dark.source });
    expect(businessManifest.slides[0].background.color).toBe("#FFFFFF");
    expect(darkManifest.slides[0].background.color).toBe("#020617");
    expect(businessManifest.slides[0].elements.find((element) => element.id === "headline").style).toMatchObject({
      fontFace: "Microsoft YaHei",
      fontSize: 45.88,
      color: "#2563EB"
    });
    expect(darkManifest.slides[0].elements.find((element) => element.id === "headline").style).toMatchObject({
      fontFace: "Segoe UI",
      fontSize: 48.59,
      color: "#22D3EE"
    });
    expect(businessManifest.slides.find((slide) => slide.type === "dashboard").elements.find((element) => element.id === "value-0").style.fontFamily)
      .toBe("Microsoft YaHei");
    expect(businessManifest.metadata.designIntent.typographyResolution.metricFont).toEqual({
      requested: "Arial",
      resolved: "Microsoft YaHei",
      fallbackApplied: true,
      reason: "quality-fallback-generic-metric-face"
    });
    expect(darkManifest.slides.find((slide) => slide.type === "dashboard").elements.find((element) => element.id === "value-0").style.fontFamily)
      .toBe("Consolas");
    expect(digest(darkManifest)).not.toBe(digest(businessManifest));
  });

  it("materializes resolved hero/content component baselines into core native containers", () => {
    const tokens = structuredClone(business.tokens);
    tokens.components["hero-card"] = {
      ...tokens.components["hero-card"],
      backgroundColor: "#123456",
      borderColor: "#345678"
    };
    tokens.components["content-card"] = {
      ...tokens.components["content-card"],
      backgroundColor: "#ABCDEF",
      borderColor: "#789ABC"
    };
    const manifest = compileDeckPlan(loadPlan(), optionsFor({ ...business, tokens }));
    const comparison = manifest.slides.find((slide) => slide.type === "comparison");

    expect(comparison.elements.find((element) => element.id === "left-panel").style).toMatchObject({
      component: "{components.hero-card}",
      fill: "#123456",
      line: "#345678"
    });
    expect(comparison.elements.find((element) => element.id === "right-panel").style).toMatchObject({
      component: "{components.content-card}",
      fill: "#ABCDEF",
      line: "#789ABC"
    });
  });

  it("preserves a declared metric face when design identity locks protect it", () => {
    const plan = loadPlan();
    plan.designIntent.locks.protectedTokens = ["typography.metric.fontFamily"];
    const manifest = compileDeckPlan(plan, optionsFor(business, "business-neutral"));
    const metric = manifest.slides.find((slide) => slide.type === "dashboard").elements.find((element) => element.id === "value-0");
    expect(metric.style).toMatchObject({
      fontFamily: "Arial",
      fontResolution: { requested: "Arial", resolved: "Arial", fallbackApplied: false, reason: "design-token-locked" }
    });
    expect(manifest.metadata.designIntent.typographyResolution.metricFont).toEqual(metric.style.fontResolution);
  });

  it("makes every global and slide-level intent field materially affect elements", () => {
    const cases = [
      ["visualAmbition", (p) => { p.context.visualAmbition = 10; }, (p) => { p.context.visualAmbition = 90; }],
      ["compositionVariance", (p) => { p.designIntent.dials.compositionVariance = 10; }, (p) => { p.designIntent.dials.compositionVariance = 90; }],
      ["visualDensity", (p) => { p.designIntent.dials.visualDensity = 10; }, (p) => { p.designIntent.dials.visualDensity = 90; }],
      ["visualEnergy", (p) => { p.designIntent.dials.visualEnergy = 10; }, (p) => { p.designIntent.dials.visualEnergy = 90; }],
      ["pageRole", (p) => { p.slides[0].pageRole = "cover"; }, (p) => { p.slides[0].pageRole = "single-point"; }],
      ["strategy", (p) => { p.slides[0].compositionIntent.strategy = "asymmetric"; }, (p) => { p.slides[0].compositionIntent.strategy = "focus"; }],
      ["whitespace", (p) => { p.slides[0].compositionIntent.whitespace = "compact"; }, (p) => { p.slides[0].compositionIntent.whitespace = "spacious"; }]
    ];
    for (const [label, low, high] of cases) expectMaterialChange(label, low, high);
  });

  it("keeps page role, visual ambition, and visual energy material after secondary markers are removed", () => {
    const pairs = [
      ["pageRole", (plan) => { plan.slides[0].pageRole = "cover"; }, (plan) => { plan.slides[0].pageRole = "single-point"; }],
      ["visualAmbition", (plan) => { plan.context.visualAmbition = 10; }, (plan) => { plan.context.visualAmbition = 90; }],
      ["visualEnergy", (plan) => { plan.designIntent.dials.visualEnergy = 10; }, (plan) => { plan.designIntent.dials.visualEnergy = 90; }]
    ];
    for (const [label, lowMutation, highMutation] of pairs) {
      const low = compileMutation(lowMutation);
      const high = compileMutation(highMutation);
      expect(coreDigest(high), `${label} must change core elements`).not.toBe(coreDigest(low));
    }
  });

  it("targets attention at the matching semantic class without recoloring functional panels", () => {
    const message = compileMutation(() => {});
    const diagram = compileMutation((plan) => { plan.slides[0].attentionTarget = { kind: "diagram", ref: "brief:system" }; });
    const dashboard = message.slides.find((slide) => slide.type === "dashboard");
    const comparison = message.slides.find((slide) => slide.type === "comparison");
    const messageEmphasis = compileMutation((plan) => { plan.slides[4].compositionIntent.emphasis = "message"; }).slides[4];

    expect(message.slides[0].elements.find((element) => element.id === "headline").style.color).toBe("#2563EB");
    const diagramHeadline = diagram.slides[0].elements.find((element) => element.id === "headline");
    const messageHeadline = message.slides[0].elements.find((element) => element.id === "headline");
    expect(diagramHeadline.style.color).toBe("#2563EB");
    expect(diagramHeadline.style.fontSize).toBeLessThan(messageHeadline.style.fontSize);
    expect(diagram.slides[0].elements.find((element) => element.id === "cover-accent").style.borderWidth).toBeGreaterThan(1);
    expect(dashboard.elements.find((element) => element.id === "value-0").style.fontSize).toBeGreaterThan(business.tokens.typography.metric.fontSize);
    expect(dashboard.elements.find((element) => element.id === "value-0").style.fontSize)
      .toBeGreaterThan(messageEmphasis.elements.find((element) => element.id === "value-0").style.fontSize);
    expect(comparison.elements.find((element) => element.id === "left-items").style.color).toBe("#2563EB");
    expect(["#F8FAFC", "#EFF6FF"]).toContain(comparison.elements.find((element) => element.id === "left-panel").style.fill);
  });

  it("renders declared section starts and decision-path placement as visible native markers", () => {
    const manifest = compileMutation(() => {});
    const cover = manifest.slides[0];
    expect(cover.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "section-eyebrow", type: "text", text: "From intent to evidence" }),
      expect.objectContaining({ id: "decision-marker", type: "shape" })
    ]));
    expect(manifest.slides.find((slide) => slide.id === "slide-architecture").elements.some((element) => element.id === "decision-marker")).toBe(false);

    const withoutSectionStart = compileMutation((plan) => { plan.story.sections[0].slideIds = plan.story.sections[0].slideIds.slice(1); });
    const withoutDecision = compileMutation((plan) => { plan.story.decisionPath = plan.story.decisionPath.slice(1); });
    expect(withoutSectionStart.slides[0].elements.some((element) => element.id === "section-eyebrow")).toBe(false);
    expect(withoutDecision.slides[0].elements.some((element) => element.id === "decision-marker")).toBe(false);
  });

  it("preserves full asset contracts and emits visual image elements with crop intent", () => {
    const plan = loadPlan();
    const asset = {
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      description: "A localized evidence image",
      provenance: { origin: "project", sourceRef: "source/hero.png", license: "project-owned", contentHash: "sha256:test" },
      focalPoint: "top-right",
      cropPolicy: "cover",
      altText: "Team reviewing the evidence",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    };
    plan.assets.push(asset);
    plan.slides[0].assetIds = [asset.id];
    plan.slides[0].attentionTarget = { kind: "asset", ref: asset.id };
    plan.slides[0].compositionIntent.emphasis = "asset";
    const compilerOptions = optionsFor(business, null, { assetSourceById: { [asset.id]: "assets/asset-hero-abc.png" } });
    const manifest = compileDeckPlan(plan, compilerOptions);
    const image = manifest.slides[0].elements.find((element) => element.type === "image");

    expect(manifest.assets[0]).toMatchObject({ ...asset, src: "assets/asset-hero-abc.png" });
    expect(image).toMatchObject({
      id: "asset-asset-hero",
      type: "image",
      assetId: asset.id,
      src: "assets/asset-hero-abc.png",
      focalPoint: "top-right",
      cropPolicy: "cover",
      alt: asset.altText,
      altText: asset.altText,
      sizing: { type: "cover" }
    });
    expect(image.w).toBeGreaterThan(4);

    const lowIntensity = structuredClone(plan);
    lowIntensity.context.assetIntensity = 10;
    const highIntensity = structuredClone(plan);
    highIntensity.context.assetIntensity = 90;
    const lowImage = compileDeckPlan(lowIntensity, compilerOptions).slides[0].elements.find((element) => element.type === "image");
    const highImage = compileDeckPlan(highIntensity, compilerOptions).slides[0].elements.find((element) => element.type === "image");
    expect(highImage.w).toBeGreaterThan(lowImage.w);
    expect(highImage.h).toBeGreaterThan(lowImage.h);

    const nonvisual = structuredClone(plan);
    nonvisual.assets[0].kind = "chart-data";
    nonvisual.slides[0].attentionTarget = { kind: "data", ref: "brief:data" };
    nonvisual.slides[0].compositionIntent.emphasis = "data";
    expect(compileDeckPlan(nonvisual, optionsFor(business, null, { assetSourceById: { [asset.id]: "assets/data.csv" } })).slides[0].elements)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ assetId: asset.id, type: "image" })]));
  });

  it("rejects duplicate, nonmember, nonvisual, unsupported-count, and empty asset-emphasis contracts", () => {
    const cases = [
      ["duplicate", (plan) => {
        plan.assets.push(visualAsset("asset-a"));
        plan.slides[0].assetIds = ["asset-a", "asset-a"];
      }, /duplicate|unique/i],
      ["nonmember attention", (plan) => {
        plan.assets.push(visualAsset("asset-a"), visualAsset("asset-b"));
        plan.slides[0].assetIds = ["asset-a"];
        plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-b" };
      }, /attentionTarget.*assetIds|belong/i],
      ["nonvisual attention", (plan) => {
        plan.assets.push(visualAsset("asset-data", "chart-data"));
        plan.slides[0].assetIds = ["asset-data"];
        plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-data" };
      }, /attentionTarget.*visual|renderable/i],
      ["unsupported count", (plan) => {
        plan.assets.push(...Array.from({ length: 6 }, (_, index) => visualAsset(`asset-${index + 1}`)));
        plan.slides[0].assetIds = plan.assets.map((asset) => asset.id);
      }, /at most 5|maximum.*5/i],
      ["asset emphasis without visual", (plan) => {
        plan.assets.push(visualAsset("asset-data", "diagram-source"));
        plan.slides[0].assetIds = ["asset-data"];
        plan.slides[0].compositionIntent.emphasis = "asset";
      }, /emphasis.*asset.*visual/i]
    ];

    for (const [label, mutate, expected] of cases) {
      const plan = loadPlan();
      mutate(plan);
      const validation = validateDeckPlan(plan);
      expect(validation.valid, label).toBe(false);
      expect(validation.errors.join("; "), label).toMatch(expected);
      expect(() => compileDeckPlan(plan, optionsFor(business)), label).toThrow(expected);
    }
  });

  it("lays out one hero plus up to four supports in a deterministic bounded media zone", () => {
    for (const count of [1, 2, 4, 5]) {
      const plan = loadPlan();
      const assets = Array.from({ length: count }, (_, index) => visualAsset(`asset-${index + 1}`));
      plan.assets.push(...assets);
      plan.slides[0].assetIds = assets.map((asset) => asset.id);
      plan.slides[0].attentionTarget = { kind: "asset", ref: assets.at(-1).id };
      plan.slides[0].compositionIntent.emphasis = "asset";
      const sourceById = Object.fromEntries(assets.map((asset) => [asset.id, `assets/${asset.id}.png`]));
      const manifest = compileDeckPlan(plan, optionsFor(business, null, { assetSourceById: sourceById }));
      const slide = manifest.slides[0];
      const images = slide.elements.filter((element) => element.type === "image");
      const nativeCore = slide.elements.filter((element) => element.type !== "image" && !SECONDARY_MARKERS.has(element.id));

      expect(images.map((element) => element.assetId), `count=${count}`).toEqual([
        assets.at(-1).id,
        ...assets.slice(0, -1).map((asset) => asset.id)
      ]);
      for (const image of images) {
        expect(image.w, `${image.id} width`).toBeGreaterThanOrEqual(1);
        expect(image.h, `${image.id} height`).toBeGreaterThanOrEqual(0.75);
        expect(image.x + image.w, `${image.id} right`).toBeLessThanOrEqual(13.333);
        expect(image.y + image.h, `${image.id} bottom`).toBeLessThanOrEqual(7.5);
        expect(nativeCore.some((element) => rectanglesOverlap(image, element)), `${image.id} overlaps native content`).toBe(false);
      }
      for (let left = 0; left < images.length; left += 1) {
        for (let right = left + 1; right < images.length; right += 1) {
          expect(rectanglesOverlap(images[left], images[right], 0.04), `${images[left].id} overlaps ${images[right].id}`).toBe(false);
        }
      }
    }
  });

  it("keeps every emitted element in bounds, text-fit safe, validates the manifest, and resolves connectors last", async () => {
    const plan = loadPlan();
    plan.context.visualAmbition = 100;
    plan.context.assetIntensity = 100;
    plan.designIntent.dials = { compositionVariance: 100, visualDensity: 100, visualEnergy: 100 };
    const manifest = compileDeckPlan(plan, optionsFor(dark, "dark-tech"));
    expect(validateJsonSchema(manifest, manifestSchema)).toEqual({ valid: true, errors: [] });

    for (const slide of manifest.slides) {
      for (const element of slide.elements) {
        expect(element.x, `${slide.id}/${element.id}`).toBeGreaterThanOrEqual(0);
        expect(element.y, `${slide.id}/${element.id}`).toBeGreaterThanOrEqual(0);
        expect(element.w, `${slide.id}/${element.id}`).toBeGreaterThanOrEqual(0);
        expect(element.h, `${slide.id}/${element.id}`).toBeGreaterThanOrEqual(0);
        expect(element.w + element.h, `${slide.id}/${element.id}`).toBeGreaterThan(0);
        expect(element.x + element.w, `${slide.id}/${element.id}`).toBeLessThanOrEqual(13.333);
        expect(element.y + element.h, `${slide.id}/${element.id}`).toBeLessThanOrEqual(7.5);
      }
    }

    const process = manifest.slides.find((slide) => slide.type === "process");
    for (const connector of process.elements.filter((element) => element.role === "connector")) {
      const source = process.elements.find((element) => element.id === connector.connector.sourceId);
      const target = process.elements.find((element) => element.id === connector.connector.targetId);
      expect(connector.x).toBeCloseTo(source.x + source.w, 6);
      expect(connector.y).toBeCloseTo(source.y + source.h / 2, 6);
      expect(connector.x + connector.w).toBeCloseTo(target.x, 6);
      expect(connector.y + connector.h).toBeCloseTo(target.y + target.h / 2, 6);
    }

    const fitted = await fitManifestText(manifest, { designTokens: dark.tokens });
    expect(fitted.report.status).toBe("passed");
    expect(fitted.unresolved).toEqual([]);
  });
});
