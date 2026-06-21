const SUPPORTED = new Set([
  "move",
  "resize",
  "updateStyle",
  "updateText",
  "removeElement",
  "increaseSpacing",
  "reduceDensity",
  "adjustStyle"
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findSlide(manifest, slideId) {
  const slide = manifest.slides?.find((item) => item.id === slideId);
  if (!slide) throw new Error(`Cannot apply patch: missing slide ${slideId}`);
  return slide;
}

function findElement(slide, elementId) {
  const element = slide.elements?.find((item) => item.id === elementId);
  if (!element) throw new Error(`Cannot apply patch: missing element ${elementId}`);
  return element;
}

export function applyRepairPatch(manifest, repairPatch) {
  if (!repairPatch || !Array.isArray(repairPatch.patches)) {
    throw new Error("repairPatch.patches must be an array");
  }
  const next = clone(manifest);
  for (const patch of repairPatch.patches) {
    if (!SUPPORTED.has(patch.operation)) {
      throw new Error(`Unsupported repair operation: ${patch.operation}`);
    }
    const slide = findSlide(next, patch.slideId);
    if (patch.operation === "removeElement") {
      const index = slide.elements?.findIndex((item) => item.id === patch.targetElementId) ?? -1;
      if (index < 0) throw new Error(`Cannot apply patch: missing element ${patch.targetElementId}`);
      slide.elements.splice(index, 1);
      continue;
    }
    const element = findElement(slide, patch.targetElementId);
    const changes = patch.changes || {};
    if (patch.operation === "move") {
      if (typeof changes.x === "number") element.x = changes.x;
      if (typeof changes.y === "number") element.y = changes.y;
    }
    if (patch.operation === "resize") {
      if (typeof changes.w === "number") element.w = changes.w;
      if (typeof changes.h === "number") element.h = changes.h;
    }
    if (patch.operation === "updateStyle") {
      element.style = { ...(element.style || {}), ...changes };
    }
    if (patch.operation === "updateText") {
      if (typeof changes.text !== "string") throw new Error("updateText requires changes.text");
      element.text = changes.text;
    }
    if (patch.operation === "increaseSpacing") {
      const padding = changes.padding ?? "spacing.md";
      const numeric = parseFloat(padding);
      const value = Number.isFinite(numeric) ? numeric : 0.5;
      element.style = element.style || {};
      const existingPad = typeof element.style.padding === "number" ? element.style.padding : 0;
      element.style.padding = Math.max(existingPad, value);
    }
    if (patch.operation === "reduceDensity") {
      // Best-effort: requires children list. Manifest elements don't carry a
      // `children` array, so we cannot thin them out deterministically. Log
      // the intent and let the caller re-render with a denser-aware layout.
      console.warn(
        `[repair-patch] reduceDensity is a no-op on element ${patch.targetElementId}; ` +
          "manifest elements carry no children list."
      );
    }
    if (patch.operation === "adjustStyle") {
      const styleChanges = (changes && typeof changes.style === "object" && changes.style) || {};
      element.style = { ...(element.style || {}), ...styleChanges };
    }
  }
  return next;
}

export { SUPPORTED };