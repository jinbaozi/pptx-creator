import { SLIDE_SIZE } from "./html-to-manifest-core.mjs";

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
export const MEASUREMENT_VERSION = "0.1.0";

export function roundInches(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function pxToInches(px, viewportPx, slideIn) {
  if (!viewportPx) return 0;
  return roundInches((px / viewportPx) * slideIn);
}

export function convertMeasurementPxToInches(pxBox, viewport, slideSize = SLIDE_SIZE) {
  return {
    x: pxToInches(pxBox.x, viewport.width, slideSize.width),
    y: pxToInches(pxBox.y, viewport.height, slideSize.height),
    w: pxToInches(pxBox.w, viewport.width, slideSize.width),
    h: pxToInches(pxBox.h, viewport.height, slideSize.height)
  };
}

export function buildMeasurementLookup(measurements) {
  const lookup = new Map();
  for (const element of measurements?.elements ?? []) {
    if (element?.id) lookup.set(element.id, element);
  }
  return lookup;
}

export function getMeasurementBox(lookup, id, fallback = null) {
  if (!lookup || !id) return fallback;
  const measured = lookup.get(id);
  if (!measured) return fallback;
  const { x, y, w, h } = measured;
  if ([x, y, w, h].every((value) => Number.isFinite(value))) {
    return { x, y, w, h };
  }
  return fallback;
}

export function mergeMeasurementsIntoManifest(manifest, measurements) {
  if (!measurements?.elements?.length) return manifest;
  const lookup = buildMeasurementLookup(measurements);
  for (const slide of manifest.slides ?? []) {
    for (const element of slide.elements ?? []) {
      const box = getMeasurementBox(lookup, element.id);
      if (box) {
        element.x = box.x;
        element.y = box.y;
        element.w = box.w;
        element.h = box.h;
      }
    }
  }
  return manifest;
}

export function normalizeMeasuredElements(rawElements, viewport, slideSize = SLIDE_SIZE) {
  return rawElements
    .filter((element) => element?.id && element?.kind)
    .map((element) => {
      const inches = element.inches ?? convertMeasurementPxToInches(element.px, viewport, slideSize);
      return {
        id: element.id,
        ...(element.slideId ? { slideId: element.slideId } : {}),
        kind: element.kind,
        slideIndex: Number.isInteger(element.slideIndex) ? element.slideIndex : null,
        tagName: element.tagName ?? null,
        selector: element.selector ?? `[data-pptx-id="${element.id}"]`,
        x: inches.x,
        y: inches.y,
        w: inches.w,
        h: inches.h,
        px: element.px,
        text: element.text ?? "",
        visibleText: typeof element.visibleText === "string" ? element.visibleText : null,
        src: element.src ?? null,
        href: element.href ?? null,
        hyperlinkTooltip: element.hyperlinkTooltip ?? null,
        naturalWidth: Number.isFinite(element.naturalWidth) ? element.naturalWidth : null,
        naturalHeight: Number.isFinite(element.naturalHeight) ? element.naturalHeight : null,
        semantics: element.semantics && typeof element.semantics === "object" ? element.semantics : {},
        style: element.style && typeof element.style === "object" ? element.style : {},
        replica: element.replica && typeof element.replica === "object" ? element.replica : {}
      };
    });
}

export function normalizeMeasuredSlides(rawSlides = []) {
  return rawSlides.map((slide, index) => ({
    ...(slide.slideId ? { slideId: slide.slideId } : {}),
    slideIndex: Number.isInteger(slide.slideIndex) ? slide.slideIndex : index,
    selector: slide.selector ?? null,
    style: slide.style && typeof slide.style === "object" ? slide.style : {},
    replica: slide.replica && typeof slide.replica === "object" ? slide.replica : {}
  }));
}

export function buildMeasurementsDocument({
  source,
  viewport = DEFAULT_VIEWPORT,
  slideSize = SLIDE_SIZE,
  elements,
  slides = [],
  measuredAt = new Date().toISOString()
}) {
  return {
    version: MEASUREMENT_VERSION,
    source,
    measuredAt,
    slideSize: {
      preset: slideSize.preset ?? "wide",
      width: slideSize.width,
      height: slideSize.height,
      unit: slideSize.unit ?? "in"
    },
    viewport: { ...viewport },
    slides: normalizeMeasuredSlides(slides),
    elements: normalizeMeasuredElements(elements, viewport, slideSize)
  };
}
