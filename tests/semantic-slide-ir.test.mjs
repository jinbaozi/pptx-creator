import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileDeckPlan,
  compileDeckPlanArtifacts
} from "../scripts/lib/deck-plan.mjs";
import {
  canonicalTokenSnapshotHash,
  compileDeckPlanToIr,
  compileIrCompatibilityFixture,
  compileSemanticDeckIr,
  validateSemanticDeckIr
} from "../scripts/lib/semantic-slide-ir.mjs";
import { parseDesignFile } from "../scripts/parse-design-md.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = process.cwd();
const fixturePath = path.join(root, "examples/text-input/creative/deck.plan.json");
const planPaths = [
  fixturePath,
  path.join(root, "examples/text-input/calibration/clean.deck.plan.json"),
  path.join(root, "examples/text-input/calibration/borderline.deck.plan.json"),
  path.join(root, "examples/text-input/calibration/risky.deck.plan.json")
];
const loadJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const loadPlan = () => loadJson(fixturePath);
const schema = loadJson(path.join(root, "schemas/semantic-slide-ir.schema.json"));
const manifestSchema = loadJson(path.join(root, "schemas/deck.schema.json"));
const visualKinds = new Set(["photo", "illustration", "icon", "logo", "texture"]);
let design;

const definitionSchema = (name) => ({ $defs: schema.$defs, $ref: `#/$defs/${name}` });

function options(extra = {}) {
  return { design, ...extra };
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => walk(entry, visit));
}

function findLayout(layout, predicate) {
  if (predicate(layout)) return layout;
  if (!layout || typeof layout !== "object") return null;
  for (const value of Object.values(layout)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findLayout(entry, predicate);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findLayout(value, predicate);
      if (found) return found;
    }
  }
  return null;
}

function visualAsset(id = "asset-hero") {
  return {
    id,
    kind: "photo",
    role: "hero evidence",
    description: "A localized evidence image",
    provenance: {
      origin: "project",
      sourceRef: `source/${id}.png`,
      sourceUrl: `https://example.com/provenance/${id}`,
      rights: { status: "allowed", license: "project-owned" },
      contentHash: `sha256:${"a".repeat(64)}`
    },
    focalPoint: "top-right",
    cropPolicy: "cover",
    altText: "Team reviewing the evidence",
    fallback: { strategy: "placeholder", description: "Use a native placeholder" }
  };
}

function planWithAsset() {
  const plan = loadPlan();
  const asset = visualAsset();
  plan.assets.push(asset);
  plan.slides[0].assetIds = [asset.id];
  plan.slides[0].attentionTarget = { kind: "asset", ref: asset.id };
  plan.slides[0].compositionIntent.emphasis = "asset";
  return plan;
}

function expectSemanticInvalid(ir, pattern) {
  const result = validateSemanticDeckIr(ir, { design });
  expect(result.valid).toBe(false);
  expect(result.errors.join("; ")).toMatch(pattern);
  expect(() => compileSemanticDeckIr(ir, { design })).toThrow(pattern);
}

function familyLayoutFor(slide) {
  return findLayout(slide.layout, (layout) => layout?.id === "family-layout");
}

function withoutSemanticLineage(manifest) {
  const copy = structuredClone(manifest);
  for (const slide of copy.slides ?? []) {
    for (const element of slide.elements ?? []) delete element.semanticParentId;
  }
  return copy;
}

beforeAll(async () => {
  design = await parseDesignFile(path.join(root, "design-systems/business-neutral/DESIGN.md"));
});

describe("Semantic Slide IR 0.1.0", () => {
  it("compiles every tracked 0.2 plan example to strict coordinate-free schema-valid IR", () => {
    for (const planPath of planPaths) {
      const plan = loadJson(planPath);
      const ir = compileDeckPlanToIr(plan, options());
      expect(validateJsonSchema(ir, schema), planPath).toEqual({ valid: true, errors: [] });
      expect(validateSemanticDeckIr(ir, { design }), planPath).toEqual({ valid: true, errors: [] });

      const wire = JSON.stringify(ir);
      expect(wire).not.toContain("contentModel");
      expect(wire).not.toContain("\"elements\"");
      expect(wire).not.toMatch(/#[0-9A-F]{6}/i);
      expect(wire).not.toContain("Microsoft YaHei");
      walk(ir, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        for (const key of ["x", "y", "w", "h", "left", "top", "right", "bottom", "width", "height", "elements"]) {
          expect(value, `${planPath} contains banned key ${key}`).not.toHaveProperty(key);
        }
      });
    }
  });

  it("rejects loose canonical objects at the JSON Schema boundary", () => {
    const base = compileDeckPlanToIr(loadPlan(), options());
    const invalidCases = [
      ["context", (ir) => { ir.context.unexpected = true; }],
      ["design intent", (ir) => { ir.designIntent.unexpected = true; }],
      ["story", (ir) => { ir.story.unexpected = true; }],
      ["design selection", (ir) => { ir.designSystem.selection.unexpected = true; }],
      ["slide", (ir) => { ir.slides[0].unexpected = true; }],
      ["family", (ir) => { ir.slides[0].family = "unknown"; }],
      ["attention", (ir) => { ir.slides[0].attentionTarget.unexpected = true; }],
      ["composition", (ir) => { ir.slides[0].compositionIntent.unexpected = true; }],
      ["route", (ir) => { ir.slides[0].routePolicy.unexpected = true; }],
      ["node common", (ir) => { ir.slides[0].nodes[0].unexpected = true; }],
      ["node kind", (ir) => { ir.slides[0].nodes[0].kind = "unknown"; }],
      ["flow link", (ir) => {
        const process = ir.slides.find((slide) => slide.family === "process");
        findLayout(process.layout, (layout) => layout?.primitive === "flow").links[0].unexpected = true;
      }],
      ["stack align", (ir) => {
        findLayout(ir.slides[0].layout, (layout) => layout?.primitive === "stack").align = "diagonal";
      }],
      ["anchor", (ir) => {
        findLayout(ir.slides[0].layout, (layout) => layout?.primitive === "anchor").anchor = "nearby";
      }]
    ];
    for (const [label, mutate] of invalidCases) {
      const ir = structuredClone(base);
      mutate(ir);
      expect(validateJsonSchema(ir, schema).valid, label).toBe(false);
    }

    const assetIr = compileDeckPlanToIr(planWithAsset(), options({ assetSourceById: { "asset-hero": "assets/hero.png" } }));
    delete assetIr.assets[0].src;
    expect(validateJsonSchema(assetIr, schema).valid, "portable asset src").toBe(false);
  });

  it("defines closed payload contracts for all eight semantic node kinds", () => {
    const common = {
      role: "evidence",
      tokenRefs: {
        typography: "{typography.body}",
        foreground: "{colors.text}",
        background: "{colors.surface}",
        border: "{colors.border}",
        spacing: "{spacing.md}"
      },
      assetRefs: []
    };
    const fixtures = {
      text: { text: "A clear claim" },
      media: { placement: "hero", fit: "cover", focalPoint: "center", alt: "Evidence image" },
      metric: { label: "Conversion", value: "42%" },
      chart: { chartKind: "bar", data: [{ label: "Current", value: 42 }], showValues: true, showLegend: false },
      table: { headers: ["Option"], rows: [["Native"]] },
      diagram: { type: "architecture-layer", label: "Semantic IR" },
      quote: { text: "Clarity compounds.", attribution: "Design review" },
      divider: {
        type: "connector",
        sourceId: "step-0",
        targetId: "step-1",
        sourceAnchor: "right",
        targetAnchor: "left",
        route: "orthogonal",
        arrow: "triangle"
      }
    };
    for (const [kind, payload] of Object.entries(fixtures)) {
      const candidate = {
        id: `node-${kind}`,
        kind,
        ...structuredClone(common),
        assetRefs: kind === "media" ? ["asset-hero"] : [],
        payload: structuredClone(payload)
      };
      expect(validateJsonSchema(candidate, definitionSchema("node")), `${kind} valid`).toEqual({ valid: true, errors: [] });
      candidate.payload.unexpected = true;
      expect(validateJsonSchema(candidate, definitionSchema("node")).valid, `${kind} closed payload`).toBe(false);
    }
  });

  it("is deterministic, canonicalizes token hashes, and never mutates inputs", () => {
    const plan = loadPlan();
    const compilerOptions = options();
    const beforePlan = structuredClone(plan);
    const beforeDesign = structuredClone(design);
    const beforeOptions = structuredClone(compilerOptions);
    const first = compileDeckPlanArtifacts(plan, compilerOptions);
    const second = compileDeckPlanArtifacts(plan, compilerOptions);

    expect(first).toEqual(second);
    expect(plan).toEqual(beforePlan);
    expect(design).toEqual(beforeDesign);
    expect(compilerOptions).toEqual(beforeOptions);
    expect(canonicalTokenSnapshotHash({ b: 2, a: { d: 4, c: [3, 2, 1] } }))
      .toBe(canonicalTokenSnapshotHash({ a: { c: [3, 2, 1], d: 4 }, b: 2 }));
  });

  it("keeps default and legacy option manifests deeply equal without synthetic design selection metadata", () => {
    const plan = loadPlan();
    const optionCases = [
      options(),
      {
        designTokens: structuredClone(design.tokens),
        designSystemName: design.name,
        designSystemSource: design.source
      }
    ];
    for (const compilerOptions of optionCases) {
      const legacy = compileIrCompatibilityFixture(plan, compilerOptions);
      const current = compileDeckPlan(plan, compilerOptions);
      expect(withoutSemanticLineage(current)).toEqual(legacy);
      expect(current.metadata.designIntent).not.toHaveProperty("designSystemSelection");
    }

    const explicitNullSelection = {
      request: null,
      resolvedSource: path.join(root, "design-systems/business-neutral/DESIGN.md")
    };
    const copiedDesign = { ...design, source: "output/DESIGN.md" };
    const explicitOptions = { design: copiedDesign, designSystemSelection: explicitNullSelection };
    const explicitLegacy = compileIrCompatibilityFixture(plan, explicitOptions);
    const explicitCurrent = compileDeckPlan(plan, explicitOptions);
    expect(explicitCurrent.metadata.designIntent.designSystemSelection).toEqual(explicitNullSelection);
    expect(withoutSemanticLineage(explicitCurrent)).toEqual(explicitLegacy);

    const sameValueSelection = { request: null, resolvedSource: design.source };
    const sameValueOptions = { design, designSystemSelection: sameValueSelection };
    const sameValueLegacy = compileIrCompatibilityFixture(plan, sameValueOptions);
    const sameValueCurrent = compileDeckPlan(plan, sameValueOptions);
    expect(sameValueCurrent.metadata.designIntent.designSystemSelection).toEqual(sameValueSelection);
    expect(withoutSemanticLineage(sameValueCurrent)).toEqual(sameValueLegacy);
  });

  it("keeps the compatibility wrapper deeply equivalent for all eight families and themed assets", () => {
    const plan = loadPlan();
    const ir = compileDeckPlanToIr(plan, options());
    expect(new Set(ir.slides.map((slide) => slide.family))).toEqual(new Set([
      "cover", "architecture", "comparison", "process", "dashboard", "quote", "matrix", "closing"
    ]));
    expect(compileDeckPlan(plan, options())).toEqual(compileSemanticDeckIr(ir, { design }));

    const assetPlan = planWithAsset();
    const assetOptions = options({ assetSourceById: { "asset-hero": "assets/asset-hero-local.png" } });
    const assetIr = compileDeckPlanToIr(assetPlan, assetOptions);
    expect(assetIr.assets[0].src).toBe("assets/asset-hero-local.png");
    expect(compileDeckPlan(assetPlan, assetOptions)).toEqual(compileSemanticDeckIr(assetIr, { design }));
  });

  it("treats IR payloads as authoritative after plan conversion", () => {
    const plan = loadPlan();
    const ir = compileDeckPlanToIr(plan, options());
    const baseline = compileSemanticDeckIr(ir, { design });
    plan.slides[0].contentModel.data.headline = "MUTATED SOURCE PLAN";
    expect(compileSemanticDeckIr(ir, { design })).toEqual(baseline);

    const edited = structuredClone(ir);
    edited.slides[0].nodes.find((node) => node.id === "headline").payload.text = "Edited in the IR";
    expect(compileSemanticDeckIr(edited, { design }).slides[0].elements.find((element) => element.id === "headline").text)
      .toBe("Edited in the IR");

    const dashboard = structuredClone(ir);
    dashboard.slides.find((slide) => slide.family === "dashboard").nodes
      .find((node) => node.id === "kpi-card-0").payload.value = "999";
    expect(compileSemanticDeckIr(dashboard, { design }).slides.find((slide) => slide.type === "dashboard").elements
      .find((element) => element.id === "value-0").text).toBe("999");

    const quote = structuredClone(ir);
    quote.slides.find((slide) => slide.family === "quote").nodes.find((node) => node.id === "quote").payload.text = "IR quote";
    expect(compileSemanticDeckIr(quote, { design }).slides.find((slide) => slide.type === "quote").elements
      .find((element) => element.id === "quote").text).toContain("IR quote");
  });

  it("enforces exact eight-family and derived-node authority contracts", () => {
    const base = compileDeckPlanToIr(loadPlan(), options());
    const invalidCases = [
      ["cover missing subtitle", (ir) => {
        const slide = ir.slides.find((entry) => entry.family === "cover");
        slide.nodes = slide.nodes.filter((entry) => entry.id !== "subtitle");
        familyLayoutFor(slide).children = familyLayoutFor(slide).children.filter((entry) => entry.nodeRef !== "subtitle");
      }, /cover.*subtitle|family.*contract/i],
      ["comparison extra sibling", (ir) => {
        const slide = ir.slides.find((entry) => entry.family === "comparison");
        slide.nodes.push({
          id: "ignored-extra", kind: "text", role: "evidence", tokenRefs: {}, assetRefs: [], payload: { text: "Ignored" }
        });
        familyLayoutFor(slide).children.push({ nodeRef: "ignored-extra" });
      }, /comparison.*ignored-extra|family.*contract|unexpected.*node/i],
      ["process missing connector", (ir) => {
        const slide = ir.slides.find((entry) => entry.family === "process");
        const flow = findLayout(slide.layout, (layout) => layout?.primitive === "flow");
        const removed = flow.links.pop().connectorRef;
        slide.nodes = slide.nodes.filter((entry) => entry.id !== removed);
      }, /process.*connector|family.*contract|cardinality/i],
      ["dashboard ignored fifth metric", (ir) => {
        const slide = ir.slides.find((entry) => entry.family === "dashboard");
        slide.nodes.push({
          id: "kpi-card-4", kind: "metric", role: "kpi", tokenRefs: {}, assetRefs: [],
          payload: { label: "Ignored", value: "5" }
        });
        findLayout(slide.layout, (layout) => layout?.primitive === "grid").children.push({ nodeRef: "kpi-card-4" });
      }, /dashboard.*(?:kpi-card-4|kpi-card.*cardinality)|metric.*cardinality|family.*contract/i],
      ["matrix extra sibling", (ir) => {
        const slide = ir.slides.find((entry) => entry.family === "matrix");
        slide.nodes.push({
          id: "matrix-note", kind: "text", role: "evidence", tokenRefs: {}, assetRefs: [], payload: { text: "Ignored" }
        });
        familyLayoutFor(slide).children.push({ nodeRef: "matrix-note" });
      }, /matrix.*matrix-note|family.*contract|unexpected.*node/i],
      ["non-canonical layer index", (ir) => {
        const slide = ir.slides.find((entry) => entry.family === "architecture");
        slide.nodes.find((entry) => entry.id === "layer-0").id = "layer-00";
        findLayout(slide.layout, (layout) => layout?.primitive === "stack"
          && layout.children?.some((entry) => entry.nodeRef === "layer-0"))
          .children.find((entry) => entry.nodeRef === "layer-0").nodeRef = "layer-00";
      }, /architecture.*layer-00|canonical|family.*contract/i],
      ["missing page role marker", (ir) => {
        const slide = ir.slides[0];
        slide.nodes = slide.nodes.filter((entry) => entry.id !== "role-marker");
        slide.layout.child.children = slide.layout.child.children.filter((entry) => entry.id !== "role-marker-anchor");
      }, /role-marker|derived.*contract/i]
    ];
    for (const [label, mutate, pattern] of invalidCases) {
      const ir = structuredClone(base);
      mutate(ir);
      try {
        expectSemanticInvalid(ir, pattern);
      } catch (error) {
        error.message = `${label}: ${error.message}`;
        throw error;
      }
    }

    const plan = planWithAsset();
    const second = visualAsset("asset-support");
    second.altText = "Supporting visual evidence";
    plan.assets.push(second);
    plan.slides[0].assetIds.push(second.id);
    const assetOptions = options({ assetSourceById: {
      "asset-hero": "assets/hero.png",
      "asset-support": "assets/support.png"
    } });
    const withMedia = compileDeckPlanToIr(plan, assetOptions);
    expect(validateSemanticDeckIr(withMedia, { design })).toEqual({ valid: true, errors: [] });
    expect(withMedia.slides[0].nodes.filter((entry) => entry.kind === "media").map((entry) => entry.id))
      .toEqual(["asset-asset-hero", "asset-asset-support"]);
    expect(compileSemanticDeckIr(withMedia, { design }).slides[0].elements.filter((entry) => entry.type === "image").map((entry) => entry.id))
      .toEqual(["asset-asset-hero", "asset-asset-support"]);

    const driftedMedia = structuredClone(withMedia);
    driftedMedia.slides[0].nodes.find((entry) => entry.id === "asset-asset-support").payload.alt = "Drifted duplicate truth";
    expectSemanticInvalid(driftedMedia, /media.*payload|asset-support.*alt|derived.*contract/i);
  });

  it("validates flow connectors against ordered steps and lowers their explicit payload", () => {
    const ir = compileDeckPlanToIr(loadPlan(), options());
    const process = ir.slides.find((slide) => slide.family === "process");
    const flow = findLayout(process.layout, (layout) => layout?.primitive === "flow");

    const unknownEndpoint = structuredClone(ir);
    unknownEndpoint.slides.find((slide) => slide.family === "process").nodes
      .find((entry) => entry.id === flow.links[0].connectorRef).payload.sourceId = "missing-step";
    expectSemanticInvalid(unknownEndpoint, /connector.*source|source.*resolve|missing-step/i);

    const wrongOrder = structuredClone(ir);
    wrongOrder.slides.find((slide) => slide.family === "process").nodes
      .find((entry) => entry.id === flow.links[0].connectorRef).payload.targetId = flow.children[2].nodeRef;
    expectSemanticInvalid(wrongOrder, /connector.*order|adjacent|step.*order/i);

    const missingArrow = structuredClone(ir);
    delete missingArrow.slides.find((slide) => slide.family === "process").nodes
      .find((entry) => entry.id === flow.links[0].connectorRef).payload.arrow;
    expectSemanticInvalid(missingArrow, /connector.*arrow|missing.*arrow/i);

    const edited = structuredClone(ir);
    const connector = edited.slides.find((slide) => slide.family === "process").nodes
      .find((entry) => entry.id === flow.links[0].connectorRef);
    connector.payload.sourceAnchor = "bottom";
    connector.payload.targetAnchor = "top";
    connector.payload.route = "orthogonal";
    connector.payload.arrow = "triangle";
    const manifestConnector = compileSemanticDeckIr(edited, { design }).slides.find((slide) => slide.type === "process").elements
      .find((entry) => entry.id === connector.id);
    expect(manifestConnector.connector).toEqual({
      sourceId: connector.payload.sourceId,
      targetId: connector.payload.targetId,
      sourceAnchor: "bottom",
      targetAnchor: "top",
      route: "orthogonal"
    });
    expect(manifestConnector.style.endArrowType).toBe("triangle");
  });

  it("uses layout traversal while preserving ordered-family primary IDs and derived lineage", () => {
    const ir = compileDeckPlanToIr(loadPlan(), options());
    const baseline = compileSemanticDeckIr(ir, { design });
    const reorderedNodes = structuredClone(ir);
    reorderedNodes.slides.forEach((slide) => slide.nodes.reverse());
    expect(compileSemanticDeckIr(reorderedNodes, { design })).toEqual(baseline);

    const reorderedLayout = structuredClone(ir);
    const architecture = reorderedLayout.slides.find((slide) => slide.family === "architecture");
    const layerLayout = findLayout(architecture.layout, (value) => value?.primitive === "stack"
      && value.children?.some((child) => child.nodeRef === "layer-0"));
    const layerChildren = layerLayout.children.filter((child) => child.nodeRef?.startsWith("layer-"));
    const untouched = layerLayout.children.filter((child) => !child.nodeRef?.startsWith("layer-"));
    layerLayout.children = [...untouched, ...layerChildren.reverse()];

    const process = reorderedLayout.slides.find((slide) => slide.family === "process");
    const flow = findLayout(process.layout, (value) => value?.primitive === "flow");
    flow.children.reverse();
    flow.links.forEach((link, index) => {
      const payload = process.nodes.find((entry) => entry.id === link.connectorRef).payload;
      payload.sourceId = flow.children[index].nodeRef;
      payload.targetId = flow.children[index + 1].nodeRef;
    });

    const dashboard = reorderedLayout.slides.find((slide) => slide.family === "dashboard");
    const metricGrid = findLayout(dashboard.layout, (value) => value?.id === "metric-grid");
    metricGrid.children.reverse();

    const changed = compileSemanticDeckIr(reorderedLayout, { design });
    expect(changed).not.toEqual(baseline);
    for (const [family, role, textFields] of [
      ["architecture", "architecture-layer", ["label"]],
      ["process", "process-step", ["label"]],
      ["dashboard", "kpi", ["label", "value"]]
    ]) {
      const irSlide = reorderedLayout.slides.find((slide) => slide.family === family);
      const manifestSlide = changed.slides.find((slide) => slide.type === family);
      for (const source of irSlide.nodes.filter((entry) => entry.role === role)) {
        expect(manifestSlide.elements.some((entry) => entry.id === source.id), `${family}/${source.id} primary id`).toBe(true);
        for (const field of textFields) {
          const suffix = source.id.match(/(\d+)$/)?.[1];
          const expectedDerivedId = family === "architecture"
            ? `layer-label-${suffix}`
            : family === "process"
              ? `step-label-${suffix}`
              : `${field}-${suffix}`;
          expect(manifestSlide.elements.some((entry) => entry.id === expectedDerivedId
            && entry.semanticParentId === source.id
            && String(entry.text) === String(source.payload[field])), `${family}/${source.id}/${field} stable derived id and lineage`).toBe(true);
        }
      }
    }
  });

  it("preserves primary IDs and assigns stable semantic lineage to every derived element", () => {
    const ir = compileDeckPlanToIr(loadPlan(), options());
    const manifest = compileSemanticDeckIr(ir, { design });
    for (const irSlide of ir.slides) {
      const manifestSlide = manifest.slides.find((slide) => slide.id === irSlide.id);
      for (const node of irSlide.nodes) {
        expect(manifestSlide.elements.some((element) => element.id === node.id), `${irSlide.id}/${node.id}`).toBe(true);
      }
    }
    const lineage = Object.fromEntries(manifest.slides.flatMap((slide) => slide.elements
      .filter((element) => element.semanticParentId)
      .map((element) => [`${slide.id}/${element.id}`, element.semanticParentId])));
    expect(lineage).toMatchObject({
      "slide-architecture/layer-label-0": "layer-0",
      "slide-comparison/left-title": "left-panel",
      "slide-process/step-label-0": "step-0",
      "slide-dashboard/value-0": "kpi-card-0",
      "slide-quote/attribution": "quote",
      "slide-matrix/axis-y": "axis-x"
    });

    const withSibling = loadPlan();
    withSibling.story.sections.push({ id: "extra", title: "Extra section", slideIds: ["slide-architecture"] });
    const changed = compileDeckPlan(withSibling, options());
    const changedLineage = Object.fromEntries(changed.slides.flatMap((slide) => slide.elements
      .filter((element) => element.semanticParentId)
      .map((element) => [`${slide.id}/${element.id}`, element.semanticParentId])));
    expect(changedLineage).toMatchObject(lineage);
  });

  it("fails closed for coordinate injection, identity/reference drift, bad cardinality, and token drift", () => {
    const base = compileDeckPlanToIr(loadPlan(), options());
    const invalidCases = [
      ["nested geometry", (ir) => { ir.slides[0].nodes[0].payload.nested = { x: 1 }; }, /x|additional|coordinate/i],
      ["elements", (ir) => { ir.slides[0].layout.elements = []; }, /elements|additional|coordinate/i],
      ["duplicate node", (ir) => { ir.slides[0].nodes[1].id = ir.slides[0].nodes[0].id; }, /unique|duplicate/i],
      ["orphan node", (ir) => { ir.slides[0].layout.child.children[0].children = ir.slides[0].layout.child.children[0].children.slice(1); }, /orphan|exactly once/i],
      ["multiply placed", (ir) => { const family = ir.slides[0].layout.child.children[0]; family.children.push({ nodeRef: "headline" }); }, /multiple|exactly once/i],
      ["missing node ref", (ir) => { ir.slides[0].layout.child.children[0].children[0] = { nodeRef: "missing" }; }, /unknown|resolve/i],
      ["bad family cardinality", (ir) => {
        const architecture = ir.slides.find((slide) => slide.family === "architecture");
        architecture.nodes = architecture.nodes.filter((node) => node.id !== "layer-1");
        const family = architecture.layout.child.children[0];
        family.children = family.children.filter((child) => child.nodeRef !== "layer-1");
      }, /architecture|layer|cardinality/i],
      ["bad route", (ir) => { ir.slides[0].routePolicy.fullSlideRaster = true; }, /fullSlideRaster|const|route/i],
      ["bad token ref", (ir) => { ir.slides[0].nodes[0].tokenRefs.foreground = "{colors.missing}"; }, /token|resolve|missing/i]
    ];
    for (const [label, mutate, expected] of invalidCases) {
      const ir = structuredClone(base);
      mutate(ir);
      const result = validateSemanticDeckIr(ir, { design });
      expect(result.valid, label).toBe(false);
      expect(result.errors.join("; "), label).toMatch(expected);
      expect(() => compileSemanticDeckIr(ir, { design }), label).toThrow(expected);
    }

    const assetIr = compileDeckPlanToIr(planWithAsset(), options({ assetSourceById: { "asset-hero": "assets/hero.png" } }));
    const media = assetIr.slides[0].nodes.find((node) => node.kind === "media");
    media.assetRefs = [];
    expect(() => compileSemanticDeckIr(assetIr, { design })).toThrow(/media|asset/i);

    const wrongDesign = structuredClone(design);
    wrongDesign.tokens.colors.primary = "#000000";
    expect(() => compileSemanticDeckIr(base, { design: wrongDesign })).toThrow(/token.*hash|hash.*token/i);
  });

  it("supports exactly eleven coordinate-free layout primitive contracts", () => {
    const node = { nodeRef: "n" };
    const gap = "{spacing.md}";
    const primitives = {
      stack: { id: "l", primitive: "stack", direction: "vertical", gap, align: "start", children: [node] },
      grid: { id: "l", primitive: "grid", columns: 2, rows: 1, columnGap: gap, rowGap: gap, children: [node] },
      split: { id: "l", primitive: "split", direction: "horizontal", ratios: [1, 2], gap, children: [node, node] },
      overlay: { id: "l", primitive: "overlay", children: [node] },
      anchor: { id: "l", primitive: "anchor", anchor: "center", inset: gap, child: node },
      flow: { id: "l", primitive: "flow", direction: "horizontal", gap, wrap: false, children: [node], links: [] },
      align: { id: "l", primitive: "align", axis: "inline", value: "center", children: [node] },
      distribute: { id: "l", primitive: "distribute", axis: "inline", mode: "space-between", children: [node] },
      "aspect-ratio": { id: "l", primitive: "aspect-ratio", ratio: 1.777, fit: "contain", child: node },
      "fit-content": { id: "l", primitive: "fit-content", axis: "block", padding: gap, child: node },
      "safe-area": {
        id: "l", primitive: "safe-area",
        insets: { blockStart: gap, inlineEnd: gap, blockEnd: gap, inlineStart: gap },
        child: node
      }
    };
    const layoutSchema = { $defs: schema.$defs, $ref: "#/$defs/layout" };
    expect(Object.keys(primitives)).toHaveLength(11);
    for (const [name, fixture] of Object.entries(primitives)) {
      expect(validateJsonSchema(fixture, layoutSchema), name).toEqual({ valid: true, errors: [] });
    }
    const malformed = structuredClone(primitives.split);
    malformed.ratios = [1];
    expect(validateJsonSchema(malformed, layoutSchema).valid).toBe(false);
    const geometry = structuredClone(primitives.grid);
    geometry.children[0].width = 10;
    expect(validateJsonSchema(geometry, layoutSchema).valid).toBe(false);
  });

  it("resolves every spacing-bearing layout field against the selected token snapshot", () => {
    const spacingFields = ["gap", "columnGap", "rowGap", "inset", "padding", "blockStart", "inlineEnd", "blockEnd", "inlineStart"];
    for (const field of spacingFields) {
      const ir = compileDeckPlanToIr(loadPlan(), options());
      let found = false;
      walk(ir.slides.map((slide) => slide.layout), (value) => {
        if (found || !value || typeof value !== "object" || Array.isArray(value)) return;
        if (Object.prototype.hasOwnProperty.call(value, field)) {
          value[field] = "{spacing.missing}";
          found = true;
        }
      });
      expect(found, field).toBe(true);
      expectSemanticInvalid(ir, /spacing\.missing|spacing.*resolve|token.*missing/i);
    }
  });

  it("executes uniqueItems, contains, and minProperties schema constraints", () => {
    expect(validateJsonSchema(["native", "native"], {
      type: "array", uniqueItems: true, items: { enum: ["native", "html-assisted"] }
    }).valid).toBe(false);
    expect(validateJsonSchema(["html-assisted"], {
      type: "array", contains: { const: "native" }, items: { enum: ["native", "html-assisted"] }
    }).valid).toBe(false);
    expect(validateJsonSchema({}, {
      type: "object", minProperties: 1, additionalProperties: { type: "number" }
    }).valid).toBe(false);

    const duplicateRoute = compileDeckPlanToIr(loadPlan(), options());
    duplicateRoute.slides[0].routePolicy.allowed = ["native", "native"];
    expect(validateJsonSchema(duplicateRoute, schema).valid).toBe(false);

    const noNative = compileDeckPlanToIr(loadPlan(), options());
    noNative.slides[0].routePolicy.allowed = ["html-assisted"];
    expect(validateJsonSchema(noNative, schema).valid).toBe(false);

    const chartPoint = { label: "Series only", series: {} };
    expect(validateJsonSchema(chartPoint, definitionSchema("chartDataPoint")).valid).toBe(false);
  });

  it("keeps direct and replica manifest validation compatible with optional semantic fields", () => {
    const direct = loadJson(path.join(root, "examples/text-input/deck.manifest.json"));
    const replica = loadJson(path.join(root, "examples/html-input/deck.manifest.json"));
    expect(validateJsonSchema(direct, manifestSchema)).toEqual({ valid: true, errors: [] });
    expect(validateJsonSchema(replica, manifestSchema)).toEqual({ valid: true, errors: [] });
  });

  it("declares and validates optional semantic manifest fields when present", () => {
    const slideProperties = manifestSchema.properties.slides.items.properties;
    const elementProperties = slideProperties.elements.items.properties;
    expect(Object.keys(slideProperties)).toEqual(expect.arrayContaining([
      "semanticPageRole", "attentionTarget", "compositionIntent", "routePolicy"
    ]));
    expect(Object.keys(elementProperties)).toEqual(expect.arrayContaining([
      "semanticParentId", "assetId", "alt", "altText", "focalPoint", "cropPolicy", "sizing"
    ]));

    const manifest = compileDeckPlan(loadPlan(), options());
    const badAttention = structuredClone(manifest);
    badAttention.slides[0].attentionTarget.unexpected = true;
    expect(validateJsonSchema(badAttention, manifestSchema).valid).toBe(false);

    const assetManifest = compileDeckPlan(planWithAsset(), options({ assetSourceById: { "asset-hero": "assets/hero.png" } }));
    const image = assetManifest.slides[0].elements.find((element) => element.assetId === "asset-hero");
    image.sizing.unexpected = true;
    expect(validateJsonSchema(assetManifest, manifestSchema).valid).toBe(false);
  });

  it("requires portable assets and same-slide visual attention membership", () => {
    const ir = compileDeckPlanToIr(planWithAsset(), options({ assetSourceById: { "asset-hero": "assets/hero.png" } }));
    expect(ir.assets[0]).toMatchObject({ id: "asset-hero", src: "assets/hero.png" });
    expect(visualKinds.has(ir.assets[0].kind)).toBe(true);

    const missingSrc = structuredClone(ir);
    delete missingSrc.assets[0].src;
    expect(validateSemanticDeckIr(missingSrc, { design }).valid).toBe(false);

    const nonmember = structuredClone(ir);
    nonmember.slides[0].assetRefs = [];
    expect(validateSemanticDeckIr(nonmember, { design }).errors.join("; ")).toMatch(/attention|asset|member/i);
  });

  it("preserves canonical provenance while rejecting remote runtime sources before render", () => {
    const plan = planWithAsset();
    const local = options({ assetSourceById: { "asset-hero": "assets/asset-hero-local.png" } });
    const ir = compileDeckPlanToIr(plan, local);
    expect(ir.assets[0]).toMatchObject({
      id: "asset-hero",
      src: "assets/asset-hero-local.png",
      provenance: {
        origin: "project",
        sourceRef: "source/asset-hero.png",
        sourceUrl: "https://example.com/provenance/asset-hero",
        rights: { status: "allowed", license: "project-owned" },
        contentHash: `sha256:${"a".repeat(64)}`
      },
      role: "hero evidence",
      focalPoint: "top-right",
      cropPolicy: "cover",
      altText: "Team reviewing the evidence",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    const manifest = compileSemanticDeckIr(ir, { design });
    expect(manifest.assets[0]).toMatchObject({
      src: "assets/asset-hero-local.png",
      provenance: ir.assets[0].provenance
    });
    expect(manifest.slides[0].elements.find((element) => element.assetId === "asset-hero").src)
      .toBe("assets/asset-hero-local.png");

    for (const unsafe of [
      "https://example.com/hero.png",
      "//example.com/hero.png",
      "/tmp/hero.png",
      "assets/../hero.png",
      "assets\\hero.png",
      "data:image/png;base64,AAAA",
      "file:///tmp/hero.png",
      "C:/assets/hero.png",
      "assets/%2e%2e/hero.png",
      "assets／hero.png"
    ]) {
      expect(() => compileDeckPlanToIr(plan, options({ assetSourceById: { "asset-hero": unsafe } })), unsafe)
        .toThrow(/asset.*runtime|local.*path|unsafe/i);
    }

    const forged = structuredClone(ir);
    forged.assets[0].src = "https://example.com/forged.png";
    expectSemanticInvalid(forged, /asset.*src|runtime|local.*path|unsafe/i);

    const missingAsset = structuredClone(ir);
    missingAsset.assets = [];
    expectSemanticInvalid(missingAsset, /asset|unknown|authority|member/i);

    const forgedNodeSource = structuredClone(ir);
    const media = forgedNodeSource.slides[0].nodes.find((entry) => entry.kind === "media");
    media.payload.src = "assets/forged.png";
    expectSemanticInvalid(forgedNodeSource, /unexpected|authority|payload/i);
  });
});
