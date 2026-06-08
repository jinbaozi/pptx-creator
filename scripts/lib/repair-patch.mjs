const SUPPORTED = new Set(["move", "resize", "updateStyle", "updateText"]);

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
  }
  return next;
}
