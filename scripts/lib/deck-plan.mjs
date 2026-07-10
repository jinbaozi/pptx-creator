const W = 13.333;
const H = 7.5;

const text = (id, value, x, y, w, h, style = {}) => ({
  type: "text", id, x, y, w, h, text: Array.isArray(value) ? value.join("\n") : String(value ?? ""), style
});
const shape = (id, x, y, w, h, fill = "#EEF2FF", line = "#2563EB") => ({
  type: "shape", id, shape: "roundRect", x, y, w, h, style: { fill, line }
});
const line = (id, x, y, w, h, color = "#2563EB") => ({
  type: "line", id, x, y, w, h, style: { color, width: 2 }
});
const title = (value) => text("headline", value, 0.72, 0.42, 11.9, 0.62, { fontSize: 28, bold: true, color: "#111827" });
const itemText = (item) => typeof item === "string" ? item : item?.label ?? item?.title ?? item?.name ?? JSON.stringify(item);

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
    text("left-title", content.left.title, 1.05, 1.72, 4.9, 0.5, { fontSize: 21, bold: true }),
    text("left-items", content.left.items, 1.05, 2.42, 4.9, 2.9, { fontSize: 16 }),
    text("right-title", content.right.title, 7.32, 1.72, 4.9, 0.5, { fontSize: 21, bold: true }),
    text("right-items", content.right.items, 7.32, 2.42, 4.9, 2.9, { fontSize: 16 })];
}

function compileProcess(content) {
  const steps = content.steps.slice(0, 5);
  return [title(content.headline), ...steps.flatMap((entry, index) => {
    const x = 0.72 + index * 2.5;
    return [shape(`step-${index}`, x + 0.5, 2.08, 0.86, 0.86, "#EEF2FF"), text(`step-label-${index}`, itemText(entry), x + 0.08, 3.35, 1.7, 0.72, { fontSize: 15, bold: true, align: "center" }), ...(index < steps.length - 1 ? [line(`connector-${index}`, x + 1.36, 2.5, 1.14, 0.01)] : [])];
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

function familyValidator(family, required, check = () => null) {
  return (content = {}) => {
    for (const key of required) if (content[key] === undefined || content[key] === "") return `${family} requires content.${key}`;
    return check(content);
  };
}

const REGISTRY = Object.freeze({
  cover: { schema: { $id: "archetype:cover", required: ["headline", "subtitle"] }, validate: familyValidator("cover", ["headline", "subtitle"], (c) => typeof c.headline === "string" && typeof c.subtitle === "string" ? null : "cover headline/subtitle must be strings"), compile: compileCover },
  architecture: { schema: { $id: "archetype:architecture", required: ["headline", "layers"], minLayers: 2 }, validate: familyValidator("architecture", ["headline", "layers"], (c) => Array.isArray(c.layers) && c.layers.length >= 2 ? null : "architecture requires at least two layers"), compile: compileArchitecture },
  comparison: { schema: { $id: "archetype:comparison", required: ["headline", "left", "right"] }, validate: familyValidator("comparison", ["headline", "left", "right"], (c) => Array.isArray(c.left?.items) && Array.isArray(c.right?.items) ? null : "comparison requires left/right items"), compile: compileComparison },
  process: { schema: { $id: "archetype:process", required: ["headline", "steps"], minSteps: 2 }, validate: familyValidator("process", ["headline", "steps"], (c) => Array.isArray(c.steps) && c.steps.length >= 2 ? null : "process requires at least two steps"), compile: compileProcess },
  dashboard: { schema: { $id: "archetype:dashboard", required: ["headline", "metrics"] }, validate: familyValidator("dashboard", ["headline", "metrics"], (c) => Array.isArray(c.metrics) && c.metrics.length > 0 && c.metrics.every((metric) => metric.label && metric.value !== undefined) ? null : "dashboard requires metric label/value"), compile: compileDashboard },
  quote: { schema: { $id: "archetype:quote", required: ["quote", "attribution"] }, validate: familyValidator("quote", ["quote", "attribution"], (c) => typeof c.quote === "string" && typeof c.attribution === "string" ? null : "quote and attribution must be strings"), compile: compileQuote },
  matrix: { schema: { $id: "archetype:matrix", required: ["headline", "xAxis", "yAxis", "quadrants"], quadrantCount: 4 }, validate: familyValidator("matrix", ["headline", "xAxis", "yAxis", "quadrants"], (c) => Array.isArray(c.quadrants) && c.quadrants.length === 4 ? null : "matrix requires exactly four quadrants"), compile: compileMatrix },
  closing: { schema: { $id: "archetype:closing", required: ["headline", "callToAction"] }, validate: familyValidator("closing", ["headline", "callToAction"], (c) => typeof c.callToAction === "string" ? null : "closing callToAction must be a string"), compile: compileClosing }
});

export const ADVERTISED_ARCHETYPES = Object.freeze(Object.keys(REGISTRY));
export const getArchetypeRegistry = () => ({ ...REGISTRY });

function validateSlide(slide, index, errors) {
  const family = slide?.layoutFamily;
  const entry = REGISTRY[family];
  if (!entry) { errors.push(`slides[${index}] unknown layoutFamily ${family}`); return; }
  if (!slide.id || !slide.message) errors.push(`slides[${index}] requires id and message`);
  if (!Array.isArray(slide.contentReferences) || !Array.isArray(slide.assetReferences)) errors.push(`slides[${index}] requires contentReferences and assetReferences`);
  const familyError = entry.validate(slide.content);
  if (familyError) errors.push(`${family} slide ${slide.id ?? index}: ${familyError}`);
}

export function validateDeckPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { valid: false, errors: ["deck.plan must be an object"] };
  if (plan.version !== "0.1.0") errors.push("version must be 0.1.0");
  if (typeof plan.designRead !== "string" || !plan.designRead.trim() || plan.designRead.includes("\n")) errors.push("designRead must be one non-empty line");
  for (const dial of ["compositionVariance", "visualDensity", "visualEnergy"]) if (!Number.isFinite(plan.dials?.[dial]) || plan.dials[dial] < 0 || plan.dials[dial] > 100) errors.push(`dials.${dial} must be 0..100`);
  if (typeof plan.audience !== "string" || !plan.audience.trim()) errors.push("audience is required");
  if (!Array.isArray(plan.narrativeBeats) || plan.narrativeBeats.length < 1) errors.push("narrativeBeats must be non-empty");
  if (!Array.isArray(plan.slides) || plan.slides.length < 1) errors.push("slides must be non-empty");
  else plan.slides.forEach((slide, index) => validateSlide(slide, index, errors));
  return { valid: errors.length === 0, errors };
}

export function compileDeckPlan(plan, options = {}) {
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  return {
    version: "0.2.0",
    metadata: { mode: "creative", inputType: "text", qualityProfile: "creative", designIntent: { source: "deck.plan", read: plan.designRead, dials: plan.dials, intentOverride: plan.intentOverride ?? null }, generator: { name: "deck-plan.mjs" } },
    designSystem: { source: options.designSystemSource ?? "design-systems/business-neutral/DESIGN.md", name: options.designSystemName ?? "Business Neutral" },
    deck: { title: plan.title, language: plan.language, editabilityFloor: 4, size: { preset: "wide", width: W, height: H, unit: "in" } },
    assets: [],
    slides: plan.slides.map((slide) => ({ id: slide.id, type: slide.layoutFamily, title: slide.message, notes: slide.message, background: { type: "solid", color: slide.layoutFamily === "closing" ? "#111827" : "#FFFFFF" }, elements: REGISTRY[slide.layoutFamily].compile(slide.content) }))
  };
}

export function geometrySignature(slide) {
  return slide.elements.map((element) => `${element.type}:${Number(element.x).toFixed(2)},${Number(element.y).toFixed(2)},${Number(element.w).toFixed(2)},${Number(element.h).toFixed(2)}`).join("|");
}
