import { readFileSync } from "node:fs";
import { validateJsonSchema } from "./schema-utils.mjs";
import { resolveSemanticConnectors } from "./connector-resolver.mjs";

const W = 13.333;
const H = 7.5;
const DECK_PLAN_SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/deck-plan.schema.json", import.meta.url), "utf8"));

const text = (id, value, x, y, w, h, style = {}) => ({
  type: "text", id, x, y, w, h, text: Array.isArray(value) ? value.join("\n") : String(value ?? ""), style
});
const shape = (id, x, y, w, h, fill = "#EEF2FF", line = "#2563EB") => ({
  type: "shape", id, shape: "roundRect", x, y, w, h, style: { fill, line }
});
const line = (id, x, y, w, h, color = "#2563EB", connector = null) => ({
  type: "line", id, x, y, w, h,
  ...(connector ? { role: "connector" } : {}),
  ...(connector ? { connector: {
    sourceId: connector.sourceId,
    targetId: connector.targetId,
    sourceAnchor: connector.sourceAnchor ?? "auto",
    targetAnchor: connector.targetAnchor ?? "auto",
    route: connector.route ?? "straight"
  } } : {}),
  style: { color, width: 2, ...(connector?.endArrowType ? { endArrowType: connector.endArrowType } : {}) }
});
const title = (value) => text("headline", value, 0.72, 0.42, 11.9, 0.62, { fontSize: 28, bold: true, color: "#111827" });
const itemText = (item) => typeof item === "string" ? item : item?.label ?? item?.title ?? item?.name ?? JSON.stringify(item);
const PAGE_ROLE_MAP = Object.freeze({
  "single-point": "point",
  decision: "evidence",
  appendix: "section"
});

function applyCompositionStrategy(elements, strategy) {
  if (!strategy) return elements;
  return elements.map((element, index) => {
    const next = structuredClone(element);
    if (strategy === "asymmetric") {
      next.x = Math.max(0, Math.min(W - next.w, next.x + (index % 2 ? 0.22 : -0.08)));
      next.y = Math.max(0, Math.min(H - next.h, next.y + index * 0.015));
    } else if (strategy === "split") {
      next.x = Math.max(0, Math.min(W - next.w, next.x + (index % 2 ? 0.14 : -0.14)));
    } else if (strategy === "focus" && index === 0) {
      next.w = Math.min(W - next.x, next.w + 0.35);
      if (next.type === "text") next.style.fontSize = Number(next.style?.fontSize ?? 24) + 4;
    } else if (strategy === "editorial" && next.type === "text") {
      next.y = Math.max(0, Math.min(H - next.h, next.y + (index % 3) * 0.08));
    } else if (strategy === "immersive" && next.type === "shape") {
      next.x = Math.max(0, next.x - 0.08); next.w = Math.min(W - next.x, next.w + 0.16);
    } else if (strategy === "data-led") {
      next.y = Math.max(0, Math.min(H - next.h, next.y + (index % 2) * 0.05));
    } else if (strategy === "structural") {
      next.x = Math.max(0, Math.min(W - next.w, next.x + (index % 3 - 1) * 0.06));
    } else if (strategy === "minimal-whitespace") {
      const delta = next.w * 0.06; next.x += delta; next.w -= delta * 2;
    }
    return next;
  });
}

function compileCover(content) {
  return [
    text("headline", content.headline, 0.82, 1.25, 8.5, 1.25, { fontSize: 42, bold: true, color: "#111827" }),
    text("subtitle", content.subtitle, 0.86, 2.72, 7.2, 0.64, { fontSize: 18, color: "#374151" }),
    shape("cover-accent", 0.86, 6.45, 3.35, 0.09, "#2563EB", "#2563EB")
  ];
}

function compileArchitecture(content) {
  const layers = content.layers.slice(0, 4);
  return [title(content.headline), ...layers.flatMap((entry, index) => {
    const x = 1.3 + index * 0.32;
    const y = 1.42 + index * 1.16;
    const w = 10.6 - index * 0.64;
    return [shape(`layer-${index}`, x, y, 0.12, 0.82, index % 2 ? "#60A5FA" : "#2563EB"), text(`layer-label-${index}`, itemText(entry), x + 0.38, y + 0.2, w - 0.5, 0.36, { fontSize: 16, bold: true, color: "#1E3A8A" })];
  })];
}

function compileComparison(content) {
  return [title(content.headline), shape("left-panel", 0.76, 1.35, 5.55, 4.9, "#EFF6FF"), shape("right-panel", 7.02, 1.35, 5.55, 4.9, "#FFF7ED", "#EA580C"),
    text("left-title", content.primary.title, 1.05, 1.72, 4.9, 0.5, { fontSize: 21, bold: true }),
    text("left-items", content.primary.items, 1.05, 2.42, 4.9, 2.9, { fontSize: 16 }),
    text("right-title", content.secondary.title, 7.32, 1.72, 4.9, 0.5, { fontSize: 21, bold: true }),
    text("right-items", content.secondary.items, 7.32, 2.42, 4.9, 2.9, { fontSize: 16 })];
}

function compileProcess(content) {
  const steps = content.steps.slice(0, 5);
  return [title(content.headline), ...steps.flatMap((entry, index) => {
    const x = 0.72 + index * 2.5;
    return [shape(`step-${index}`, x + 0.5, 2.08, 0.86, 0.86, "#EEF2FF"), text(`step-label-${index}`, itemText(entry), x + 0.08, 3.35, 1.7, 0.72, { fontSize: 15, bold: true, align: "center" }), ...(index < steps.length - 1 ? [line(`connector-${index}`, x + 1.36, 2.5, 1.14, 0.01, "#2563EB", { sourceId: `step-${index}`, targetId: `step-${index + 1}`, sourceAnchor: "auto", targetAnchor: "auto", route: "straight", endArrowType: "triangle" })] : [])];
  })];
}

function compileDashboard(content) {
  const metrics = content.metrics.slice(0, 4);
  return [title(content.headline), ...metrics.flatMap((entry, index) => {
    const x = 0.78 + (index % 2) * 6.2;
    const y = 1.36 + Math.floor(index / 2) * 2.55;
    return [shape(`kpi-card-${index}`, x, y, 5.55, 2.0, index % 2 ? "#ECFDF5" : "#EFF6FF"), text(`value-${index}`, entry.value, x + 0.3, y + 0.32, 2.1, 0.66, { fontSize: 30, bold: true, color: "#1D4ED8" }), text(`label-${index}`, entry.label, x + 2.42, y + 0.4, 2.7, 0.5, { fontSize: 16, bold: true })];
  })];
}

function compileQuote(content) {
  return [shape("quote-mark", 0.9, 1.25, 0.2, 4.5, "#2563EB", "#2563EB"), text("quote", `“${content.quote}”`, 1.55, 1.36, 10.25, 3.35, { fontSize: 31, bold: true, color: "#111827", italic: true }), text("attribution", `— ${content.attribution}`, 7.2, 5.25, 4.6, 0.5, { fontSize: 16, color: "#4B5563", align: "right" })];
}

function compileMatrix(content) {
  const labels = content.quadrants.slice(0, 4);
  return [title(content.headline), line("axis-x", 2.0, 3.75, 9.3, 0.01, "#111827"), line("axis-y", 6.65, 1.36, 0.01, 4.8, "#111827"),
    ...labels.map((entry, index) => text(`quadrant-${index}`, itemText(entry), index % 2 ? 7.2 : 2.6, index < 2 ? 2.0 : 4.45, 3.2, 0.65, { fontSize: 18, bold: true, align: "center" })),
    text("x-label", content.xAxis, 9.6, 6.32, 2.2, 0.36, { fontSize: 12 }), text("y-label", content.yAxis, 0.8, 1.25, 1.2, 0.36, { fontSize: 12 })];
}

function compileClosing(content) {
  return [text("headline", content.headline, 1.25, 1.75, 10.85, 1.25, { fontSize: 39, bold: true, color: "#FFFFFF", align: "center" }), text("call-to-action", content.callToAction, 2.3, 3.4, 8.75, 0.72, { fontSize: 20, color: "#BFDBFE", align: "center" }), shape("closing-accent", 5.2, 5.28, 2.9, 0.1, "#60A5FA", "#60A5FA")];
}

function schemaValidator(family) {
  const schema = {
    $defs: DECK_PLAN_SCHEMA.$defs,
    $ref: `#/$defs/${family}Content`
  };
  return (content = {}) => {
    const result = validateJsonSchema(content, schema);
    return result.valid ? null : `${family} schema: ${result.errors.map((error) => `${error.path} ${error.message}`).join("; ")}`;
  };
}

const REGISTRY = Object.freeze({
  cover: { schema: DECK_PLAN_SCHEMA.$defs.coverContent, validate: schemaValidator("cover"), compile: compileCover },
  architecture: { schema: DECK_PLAN_SCHEMA.$defs.architectureContent, validate: schemaValidator("architecture"), compile: compileArchitecture },
  comparison: { schema: DECK_PLAN_SCHEMA.$defs.comparisonContent, validate: schemaValidator("comparison"), compile: compileComparison },
  process: { schema: DECK_PLAN_SCHEMA.$defs.processContent, validate: schemaValidator("process"), compile: compileProcess },
  dashboard: { schema: DECK_PLAN_SCHEMA.$defs.dashboardContent, validate: schemaValidator("dashboard"), compile: compileDashboard },
  quote: { schema: DECK_PLAN_SCHEMA.$defs.quoteContent, validate: schemaValidator("quote"), compile: compileQuote },
  matrix: { schema: DECK_PLAN_SCHEMA.$defs.matrixContent, validate: schemaValidator("matrix"), compile: compileMatrix },
  closing: { schema: DECK_PLAN_SCHEMA.$defs.closingContent, validate: schemaValidator("closing"), compile: compileClosing }
});

export const ADVERTISED_ARCHETYPES = Object.freeze(Object.keys(REGISTRY));
export const getArchetypeRegistry = () => ({ ...REGISTRY });

function duplicateIdErrors(items, label) {
  const seen = new Set();
  const errors = [];
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`${label} id "${item.id}" must be unique`);
    seen.add(item.id);
  }
  return errors;
}

function validateSemanticRules(plan) {
  const errors = [
    ...duplicateIdErrors(plan.slides, "slide"),
    ...duplicateIdErrors(plan.assets, "asset")
  ];
  const slideIds = new Set(plan.slides.map((slide) => slide.id));
  const assetIds = new Set(plan.assets.map((asset) => asset.id));
  const suites = new Set();

  for (const target of plan.context.targetSuites) {
    if (suites.has(target.suite)) errors.push(`context.targetSuites suite "${target.suite}" must be unique`);
    suites.add(target.suite);
  }
  if (!plan.context.targetSuites.some((target) => target.suite === "libreoffice" && target.required === true)) {
    errors.push("context.targetSuites must include libreoffice with required true");
  }

  plan.story.sections.forEach((section, sectionIndex) => {
    section.slideIds.forEach((slideId) => {
      if (!slideIds.has(slideId)) errors.push(`story.sections[${sectionIndex}] references unknown slide "${slideId}"`);
    });
  });
  plan.story.decisionPath.forEach((slideId) => {
    if (!slideIds.has(slideId)) errors.push(`story.decisionPath references unknown slide "${slideId}"`);
  });

  plan.slides.forEach((slide, slideIndex) => {
    if (slide.attentionTarget.kind === "asset" && !assetIds.has(slide.attentionTarget.ref)) {
      errors.push(`slides[${slideIndex}].attentionTarget references unknown asset "${slide.attentionTarget.ref}"`);
    }
    slide.assetIds.forEach((assetId) => {
      if (!assetIds.has(assetId)) errors.push(`slides[${slideIndex}].assetIds references unknown asset "${assetId}"`);
    });
    if (!slide.routePolicy.allowed.includes(slide.routePolicy.preferred)) {
      errors.push(`slides[${slideIndex}].routePolicy preferred must belong to allowed`);
    }
    if (!slide.routePolicy.allowed.includes("native")) {
      errors.push(`slides[${slideIndex}].routePolicy.allowed must include native`);
    }
  });

  for (let index = 2; index < plan.slides.length; index += 1) {
    const strategy = plan.slides[index].compositionIntent.strategy;
    if (strategy === plan.slides[index - 1].compositionIntent.strategy
      && strategy === plan.slides[index - 2].compositionIntent.strategy) {
      errors.push(`slides[${index - 2}..${index}] repeat the same composition strategy for three consecutive slides`);
    }
  }
  return errors;
}

export function validateDeckPlan(plan) {
  if (plan?.version === "0.1.0") {
    return { valid: false, errors: ["deck.plan 0.1.0 is retired; expected 0.2.0"] };
  }
  const structural = validateJsonSchema(plan, DECK_PLAN_SCHEMA);
  if (!structural.valid) {
    return {
      valid: false,
      errors: structural.errors.map((error) => `${error.path} ${error.message}`)
    };
  }
  const errors = validateSemanticRules(plan);
  return { valid: errors.length === 0, errors };
}

export function compileDeckPlan(plan, options = {}) {
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  return {
    version: "0.2.0",
    metadata: {
      mode: "creative",
      inputType: "text",
      qualityProfile: "creative",
      designIntent: {
        source: "deck.plan",
        ...structuredClone(plan.designIntent),
        read: plan.designIntent.designRead,
        visibleGrid: plan.designIntent.composition.visibleGrid,
        intentOverride: structuredClone(plan.designIntent.locks),
        qualityProfile: plan.context.qualityProfile,
        context: structuredClone(plan.context),
        story: structuredClone(plan.story)
      },
      generator: { name: "deck-plan.mjs" }
    },
    designSystem: { source: options.designSystemSource ?? "design-systems/business-neutral/DESIGN.md", name: options.designSystemName ?? "Business Neutral" },
    deck: {
      title: plan.context.title,
      language: plan.context.language,
      editabilityFloor: plan.context.editabilityFloor,
      size: { preset: "wide", width: W, height: H, unit: "in" }
    },
    assets: plan.assets.map((asset) => ({
      id: asset.id,
      src: asset.provenance.sourceRef,
      ...structuredClone(asset.provenance)
    })),
    slides: plan.slides.map((slide) => {
      const family = slide.contentModel.kind;
      const strategy = slide.compositionIntent.strategy;
      return {
        id: slide.id,
        type: family,
        pageRole: PAGE_ROLE_MAP[slide.pageRole] ?? slide.pageRole,
        semanticPageRole: slide.pageRole,
        compositionStrategy: strategy,
        attentionTarget: structuredClone(slide.attentionTarget),
        compositionIntent: structuredClone(slide.compositionIntent),
        routePolicy: structuredClone(slide.routePolicy),
        title: slide.message,
        notes: slide.message,
        background: { type: "solid", color: family === "closing" ? "#111827" : "#FFFFFF" },
        elements: resolveSemanticConnectors(applyCompositionStrategy(REGISTRY[family].compile(slide.contentModel.data), strategy))
      };
    })
  };
}

const BRIEF_DOMAIN_INTENT = Object.freeze({
  business: { designRead: "Confident business decision story with disciplined hierarchy.", dials: { compositionVariance: 50, visualDensity: 55, visualEnergy: 55 } },
  editorial: { designRead: "Editorial narrative with expressive hierarchy and measured pacing.", dials: { compositionVariance: 60, visualDensity: 45, visualEnergy: 50 } },
  technical: { designRead: "Structured technical explanation with visible system logic.", dials: { compositionVariance: 50, visualDensity: 60, visualEnergy: 45 } },
  "public-sector": { designRead: "Accessible civic communication with clear evidence and sequence.", dials: { compositionVariance: 40, visualDensity: 50, visualEnergy: 35 } },
  data: { designRead: "Dense data-led analysis with explicit comparison and hierarchy.", dials: { compositionVariance: 50, visualDensity: 80, visualEnergy: 50 } },
  narrative: { designRead: "High-energy narrative with a decisive opening or close.", dials: { compositionVariance: 70, visualDensity: 40, visualEnergy: 80 } }
});

function fixtureContent(family, brief) {
  const headline = brief;
  const content = {
    cover: { headline, subtitle: "A concise evidence-led briefing" },
    architecture: { headline, layers: ["Intent", "System", "Execution"] },
    comparison: { headline, primary: { title: "Option A", items: ["Benefit", "Constraint"] }, secondary: { title: "Option B", items: ["Benefit", "Constraint"] } },
    process: { headline, steps: ["Frame", "Decide", "Deliver"] },
    dashboard: { headline, metrics: [{ label: "Current", value: "72" }, { label: "Target", value: "85" }, { label: "Delta", value: "+13" }] },
    quote: { quote: brief, attribution: "Briefing evidence" },
    matrix: { headline, xAxis: "Effort", yAxis: "Impact", quadrants: ["Maintain", "Prioritize", "Explore", "Accelerate"] },
    closing: { headline, callToAction: "Align on the next decision." }
  };
  return content[family];
}

function familyFromIntent(intent) {
  const normalized = String(intent ?? "").trim().toLowerCase();
  const rules = [
    [/metric/, "dashboard"],
    [/compar|option/, "comparison"],
    [/quot/, "quote"],
    [/architect/, "architecture"],
    [/process|roadmap/, "process"],
    [/matrix|prioriti/, "matrix"],
    [/call to action|clos/, "closing"],
    [/opening|story/, "cover"]
  ];
  return rules.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

const FIXTURE_SLIDE_INTENT = Object.freeze({
  cover: { pageRole: "cover", strategy: "focus", whitespace: "spacious", emphasis: "message" },
  architecture: { pageRole: "architecture", strategy: "structural", whitespace: "balanced", emphasis: "evidence" },
  comparison: { pageRole: "comparison", strategy: "split", whitespace: "balanced", emphasis: "evidence" },
  process: { pageRole: "process", strategy: "editorial", whitespace: "balanced", emphasis: "evidence" },
  dashboard: { pageRole: "data", strategy: "data-led", whitespace: "compact", emphasis: "data" },
  quote: { pageRole: "quote", strategy: "minimal-whitespace", whitespace: "spacious", emphasis: "message" },
  matrix: { pageRole: "comparison", strategy: "asymmetric", whitespace: "balanced", emphasis: "data" },
  closing: { pageRole: "closing", strategy: "immersive", whitespace: "spacious", emphasis: "message" }
});

export function buildPlanFromBriefFixture(fixture) {
  const intent = BRIEF_DOMAIN_INTENT[fixture?.domain];
  const family = familyFromIntent(fixture?.input?.intent);
  if (!intent || !REGISTRY[family]) throw new Error(`unsupported brief fixture ${fixture?.id ?? "(unknown)"}`);
  const slideId = `slide-${fixture.id}-1`;
  const slideIntent = FIXTURE_SLIDE_INTENT[family];
  return {
    version: "0.2.0",
    context: {
      title: fixture.brief,
      language: fixture.language,
      audience: { primary: fixture.input.audience || `${fixture.domain} decision makers`, knowledgeLevel: "mixed" },
      decisionGoal: fixture.brief,
      durationMinutes: 5,
      environment: { viewingMode: "desktop", presentedOrReadAlone: "read-alone" },
      tone: "Clear, concise, and evidence-led",
      mustRemember: [fixture.brief],
      brand: { references: [], antiReferences: [] },
      qualityProfile: "standard",
      targetSuites: [{ suite: "libreoffice", required: true }],
      editabilityFloor: 4,
      assetIntensity: 0,
      visualAmbition: intent.dials.visualEnergy
    },
    designIntent: {
      designRead: intent.designRead,
      typography: "Clear sans-serif hierarchy",
      palette: "Neutral foundation with one contextual accent",
      material: "Flat native PowerPoint geometry",
      imagery: "No external imagery required",
      composition: { direction: "One decisive native composition", visibleGrid: false },
      dials: { ...intent.dials },
      locks: { sourceLocked: false, brandLocked: false, protectedTokens: [], protectedAssets: [] }
    },
    story: {
      narrativeBeats: ["Frame", "Explain", "Decide"],
      sections: [{ id: `section-${fixture.id}`, title: fixture.brief, slideIds: [slideId] }],
      decisionPath: [slideId]
    },
    assets: [],
    slides: [{
      id: slideId,
      pageRole: slideIntent.pageRole,
      message: fixture.brief,
      contentModel: { kind: family, data: fixtureContent(family, fixture.brief) },
      attentionTarget: { kind: "message", ref: `brief:${fixture.id}` },
      compositionIntent: {
        strategy: slideIntent.strategy,
        whitespace: slideIntent.whitespace,
        emphasis: slideIntent.emphasis
      },
      assetIds: [],
      routePolicy: { preferred: "native", allowed: ["native"], fullSlideRaster: false }
    }]
  };
}

export function geometrySignature(slide) {
  return slide.elements.map((element) => `${element.type}:${Number(element.x).toFixed(2)},${Number(element.y).toFixed(2)},${Number(element.w).toFixed(2)},${Number(element.h).toFixed(2)}`).join("|");
}
