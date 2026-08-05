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

export function buildComponentRegions({ html, measurements, manifest } = {}) {
  const root = parse(String(html ?? ""));
  const slides = sourceSlides(root);
  const byId = new Map((manifest?.slides ?? []).flatMap((slide) => (slide.elements ?? []).map((element) => [element.id, { ...element, slideIndex: manifest.slides.indexOf(slide) }])));
  const candidates = new Map();
  const add = (id, slideIndex, source, kind) => {
    if (!id || candidates.has(id)) return;
    const measurement = componentMeasurement(measurements, id, slideIndex);
    const element = byId.get(id);
    const box = measurement?.px ?? null;
    if (!box || !(Number(box.w) > 0 && Number(box.h) > 0)) return;
    candidates.set(id, {
      id,
      slideIndex,
      kind: kind ?? element?.type ?? measurement?.kind ?? "component",
      source,
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
      if (element?.type === "chart" || element?.type === "group") add(element.id, slideIndex, element.type, element.type);
    }
  }
  return {
    version: "1.0.0",
    components: [...candidates.values()].sort((a, b) => a.slideIndex - b.slideIndex || a.id.localeCompare(b.id))
  };
}
