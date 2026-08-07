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

function normalizeTableMetadata(table, viewport, slideSize) {
  if (!table || typeof table !== "object") return null;
  const normalizeBox = (box) => box && typeof box === "object" && ["x", "y", "w", "h"].every((key) => Number.isFinite(Number(box[key])))
    ? convertMeasurementPxToInches(box, viewport, slideSize)
    : box;
  const normalizeCell = (cell) => {
    if (!cell || typeof cell !== "object") return cell;
    return {
      ...cell,
      ...(cell.px ? { inches: normalizeBox(cell.px) } : {}),
      ...(Array.isArray(cell.runs) ? { runs: cell.runs.map((run) => ({ ...run })) } : {})
    };
  };
  const sections = Array.isArray(table.sections)
    ? table.sections.map((section) => ({
      ...section,
      rows: Array.isArray(section.rows)
        ? section.rows.map((row) => ({
          ...row,
          ...(row.px ? { inches: normalizeBox(row.px) } : {}),
          cells: Array.isArray(row.cells) ? row.cells.map(normalizeCell) : []
        }))
        : []
    }))
    : [];
  const columns = Array.isArray(table.columnsPx)
    ? table.columnsPx.map((value) => pxToInches(Number(value), viewport.width, slideSize.width))
    : Array.isArray(table.colW) ? table.colW.map(Number) : undefined;
  const rowHeights = Array.isArray(table.rowHeightsPx)
    ? table.rowHeightsPx.map((value) => pxToInches(Number(value), viewport.height, slideSize.height))
    : Array.isArray(table.rowH) ? table.rowH.map(Number) : undefined;
  return {
    ...table,
    ...(sections.length > 0 ? { sections } : {}),
    ...(columns ? { columns } : {}),
    ...(rowHeights ? { rowHeights } : {}),
    ...(table.caption ? {
      caption: {
        ...table.caption,
        ...(table.caption.px ? { inches: normalizeBox(table.caption.px) } : {}),
        ...(Array.isArray(table.caption.runs) ? { runs: table.caption.runs.map((run) => ({ ...run })) } : {})
      }
    } : {})
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
  const source = measured.style?.transformData?.supported !== false && measured.transformBox
    ? measured.transformBox
    : measured;
  const { x, y, w, h } = source;
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
      const layoutBox = element.layoutPx ? convertMeasurementPxToInches(element.layoutPx, viewport, slideSize) : null;
      const transformBox = element.transformBoxPx ? convertMeasurementPxToInches(element.transformBoxPx, viewport, slideSize) : null;
      return {
        id: element.id,
        ...(element.slideId ? { slideId: element.slideId } : {}),
        kind: element.kind,
        slideIndex: Number.isInteger(element.slideIndex) ? element.slideIndex : null,
        tagName: element.tagName ?? null,
        selector: element.selector ?? `[data-pptx-id="${element.id}"]`,
        ...(element.generated ? { generated: true } : {}),
        ...(element.dataPptxGenerated ? { dataPptxGenerated: true } : {}),
        ...(element.generatedBy ? { generatedBy: String(element.generatedBy) } : {}),
        ...(element.pseudo ? { pseudo: String(element.pseudo) } : {}),
        ...(element.pseudoOwnerId ? { pseudoOwnerId: String(element.pseudoOwnerId) } : {}),
        x: inches.x,
        y: inches.y,
        w: inches.w,
        h: inches.h,
        px: element.px,
        pixelScale: {
          x: slideSize.width / viewport.width,
          y: slideSize.height / viewport.height
        },
        ...(layoutBox ? { layoutBox, layoutPx: element.layoutPx } : {}),
        ...(transformBox ? { transformBox, transformBoxPx: element.transformBoxPx } : {}),
        ...(Number.isFinite(Number(element.paintOrder)) ? { paintOrder: Number(element.paintOrder) } : {}),
        ...(element.stackingContext !== undefined ? { stackingContext: Boolean(element.stackingContext) } : {}),
        ...(Array.isArray(element.stackingContextPath) ? { stackingContextPath: [...element.stackingContextPath] } : {}),
        text: element.text ?? "",
        visibleText: typeof element.visibleText === "string" ? element.visibleText : null,
        ...(Array.isArray(element.renderedLines) ? { renderedLines: [...element.renderedLines] } : {}),
        ...(Array.isArray(element.lineBreakOffsets) ? { lineBreakOffsets: [...element.lineBreakOffsets] } : {}),
        ...(Number.isInteger(element.renderedLineCount) ? { renderedLineCount: element.renderedLineCount } : {}),
        ...(Array.isArray(element.runs) ? { runs: element.runs.map((run) => ({ ...run })) } : {}),
        ...(element.table ? { table: normalizeTableMetadata(element.table, viewport, slideSize) } : {}),
        ...(element.svg && typeof element.svg === "object" ? {
          svg: {
            ...element.svg,
            ...(Array.isArray(element.svg.nodes) ? {
              nodes: element.svg.nodes.map((node) => ({
                ...node,
                ...(node.style && typeof node.style === "object" ? { style: { ...node.style } } : {})
              }))
            } : {})
          }
        } : {}),
        ...(element.shapeOverride ? { shapeOverride: String(element.shapeOverride) } : {}),
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
    ...(Number.isFinite(Number(slide.paintOrder)) ? { paintOrder: Number(slide.paintOrder) } : {}),
    ...(slide.stackingContext !== undefined ? { stackingContext: Boolean(slide.stackingContext) } : {}),
    ...(Array.isArray(slide.stackingContextPath) ? { stackingContextPath: [...slide.stackingContextPath] } : {}),
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
  runtime = null,
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
    ...(runtime && typeof runtime === "object" ? { runtime: { ...runtime } } : {}),
    slides: normalizeMeasuredSlides(slides),
    elements: normalizeMeasuredElements(elements, viewport, slideSize)
  };
}
