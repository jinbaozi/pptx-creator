import { parse } from "node-html-parser";

function stableNodeId(node) {
  return node?.getAttribute?.("data-pptx-id")
    ?? node?.getAttribute?.("data-id")
    ?? node?.getAttribute?.("id")
    ?? null;
}

function sourceSlides(root) {
  const slides = root.querySelectorAll?.(".pptx-slide, [data-slide]") ?? [];
  return slides.length > 0 ? [...slides] : [root];
}

function componentMeasurement(measurements, id, slideIndex) {
  return (measurements?.elements ?? []).find((element) => element?.id === id && (
    !Number.isInteger(element.slideIndex) || element.slideIndex === slideIndex
  ));
}

function keyMarker(node) {
  const value = String(node?.getAttribute?.("data-pptx-visual-key") ?? "").trim().toLowerCase();
  return ["true", "1", "yes"].includes(value);
}

function runVisualSignature(run) {
  const source = run && typeof run === "object" ? run : {};
  const style = source.style && typeof source.style === "object" ? source.style : {};
  return JSON.stringify({
    fontFamily: source.fontFamily ?? style.fontFamily ?? null,
    fontSize: source.fontSize ?? style.fontSize ?? null,
    fontWeight: source.fontWeight ?? style.fontWeight ?? null,
    fontStyle: source.fontStyle ?? style.fontStyle ?? null,
    italic: source.italic ?? style.italic ?? null,
    bold: source.bold ?? style.bold ?? null,
    color: source.color ?? style.color ?? null,
    backgroundColor: source.backgroundColor ?? style.backgroundColor ?? null,
    decoration: source.decoration ?? style.decoration ?? style.textDecoration ?? null,
    underline: source.underline ?? style.underline ?? null,
    strike: source.strike ?? style.strike ?? null,
    baseline: source.baseline ?? style.baseline ?? null,
    charSpacing: source.charSpacing ?? style.charSpacing ?? null
  });
}

function hasVisuallyDistinctRuns(element, measurement) {
  const measuredRuns = Array.isArray(measurement?.runs) ? measurement.runs : [];
  const runs = measurement
    ? measuredRuns
    : (Array.isArray(element?.runs) ? element.runs : []);
  return runs.length > 1 && new Set(runs.map(runVisualSignature)).size > 1;
}

function componentRiskReasons(element, measurement) {
  const reasons = [];
  const transform = element?.transform ?? measurement?.style?.transformData;
  if (transform && typeof transform === "object" && transform.supported !== false) reasons.push("css-transform");
  if (element?.type === "chart") reasons.push("native-chart");
  if (element?.type === "table") reasons.push("native-table");
  if (element?.type === "group") reasons.push("native-group");
  if (element?.type === "cropped-asset" || /localized-fallback$/.test(String(element?.id ?? ""))) reasons.push("localized-fallback");
  if (element?.type === "image" && (element?.sizing?.type === "crop" || measurement?.style?.objectFit === "cover")) {
    reasons.push("cropped-image");
  }
  if (element?.mediaKind === "svg" || measurement?.svg) reasons.push("svg-mapping");
  if (element?.type === "text" && hasVisuallyDistinctRuns(element, measurement)) reasons.push("rich-text-runs");
  return [...new Set(reasons)].sort();
}

export function buildComponentRegions({ html, measurements, manifest, riskOnly = false } = {}) {
  const root = parse(String(html ?? ""));
  const slides = sourceSlides(root);
  const byId = new Map((manifest?.slides ?? []).flatMap((slide) => (slide.elements ?? []).map((element) => [element.id, { ...element, slideIndex: manifest.slides.indexOf(slide) }])));
  const candidates = new Map();
  const add = (id, slideIndex, source, kind, riskReasons = []) => {
    if (!id) return;
    const measurement = componentMeasurement(measurements, id, slideIndex);
    const element = byId.get(id);
    const box = measurement?.px ?? null;
    if (!box || !(Number(box.w) > 0 && Number(box.h) > 0)) return;
    const reasons = [...new Set(riskReasons)].sort();
    const existing = candidates.get(id);
    if (existing) {
      existing.riskReasons = [...new Set([...(existing.riskReasons ?? []), ...reasons])].sort();
      existing.risk = existing.riskReasons.length > 0;
      return;
    }
    candidates.set(id, {
      id,
      slideIndex,
      kind: kind ?? element?.type ?? measurement?.kind ?? "component",
      source,
      risk: reasons.length > 0,
      riskReasons: reasons,
      box: {
        x: Number(box.x),
        y: Number(box.y),
        w: Number(box.w),
        h: Number(box.h)
      }
    });
  };
  slides.forEach((slide, slideIndex) => {
    for (const node of slide.querySelectorAll?.("[data-pptx-visual-key='true'], [data-pptx-visual-key='1'], [data-pptx-visual-key='yes'], pre, code") ?? []) {
      const id = stableNodeId(node);
      if (id) add(id, slideIndex, keyMarker(node) ? "data-pptx-visual-key" : String(node.tagName ?? "").toLowerCase(), String(node.tagName ?? "").toLowerCase());
    }
  });
  for (const slide of manifest?.slides ?? []) {
    const slideIndex = manifest.slides.indexOf(slide);
    for (const element of slide.elements ?? []) {
      const measurement = componentMeasurement(measurements, element?.id, slideIndex);
      const reasons = componentRiskReasons(element, measurement);
      if (element?.type === "chart" || element?.type === "group" || reasons.length > 0) {
        add(element.id, slideIndex, element.type, element.type, reasons);
      }
    }
  }
  const selected = [...candidates.values()]
    .filter((component) => !riskOnly || component.risk)
    .sort((a, b) => a.slideIndex - b.slideIndex || a.id.localeCompare(b.id));
  return {
    version: "1.0.0",
    selectionMode: riskOnly ? "risk" : "all",
    components: selected
  };
}
