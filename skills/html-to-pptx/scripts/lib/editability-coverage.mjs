/** Deterministic editability coverage calculations for the V2 quality gates. */

export const EDITABILITY_COVERAGE_VERSION = "2.0.0";

const EPSILON = 1e-9;

function finite(value) {
  return Number.isFinite(Number(value));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

export function clipRect(box, slideSize) {
  if (!box || !slideSize || !["x", "y", "w", "h"].every((key) => finite(box[key]))) return null;
  const slideWidth = Number(slideSize.width);
  const slideHeight = Number(slideSize.height);
  if (!(slideWidth > 0 && slideHeight > 0)) return null;
  const left = Math.max(0, Number(box.x));
  const top = Math.max(0, Number(box.y));
  const right = Math.min(slideWidth, Number(box.x) + Number(box.w));
  const bottom = Math.min(slideHeight, Number(box.y) + Number(box.h));
  if (!(right - left > EPSILON && bottom - top > EPSILON)) return null;
  return {
    x: round(left),
    y: round(top),
    w: round(right - left),
    h: round(bottom - top)
  };
}

export function rectangleArea(rect) {
  return rect && Number(rect.w) > 0 && Number(rect.h) > 0
    ? Number(rect.w) * Number(rect.h)
    : 0;
}

/** Exact union area for axis-aligned rectangles using deterministic x-sweep. */
export function unionArea(rects = []) {
  const normalized = rects.filter((rect) => rectangleArea(rect) > 0);
  if (normalized.length === 0) return 0;
  const xCoordinates = [...new Set(normalized.flatMap((rect) => [Number(rect.x), Number(rect.x) + Number(rect.w)]))]
    .sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index < xCoordinates.length - 1; index += 1) {
    const left = xCoordinates[index];
    const right = xCoordinates[index + 1];
    const width = right - left;
    if (!(width > EPSILON)) continue;
    const active = normalized.filter((rect) => Number(rect.x) < right - EPSILON && Number(rect.x) + Number(rect.w) > left + EPSILON);
    if (active.length === 0) continue;
    const yCoordinates = [...new Set(active.flatMap((rect) => [Number(rect.y), Number(rect.y) + Number(rect.h)]))]
      .sort((a, b) => a - b);
    let yUnion = 0;
    for (let yIndex = 0; yIndex < yCoordinates.length - 1; yIndex += 1) {
      const top = yCoordinates[yIndex];
      const bottom = yCoordinates[yIndex + 1];
      if (!(bottom - top > EPSILON)) continue;
      if (active.some((rect) => Number(rect.y) < bottom - EPSILON && Number(rect.y) + Number(rect.h) > top + EPSILON)) {
        yUnion += bottom - top;
      }
    }
    area += width * yUnion;
  }
  return area;
}

function semanticValue(element) {
  const source = element?.svgSemantic
    ?? element?.semantic
    ?? element?.svg?.semantic
    ?? element?.svg?.semanticMetadata
    ?? element?.metadata?.svgSemantic;
  if (typeof source === "string") return source.toLowerCase();
  if (source && typeof source === "object") {
    return String(source.classification ?? source.kind ?? source.role ?? "").toLowerCase();
  }
  return "";
}

function isSvgElement(element) {
  return element?.mediaKind === "svg"
    || element?.vectorPreserved === true
    || element?.svg?.mode === "vector-preserved"
    || element?.svg?.tier === "C";
}

export function classifySemanticElement(element) {
  const type = String(element?.type ?? "").toLowerCase();
  if (type === "cropped-asset" || element?.replicaFallback?.kind === "raster" || element?.replicaFallback?.kind === "raster-fallback") {
    return { classification: "cropped-local-raster-fallback", weight: 0, priority: 100 };
  }
  if (type === "group") return { classification: "structured-native-group", weight: 0.95, priority: 80 };
  if (type === "chart") return { classification: "native-chart", weight: 1, priority: 20 };
  if (isSvgElement(element)) {
    const semantic = semanticValue(element);
    if (["chart", "chart-svg", "svg-chart"].includes(semantic)) return { classification: "chart-svg", weight: 0.2, priority: 20 };
    if (["architecture", "architecture-svg", "diagram", "diagram-svg", "svg-architecture"].includes(semantic)) return { classification: "architecture-svg", weight: 0.2, priority: 20 };
    if (["text", "text-bearing", "text-bearing-svg", "svg-text"].includes(semantic)) return { classification: "text-bearing-whole-svg", weight: 0.4, priority: 20 };
    return { classification: "decorative-svg", weight: 0.8, priority: 20 };
  }
  if (["text", "shape", "line", "table", "image", "photo", "icon"].includes(type)) {
    return { classification: type === "image" || type === "photo" ? "native-photo" : `native-${type}`, weight: 1, priority: 20 };
  }
  return { classification: "native-object", weight: 1, priority: 20 };
}

function weightedUnionArea(records = []) {
  const normalized = records.filter((record) => rectangleArea(record.box) > 0);
  const visibleAreas = new Map();
  if (normalized.length === 0) return { area: 0, visibleAreas };
  const xCoordinates = [...new Set(normalized.flatMap((record) => [Number(record.box.x), Number(record.box.x) + Number(record.box.w)]))]
    .sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index < xCoordinates.length - 1; index += 1) {
    const left = xCoordinates[index];
    const right = xCoordinates[index + 1];
    const width = right - left;
    if (!(width > EPSILON)) continue;
    const active = normalized.filter((record) => Number(record.box.x) < right - EPSILON && Number(record.box.x) + Number(record.box.w) > left + EPSILON);
    if (active.length === 0) continue;
    const yCoordinates = [...new Set(active.flatMap((record) => [Number(record.box.y), Number(record.box.y) + Number(record.box.h)]))]
      .sort((a, b) => a - b);
    for (let yIndex = 0; yIndex < yCoordinates.length - 1; yIndex += 1) {
      const topY = yCoordinates[yIndex];
      const bottomY = yCoordinates[yIndex + 1];
      if (!(bottomY - topY > EPSILON)) continue;
      const covering = active.filter((record) => Number(record.box.y) < bottomY - EPSILON && Number(record.box.y) + Number(record.box.h) > topY + EPSILON);
      if (covering.length === 0) continue;
      // Manifest order is the deterministic visible z-order. A later object
      // wins over the slide background even when its semantic weight is lower
      // (for example, a chart SVG or a raster fallback). Weight then breaks a
      // same-z tie, followed by source order for complete determinism.
      const topRecord = covering.reduce((current, record) => {
        if (!current) return record;
        const zDelta = Number(record.zOrder ?? 0) - Number(current.zOrder ?? 0);
        if (zDelta !== 0) return zDelta > 0 ? record : current;
        const weightDelta = Number(record.weight ?? 0) - Number(current.weight ?? 0);
        if (weightDelta !== 0) return weightDelta > 0 ? record : current;
        return normalized.indexOf(record) > normalized.indexOf(current) ? record : current;
      }, null);
      const cellArea = width * (bottomY - topY);
      const topWeight = Number(topRecord?.weight ?? 0);
      area += cellArea * topWeight;
      if (topRecord?.id) visibleAreas.set(topRecord.id, (visibleAreas.get(topRecord.id) ?? 0) + cellArea);
    }
  }
  return { area, visibleAreas };
}

function fallbackIdentity(fallback, index) {
  const source = String(fallback?.sourceElementId ?? fallback?.componentId ?? fallback?.id ?? index)
    .replace(/-localized-fallback$/, "");
  return `${fallback?.slideId ?? fallback?.slideIndex ?? "slide"}\0${source}`;
}

function slideFallbacks(manifest, fallbacks, slide, slideIndex) {
  const entries = new Map();
  const candidates = [
    ...(Array.isArray(fallbacks) ? fallbacks.map((fallback) => ({ fallback, source: "ledger" })) : []),
    ...(slide.elements ?? [])
      .filter((element) => element?.type === "cropped-asset")
      .map((element) => ({
        source: "manifest",
        fallback: {
          id: element.id,
          slideId: slide.id,
          slideIndex,
          sourceElementId: element.id,
          box: { x: element.x, y: element.y, w: element.w, h: element.h }
        }
      }))
  ];
  for (const [index, candidate] of candidates.entries()) {
    const fallback = candidate.fallback;
    if (!fallback || (fallback.slideId && fallback.slideId !== slide.id) || (fallback.slideIndex !== undefined && Number(fallback.slideIndex) !== slideIndex)) continue;
    const identity = fallbackIdentity(fallback, index);
    const current = entries.get(identity);
    if (!current) {
      entries.set(identity, candidate);
      continue;
    }
    // The ledger is authoritative for localized fallback identity and
    // provenance. Keep it as the visible record while allowing the manifest
    // crop to fill a missing box/path field; this prevents duplicate semantic
    // evidence when both representations describe the same fallback.
    const canonical = current.source === "ledger" ? current.fallback : candidate.source === "ledger" ? candidate.fallback : current.fallback;
    const supplemental = canonical === current.fallback ? candidate.fallback : current.fallback;
    entries.set(identity, {
      source: canonical === current.fallback ? current.source : candidate.source,
      fallback: {
        ...supplemental,
        ...canonical,
        box: canonical.box ?? supplemental.box
      }
    });
  }
  return [...entries.values()].map((entry) => entry.fallback);
}

function buildSemanticRecords(slide, slideSize, fallbacks, slideIndex) {
  const elements = Array.isArray(slide?.elements) ? slide.elements : [];
  const byId = new Map(elements.filter((element) => element?.id).map((element) => [element.id, element]));
  const groupChildIds = new Set(elements.filter((element) => element?.type === "group").flatMap((group) => Array.isArray(group.children) ? group.children : []));
  const generatedOwnedIds = new Set(elements
    .filter((element) => element?.semanticParentId && byId.has(element.semanticParentId))
    .map((element) => element.id));
  const records = [{
    id: `${slide.id}-background`,
    source: "manifest",
    box: { x: 0, y: 0, w: Number(slideSize.width), h: Number(slideSize.height) },
    area: Number(slideSize.width) * Number(slideSize.height),
    classification: "native-slide-background",
    weight: 1,
    priority: 0,
    zOrder: -1
  }];
  for (const [elementIndex, element] of elements.entries()) {
    // Cropped assets are represented once by the canonical fallback entries
    // below, which merge manifest and ledger provenance.
    if (!element?.id || element.type === "cropped-asset" || groupChildIds.has(element.id) || generatedOwnedIds.has(element.id)) continue;
    const classification = classifySemanticElement(element);
    const box = clipRect(element, slideSize);
    if (!box) continue;
    records.push({
      id: element.id,
      source: "manifest",
      box,
      area: rectangleArea(box),
      ...classification,
      zOrder: elementIndex
    });
  }
  for (const [index, fallback] of slideFallbacks(null, fallbacks, slide, slideIndex).entries()) {
    const box = clipRect(fallback.box, slideSize);
    if (!box) continue;
    records.push({
      id: fallback.componentId ?? fallback.sourceElementId ?? fallback.id ?? `fallback-${index + 1}`,
      source: "fallback-ledger",
      box,
      area: rectangleArea(box),
      classification: "cropped-local-raster-fallback",
      weight: 0,
      priority: 100,
      zOrder: elements.length + index + 1
    });
  }
  return records;
}

export function calculateEditabilityCoverage({ manifest, fallbacks = [], countersBySlide = [] } = {}) {
  const deckSize = manifest?.deck?.size ?? { width: 13.333, height: 7.5 };
  const slideArea = Number(deckSize.width) * Number(deckSize.height);
  const perSlide = (manifest?.slides ?? []).map((slide, slideIndex) => {
    const fallbackEntries = slideFallbacks(manifest, fallbacks, slide, slideIndex);
    const fallbackRects = fallbackEntries.map((fallback) => clipRect(fallback.box, deckSize)).filter(Boolean);
    const fallbackArea = unionArea(fallbackRects);
    const nativeObjectCoverage = slideArea > 0 ? round(Math.max(0, 1 - fallbackArea / slideArea)) : 0;
    const records = buildSemanticRecords(slide, deckSize, fallbackEntries, slideIndex);
    const weighted = weightedUnionArea(records);
    const semanticWeightedArea = weighted.area;
    const semanticEditabilityCoverage = slideArea > 0 ? round(Math.max(0, Math.min(1, semanticWeightedArea / slideArea))) : 0;
    const evidence = records.map((record) => {
      const visibleArea = weighted.visibleAreas.get(record.id) ?? 0;
      return {
      id: record.id,
      source: record.source,
      classification: record.classification,
      box: record.box,
      area: round(record.area),
      weight: record.weight,
      weightedArea: round(record.area * record.weight),
      priority: record.priority,
      zOrder: record.zOrder,
      visibleArea: round(visibleArea),
      visibleContribution: round(visibleArea * record.weight)
      };
    });
    return {
      slideIndex,
      slideId: slide.id,
      level: null,
      nativeObjectCoverage,
      nativeCoverage: nativeObjectCoverage,
      semanticEditabilityCoverage,
      fallbackArea: round(fallbackArea),
      fallbackRectangles: fallbackRects,
      semanticArea: round(unionArea(records.map((record) => record.box))),
      semanticWeightedArea: round(semanticWeightedArea),
      semanticEvidence: evidence,
      counters: countersBySlide[slideIndex] ?? null
    };
  });
  const minimum = (key, fallback = 1) => perSlide.length ? Math.min(...perSlide.map((slide) => Number(slide[key] ?? fallback))) : fallback;
  return {
    version: EDITABILITY_COVERAGE_VERSION,
    nativeObjectCoverage: minimum("nativeObjectCoverage"),
    nativeCoverage: minimum("nativeObjectCoverage"),
    semanticEditabilityCoverage: minimum("semanticEditabilityCoverage", 0),
    perSlide
  };
}
