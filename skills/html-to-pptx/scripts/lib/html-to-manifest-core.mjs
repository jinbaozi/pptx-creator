import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageSize } from "image-size";
import { parse } from "node-html-parser";
import { buildMeasurementLookup, getMeasurementBox, mergeMeasurementsIntoManifest, roundInches } from "./html-measurement-core.mjs";
import { buildTokenLookup, exactTokenRef, resolveTokens } from "./color-tokens.mjs";
import { resolveSemanticConnectors } from "./connector-resolver.mjs";
import { FIDELITY_CHART_KINDS, isNativeChartElement } from "./chart-renderer.mjs";
import * as archetypeResolver from "./archetype-resolver.mjs";

export { mergeMeasurementsIntoManifest };

/**
 * Detect the layout mode for a slide. A "marker" is any element with
 * `data-pptx-kind` or `data-pptx-type` attributes; an "auto-layout container"
 * is `.cards`, `[data-cards]`, or a slide whose direct children are
 * `.card` / `[data-card]` siblings. The detection rule is:
 *
 *   - forceMeasured      -> "measured"
 *   - forceAutoLayout    -> "auto-layout"
 *   - forceHybrid        -> "hybrid"
 *   - markers > 0, autoLayout === 0  -> "measured"
 *   - markers === 0, autoLayout > 0  -> "auto-layout"
 *   - markers > 0, autoLayout > 0    -> "hybrid"
 *   - markers === 0, autoLayout === 0 -> "auto-layout" (semantic fallback)
 */
export function detectLayoutMode(slideNode, options = {}) {
  if (options.forceMeasured) return { path: "measured", markers: -1, autoLayoutContainers: -1 };
  if (options.forceAutoLayout) return { path: "auto-layout", markers: -1, autoLayoutContainers: -1 };
  if (options.forceHybrid) return { path: "hybrid", markers: -1, autoLayoutContainers: -1 };

  // Resolve archetype metadata up front, but only force the measured path
  // when the HTML actually contains measured markers. Semantic HTML with a
  // data-archetype attribute still needs the semantic/card converter; routing
  // it to convertMeasuredSlide() would otherwise produce an empty slide.
  let archetypeMetadata = {};
  if (options.preferArchetypeFromArchetypeMd !== false) {
    const archetypeAttr = slideNode.getAttribute?.("data-archetype");
    if (archetypeAttr) {
      const { loadFromBothRoots } = archetypeResolver;
      if (loadFromBothRoots) {
        try {
          const archetype = loadFromBothRoots(archetypeAttr);
          archetypeMetadata = {
            archetype: archetype.name,
            archetypeRoot: archetype.root
          };
        } catch {
          // Unknown archetype name — fall through to heuristic detection.
        }
      }
    }
  }

  const markers = slideNode.querySelectorAll("[data-pptx-kind],[data-pptx-type]").length;
  const autoLayoutContainers = slideNode.querySelectorAll(".cards,.card-grid,[data-cards]").length;

  if (archetypeMetadata.archetype && markers > 0) {
    return { path: "measured", markers, autoLayoutContainers, ...archetypeMetadata };
  }

  if (markers > 0 && autoLayoutContainers === 0) {
    return { path: "measured", markers, autoLayoutContainers, ...archetypeMetadata };
  }
  if (markers === 0 && autoLayoutContainers > 0) {
    return { path: "auto-layout", markers, autoLayoutContainers, ...archetypeMetadata };
  }
  if (markers > 0 && autoLayoutContainers > 0) {
    return { path: "hybrid", markers, autoLayoutContainers, ...archetypeMetadata };
  }
  return { path: "auto-layout", markers, autoLayoutContainers, ...archetypeMetadata };
}

/**
 * Region key for the per-region first-element dedup. Slides are partitioned
 * into a coarse 2x2 grid (top-left, top-right, bottom-left, bottom-right) by
 * rounding normalized x/y into one of four buckets.
 */
function regionKey(box) {
  const halfW = CONTENT_WIDTH / 2;
  const halfH = SLIDE_SIZE.height / 2;
  const col = box.x < halfW ? 0 : 1;
  const row = box.y < halfH ? 0 : 1;
  return `${row}-${col}`;
}

function attachSourceCoordinate(element, sourceCoordinates, recordedRegions) {
  if (!element || element.x === undefined || element.y === undefined) return;
  if (element.type === "image") {
    sourceCoordinates.push({
      slideId: element._slideId ?? null,
      elementId: element.id ?? null,
      dx: roundInches(element.x, 3),
      dy: roundInches(element.y, 3)
    });
    return;
  }
  const region = regionKey(element);
  if (recordedRegions.has(region)) return;
  recordedRegions.add(region);
  sourceCoordinates.push({
    slideId: element._slideId ?? null,
    elementId: element.id ?? null,
    dx: roundInches(element.x, 3),
    dy: roundInches(element.y, 3)
  });
}

export const SLIDE_SIZE = { preset: "wide", width: 13.333, height: 7.5, unit: "in" };
export const MARGIN = 0.7;
export const CONTENT_WIDTH = SLIDE_SIZE.width - MARGIN * 2;

const TYPOGRAPHY = {
  h1: "{typography.title}",
  h2: "{typography.heading}",
  h3: "{typography.heading}",
  subtitle: "{typography.subtitle}",
  body: "{typography.body}",
  metric: "{typography.metric}",
  caption: "{typography.caption}"
};

let elementCounter = 0;

// CSS color properties whose values may carry inline hex colors we want
// to resolve against DESIGN.md tokens. Limited to the small subset that
// `convertSlide` actually surfaces into manifest element styles.
const COLOR_STYLE_KEYS = ["color", "background", "backgroundColor", "fill", "borderColor", "headerFill"];

function isHexColor(value) {
  return typeof value === "string" && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

function normalizeHex(value) {
  const trimmed = value.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  const body = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return `#${body.toUpperCase()}`;
}

/**
 * Resolve inline hex colors in element styles against a DESIGN.md token
 * table. Returns the same shape as the caller passed in plus a
 * `paletteResolution` field on the returned object: {matches, unmapped,
 * paletteMatch, skipped}.
 *
 *   - On exact hex match, the inline hex is replaced with the token
 *     reference (e.g., "{colors.primary}").
 *   - On no exact match, the inline hex is kept verbatim and the
 *     unmapped entries are accumulated for the consistency report.
 *   - Strict replica mode (`isReplica === true`) short-circuits and
 *     leaves all colors untouched.
 */
export function resolveInlineStyles(elements, designTokens, options = {}) {
  const isReplica = Boolean(options.isReplica);
  const tokenLookup = isReplica ? null : buildTokenLookup(designTokens ?? {});
  const summary = { matches: [], unmapped: [], paletteMatch: 1, skipped: isReplica };

  if (!Array.isArray(elements) || elements.length === 0) {
    return { elements, paletteResolution: summary };
  }
  if (isReplica) {
    return { elements, paletteResolution: summary };
  }

  for (const element of elements) {
    const style = element?.style;
    if (!style || typeof style !== "object") continue;
    for (const key of COLOR_STYLE_KEYS) {
      const value = style[key];
      if (!isHexColor(value)) continue;
      const normalized = normalizeHex(value);
      if (!normalized) continue;
      const tokenRef = exactTokenRef(normalized, tokenLookup);
      if (tokenRef) {
        style[key] = `{${tokenRef}}`;
        summary.matches.push({
          extractedHex: normalized,
          tokenRef: `{${tokenRef}}`,
          elementId: element.id ?? null,
          origin: `style.${key}`
        });
      } else {
        summary.unmapped.push({
          extractedHex: normalized,
          elementId: element.id ?? null,
          origin: `style.${key}`
        });
      }
    }
  }

  // Use the resolver's weighted average so the consistency report gets a
  // single 0..1 score that's consistent with the image adapter's path.
  const resolved = resolveTokens(
    [
      ...summary.matches.map((m) => ({ hex: m.extractedHex, origin: m.origin })),
      ...summary.unmapped.map((m) => ({ hex: m.extractedHex, origin: m.origin }))
    ],
    designTokens
  );
  summary.paletteMatch = resolved.paletteMatch;

  return { elements, paletteResolution: summary };
}

function nextId(prefix) {
  elementCounter += 1;
  return `${prefix}-${String(elementCounter).padStart(3, "0")}`;
}

function resetIds() {
  elementCounter = 0;
}

function textContent(node) {
  return node.text.replace(/\s+/g, " ").trim();
}

function parseCoord(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function parseCoords(node) {
  const x = parseCoord(node.getAttribute("data-x"));
  const y = parseCoord(node.getAttribute("data-y"));
  const w = parseCoord(node.getAttribute("data-w"));
  const h = parseCoord(node.getAttribute("data-h"));
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

function designSystemSource(id, options = {}) {
  const fallback = `../../design-systems/${id}/DESIGN.md`;
  if (!options.packageRoot || !options.manifestDir) return fallback;
  const designPath = resolve(options.packageRoot, `design-systems/${id}/DESIGN.md`);
  const rel = relative(options.manifestDir, designPath).replace(/\\/g, "/");
  return rel.startsWith("../") ? designPath : rel;
}

function designSystemName(id) {
  const names = {
    "business-neutral": "Business Neutral",
    "warm-editorial": "Warm Editorial",
    "paper-minimal": "Paper Minimal",
    "dark-tech": "Dark Tech",
    "ai-infra": "AI Infra",
    "product-roadshow": "Product Roadshow",
    "developer-docs": "Developer Docs",
    "dashboard-data": "Dashboard Data",
    "premium-black": "Premium Black",
    "chinese-government": "Chinese Government"
  };
  return names[id] ?? "Business Neutral";
}

function textElement(id, text, box, typographyKey, color = "{colors.text}", extra = {}) {
  const { style: extraStyle, ...elementExtra } = extra;
  return {
    type: "text",
    id,
    text,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    ...elementExtra,
    style: { typography: TYPOGRAPHY[typographyKey] ?? TYPOGRAPHY.body, color, ...extraStyle }
  };
}

function shapeElement(id, box, component = "{components.content-card}") {
  return {
    type: "shape",
    id,
    shape: "roundRect",
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    style: { component }
  };
}

function shapeOverrideFromNode(node) {
  const value = String(node?.getAttribute?.("data-pptx-shape") ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "roundrect" || value === "round-rect") return "roundRect";
  return ["rect", "roundRect", "pill", "circle", "ellipse"].includes(value) ? value : null;
}

function replicaTableStyle(style = {}) {
  const tableStyle = {
    borderColor: style.borderColor ?? "{colors.border}",
    color: style.color ?? "{colors.text}",
    fill: style.backgroundColor ?? "{colors.background}",
    headerFill: style.backgroundColor ?? "{colors.surfaceAlt}",
    fontSize: style.fontSize ?? 12
  };
  const borderWidthPx = Number(style.borderWidth);
  if (Number.isFinite(borderWidthPx) && borderWidthPx > 0) {
    tableStyle.borderWidth = Math.round(borderWidthPx * 0.75 * 100) / 100;
  }
  return tableStyle;
}

function parseInlineStyle(node) {
  const style = {};
  const raw = String(node?.getAttribute?.("style") ?? "");
  for (const declaration of raw.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const key = declaration.slice(0, separator).trim().replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = declaration.slice(separator + 1).trim();
    if (key && value) style[key] = value;
  }
  return style;
}

function cssLengthToPoints(value, fallback = null) {
  const source = String(value ?? "").trim().toLowerCase();
  const number = Number.parseFloat(source);
  if (!Number.isFinite(number)) return fallback;
  if (source.endsWith("pt")) return number;
  if (source.endsWith("in")) return number * 72;
  return number * 0.75;
}

function nodeRichRuns(node, inherited = {}) {
  if (!node) return [];
  const runs = [];
  const walk = (current, parentStyle) => {
    for (const child of current.childNodes ?? []) {
      if (child.nodeType === 3) {
        const text = String(child.text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ");
        if (!text || !text.trim()) continue;
        runs.push({
          text,
          ...(parentStyle.fontFamily ? { fontFamily: parentStyle.fontFamily } : {}),
          ...(parentStyle.fontSize ? { fontSize: parentStyle.fontSize } : {}),
          ...(parentStyle.fontWeight ? { fontWeight: parentStyle.fontWeight } : {}),
          ...(parentStyle.fontStyle ? { fontStyle: parentStyle.fontStyle } : {}),
          ...(parentStyle.color ? { color: parentStyle.color } : {}),
          ...(parentStyle.decoration ? { decoration: parentStyle.decoration } : {}),
          ...(parentStyle.hyperlink ? { hyperlink: parentStyle.hyperlink } : {})
        });
      } else if (String(child.tagName ?? "").toLowerCase() === "br") {
        runs.push({ text: "\n", ...parentStyle });
      } else if (child.tagName) {
        const tagName = String(child.tagName).toLowerCase();
        if (child.hasAttribute?.("data-pptx-kind") || child.hasAttribute?.("data-pptx-type")
          || child.hasAttribute?.("data-pptx-id") || child.hasAttribute?.("data-id")) continue;
        const inline = parseInlineStyle(child);
        const style = { ...parentStyle };
        if (inline.fontFamily) style.fontFamily = inline.fontFamily.replace(/^['"]|['"]$/g, "");
        if (inline.fontSize) style.fontSize = cssLengthToPoints(inline.fontSize, style.fontSize);
        if (inline.fontWeight) style.fontWeight = Number.parseInt(inline.fontWeight, 10) || (/bold|bolder/i.test(inline.fontWeight) ? 700 : style.fontWeight);
        if (inline.fontStyle) style.fontStyle = inline.fontStyle;
        if (inline.color) style.color = inline.color;
        if (inline.textDecoration) {
          const decoration = {};
          if (/underline/i.test(inline.textDecoration)) decoration.underline = { style: "sng" };
          if (/line-through/i.test(inline.textDecoration)) decoration.strike = "sngStrike";
          style.decoration = decoration;
        }
        const href = child.getAttribute?.("href");
        if (href && /^https?:\/\//i.test(href)) style.hyperlink = { url: href };
        if (tagName === "strong" || tagName === "b") style.fontWeight = 700;
        if (tagName === "em" || tagName === "i") style.fontStyle = "italic";
        if (tagName === "u") style.decoration = { ...(style.decoration ?? {}), underline: { style: "sng" } };
        walk(child, style);
      }
    }
  };
  walk(node, inherited);
  if (runs.length > 0) {
    runs[0].text = runs[0].text.replace(/^\s+/, "");
    runs.at(-1).text = runs.at(-1).text.replace(/\s+$/, "");
  }
  return runs.filter((run) => run.text);
}

function tableCellManifest(cell, measuredCell = null, sectionType = "tbody") {
  const sourceText = measuredCell?.text ?? textContent(cell);
  const runs = measuredCell?.runs?.length ? measuredCell.runs.map((run) => ({ ...run })) : nodeRichRuns(cell);
  const sourceStyle = measuredCell?.style ?? parseInlineStyle(cell);
  const colspan = Math.max(1, Number(measuredCell?.colspan ?? cell?.getAttribute?.("colspan") ?? 1) || 1);
  const rowspan = Math.max(1, Number(measuredCell?.rowspan ?? cell?.getAttribute?.("rowspan") ?? 1) || 1);
  const href = measuredCell?.href ?? cell?.getAttribute?.("href") ?? cell?.querySelector?.("a[href]")?.getAttribute?.("href");
  const hyperlink = /^https?:\/\//i.test(String(href ?? ""))
    ? { url: href, ...(measuredCell?.hyperlinkTooltip ? { tooltip: measuredCell.hyperlinkTooltip } : {}) }
    : null;
  const style = {
    ...sourceStyle,
    ...(sectionType === "thead" && sourceStyle.backgroundColor === undefined ? { backgroundColor: "{colors.surfaceAlt}" } : {})
  };
  return {
    text: sourceText,
    ...(runs.length > 0 ? { runs } : {}),
    ...(colspan > 1 ? { colspan } : {}),
    ...(rowspan > 1 ? { rowspan } : {}),
    ...(hyperlink ? { hyperlink } : {}),
    style,
    ...(measuredCell?.inches ? { box: { ...measuredCell.inches } } : {})
  };
}

function tableSectionsFromNode(tableNode, measuredTable = null) {
  const measuredSections = Array.isArray(measuredTable?.sections) ? measuredTable.sections : [];
  const sections = [];
  const children = (tableNode?.childNodes ?? []).filter((child) => child?.tagName);
  for (const child of children) {
    const type = String(child.tagName ?? "").toLowerCase();
    if (!["thead", "tbody", "tfoot"].includes(type)) continue;
    const measured = measuredSections.find((section) => section.type === type && !sections.some((entry) => entry.type === type));
    const rows = [...(child.childNodes ?? [])].filter((row) => String(row.tagName ?? "").toLowerCase() === "tr");
    sections.push({
      type,
      rows: rows.map((row, rowIndex) => {
        const measuredRow = measured?.rows?.[rowIndex];
        const cells = [...(row.childNodes ?? [])].filter((cell) => ["th", "td"].includes(String(cell.tagName ?? "").toLowerCase()));
        return {
          ...(measuredRow?.inches ? { box: { ...measuredRow.inches } } : {}),
          cells: cells.map((cell, cellIndex) => tableCellManifest(cell, measuredRow?.cells?.[cellIndex], type))
        };
      })
    });
  }
  const directRows = [...children].filter((row) => String(row.tagName ?? "").toLowerCase() === "tr");
  if (directRows.length > 0) {
    const measured = measuredSections.find((section) => section.type === "tbody");
    sections.push({
      type: "tbody",
      rows: directRows.map((row, rowIndex) => {
        const measuredRow = measured?.rows?.[rowIndex];
        const cells = [...(row.childNodes ?? [])].filter((cell) => ["th", "td"].includes(String(cell.tagName ?? "").toLowerCase()));
        return {
          ...(measuredRow?.inches ? { box: { ...measuredRow.inches } } : {}),
          cells: cells.map((cell, cellIndex) => tableCellManifest(cell, measuredRow?.cells?.[cellIndex], "tbody"))
        };
      })
    });
  }
  return sections;
}

function tableElement(id, tableNode, box, measuredStyle = null, measuredMeasurement = null) {
  const measuredTable = measuredMeasurement?.table ?? (measuredStyle?.sections ? measuredStyle : null);
  const sections = tableSectionsFromNode(tableNode, measuredTable);
  const headers = [];
  const rows = [];
  const richRows = [];
  for (const section of sections) {
    for (const row of section.rows) {
      const cells = row.cells ?? [];
      richRows.push({ section: section.type, cells });
      if (section.type === "thead") headers.push(...cells.map((cell) => cell.text));
      else if (section.type === "tbody" || section.type === "tfoot") rows.push(cells.map((cell) => cell.text));
    }
  }
  if (headers.length === 0 && rows.length > 0) headers.push(...rows.shift());
  const element = {
    type: "table",
    id,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    rows,
    sections,
    richRows,
    style: measuredStyle ? replicaTableStyle(measuredStyle) : replicaTableStyle()
  };
  if (headers.length > 0) element.headers = headers;
  const captionNode = tableNode?.querySelector?.("caption");
  const measuredCaption = measuredTable?.caption;
  if (captionNode || measuredCaption?.text) {
    element.caption = measuredCaption?.text ?? textContent(captionNode);
    const captionRuns = measuredCaption?.runs?.length ? measuredCaption.runs : nodeRichRuns(captionNode);
    if (captionRuns?.length > 0) element.captionRuns = captionRuns;
    if (measuredCaption?.inches) element.captionBox = { ...measuredCaption.inches };
  }
  const colW = measuredTable?.columns ?? measuredTable?.colW;
  const rowH = measuredTable?.rowHeights ?? measuredTable?.rowH;
  if (Array.isArray(colW) && colW.length > 0) element.colW = colW.map(Number).filter(Number.isFinite);
  if (Array.isArray(rowH) && rowH.length > 0) element.rowH = rowH.map(Number).filter(Number.isFinite);
  return element;
}

function lineStyleFromNode(node) {
  if (!node) return { color: "{colors.border}", width: 1.5 };
  const inline = node.getAttribute?.("style") ?? "";
  const styleValue = (name) => {
    const match = inline.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"));
    return match?.[1]?.trim() ?? null;
  };
  const markerStart = node.getAttribute?.("marker-start") ?? styleValue("marker-start");
  const markerEnd = node.getAttribute?.("marker-end") ?? styleValue("marker-end");
  const stroke = node.getAttribute?.("stroke") ?? styleValue("stroke");
  const strokeWidth = Number(node.getAttribute?.("stroke-width") ?? styleValue("stroke-width"));
  const dash = node.getAttribute?.("stroke-dasharray") ?? styleValue("stroke-dasharray");
  return {
    color: stroke && stroke !== "none" ? stroke : "{colors.border}",
    width: Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 1.5,
    ...(dash && dash !== "none" ? { dash: "dash" } : {}),
    ...(markerStart && markerStart !== "none" ? { beginArrowType: "triangle" } : {}),
    ...(markerEnd && markerEnd !== "none" ? { endArrowType: "triangle" } : {})
  };
}

function lineElement(id, box, preserveHeight = false, node = null) {
  const sourceId = node?.getAttribute?.("data-source-id");
  const targetId = node?.getAttribute?.("data-target-id");
  const isConnector = Boolean(sourceId || targetId || node?.getAttribute?.("data-connector") !== undefined);
  return {
    type: "line",
    id,
    ...(isConnector ? { role: "connector" } : {}),
    x: box.x,
    y: box.y,
    w: box.w,
    h: preserveHeight ? box.h : 0.02,
    style: lineStyleFromNode(node),
    ...(sourceId || targetId ? {
      connector: {
        sourceId: sourceId ?? "",
        targetId: targetId ?? "",
        sourceAnchor: node?.getAttribute?.("data-source-anchor") ?? "auto",
        targetAnchor: node?.getAttribute?.("data-target-anchor") ?? "auto",
        route: node?.getAttribute?.("data-connector-route") ?? "straight"
      }
    } : {})
  };
}

function measuredBox(measurement) {
  const transform = measurement?.style?.transformData;
  if (transform?.supported !== false && measurement?.transformBox
    && ["x", "y", "w", "h"].every((key) => Number.isFinite(Number(measurement.transformBox[key])))) {
    return {
      x: Number(measurement.transformBox.x),
      y: Number(measurement.transformBox.y),
      w: Number(measurement.transformBox.w),
      h: Number(measurement.transformBox.h)
    };
  }
  return {
    x: measurement.x,
    y: measurement.y,
    w: measurement.w,
    h: measurement.h
  };
}

function cssStyle(measurement) {
  return measurement?.style && typeof measurement.style === "object" ? measurement.style : {};
}

function replicaTextMargin(style) {
  const values = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map((value) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null
  );
  return values.every((value) => value !== null) && values.some((value) => value > 0) ? values : 0.02;
}

function applyTextTransform(text, transform) {
  const value = String(text ?? "");
  if (transform === "uppercase") return value.toUpperCase();
  if (transform === "lowercase") return value.toLowerCase();
  if (transform === "capitalize") {
    return value.replace(/\b(\p{L})/gu, (match) => match.toUpperCase());
  }
  return value;
}

function replicaTextContent(measurement, style) {
  const source = typeof measurement.visibleText === "string" && measurement.visibleText ? measurement.visibleText : (measurement.text ?? "");
  return applyTextTransform(source, style.textTransform);
}

function replicaTextDecoration(style) {
  const line = typeof style.textDecorationLine === "string" ? style.textDecorationLine : "";
  const decoration = {};
  if (/\bunderline\b/.test(line)) decoration.underline = { style: "sng" };
  if (/\bline-through\b/.test(line)) decoration.strike = "sngStrike";
  return decoration;
}

function replicaTextSmallCaps(style) {
  return ["small-caps", "all-small-caps"].includes(String(style.fontVariantCaps ?? "").trim().toLowerCase());
}

function replicaTextOverflow(style) {
  const overflow = String(style.textOverflow ?? "").trim().toLowerCase();
  const whiteSpace = String(style.whiteSpace ?? "").trim().toLowerCase();
  const overflowX = String(style.overflowX ?? "").trim().toLowerCase();
  return overflow === "ellipsis" && whiteSpace === "nowrap" && ["hidden", "clip"].includes(overflowX) ? "ellipsis" : undefined;
}

function replicaTextAlign(style) {
  const textAlign = String(style.textAlign ?? "").trim().toLowerCase();
  if (["center", "left", "right", "justify"].includes(textAlign)) return textAlign;
  const direction = String(style.direction ?? "ltr").trim().toLowerCase();
  if (textAlign === "start") return direction === "rtl" ? "right" : "left";
  if (textAlign === "end") return direction === "rtl" ? "left" : "right";
  if (style.display === "flex" && style.justifyContent === "center") return "center";
  if (style.display === "flex" && style.justifyContent === "flex-end") return "right";
  return "left";
}

function replicaTextIndent(style) {
  const value = Number(style.textIndent);
  return Number.isFinite(value) && Math.abs(value) >= 0.01 ? Math.round((value / 96) * 1000) / 1000 : undefined;
}

function replicaTextStroke(style) {
  const widthPx = Number(style.webkitTextStrokeWidth);
  if (!Number.isFinite(widthPx) || widthPx <= 0) return undefined;
  const color = style.webkitTextStrokeColor ?? style.color;
  if (!color) return undefined;
  const stroke = {
    color,
    width: Math.round(widthPx * 0.75 * 100) / 100
  };
  const transparency = cssCombinedTransparency(style, "webkitTextStrokeTransparency");
  if (transparency !== null) stroke.transparency = transparency;
  return stroke;
}

function replicaTextFillColor(style) {
  return style.webkitTextFillColor ?? style.color ?? "{colors.text}";
}

function replicaTextDirection(style) {
  const writingMode = String(style.writingMode ?? "").trim().toLowerCase();
  return writingMode.startsWith("vertical-") || writingMode === "sideways-rl" || writingMode === "sideways-lr" ? "vertical" : undefined;
}

function replicaTextRtl(style) {
  return String(style.direction ?? "").trim().toLowerCase() === "rtl" || undefined;
}

function replicaTextValign(style) {
  const verticalAlign = String(style.verticalAlign ?? "").trim().toLowerCase();
  if (["middle", "center"].includes(verticalAlign)) return "middle";
  if (["bottom", "text-bottom"].includes(verticalAlign)) return "bottom";
  if (style.display === "flex" && style.alignItems === "center") return "middle";
  if (style.display === "flex" && style.alignItems === "flex-end") return "bottom";
  return "top";
}

function replicaRotate(style) {
  const value = Number(style.rotate ?? style.rotation);
  if (!Number.isFinite(value) || Math.abs(value) <= 0.01) return null;
  return Math.round(value * 100) / 100;
}

function applyReplicaRotation(element, style, measurement = null) {
  const transformData = style?.transformData;
  if (transformData && typeof transformData === "object") {
    // Keep the complete browser matrix/origin in the manifest for audit and
    // downstream consumers.  Native PowerPoint geometry can express the
    // orthogonal 2D subset; unsupported shear/3D transforms are routed to the
    // localized fallback gate instead of being silently flattened.
    element.transform = {
      ...transformData,
      ...(Array.isArray(transformData.matrix) ? { matrix: [...transformData.matrix] } : {}),
      ...(transformData.transformOrigin && typeof transformData.transformOrigin === "object"
        ? { transformOrigin: { ...transformData.transformOrigin } }
        : {}),
      ...(measurement?.layoutBox && measurement?.transformBox ? {
        geometry: {
          layoutBox: { ...measurement.layoutBox },
          transformBox: { ...measurement.transformBox },
          renderedBounds: {
            x: Number(measurement.x),
            y: Number(measurement.y),
            w: Number(measurement.w),
            h: Number(measurement.h)
          }
        }
      } : {})
    };
    if (transformData.supported !== false) {
      const rotate = Number(transformData.rotate);
      if (Number.isFinite(rotate) && Math.abs(rotate) > 0.01) element.rotate = Math.round(rotate * 100) / 100;
      if (transformData.flipH) element.flipH = true;
      if (transformData.flipV) element.flipV = true;
    }
  }
  const rotate = replicaRotate(style);
  if (rotate !== null && element.rotate === undefined) element.rotate = rotate;
  return element;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function cssCombinedTransparency(style, ...transparencyKeys) {
  let alpha = 1;
  // Measurement computes the product of all ancestor opacities. Prefer that
  // value when present so child paint layers do not double-count the local
  // opacity; legacy measurement documents continue to use style.opacity.
  const opacity = Number(style.effectiveOpacity ?? style.opacity);
  if (Number.isFinite(opacity)) alpha *= clamp01(opacity);
  for (const key of transparencyKeys) {
    const transparency = Number(style[key]);
    if (Number.isFinite(transparency)) alpha *= 1 - clamp01(transparency / 100);
  }
  const result = Math.round((1 - alpha) * 100);
  return result > 0 ? result : null;
}

function objectPositionValue(value, axis, unitScale) {
  const token = String(value ?? "").trim().toLowerCase();
  const start = axis === "x" ? "left" : "top";
  const end = axis === "x" ? "right" : "bottom";
  if (!token || token === "center") return { percent: 0.5, length: 0 };
  if (token === start) return { percent: 0, length: 0 };
  if (token === end) return { percent: 1, length: 0 };
  const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (percent) return { percent: Number(percent[1]) / 100, length: 0 };
  const px = token.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (px) return { percent: 0, length: Number(px[1]) * unitScale };
  const calc = token.match(/^calc\(\s*(-?\d+(?:\.\d+)?)%\s*([+-])\s*(-?\d+(?:\.\d+)?)px\s*\)$/);
  if (calc) {
    return {
      percent: Number(calc[1]) / 100,
      length: Number(calc[3]) * unitScale * (calc[2] === "+" ? 1 : -1)
    };
  }
  return null;
}

function objectPositionEdgeValue(edge, offset, axis, unitScale) {
  const parsed = objectPositionValue(offset, axis, unitScale);
  if (!parsed) return null;
  const start = axis === "x" ? "left" : "top";
  if (edge === start) return parsed;
  return { percent: 1 - parsed.percent, length: -parsed.length };
}

function objectPositionAxisForEdge(value) {
  if (["left", "right"].includes(value)) return "x";
  if (["top", "bottom"].includes(value)) return "y";
  return null;
}

export function parseObjectPosition(value, unitScale = {}) {
  const scale = {
    x: Number.isFinite(Number(unitScale.x)) ? Number(unitScale.x) : 1 / 96,
    y: Number.isFinite(Number(unitScale.y)) ? Number(unitScale.y) : 1 / 96
  };
  const parts = splitCssWhitespaceList(value ?? "50% 50%");
  const centered = () => ({ percent: 0.5, length: 0 });
  if (parts.length === 0) return { x: centered(), y: centered() };

  if (parts.length === 1) {
    const axis = objectPositionAxisForEdge(parts[0]) ?? "x";
    const parsed = objectPositionValue(parts[0], axis, scale[axis]) ?? centered();
    return axis === "x" ? { x: parsed, y: centered() } : { x: centered(), y: parsed };
  }

  if (parts.length === 2 && objectPositionAxisForEdge(parts[0])
    && !objectPositionAxisForEdge(parts[1]) && parts[1] !== "center") {
    const axis = objectPositionAxisForEdge(parts[0]);
    const parsed = objectPositionEdgeValue(parts[0], parts[1], axis, scale[axis]) ?? centered();
    return axis === "x" ? { x: parsed, y: centered() } : { x: centered(), y: parsed };
  }

  if (parts.length === 2) {
    const firstAxis = objectPositionAxisForEdge(parts[0]);
    const secondAxis = objectPositionAxisForEdge(parts[1]);
    if (firstAxis && secondAxis && firstAxis !== secondAxis) {
      return {
        x: objectPositionValue(firstAxis === "x" ? parts[0] : parts[1], "x", scale.x) ?? centered(),
        y: objectPositionValue(firstAxis === "y" ? parts[0] : parts[1], "y", scale.y) ?? centered()
      };
    }
    if (firstAxis && parts[1] === "center") {
      const parsed = objectPositionValue(parts[0], firstAxis, scale[firstAxis]) ?? centered();
      return firstAxis === "x" ? { x: parsed, y: centered() } : { x: centered(), y: parsed };
    }
    if (parts[0] === "center" && secondAxis) {
      const parsed = objectPositionValue(parts[1], secondAxis, scale[secondAxis]) ?? centered();
      return secondAxis === "x" ? { x: parsed, y: centered() } : { x: centered(), y: parsed };
    }
    return {
      x: objectPositionValue(parts[0], "x", scale.x) ?? centered(),
      y: objectPositionValue(parts[1], "y", scale.y) ?? centered()
    };
  }

  const resolved = { x: null, y: null };
  const singles = [];
  for (let index = 0; index < parts.length; index += 1) {
    const edge = parts[index];
    const axis = objectPositionAxisForEdge(edge);
    const next = parts[index + 1];
    if (axis && next && !objectPositionAxisForEdge(next) && next !== "center") {
      resolved[axis] = objectPositionEdgeValue(edge, next, axis, scale[axis]);
      index += 1;
    } else {
      singles.push(edge);
    }
  }
  for (const token of singles) {
    const axis = objectPositionAxisForEdge(token)
      ?? (resolved.x === null ? "x" : resolved.y === null ? "y" : null);
    if (axis && resolved[axis] === null) resolved[axis] = objectPositionValue(token, axis, scale[axis]);
  }
  return { x: resolved.x ?? centered(), y: resolved.y ?? centered() };
}

export function coverImageSizingForBox(sourceWidth, sourceHeight, box, objectPosition, unitScale = {}) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
  const imageRatio = sourceHeight / sourceWidth;
  const boxRatio = box.h / box.w;
  const position = parseObjectPosition(objectPosition, unitScale);
  let sourceW = box.w;
  let sourceH = box.h;
  let x = 0;
  let y = 0;
  if (boxRatio > imageRatio) {
    sourceH = box.h;
    sourceW = box.h / imageRatio;
  } else if (boxRatio < imageRatio) {
    sourceW = box.w;
    sourceH = box.w * imageRatio;
  }
  x = Math.max(0, sourceW - box.w) * position.x.percent - position.x.length;
  y = Math.max(0, sourceH - box.h) * position.y.percent - position.y.length;
  const sizing = {
    type: Math.abs(x) > 0.001 || Math.abs(y) > 0.001 ? "crop" : "cover",
    w: box.w,
    h: box.h,
    sourceW: roundInches(sourceW),
    sourceH: roundInches(sourceH)
  };
  if (sizing.type === "crop") {
    sizing.x = roundInches(x);
    sizing.y = roundInches(y);
  }
  return sizing;
}

function replicaCoverImageSizing(measurement, box, style) {
  return coverImageSizingForBox(
    Number(measurement.naturalWidth),
    Number(measurement.naturalHeight),
    box,
    style.objectPosition,
    measurement.pixelScale
  );
}

function replicaImageSizing(measurement, style, box) {
  if (!["cover", "contain"].includes(style.objectFit)) return null;
  if (style.objectFit === "cover") {
    const cover = replicaCoverImageSizing(measurement, box, style);
    if (cover) return cover;
  }
  return {
    type: style.objectFit,
    w: box.w,
    h: box.h
  };
}

function replicaImageElement(measurement, box) {
  const style = cssStyle(measurement);
  const element = applyReplicaRotation({ type: "image", id: measurement.id, src: measurement.src, ...box }, style, measurement);
  const hyperlink = measurementHyperlink(measurement);
  if (hyperlink) element.hyperlink = hyperlink;
  const shapeKind = replicaShapeKind(measurement);
  if (shapeKind === "ellipse") element.rounding = true;
  else if (shapeKind === "roundRect") element.imageShape = "roundRect";
  const transparency = cssCombinedTransparency(style);
  if (transparency !== null) element.transparency = transparency;
  const shadow = parseCssDropShadowFilter(measurement.replica?.filter) ?? parseCssBoxShadow(style.boxShadow);
  if (shadow) element.style = { shadow };
  const sizing = replicaImageSizing(measurement, style, box);
  if (sizing) element.sizing = sizing;
  return element;
}

function replicaImageBorderElement(measurement) {
  const style = cssStyle(measurement);
  if (!(Number(style.borderWidth ?? 0) > 0)) return null;
  const borderStyle = style.borderStyle ?? "solid";
  if (borderStyle === "none" || borderStyle === "hidden") return null;
  return replicaShapeElement(`${measurement.id}-border`, {
    ...measurement,
    style: {
      ...style,
      backgroundColor: null,
      boxShadow: null
    }
  });
}

function replicaImageLayerElements(measurement, box) {
  const elements = [replicaImageElement(measurement, box)];
  const border = replicaImageBorderElement(measurement);
  if (border) elements.push(border);
  const outline = replicaOutlineElement(measurement.id, measurement);
  if (outline) elements.push(outline);
  return elements;
}

function hasCssOutline(style) {
  const width = Number(style.outlineWidth ?? 0) || 0;
  const outlineStyle = style.outlineStyle ?? "none";
  return width > 0 && outlineStyle !== "none" && outlineStyle !== "hidden";
}

function replicaOutlineElement(id, measurement) {
  const style = cssStyle(measurement);
  if (!hasCssOutline(style)) return null;
  const widthPx = Number(style.outlineWidth ?? 0) || 0;
  const offsetPx = Number(style.outlineOffset ?? 0) || 0;
  const expansion = Math.max(0, (offsetPx + widthPx / 2) / 96);
  const box = measuredBox(measurement);
  const outlineStyle = {
    ...style,
    backgroundColor: null,
    borderColor: style.outlineColor ?? style.borderColor ?? "{colors.border}",
    borderTransparency: style.outlineTransparency ?? style.borderTransparency,
    borderWidth: widthPx,
    borderStyle: style.outlineStyle,
    boxShadow: null
  };
  return replicaShapeElement(`${id}-outline`, {
    ...measurement,
    x: roundInches(box.x - expansion),
    y: roundInches(box.y - expansion),
    w: roundInches(box.w + expansion * 2),
    h: roundInches(box.h + expansion * 2),
    style: outlineStyle
  });
}

function parseCssBackgroundImageUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^url\(/i.test(trimmed) || splitCssCommaList(trimmed).length !== 1) return null;
  const match = trimmed.match(/^url\((['"]?)(.*?)\1\)$/i);
  if (!match) return null;
  const raw = match[2].trim();
  if (!raw || /^data:/i.test(raw)) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

function replicaBackgroundImageSizing(style, box) {
  return replicaBackgroundImageSizingForSrc(null, style, box);
}

function localImageDimensions(src) {
  if (!src || /^https?:\/\//i.test(src)) return null;
  try {
    const dimensions = imageSize(src);
    const width = Number(dimensions.width);
    const height = Number(dimensions.height);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function cssBackgroundSizeLength(value, axisInches) {
  const token = String(value ?? "").trim().toLowerCase();
  const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (percent) return Math.max(0, axisInches * (Number(percent[1]) / 100));
  const px = token.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (px) return Math.max(0, Number(px[1]) / 96);
  return null;
}

function cssBackgroundPositionLength(value, remainingInches) {
  const token = String(value ?? "").trim().toLowerCase();
  const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (percent) return remainingInches * (Number(percent[1]) / 100);
  const px = token.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (px) return Number(px[1]) / 96;
  const calc = token.match(/^calc\(\s*(-?\d+(?:\.\d+)?)%\s*([+-])\s*(-?\d+(?:\.\d+)?)px\s*\)$/);
  if (calc) {
    const percentOffset = remainingInches * (Number(calc[1]) / 100);
    const pixelOffset = Number(calc[3]) / 96;
    return calc[2] === "+" ? percentOffset + pixelOffset : percentOffset - pixelOffset;
  }
  return null;
}

function cssBackgroundPositionAxisOffset(token, axis, remainingInches) {
  const value = String(token ?? "").trim().toLowerCase();
  if (!value || value === "center") return remainingInches / 2;
  if ((axis === "x" && value === "left") || (axis === "y" && value === "top")) return 0;
  if ((axis === "x" && value === "right") || (axis === "y" && value === "bottom")) return remainingInches;
  return cssBackgroundPositionLength(value, remainingInches);
}

function cssBackgroundEdgeOffset(edge, offsetToken, axis, remainingInches) {
  const value = cssBackgroundPositionLength(offsetToken, remainingInches);
  if (value === null) return null;
  if ((axis === "x" && edge === "left") || (axis === "y" && edge === "top")) return value;
  if ((axis === "x" && edge === "right") || (axis === "y" && edge === "bottom")) return remainingInches - value;
  return null;
}

function backgroundPositionOffset(value, box, imageBox) {
  const remainingX = Math.max(0, box.w - imageBox.w);
  const remainingY = Math.max(0, box.h - imageBox.h);
  const parts = splitCssWhitespaceList(value ?? "50% 50%");
  let x = remainingX / 2;
  let y = remainingY / 2;

  if (parts.length === 1) {
    if (["top", "bottom"].includes(parts[0])) {
      y = cssBackgroundPositionAxisOffset(parts[0], "y", remainingY);
    } else {
      x = cssBackgroundPositionAxisOffset(parts[0], "x", remainingX);
    }
  } else if (parts.length === 2) {
    const [first, second] = parts;
    if (["top", "bottom"].includes(first) && ["left", "right"].includes(second)) {
      y = cssBackgroundPositionAxisOffset(first, "y", remainingY);
      x = cssBackgroundPositionAxisOffset(second, "x", remainingX);
    } else {
      x = cssBackgroundPositionAxisOffset(first, "x", remainingX);
      y = cssBackgroundPositionAxisOffset(second, "y", remainingY);
    }
  } else if (parts.length === 4) {
    const [firstEdge, firstOffset, secondEdge, secondOffset] = parts;
    const firstAxis = ["left", "right"].includes(firstEdge) ? "x" : ["top", "bottom"].includes(firstEdge) ? "y" : null;
    const secondAxis = ["left", "right"].includes(secondEdge) ? "x" : ["top", "bottom"].includes(secondEdge) ? "y" : null;
    if (firstAxis && secondAxis && firstAxis !== secondAxis) {
      const first = cssBackgroundEdgeOffset(firstEdge, firstOffset, firstAxis, firstAxis === "x" ? remainingX : remainingY);
      const second = cssBackgroundEdgeOffset(secondEdge, secondOffset, secondAxis, secondAxis === "x" ? remainingX : remainingY);
      if (first === null || second === null) return null;
      if (firstAxis === "x") {
        x = first;
        y = second;
      } else {
        y = first;
        x = second;
      }
    } else {
      return null;
    }
  } else if (parts.length > 0) {
    return null;
  }

  if (![x, y].every((offset) => Number.isFinite(offset) && offset >= 0)) return null;
  return { x: roundInches(x), y: roundInches(y) };
}

function splitCssWhitespaceList(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of String(value).trim().toLowerCase()) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function placedBackgroundImageBox(style, box, w, h) {
  const position = backgroundPositionOffset(style.backgroundPosition, box, { w, h });
  if (!position) return null;
  return {
    x: roundInches(box.x + position.x),
    y: roundInches(box.y + position.y),
    w: roundInches(w),
    h: roundInches(h)
  };
}

function explicitBackgroundImageBox(src, style, box) {
  const size = String(style.backgroundSize ?? "").trim().toLowerCase();
  if (!size || ["auto", "cover", "contain", "100% 100%"].includes(size)) return null;
  const parts = size.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const [widthToken, heightToken = "auto"] = parts;
  const dimensions = widthToken === "auto" || heightToken === "auto" ? localImageDimensions(src) : null;
  const ratio = dimensions ? dimensions.height / dimensions.width : null;
  let w = widthToken === "auto" ? null : cssBackgroundSizeLength(widthToken, box.w);
  let h = heightToken === "auto" ? null : cssBackgroundSizeLength(heightToken, box.h);
  if (w === null && h !== null && ratio) w = h / ratio;
  if (h === null && w !== null && ratio) h = w * ratio;
  if (!(w > 0 && h > 0)) return null;
  if (w > box.w || h > box.h) return null;
  return placedBackgroundImageBox(style, box, w, h);
}

function intrinsicBackgroundImageBox(src, style, box) {
  const size = String(style.backgroundSize ?? "").trim().toLowerCase();
  if (!["auto", "auto auto"].includes(size)) return null;
  const repeat = String(style.backgroundRepeat ?? "repeat").trim().toLowerCase();
  if (repeat && repeat !== "no-repeat") return null;
  const dimensions = localImageDimensions(src);
  if (!dimensions) return null;
  const w = dimensions.width / 96;
  const h = dimensions.height / 96;
  if (!(w > 0 && h > 0) || w > box.w || h > box.h) return null;
  return placedBackgroundImageBox(style, box, w, h);
}

function normalizedBackgroundRepeat(style) {
  return String(style.backgroundRepeat ?? "repeat").trim().toLowerCase();
}

function nearlyEqual(a, b, tolerance = 0.002) {
  return Math.abs(a - b) <= tolerance;
}

function repeatBackgroundImagePlanForSrc(src, style, box) {
  const repeat = normalizedBackgroundRepeat(style);
  if (!["repeat-x", "repeat-y", "repeat"].includes(repeat)) return null;
  const tileBox = explicitBackgroundImageBox(src, style, box) ?? intrinsicBackgroundImageBox(src, { ...style, backgroundRepeat: "no-repeat" }, box);
  if (!tileBox || !(tileBox.w > 0 && tileBox.h > 0)) return null;
  const repeatsX = repeat === "repeat-x" || repeat === "repeat";
  const repeatsY = repeat === "repeat-y" || repeat === "repeat";
  if (repeatsX && !nearlyEqual(tileBox.x, box.x)) return null;
  if (repeatsY && !nearlyEqual(tileBox.y, box.y)) return null;
  if (!repeatsX && (tileBox.x < box.x || tileBox.x + tileBox.w > box.x + box.w + 0.002)) return null;
  if (!repeatsY && (tileBox.y < box.y || tileBox.y + tileBox.h > box.y + box.h + 0.002)) return null;
  const countX = repeatsX ? box.w / tileBox.w : 1;
  const countY = repeatsY ? box.h / tileBox.h : 1;
  const roundedCountX = Math.round(countX);
  const roundedCountY = Math.round(countY);
  const totalTiles = roundedCountX * roundedCountY;
  if (
    !nearlyEqual(countX, roundedCountX) ||
    !nearlyEqual(countY, roundedCountY) ||
    roundedCountX < 1 ||
    roundedCountY < 1 ||
    totalTiles > 24
  ) return null;
  const boxes = [];
  for (let row = 0; row < roundedCountY; row += 1) {
    for (let col = 0; col < roundedCountX; col += 1) {
      boxes.push({
        x: roundInches((repeatsX ? box.x : tileBox.x) + tileBox.w * col),
        y: roundInches((repeatsY ? box.y : tileBox.y) + tileBox.h * row),
        w: tileBox.w,
        h: tileBox.h
      });
    }
  }
  return {
    boxes,
    sizing: null
  };
}

function replicaBackgroundImagePlanForSrc(src, style, box) {
  const repeat = normalizedBackgroundRepeat(style);
  if (repeat && repeat !== "no-repeat") return repeatBackgroundImagePlanForSrc(src, style, box);
  const explicitBox = explicitBackgroundImageBox(src, style, box);
  if (explicitBox) return { box: explicitBox, sizing: null };
  const intrinsicBox = intrinsicBackgroundImageBox(src, style, box);
  if (intrinsicBox) return { box: intrinsicBox, sizing: null };
  const sizing = replicaBackgroundImageSizingForSrc(src, style, box);
  return sizing ? { box, sizing } : null;
}

function replicaBackgroundImageSizingForSrc(src, style, box) {
  const size = String(style.backgroundSize ?? "").trim().toLowerCase();
  const repeat = String(style.backgroundRepeat ?? "repeat").trim().toLowerCase();
  if (repeat && repeat !== "no-repeat") return null;
  if (size === "100% 100%") return { type: "stretch" };
  if (!["cover", "contain"].includes(size)) return null;
  if (size === "cover") {
    const dimensions = localImageDimensions(src);
    const cover = dimensions ? coverImageSizingForBox(dimensions.width, dimensions.height, box, style.backgroundPosition) : null;
    if (cover) return cover;
  }
  return {
    type: size,
    w: box.w,
    h: box.h
  };
}

function replicaBackgroundImageElements(id, measurement) {
  const style = cssStyle(measurement);
  const src = parseCssBackgroundImageUrl(style.backgroundImage);
  if (!src) return [];
  const box = measuredBox(measurement);
  const plan = replicaBackgroundImagePlanForSrc(src, style, box);
  if (!plan) return [];
  const boxes = plan.boxes ?? [plan.box];
  return boxes.map((imageBox, index) => {
    const element = {
      type: "image",
      id: boxes.length === 1 ? `${id}-background-image` : `${id}-background-image-${index + 1}`,
      src,
      ...imageBox
      };
      const shapeKind = replicaShapeKind(measurement);
      if (shapeKind === "ellipse") element.rounding = true;
      else if (shapeKind === "roundRect") element.imageShape = "roundRect";
      if (plan.sizing && plan.sizing.type !== "stretch") element.sizing = plan.sizing;
      return applyReplicaRotation(element, style, measurement);
    });
}

function splitCssCommaList(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of String(value)) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizeShadowColor(value) {
  const hex = normalizeHex(value);
  return hex ? hex.slice(1) : null;
}

function parseShadowColor(value) {
  const raw = String(value);
  const rgba = raw.match(/rgba?\(([^)]+)\)/i);
  if (rgba) {
    const parts = rgba[1].split(",").map((part) => part.trim());
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
    if (channels.some((channel) => !Number.isFinite(channel))) return null;
    const color = channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("").toUpperCase();
    const alpha = Number.parseFloat(parts[3] ?? "1");
    return {
      color,
      opacity: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
      source: rgba[0]
    };
  }
  const hex = raw.match(/#[0-9a-fA-F]{6}\b|(?<![-\w])\b[0-9a-fA-F]{6}\b(?![-\w])/);
  if (!hex) return null;
  return { color: normalizeShadowColor(hex[0]), opacity: 1, source: hex[0] };
}

function parseCssLinearGradient(value) {
  if (typeof value !== "string" || !/^linear-gradient\(/i.test(value.trim())) return null;
  const body = value.trim().replace(/^linear-gradient\(/i, "").replace(/\)\s*$/, "");
  const parts = splitCssCommaList(body);
  if (parts.length < 2) return null;
  const firstStop = parseShadowColor(parts[0])
    || /^transparent(?:\s+\d+(?:\.\d+)?%)?$/i.test(String(parts[0]).trim());
  const angle = firstStop ? 180 : parseCssGradientAngle(parts[0]);
  if (angle === null) return null;
  const stops = parseCssGradientStops(firstStop ? parts : parts.slice(1));
  if (!stops) return null;
  return {
    type: "linear",
    angle: cssGradientAngleToPowerPoint(angle),
    stops
  };
}

// CSS angles use 0deg for bottom-to-top and 90deg for left-to-right.
// DrawingML uses 0deg for left-to-right, so preserve the rendered direction
// by rotating the CSS angle into PowerPoint's coordinate system.
export function cssGradientAngleToPowerPoint(angle) {
  const numeric = Number(angle);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((((numeric - 90) % 360) + 360) % 360 * 100) / 100;
}

function parseCssGradientStops(stopParts) {
  const stopCount = stopParts.length;
  if (stopCount < 2) return null;
  const stops = [];
  let previousColor = "FFFFFF";
  for (const [index, part] of stopParts.entries()) {
    const transparent = String(part).trim().match(/^transparent(?:\s+(\d+(?:\.\d+)?)%)?$/i);
    const parsedColor = transparent ? null : parseShadowColor(part);
    if (!transparent && !parsedColor?.color) return null;
    const color = parsedColor?.color ?? previousColor;
    const positionSource = transparent
      ? transparent[1] ? `${transparent[1]}%` : ""
      : part.replace(parsedColor.source, "").trim();
    const positionMatch = positionSource.match(/^(\d+(?:\.\d+)?)%$/);
    const stop = {
      color: `#${color}`,
      position: positionMatch ? Number(positionMatch[1]) : Math.round((index / Math.max(1, stopCount - 1)) * 10000) / 100
    };
    const transparency = transparent
      ? 100
      : Math.round((1 - Number(parsedColor.opacity ?? 1)) * 10000) / 100;
    if (transparency > 0) stop.transparency = transparency;
    stops.push(stop);
    previousColor = color;
  }
  if (stops.some((stop) => stop.position < 0 || stop.position > 100)) return null;
  return stops;
}

function parseCssRadialGradientDescriptor(value) {
  const source = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!source || source === "at center") return { shape: "ellipse", position: "center", xPercent: 50, yPercent: 50 };
  const match = source.match(/^(?:(circle|ellipse)\s*)?(?:at\s+(.+))?$/);
  if (!match) return null;
  const shape = match[1] ?? "ellipse";
  const position = match[2] ?? "center";
  if (["center", "50% 50%", "center center"].includes(position)) {
    return { shape, position: "center", xPercent: 50, yPercent: 50 };
  }
  const percent = position.match(/^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!percent) return null;
  const xPercent = Number(percent[1]);
  const yPercent = Number(percent[2]);
  if (xPercent < 0 || xPercent > 100 || yPercent < 0 || yPercent > 100) return null;
  return { shape, position: `${xPercent}% ${yPercent}%`, xPercent, yPercent };
}

function parseCssRadialGradient(value) {
  if (typeof value !== "string" || !/^radial-gradient\(/i.test(value.trim())) return null;
  const body = value.trim().replace(/^radial-gradient\(/i, "").replace(/\)\s*$/, "");
  const parts = splitCssCommaList(body);
  if (parts.length < 2) return null;
  const firstColor = parseShadowColor(parts[0]);
  const descriptor = firstColor?.color ? { shape: "ellipse", position: "center" } : parseCssRadialGradientDescriptor(parts[0]);
  if (!descriptor) return null;
  const stopParts = firstColor?.color ? parts : parts.slice(1);
  const stops = parseCssGradientStops(stopParts);
  if (!stops) return null;
  return {
    type: "radial",
    shape: descriptor.shape,
    position: descriptor.position,
    ...(Number.isFinite(descriptor.xPercent) ? { xPercent: descriptor.xPercent } : {}),
    ...(Number.isFinite(descriptor.yPercent) ? { yPercent: descriptor.yPercent } : {}),
    stops
  };
}

function parseCssSupportedGradient(value) {
  return parseCssLinearGradient(value) ?? parseCssRadialGradient(value);
}

function parseCssRadialOverlay(value) {
  const gradient = parseCssRadialGradient(value);
  if (!gradient || !Number.isFinite(gradient.xPercent) || !Number.isFinite(gradient.yPercent)
    || (gradient.xPercent === 50 && gradient.yPercent === 50)) return null;
  const xPercent = gradient.xPercent;
  const yPercent = gradient.yPercent;
  return {
    gradient: {
      type: "radial",
      shape: gradient.shape,
      position: "center",
      stops: gradient.stops
    },
    xPercent,
    yPercent
  };
}

export function planReplicaSlideBackground(
  backgroundImage,
  backgroundColor,
  deckSize = SLIDE_SIZE
) {
  const layers = typeof backgroundImage === "string" && backgroundImage !== "none"
    ? splitCssCommaList(backgroundImage).filter((layer) => layer && layer !== "none")
    : [];
  const plan = {
    background: { type: "solid", color: backgroundColor ?? "{colors.background}" },
    overlays: [],
    unsupported: []
  };
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const radial = parseCssRadialOverlay(layer);
    if (radial) {
      const halfWidthPercent = Math.max(
        4,
        Math.min(30, radial.xPercent, 100 - radial.xPercent)
      );
      const halfHeightPercent = Math.max(
        4,
        Math.min(30, radial.yPercent, 100 - radial.yPercent)
      );
      plan.overlays.unshift({
        type: "shape",
        id: `__slide-background-accent-${String(index + 1).padStart(3, "0")}`,
        shape: "ellipse",
        role: "background",
        x: Number(((radial.xPercent - halfWidthPercent) / 100 * deckSize.width).toFixed(4)),
        y: Number(((radial.yPercent - halfHeightPercent) / 100 * deckSize.height).toFixed(4)),
        w: Number((halfWidthPercent * 2 / 100 * deckSize.width).toFixed(4)),
        h: Number((halfHeightPercent * 2 / 100 * deckSize.height).toFixed(4)),
        style: {
          fill: radial.gradient.stops[0].color,
          borderWidth: 0,
          gradient: radial.gradient
        }
      });
      continue;
    }
    const gradient = parseCssSupportedGradient(layer);
    if (gradient) {
      if (index === layers.length - 1) {
        plan.background = { type: "gradient", gradient };
      } else {
        plan.overlays.unshift({
          type: "shape",
          id: `__slide-background-gradient-${String(index + 1).padStart(3, "0")}`,
          shape: "rect",
          role: "background",
          x: 0,
          y: 0,
          w: Number(deckSize.width),
          h: Number(deckSize.height),
          style: {
            fill: gradient.stops[0].color,
            borderWidth: 0,
            gradient
          }
        });
      }
      continue;
    }
    plan.unsupported.push(layer);
  }
  return plan;
}

function parseCssGradientAngle(value) {
  const source = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const angleMatch = source.match(/^(-?\d+(?:\.\d+)?)deg$/i);
  if (angleMatch) return Math.round(Number(angleMatch[1]) * 100) / 100;
  if (!source.startsWith("to ")) return null;
  const directions = new Set(source.slice(3).split(" ").filter(Boolean));
  if (directions.size === 0 || directions.size > 2) return null;
  const hasTop = directions.has("top");
  const hasRight = directions.has("right");
  const hasBottom = directions.has("bottom");
  const hasLeft = directions.has("left");
  if (hasTop && hasBottom) return null;
  if (hasLeft && hasRight) return null;
  if (hasTop && hasRight) return 45;
  if (hasBottom && hasRight) return 135;
  if (hasBottom && hasLeft) return 225;
  if (hasTop && hasLeft) return 315;
  if (hasTop) return 0;
  if (hasRight) return 90;
  if (hasBottom) return 180;
  if (hasLeft) return 270;
  return null;
}

function parseCssLengthPx(value) {
  const match = String(value).trim().match(/^(-?\d+(?:\.\d+)?)(px)?$/i);
  if (!match) return null;
  return Number.parseFloat(match[1]);
}

function parseCssBoxShadow(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return null;
  const shadows = splitCssCommaList(trimmed);
  if (shadows.length !== 1 || /\binset\b/i.test(shadows[0])) return null;

  const parsedColor = parseShadowColor(shadows[0]);
  if (!parsedColor?.color) return null;
  const lengthSource = shadows[0].replace(parsedColor.source, "").replace(/\binset\b/gi, " ").trim();
  const lengths = lengthSource.split(/\s+/).map(parseCssLengthPx);
  if (lengths.length < 2 || lengths.some((length) => length === null)) return null;

  const [offsetX, offsetY, blur = 0] = lengths;
  const offset = Math.round(Math.hypot(offsetX, offsetY) * 0.75 * 100) / 100;
  const angle = Math.round((Math.atan2(offsetY, offsetX) * 180) / Math.PI + 360) % 360;
  return {
    type: "outer",
    color: parsedColor.color,
    opacity: Math.round(parsedColor.opacity * 100) / 100,
    blur: Math.max(0, Math.round(blur * 0.75 * 100) / 100),
    offset,
    angle
  };
}

function parseCssDropShadowFilter(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^drop-shadow\(/i.test(trimmed) || splitCssCommaList(trimmed).length !== 1) return null;
  const match = trimmed.match(/^drop-shadow\((.*)\)$/i);
  if (!match) return null;
  return parseCssBoxShadow(match[1]);
}

function hasCssBoxShadow(style) {
  return typeof style.boxShadow === "string" && style.boxShadow.trim() && style.boxShadow.trim() !== "none";
}

function hasReplicaPaint(style) {
  const backgroundLayers = typeof style.backgroundImage === "string"
    ? splitCssCommaList(style.backgroundImage).filter((layer) => layer && layer !== "none")
    : [];
  const backgroundColorVisible = Boolean(style.backgroundColor)
    && Number(style.backgroundTransparency ?? 0) < 100;
  return backgroundColorVisible
    || backgroundLayers.length > 0
    || Boolean(style.borderColor && Number(style.borderWidth ?? 0) > 0)
    || Boolean(parseCssBoxShadow(style.boxShadow))
    || hasCssOutline(style);
}

function replicaUnsupportedEffect(measurement, style) {
  if (!measurement.replica?.hasUnsupportedEffects) return null;
  const backgroundImage = measurement.replica.backgroundImage ?? style.backgroundImage ?? null;
  const backgroundLayers = typeof backgroundImage === "string"
    ? splitCssCommaList(backgroundImage).filter((layer) => layer && layer !== "none")
    : [];
  const unsupportedBackgroundLayers = backgroundLayers.filter((layer) => {
    if (parseCssSupportedGradient(layer)) return false;
    const backgroundImageSrc = parseCssBackgroundImageUrl(layer);
    return !(backgroundImageSrc && replicaBackgroundImagePlanForSrc(backgroundImageSrc, style, measuredBox(measurement)));
  });
  const unsupportedBackgroundImage = unsupportedBackgroundLayers.length > 0
    ? unsupportedBackgroundLayers.join(", ")
    : null;
  const unsupportedFilter = measurement.replica.filter && !parseCssDropShadowFilter(measurement.replica.filter) ? measurement.replica.filter : null;
  const unsupportedCompositing = measurement.replica.unsupportedCompositing ?? {};
  const unsupportedTransform = unsupportedCompositing.transformFallback ?? (style.transformData?.supported === false ? style.transformData.fallback : null);
  if (!unsupportedFilter && !measurement.replica.backdropFilter && !measurement.replica.clipPath && !unsupportedBackgroundImage && !measurement.replica.unsupportedVisual
    && !unsupportedCompositing.blendMode && !unsupportedCompositing.isolation && !unsupportedCompositing.maskImage
    && !unsupportedCompositing.maskComposite && !unsupportedTransform) return null;
  return {
    elementId: measurement.id,
    filter: unsupportedFilter,
    backdropFilter: measurement.replica.backdropFilter ?? null,
    clipPath: measurement.replica.clipPath ?? null,
    backgroundImage: unsupportedBackgroundImage,
    unsupportedVisual: measurement.replica.unsupportedVisual ?? null,
    blendMode: unsupportedCompositing.blendMode ?? null,
    isolation: unsupportedCompositing.isolation ?? null,
    maskImage: unsupportedCompositing.maskImage ?? null,
    maskComposite: unsupportedCompositing.maskComposite ?? null,
    transformFallback: unsupportedTransform
  };
}

function replicaBorderDashType(style) {
  if (style.borderStyle === "dashed") return "dash";
  if (style.borderStyle === "dotted") return "sysDot";
  return null;
}

function replicaShapeKind(measurement) {
  const style = cssStyle(measurement);
  const box = measuredBox(measurement);
  const override = String(measurement?.shapeOverride ?? "").trim().toLowerCase();
  if (["rect", "roundrect", "round-rect", "pill", "circle", "ellipse"].includes(override)) {
    if (override === "round-rect" || override === "roundrect") return "roundRect";
    return override;
  }
  const cornerRadii = replicaCornerRadii(style);
  const widthPx = Number(measurement?.px?.w ?? box.w * 96);
  const heightPx = Number(measurement?.px?.h ?? box.h * 96);
  const shortSidePx = Math.min(widthPx, heightPx);
  const allHalfShort = cornerRadii.every((corner) =>
    Math.abs(corner.rx - shortSidePx / 2) <= 1 && Math.abs(corner.ry - shortSidePx / 2) <= 1
  );
  const allHalfWidthHeight = cornerRadii.every((corner) =>
    Math.abs(corner.rx - widthPx / 2) <= 1 && Math.abs(corner.ry - heightPx / 2) <= 1
  );
  if (allHalfShort && Math.abs(widthPx - heightPx) <= 1) return "circle";
  if (allHalfShort && Math.abs(widthPx - heightPx) > 1) return "pill";
  if (allHalfWidthHeight) return "ellipse";
  return hasUniformReplicaCornerRadius(cornerRadii) ? "roundRect" : "rect";
}

function replicaCornerRadii(style) {
  if (Array.isArray(style.cornerRadii) && style.cornerRadii.length === 4) {
    return style.cornerRadii.map((corner) => ({
      rx: Math.max(0, Number(corner?.rx) || 0),
      ry: Math.max(0, Number(corner?.ry ?? corner?.rx) || 0)
    }));
  }
  const shorthand = Number(style.borderRadius) || 0;
  return [
    [style.borderTopLeftRadiusX ?? style.borderTopLeftRadius ?? shorthand, style.borderTopLeftRadiusY ?? style.borderTopLeftRadius ?? shorthand],
    [style.borderTopRightRadiusX ?? style.borderTopRightRadius ?? shorthand, style.borderTopRightRadiusY ?? style.borderTopRightRadius ?? shorthand],
    [style.borderBottomRightRadiusX ?? style.borderBottomRightRadius ?? shorthand, style.borderBottomRightRadiusY ?? style.borderBottomRightRadius ?? shorthand],
    [style.borderBottomLeftRadiusX ?? style.borderBottomLeftRadius ?? shorthand, style.borderBottomLeftRadiusY ?? style.borderBottomLeftRadius ?? shorthand]
  ].map(([rx, ry]) => ({ rx: Math.max(0, Number(rx) || 0), ry: Math.max(0, Number(ry) || 0) }));
}

function hasUniformReplicaCornerRadius(cornerRadii) {
  const positive = cornerRadii.filter((corner) => corner.rx > 1 || corner.ry > 1);
  if (positive.length !== 4) return false;
  return cornerRadii.every((corner) =>
    Math.abs(corner.rx - cornerRadii[0].rx) <= 0.5
    && Math.abs(corner.ry - cornerRadii[0].ry) <= 0.5
  );
}

function shapeFidelityFor(measurement, style, shape) {
  const radii = replicaCornerRadii(style);
  const override = String(measurement?.shapeOverride ?? "").trim();
  const asymmetric = radii.some((corner) =>
    Math.abs(corner.rx - radii[0].rx) > 0.5 || Math.abs(corner.ry - radii[0].ry) > 0.5
  );
  const elliptical = radii.some((corner) => Math.abs(corner.rx - corner.ry) > 0.5);
  if (asymmetric || (elliptical && !["ellipse", "pill"].includes(shape))) {
    return {
      status: "unsupported",
      reason: asymmetric ? "asymmetric-corner-radii" : "elliptical-corner-radii",
      cornerRadii: radii
    };
  }
  if (override && !["rect", "roundrect", "round-rect", "pill", "circle", "ellipse"].includes(override.toLowerCase())) {
    return { status: "unsupported", reason: `unsupported-shape-override:${override}` };
  }
  return { status: "native", shape, cornerRadii: radii };
}

function cssBorderDashType(borderStyle) {
  if (borderStyle === "dashed") return "dash";
  if (borderStyle === "dotted") return "sysDot";
  return null;
}

function borderSideKey(side) {
  return `${side[0].toUpperCase()}${side.slice(1)}`;
}

function visibleBorderSides(style) {
  return ["top", "right", "bottom", "left"]
    .map((side) => {
      const key = borderSideKey(side);
      const width = Number(style[`border${key}Width`] ?? (side === "top" ? style.borderWidth : 0)) || 0;
      const borderStyle = style[`border${key}Style`] ?? (side === "top" ? style.borderStyle : null);
      const color = style[`border${key}Color`] ?? (side === "top" ? style.borderColor : null);
      return { side, width, borderStyle, color };
    })
    .filter((border) => border.width > 0 && border.borderStyle !== "none" && border.borderStyle !== "hidden");
}

function borderLineElement(id, measurement, border) {
  const style = cssStyle(measurement);
  const box = measuredBox(measurement);
  const inset = border.width / 96 / 2;
  const radii = replicaCornerRadii(style);
  const topLeft = radii[0] ?? { rx: 0, ry: 0 };
  const topRight = radii[1] ?? { rx: 0, ry: 0 };
  const bottomRight = radii[2] ?? { rx: 0, ry: 0 };
  const bottomLeft = radii[3] ?? { rx: 0, ry: 0 };
  const horizontalInset = (left, right) => Math.max(0, (Number(left) || 0) + (Number(right) || 0)) / 96;
  const verticalInset = (top, bottom) => Math.max(0, (Number(top) || 0) + (Number(bottom) || 0)) / 96;
  const line = {
    type: "line",
    id: `${id}-${border.side}-border`,
    x: border.side === "right"
      ? box.x + box.w - inset
      : border.side === "left"
        ? box.x + inset
        : box.x + (border.side === "top"
          ? (Number(topLeft.rx) || 0) / 96
          : (Number(bottomLeft.rx) || 0) / 96),
    y: border.side === "bottom"
      ? box.y + box.h - inset
      : border.side === "top"
        ? box.y + inset
        : box.y + (border.side === "right"
          ? (Number(topRight.ry) || 0) / 96
          : (Number(topLeft.ry) || 0) / 96),
    w: border.side === "left" || border.side === "right"
      ? 0
      : Math.max(0, box.w - (border.side === "top"
        ? horizontalInset(topLeft.rx, topRight.rx)
        : horizontalInset(bottomLeft.rx, bottomRight.rx))),
    h: border.side === "top" || border.side === "bottom"
      ? 0
      : Math.max(0, box.h - (border.side === "left"
        ? verticalInset(topLeft.ry, bottomLeft.ry)
        : verticalInset(topRight.ry, bottomRight.ry))),
    style: {
      color: border.color ?? style.borderColor ?? "{colors.border}",
      width: Math.max(0.25, border.width * 0.75)
    }
  };
  const dashType = cssBorderDashType(border.borderStyle);
  if (dashType) line.style.dashType = dashType;
  const sideKey = borderSideKey(border.side);
  const transparency = cssCombinedTransparency(style, "borderTransparency", `border${sideKey}Transparency`);
  if (transparency !== null) line.style.transparency = transparency;
  return line;
}

function singleSideBorderLineElement(id, measurement) {
  const style = cssStyle(measurement);
  if (style.backgroundColor || hasCssBorderRadius(style) || hasCssBoxShadow(style)) return null;
  const borders = visibleBorderSides(style);
  if (borders.length !== 1) return null;
  return borderLineElement(id, measurement, borders[0]);
}

function hasCssBorderRadius(style) {
  if (Array.isArray(style.cornerRadii)) {
    return style.cornerRadii.some((corner) => Number(corner?.rx ?? 0) > 0 || Number(corner?.ry ?? 0) > 0);
  }
  return ["borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"].some(
    (key) => Number(style[key] ?? 0) > 0
  );
}

function hasExplicitSideBorder(style) {
  return ["Top", "Right", "Bottom", "Left"].some((sideKey) =>
    ["Width", "Style", "Color", "Transparency"].some((suffix) => Object.prototype.hasOwnProperty.call(style, `border${sideKey}${suffix}`))
  );
}

function hasAsymmetricBorderSides(style, borders) {
  if (!hasExplicitSideBorder(style) || borders.length === 0) return false;
  if (borders.length !== 4) return true;
  const [first] = borders;
  return borders.some((border) => {
    const sideKey = borderSideKey(border.side);
    const firstKey = borderSideKey(first.side);
    return (
      border.width !== first.width ||
      border.borderStyle !== first.borderStyle ||
      border.color !== first.color ||
      style[`border${sideKey}Transparency`] !== style[`border${firstKey}Transparency`]
    );
  });
}

function filledBoxBorderLineElements(id, measurement) {
  const style = cssStyle(measurement);
  const borders = visibleBorderSides(style);
  if (!hasAsymmetricBorderSides(style, borders)) return [];
  return borders.map((border) => borderLineElement(id, measurement, border));
}

function replicaShapeElement(id, measurement) {
  const style = cssStyle(measurement);
  const dashType = replicaBorderDashType(style);
  const shape = replicaShapeKind(measurement);
  const shapeFidelity = shapeFidelityFor(measurement, style, shape);
  const cornerRadii = replicaCornerRadii(style);
  const borderSides = visibleBorderSides(style);
  const element = {
    type: "shape",
    id,
    shape,
    ...measuredBox(measurement),
    ...(measurement?.shapeOverride ? { shapeOverride: String(measurement.shapeOverride) } : {}),
    ...(shapeFidelity ? { shapeFidelity } : {}),
    ...(borderSides.length > 0 ? { borderSides: borderSides.map((border) => ({ side: border.side, width: border.width, style: border.borderStyle, color: border.color })) } : {}),
    style: {
      fill: style.backgroundColor ?? "#FFFFFF",
      backgroundColor: style.backgroundColor ?? "#FFFFFF",
      borderColor: style.borderColor ?? style.backgroundColor ?? "#FFFFFF",
      borderWidth: Number(style.borderWidth ?? 0) > 0 ? Math.max(0.25, Number(style.borderWidth) * 0.75) : 0,
      transparency: style.backgroundColor ? (cssCombinedTransparency(style, "backgroundTransparency") ?? 0) : 100
    }
  };
  if (["roundRect", "pill"].includes(element.shape)) {
    element.style.borderRadius = cornerRadii[0].rx;
    element.style.borderRadiusX = cornerRadii[0].rx;
    element.style.borderRadiusY = cornerRadii[0].ry;
    element.style.cornerRadii = cornerRadii;
    const explicitInset = Number(measurement?.semantics?.safeInset);
    element.safeInset = Number.isFinite(explicitInset) && explicitInset >= 0 ? explicitInset : 0.12;
  }
  const hyperlink = measurementHyperlink(measurement);
  if (hyperlink) element.hyperlink = hyperlink;
  const borderTransparency = cssCombinedTransparency(style, "borderTransparency");
  if (borderTransparency !== null) element.style.borderTransparency = borderTransparency;
  if (dashType) element.style.dashType = dashType;
  const shadow = parseCssBoxShadow(style.boxShadow);
  if (shadow) element.style.shadow = shadow;
  const filterShadow = parseCssDropShadowFilter(measurement.replica?.filter);
  if (filterShadow) element.style.shadow = filterShadow;
  return applyReplicaRotation(element, style, measurement);
}

function replicaBackgroundGradientElement(id, measurement, gradient, suffix) {
  const base = replicaShapeElement(id, measurement);
  const firstStop = gradient?.stops?.[0];
  const style = {
    ...base.style,
    fill: firstStop?.color ?? base.style.fill ?? "#FFFFFF",
    backgroundColor: firstStop?.color ?? base.style.backgroundColor ?? "#FFFFFF",
    borderColor: firstStop?.color ?? base.style.borderColor ?? "#FFFFFF",
    borderWidth: 0,
    transparency: 0,
    gradient
  };
  delete style.borderTransparency;
  delete style.dashType;
  delete style.shadow;
  return {
    ...base,
    id: `${id}-${suffix}`,
    style
  };
}

function replicaRadialGlowElement(id, measurement, radial, suffix) {
  const box = measuredBox(measurement);
  const gradient = radial?.gradient;
  const xPercent = Number(radial?.xPercent);
  const yPercent = Number(radial?.yPercent);
  if (!gradient || !Number.isFinite(xPercent) || !Number.isFinite(yPercent)) return null;
  const halfWidthPercent = Math.max(4, Math.min(30, xPercent, 100 - xPercent));
  const halfHeightPercent = Math.max(4, Math.min(30, yPercent, 100 - yPercent));
  const firstStop = gradient.stops?.[0];
  return {
    type: "shape",
    id: `${id}-${suffix}`,
    shape: gradient.shape === "circle" ? "ellipse" : "ellipse",
    x: Number((box.x + (xPercent - halfWidthPercent) / 100 * box.w).toFixed(4)),
    y: Number((box.y + (yPercent - halfHeightPercent) / 100 * box.h).toFixed(4)),
    w: Number((halfWidthPercent * 2 / 100 * box.w).toFixed(4)),
    h: Number((halfHeightPercent * 2 / 100 * box.h).toFixed(4)),
    style: {
      fill: firstStop?.color ?? "#FFFFFF",
      backgroundColor: firstStop?.color ?? "#FFFFFF",
      borderWidth: 0,
      transparency: 0,
      gradient
    }
  };
}

/**
 * Plan an element's CSS paint into deterministic editable layers. CSS paints
 * the last background image first; the returned list is therefore ordered
 * from back to front and keeps solid fill, gradients, radial glows, borders,
 * and shadows separate where PowerPoint cannot represent the CSS stack in one
 * shape.
 */
export function planReplicaElementBackgroundLayers(id, measurement) {
  const style = cssStyle(measurement);
  const layers = typeof style.backgroundImage === "string"
    ? splitCssCommaList(style.backgroundImage).filter((layer) => layer && layer !== "none")
    : [];
  const elements = [];
  const base = replicaShapeElement(id, measurement);
  delete base.style.gradient;
  const borders = visibleBorderSides(style);
  const asymmetricBorders = hasAsymmetricBorderSides(style, borders);
  const baseVisible = Boolean(style.backgroundColor)
    || Number(base.style.borderWidth ?? 0) > 0
    || Boolean(base.style.shadow);
  if (baseVisible) {
    if (asymmetricBorders) {
      base.style.borderWidth = 0;
      delete base.style.borderTransparency;
      delete base.style.dashType;
    }
    elements.push(base);
  }

  let gradientOrdinal = 0;
  let glowOrdinal = 0;
  let backgroundImagesAdded = false;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (parseCssBackgroundImageUrl(layer)) {
      if (!backgroundImagesAdded) {
        elements.push(...replicaBackgroundImageElements(id, measurement));
        backgroundImagesAdded = true;
      }
      continue;
    }
    const radial = parseCssRadialOverlay(layer);
    if (radial) {
      const glow = replicaRadialGlowElement(id, measurement, radial, `radial-glow-${String(++glowOrdinal).padStart(3, "0")}`);
      if (glow) elements.push(glow);
      continue;
    }
    const gradient = parseCssSupportedGradient(layer);
    if (!gradient) continue;
    // A centered radial/linear gradient can use the element's native bounds;
    // non-centered radial gradients use the standalone glow above so their
    // focal point remains visible instead of being silently centered.
    if (gradient.type === "radial" && (gradient.xPercent !== 50 || gradient.yPercent !== 50)) continue;
    elements.push(replicaBackgroundGradientElement(
      id,
      measurement,
      gradient,
      `background-gradient-${String(++gradientOrdinal).padStart(3, "0")}`
    ));
  }

  const borderLines = filledBoxBorderLineElements(id, measurement);
  if (borderLines.length > 0) {
    elements.push(...borderLines);
  } else if (!baseVisible && borders.length === 1) {
    const single = borderLineElement(id, measurement, borders[0]);
    if (single) elements.push(single);
  }
  const outline = replicaOutlineElement(id, measurement);
  if (outline) elements.push(outline);
  return elements;
}

function replicaPaintLayerElements(id, measurement) {
  const style = cssStyle(measurement);
  const layers = typeof style.backgroundImage === "string"
    ? splitCssCommaList(style.backgroundImage).filter((layer) => layer && layer !== "none")
    : [];
  const singleBorderLine = layers.length === 0 ? singleSideBorderLineElement(id, measurement) : null;
  if (singleBorderLine) return [singleBorderLine];
  return planReplicaElementBackgroundLayers(id, measurement);
}

function evidenceFromSemantics(semantics = {}) {
  const kind = String(semantics.evidenceKind ?? "").trim();
  if (!kind) return null;
  const sourceIds = sourceRefsFromSemantics(semantics);
  return {
    kind,
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(semantics.asOf ? { asOf: semantics.asOf } : {})
  };
}

function sourceRefsFromSemantics(semantics = {}) {
  return [...new Set((Array.isArray(semantics.sourceIds) ? semantics.sourceIds : [])
    .map((value) => String(value).trim())
    .filter(Boolean))];
}

function measurementHyperlink(measurement) {
  const url = String(measurement?.href ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    ...(measurement?.hyperlinkTooltip ? { tooltip: measurement.hyperlinkTooltip } : {})
  };
}

function measurementWithSourceText(measurement, node) {
  if (!measurement || typeof measurement !== "object") return measurement;
  if ((typeof measurement.visibleText === "string" && measurement.visibleText)
    || (typeof measurement.text === "string" && measurement.text)) return measurement;
  return { ...measurement, text: textContent(node), ...(node ? { runs: nodeRichRuns(node) } : {}) };
}

function replicaTextRuns(measurement, style) {
  if (!Array.isArray(measurement?.runs) || measurement.runs.length === 0) return [];
  const runs = measurement.runs.map((run) => {
    const source = typeof run === "string" ? { text: run } : run ?? {};
    const text = applyTextTransform(source.text ?? "", style.textTransform);
    if (!text) return null;
    const decoration = source.decoration && typeof source.decoration === "object" ? source.decoration : null;
    return {
      text,
      ...(source.fontFamily ? { fontFamily: source.fontFamily } : {}),
      ...(Number.isFinite(Number(source.fontSize)) ? { fontSize: Number(source.fontSize) } : {}),
      ...(Number.isFinite(Number(source.fontWeight)) ? { fontWeight: Number(source.fontWeight) } : {}),
      ...(source.fontStyle ? { fontStyle: source.fontStyle } : {}),
      ...(source.color ? { color: source.color } : {}),
      ...(decoration ? { decoration: { ...decoration } } : {}),
      ...(source.hyperlink ? { hyperlink: { ...source.hyperlink } } : {})
    };
  }).filter(Boolean);
  const preserveWhitespace = Boolean(style.preserveWhitespace)
    || ["pre", "pre-wrap", "break-spaces"].includes(String(style.whiteSpace ?? "").toLowerCase());
  if (runs.length > 0 && !preserveWhitespace) {
    runs[0].text = runs[0].text.replace(/^\s+/, "");
    runs.at(-1).text = runs.at(-1).text.replace(/\s+$/, "");
  }
  return runs.filter((run) => run.text);
}

function replicaTextElement(id, measurement, options = {}) {
  const style = cssStyle(measurement);
  const bullet = replicaTextBullet(style);
  const rawLineHeight = Number.isFinite(Number(style.lineHeight)) && Number(style.fontSize) > 0
    ? Number((Number(style.lineHeight) / Number(style.fontSize)).toFixed(4))
    : undefined;
  const tagName = String(measurement?.tagName ?? "").toLowerCase();
  const text = replicaTextContent(measurement, style);
  const normalizeSingleLineHeader = options.designMode !== "replica"
    && tagName === "th"
    && !String(text).includes("\n")
    && Number(rawLineHeight) > 1.4;
  const semantics = measurement?.semantics ?? {};
  const lineHeightScale = Number(semantics.pptxLineHeightScale);
  const lineHeight = normalizeSingleLineHeader ? 1.2 : rawLineHeight;
  const pptxLineHeight = Number.isFinite(lineHeightScale)
    ? Number((Number(lineHeight) * lineHeightScale).toFixed(4))
    : undefined;
  const evidence = evidenceFromSemantics(semantics);
  const sourceRefs = sourceRefsFromSemantics(semantics);
  const hyperlink = measurementHyperlink(measurement);
  const runs = replicaTextRuns(measurement, style);
  const element = {
    type: "text",
    id,
    ...(tagName === "th" && !semantics.role ? { role: "table-header" } : {}),
    ...(Number.isInteger(semantics.maxLines) ? { maxLines: semantics.maxLines } : {}),
    text,
    ...(runs.length > 0 ? { runs } : {}),
    ...(Array.isArray(measurement?.renderedLines) ? { renderedLines: [...measurement.renderedLines] } : {}),
    ...(Array.isArray(measurement?.lineBreakOffsets) ? { lineBreakOffsets: [...measurement.lineBreakOffsets] } : {}),
    ...(Number.isInteger(measurement?.renderedLineCount) ? { renderedLineCount: measurement.renderedLineCount } : {}),
    ...measuredBox(measurement),
    ...(hyperlink ? { hyperlink } : {}),
    ...(evidence ? { evidence } : {}),
    ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
    ...(semantics.listParentId ? { listParentId: semantics.listParentId } : {}),
    ...(Number.isInteger(semantics.listIndex) && semantics.listIndex >= 0 ? { listIndex: semantics.listIndex } : {}),
    style: {
      color: replicaTextFillColor(style),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      italic: style.fontStyle === "italic",
      smallCaps: replicaTextSmallCaps(style) || undefined,
      align: replicaTextAlign(style),
      valign: normalizeSingleLineHeader ? "middle" : replicaTextValign(style),
      textDirection: replicaTextDirection(style),
      rtl: replicaTextRtl(style),
      lineHeight,
      ...(Number.isFinite(pptxLineHeight) ? { pptxLineHeight } : {}),
      firstLineIndent: replicaTextIndent(style),
      textStroke: replicaTextStroke(style),
      charSpacing: style.letterSpacing,
      textOverflow: replicaTextOverflow(style),
      whiteSpace: style.whiteSpace,
      tabSize: style.tabSize,
      preserveWhitespace: Boolean(style.preserveWhitespace),
      ...replicaTextDecoration(style),
      ...(bullet ? { bullet } : {}),
      margin: replicaTextMargin(style)
    }
  };
  const shadow = parseCssBoxShadow(style.textShadow);
  if (shadow) element.style.shadow = shadow;
  const filterShadow = parseCssDropShadowFilter(measurement.replica?.filter);
  if (filterShadow) element.style.shadow = filterShadow;
  const transparency = cssCombinedTransparency(style, "colorTransparency", "webkitTextFillTransparency");
  if (transparency !== null) element.style.transparency = transparency;
  return applyReplicaRotation(element, style, measurement);
}

function replicaTextBullet(style) {
  if (style.display !== "list-item") return null;
  const listStyleType = String(style.listStyleType ?? "disc").trim().toLowerCase();
  if (!listStyleType || ["none", "hidden"].includes(listStyleType)) return null;
  const characterCodeByType = new Map([
    ["disc", "2022"],
    ["circle", "25E6"],
    ["square", "25AA"]
  ]);
  if (characterCodeByType.has(listStyleType)) {
    return {
      type: "bullet",
      characterCode: characterCodeByType.get(listStyleType)
    };
  }
  if (["decimal", "decimal-leading-zero"].includes(listStyleType)) {
    return {
      type: "number",
      style: listStyleType === "decimal-leading-zero" ? "arabicDbPeriod" : "arabicPeriod",
      startAt: 1
    };
  }
  return {
    type: "bullet",
    characterCode: "2022"
  };
}

function measurementElementsForSlide(measurements, slideIndex) {
  const elements = Array.isArray(measurements?.elements) ? measurements.elements : [];
  const hasSlideIndexes = elements.some((element) => Number.isInteger(element.slideIndex));
  if (!hasSlideIndexes) return slideIndex === 0 ? elements : [];
  return elements.filter((element) => element.slideIndex === slideIndex);
}

function measurementSlideForSlide(measurements, slideIndex) {
  const slides = Array.isArray(measurements?.slides) ? measurements.slides : [];
  return slides.find((slide) => slide.slideIndex === slideIndex) ?? null;
}

function replicaZIndex(measurement) {
  const value = cssStyle(measurement).zIndex;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && value.trim() !== "auto") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isSimpleSvgLinePath(d) {
  return (
    typeof d === "string" &&
    /^\s*M\s*-?\d+(?:\.\d+)?(?:\s+|,)\s*-?\d+(?:\.\d+)?\s+L\s*-?\d+(?:\.\d+)?(?:\s+|,)\s*-?\d+(?:\.\d+)?\s*$/i.test(d)
  );
}

function parseSimpleSvgLinePath(d) {
  if (!isSimpleSvgLinePath(d)) return null;
  const numbers = String(d).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) return null;
  const [x1, y1, x2, y2] = numbers;
  return { x1, y1, x2, y2 };
}

function parseSvgNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).trim().match(/^(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function parseSvgViewBox(svg) {
  const viewBox = String(svg.getAttribute("viewBox") ?? "").trim();
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }
  }
  const width = parseSvgNumber(svg.getAttribute("width"));
  const height = parseSvgNumber(svg.getAttribute("height"));
  return width > 0 && height > 0 ? { x: 0, y: 0, w: width, h: height } : null;
}

function svgPaint(node, name) {
  const raw = node.getAttribute(name);
  if (!raw || raw === "none") return null;
  return normalizeHex(raw);
}

function svgTransparency(node, ...opacityNames) {
  let alpha = 1;
  const opacity = parseSvgNumber(node.getAttribute("opacity"));
  if (Number.isFinite(opacity)) alpha *= clamp01(opacity);
  for (const name of opacityNames) {
    const value = parseSvgNumber(node.getAttribute(name));
    if (Number.isFinite(value)) alpha *= clamp01(value);
  }
  return alpha < 1 ? Math.round((1 - alpha) * 100) : null;
}

function svgStrokeWidth(node, viewBox, box) {
  const strokeWidth = parseSvgNumber(node.getAttribute("stroke-width"));
  if (!(strokeWidth > 0)) return 0;
  const scaleX = box.w / viewBox.w;
  const scaleY = box.h / viewBox.h;
  return Math.round(strokeWidth * ((scaleX + scaleY) / 2) * 72 * 100) / 100;
}

function svgShapeStyle(node, viewBox, box) {
  const fill = svgPaint(node, "fill");
  const stroke = svgPaint(node, "stroke");
  const borderWidth = svgStrokeWidth(node, viewBox, box);
  const style = {
    fill: fill ?? "#FFFFFF",
    backgroundColor: fill ?? "#FFFFFF",
    transparency: fill ? (svgTransparency(node, "fill-opacity") ?? 0) : 100,
    borderColor: stroke ?? fill ?? "#FFFFFF",
    borderWidth: stroke ? borderWidth : 0
  };
  const borderTransparency = stroke ? svgTransparency(node, "stroke-opacity") : null;
  if (borderTransparency !== null) style.borderTransparency = borderTransparency;
  return style;
}

function svgLineStyle(node, viewBox, box) {
  const stroke = svgPaint(node, "stroke");
  const width = svgStrokeWidth(node, viewBox, box);
  const style = {
    color: stroke ?? "{colors.border}",
    width: width > 0 ? width : 1.5
  };
  const transparency = svgTransparency(node, "stroke-opacity");
  if (transparency !== null) style.transparency = transparency;
  return style;
}

function svgBoxToSlideBox(svgBox, viewBox, localBox) {
  const scaleX = svgBox.w / viewBox.w;
  const scaleY = svgBox.h / viewBox.h;
  return {
    x: roundInches(svgBox.x + (localBox.x - viewBox.x) * scaleX),
    y: roundInches(svgBox.y + (localBox.y - viewBox.y) * scaleY),
    w: roundInches(localBox.w * scaleX),
    h: roundInches(localBox.h * scaleY)
  };
}

function svgTextElement(textNode, svgBox, viewBox) {
  const text = textContent(textNode);
  if (!text) return null;
  const x = parseSvgNumber(textNode.getAttribute("x")) ?? 0;
  const baselineY = parseSvgNumber(textNode.getAttribute("y")) ?? 0;
  const fontSize = parseSvgNumber(textNode.getAttribute("font-size")) ?? 16;
  if (![x, baselineY, fontSize].every((value) => Number.isFinite(value)) || fontSize <= 0) return null;
  const textAnchor = String(textNode.getAttribute("text-anchor") ?? "start").trim().toLowerCase();
  const localX = textAnchor === "middle" || textAnchor === "end" ? viewBox.x : x;
  const localW = textAnchor === "middle" ? viewBox.w : Math.max(1, (textAnchor === "end" ? x : viewBox.x + viewBox.w) - localX);
  const box = svgBoxToSlideBox(svgBox, viewBox, {
    x: localX,
    y: baselineY - fontSize,
    w: localW,
    h: fontSize * 1.2
  });
  const scaleY = svgBox.h / viewBox.h;
  const style = {
    color: svgPaint(textNode, "fill") ?? "#000000",
    fontSize: Math.round(fontSize * scaleY * 72 * 100) / 100,
    margin: 0
  };
  const transparency = svgTransparency(textNode, "fill-opacity");
  if (transparency !== null) style.transparency = transparency;
  const fontFamily = textNode.getAttribute("font-family");
  if (fontFamily) style.fontFamily = fontFamily.trim().replace(/^["']|["']$/g, "");
  const fontWeight = String(textNode.getAttribute("font-weight") ?? "").trim().toLowerCase();
  if (/^\d+$/.test(fontWeight)) style.fontWeight = Number(fontWeight);
  else if (fontWeight === "bold" || fontWeight === "bolder") style.fontWeight = 700;
  const fontStyle = String(textNode.getAttribute("font-style") ?? "").trim().toLowerCase();
  if (fontStyle === "italic" || fontStyle === "oblique") style.italic = true;
  const textDecoration = String(textNode.getAttribute("text-decoration") ?? "").trim().toLowerCase();
  if (/\bunderline\b/.test(textDecoration)) style.underline = { style: "sng" };
  if (/\bline-through\b/.test(textDecoration)) style.strike = "sngStrike";
  if (textAnchor === "middle") style.align = "center";
  if (textAnchor === "end") style.align = "right";
  return {
    type: "text",
    id: textNode.getAttribute("id") ?? textNode.getAttribute("data-id") ?? nextId("svg-text"),
    text,
    ...box,
    style
  };
}

function svgLineElementFromEndpoints(node, idPrefix, svgBox, viewBox, points) {
  const start = svgBoxToSlideBox(svgBox, viewBox, { x: points.x1, y: points.y1, w: 0, h: 0 });
  const end = svgBoxToSlideBox(svgBox, viewBox, { x: points.x2, y: points.y2, w: 0, h: 0 });
  const id = node.getAttribute("id") ?? node.getAttribute("data-id") ?? nextId(idPrefix);
  const line = lineElement(id, { x: start.x, y: start.y, w: roundInches(end.x - start.x), h: roundInches(end.y - start.y) }, true);
  line.style = svgLineStyle(node, viewBox, svgBox);
  return line;
}

function parseSvgPoints(value) {
  const numbers = String(value ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 4 || numbers.length % 2 !== 0 || numbers.some((number) => !Number.isFinite(number))) return [];
  const points = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

function svgPolylineSegmentElement(polyline, svgBox, viewBox, start, end, index) {
  const baseId = polyline.getAttribute("id") ?? polyline.getAttribute("data-id");
  const line = svgLineElementFromEndpoints(polyline, "svg-polyline", svgBox, viewBox, {
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y
  });
  if (baseId) line.id = `${baseId}-segment-${index + 1}`;
  return line;
}

function isStrokeOnlySvgShape(node) {
  const fill = String(node.getAttribute("fill") ?? "none").trim().toLowerCase();
  return !fill || fill === "none" || fill === "transparent";
}

function svgPrimitiveShapeElements(slideNode) {
  const elements = [];
  const svgs = slideNode.querySelectorAll("svg");
  for (const svg of svgs) {
    const svgBox = parseCoords(svg);
    const viewBox = parseSvgViewBox(svg);
    if (!svgBox || !viewBox) continue;
    for (const circle of svg.querySelectorAll("circle")) {
      const cx = parseSvgNumber(circle.getAttribute("cx"));
      const cy = parseSvgNumber(circle.getAttribute("cy"));
      const r = parseSvgNumber(circle.getAttribute("r"));
      if (![cx, cy, r].every((value) => Number.isFinite(value)) || r <= 0) continue;
      const box = svgBoxToSlideBox(svgBox, viewBox, { x: cx - r, y: cy - r, w: r * 2, h: r * 2 });
      elements.push({
        type: "shape",
        id: circle.getAttribute("id") ?? circle.getAttribute("data-id") ?? nextId("svg-circle"),
        shape: "ellipse",
        ...box,
        style: svgShapeStyle(circle, viewBox, svgBox)
      });
    }
    for (const ellipse of svg.querySelectorAll("ellipse")) {
      const cx = parseSvgNumber(ellipse.getAttribute("cx"));
      const cy = parseSvgNumber(ellipse.getAttribute("cy"));
      const rx = parseSvgNumber(ellipse.getAttribute("rx"));
      const ry = parseSvgNumber(ellipse.getAttribute("ry"));
      if (![cx, cy, rx, ry].every((value) => Number.isFinite(value)) || rx <= 0 || ry <= 0) continue;
      const box = svgBoxToSlideBox(svgBox, viewBox, { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 });
      elements.push({
        type: "shape",
        id: ellipse.getAttribute("id") ?? ellipse.getAttribute("data-id") ?? nextId("svg-ellipse"),
        shape: "ellipse",
        ...box,
        style: svgShapeStyle(ellipse, viewBox, svgBox)
      });
    }
    for (const rect of svg.querySelectorAll("rect")) {
      const x = parseSvgNumber(rect.getAttribute("x")) ?? 0;
      const y = parseSvgNumber(rect.getAttribute("y")) ?? 0;
      const w = parseSvgNumber(rect.getAttribute("width"));
      const h = parseSvgNumber(rect.getAttribute("height"));
      if (!(w > 0 && h > 0)) continue;
      const rx = parseSvgNumber(rect.getAttribute("rx")) ?? 0;
      const ry = parseSvgNumber(rect.getAttribute("ry")) ?? 0;
      const box = svgBoxToSlideBox(svgBox, viewBox, { x, y, w, h });
      elements.push({
        type: "shape",
        id: rect.getAttribute("id") ?? rect.getAttribute("data-id") ?? nextId("svg-rect"),
        shape: rx > 0 || ry > 0 ? "roundRect" : "rect",
        ...box,
        style: svgShapeStyle(rect, viewBox, svgBox)
      });
    }
    for (const svgLine of svg.querySelectorAll("line")) {
      const x1 = parseSvgNumber(svgLine.getAttribute("x1")) ?? 0;
      const y1 = parseSvgNumber(svgLine.getAttribute("y1")) ?? 0;
      const x2 = parseSvgNumber(svgLine.getAttribute("x2")) ?? 0;
      const y2 = parseSvgNumber(svgLine.getAttribute("y2")) ?? 0;
      if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) continue;
      elements.push(svgLineElementFromEndpoints(svgLine, "svg-line", svgBox, viewBox, { x1, y1, x2, y2 }));
    }
    for (const polyline of svg.querySelectorAll("polyline")) {
      const points = parseSvgPoints(polyline.getAttribute("points"));
      if (points.length < 2) continue;
      for (let index = 0; index < points.length - 1; index += 1) {
        elements.push(svgPolylineSegmentElement(polyline, svgBox, viewBox, points[index], points[index + 1], index));
      }
    }
    for (const polygon of svg.querySelectorAll("polygon")) {
      if (!isStrokeOnlySvgShape(polygon)) continue;
      const points = parseSvgPoints(polygon.getAttribute("points"));
      if (points.length < 3) continue;
      for (let index = 0; index < points.length; index += 1) {
        elements.push(svgPolylineSegmentElement(polygon, svgBox, viewBox, points[index], points[(index + 1) % points.length], index));
      }
    }
    for (const svgText of svg.querySelectorAll("text")) {
      const element = svgTextElement(svgText, svgBox, viewBox);
      if (element) elements.push(element);
    }
  }
  return elements;
}

function svgPathLineElements(slideNode) {
  const elements = [];
  const paths = slideNode.querySelectorAll("svg path[d]");
  for (const path of paths) {
    const parsed = parseSimpleSvgLinePath(path.getAttribute("d"));
    if (!parsed) continue;
    const svg = path.parentNode;
    if (!svg || String(svg.tagName).toLowerCase() !== "svg") continue;
    const svgBox = parseCoords(svg);
    const viewBox = parseSvgViewBox(svg);
    if (!svgBox) continue;
    const id = path.getAttribute("id") ?? path.getAttribute("data-id") ?? nextId("svg-line");
    if (!viewBox) {
      elements.push(lineElement(id, svgBox, true, path));
      continue;
    }
    elements.push(svgLineElementFromEndpoints(path, "svg-line", svgBox, viewBox, parsed));
  }
  return elements;
}

// SVG is deliberately handled as a small, auditable subset.  A geometry that
// cannot be represented without guessing is kept as an SVG media part; an SVG
// with effects or references that could execute/load content is routed through
// the existing localized raster fallback gate.
function svgStyleDeclarations(node) {
  const style = {};
  const raw = String(node?.getAttribute?.("style") ?? "");
  for (const declaration of raw.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const key = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (key && value) style[key] = value;
  }
  return style;
}

function svgAttributeOrStyle(node, name, inherited = null) {
  const declarations = svgStyleDeclarations(node);
  const styleValue = declarations[name] ?? declarations[name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)];
  const attributeValue = node?.getAttribute?.(name);
  return styleValue ?? attributeValue ?? inherited;
}

function svgColor(value, fallback = null) {
  const source = String(value ?? "").trim();
  if (!source || source.toLowerCase() === "none" || source.toLowerCase() === "transparent") return null;
  if (source.toLowerCase() === "currentcolor") return fallback;
  const normalized = normalizeHex(source);
  if (normalized) return normalized;
  const rgb = source.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (rgb) {
    const channels = rgb.slice(1, 4).map((channel) => Math.max(0, Math.min(255, Number(channel))));
    return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }
  const named = {
    black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#008000", blue: "#0000FF",
    yellow: "#FFFF00", gray: "#808080", grey: "#808080", orange: "#FFA500", purple: "#800080"
  };
  return named[source.toLowerCase()] ?? fallback;
}

function svgOpacity(value, fallback = 1) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? clamp01(number) : fallback;
}

function svgNodeStyle(node, inherited = {}, metadataNode = null) {
  const computed = metadataNode?.style && typeof metadataNode.style === "object" ? metadataNode.style : {};
  const fill = svgColor(svgAttributeOrStyle(node, "fill", computed.fill ?? inherited.fill), inherited.fill ?? "#000000");
  const stroke = svgColor(svgAttributeOrStyle(node, "stroke", computed.stroke ?? inherited.stroke), inherited.stroke);
  const ancestorOpacity = inherited.opacity ?? 1;
  const ownOpacity = svgOpacity(svgAttributeOrStyle(node, "opacity", computed.opacity ?? 1), 1);
  const fillOpacity = svgOpacity(Number.isFinite(Number(computed.fillOpacity))
    ? computed.fillOpacity
    : svgAttributeOrStyle(node, "fill-opacity", inherited.fillOpacity ?? 1), inherited.fillOpacity ?? 1);
  const strokeOpacity = svgOpacity(Number.isFinite(Number(computed.strokeOpacity))
    ? computed.strokeOpacity
    : svgAttributeOrStyle(node, "stroke-opacity", inherited.strokeOpacity ?? 1), inherited.strokeOpacity ?? 1);
  const fontSize = Number.parseFloat(String(svgAttributeOrStyle(node, "font-size", computed.fontSize ?? inherited.fontSize ?? 16)));
  const strokeWidth = Number.parseFloat(String(svgAttributeOrStyle(node, "stroke-width", computed.strokeWidth ?? inherited.strokeWidth ?? 1)));
  return {
    ...inherited,
    fill,
    stroke,
    fillOpacity: fillOpacity * ownOpacity * ancestorOpacity,
    strokeOpacity: strokeOpacity * ownOpacity * ancestorOpacity,
    opacity: ownOpacity * ancestorOpacity,
    strokeWidth: Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 0,
    fontFamily: svgAttributeOrStyle(node, "font-family", computed.fontFamily ?? inherited.fontFamily ?? "Arial"),
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : (inherited.fontSize ?? 16),
    fontWeight: svgAttributeOrStyle(node, "font-weight", computed.fontWeight ?? inherited.fontWeight ?? 400),
    fontStyle: svgAttributeOrStyle(node, "font-style", computed.fontStyle ?? inherited.fontStyle ?? "normal"),
    textAnchor: svgAttributeOrStyle(node, "text-anchor", computed.textAnchor ?? inherited.textAnchor ?? "start"),
    textDecoration: svgAttributeOrStyle(node, "text-decoration", computed.textDecoration ?? inherited.textDecoration ?? "none")
  };
}

function svgMatrixIdentity() {
  return [1, 0, 0, 1, 0, 0];
}

function svgMatrixMultiply(left, right) {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f
  ];
}

function svgTransformMatrix(value) {
  const source = String(value ?? "").trim();
  if (!source || source === "none") return svgMatrixIdentity();
  const matrixMatch = source.match(/^matrix\(\s*([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)\s*\)$/i);
  if (matrixMatch) {
    const matrix = matrixMatch.slice(1).map(Number);
    return matrix.every(Number.isFinite) ? matrix : null;
  }
  let matrix = svgMatrixIdentity();
  const matches = [...source.matchAll(/(translate|scale|rotate)\s*\(([^)]*)\)/gi)];
  if (matches.length === 0 || matches.map((match) => match[0]).join("").replace(/\s+/g, "") !== source.replace(/\s+/g, "")) return null;
  for (const match of matches) {
    const command = match[1].toLowerCase();
    const values = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (values.some((value) => !Number.isFinite(value))) return null;
    let next = svgMatrixIdentity();
    if (command === "translate") {
      if (values.length < 1 || values.length > 2) return null;
      next = [1, 0, 0, 1, values[0], values[1] ?? 0];
    } else if (command === "scale") {
      if (values.length < 1 || values.length > 2) return null;
      next = [values[0], 0, 0, values[1] ?? values[0], 0, 0];
    } else if (command === "rotate") {
      if (![1, 3].includes(values.length)) return null;
      const angle = values[0] * Math.PI / 180;
      const rotation = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
      if (values.length === 3) {
        const [cx, cy] = values.slice(1);
        next = svgMatrixMultiply(svgMatrixMultiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
      } else next = rotation;
    }
    matrix = svgMatrixMultiply(matrix, next);
  }
  return matrix;
}

function svgTransformAngle(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 6) return 0;
  const [a, b, c, d] = matrix;
  const scaleX = Math.hypot(a, b);
  const determinant = a * d - b * c;
  const orthogonality = scaleX > 0 ? (a * c + b * d) / scaleX : 0;
  if (!Number.isFinite(scaleX) || !Number.isFinite(determinant) || Math.abs(orthogonality) > 0.0005) return null;
  const angle = Math.atan2(b, a) * 180 / Math.PI;
  return Math.round(angle * 100) / 100;
}

function svgTransformPoint(matrix, point) {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]
  };
}

function svgTransformedBounds(points, svgBox, viewBox) {
  const mapped = points.map((point) => svgBoxToSlideBox(svgBox, viewBox, { x: point.x, y: point.y, w: 0, h: 0 }));
  const xs = mapped.map((point) => point.x);
  const ys = mapped.map((point) => point.y);
  return {
    points: mapped,
    box: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(0.001, Math.max(...xs) - Math.min(...xs)),
      h: Math.max(0.001, Math.max(...ys) - Math.min(...ys))
    }
  };
}

function svgNativeStyle(style, isLine = false) {
  const transparency = Math.round((1 - (isLine ? style.strokeOpacity : style.fillOpacity)) * 100);
  const result = isLine
    ? { color: style.stroke ?? "#000000", width: Math.max(0.25, style.strokeWidth * 0.75) }
    : {
      fill: style.fill ?? "#000000",
      backgroundColor: style.fill ?? "#000000",
      transparency: style.fill ? transparency : 100,
      borderColor: style.stroke ?? style.fill ?? "#000000",
      borderWidth: style.stroke ? Math.max(0.25, style.strokeWidth * 0.75) : 0
    };
  if (transparency > 0) result.transparency = transparency;
  return result;
}

function svgPathPoints(value) {
  const source = String(value ?? "").trim();
  if (!source) return null;
  const matches = [...source.matchAll(/([MmLlHhVvZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi)];
  if (matches.length === 0 || matches.map((match) => match[0]).join("").replace(/[\s,]+/g, "") !== source.replace(/[\s,]+/g, "")) return null;
  let command = null;
  let cursor = { x: 0, y: 0 };
  let start = null;
  const points = [];
  let index = 0;
  while (index < matches.length) {
    if (matches[index][1]) {
      command = matches[index][1];
      index += 1;
    }
    if (!command) return null;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    if (upper === "Z") {
      if (start) points.push({ ...start, close: true });
      cursor = start ?? cursor;
      command = null;
      continue;
    }
    const first = Number(matches[index][2]);
    const second = Number(matches[index + 1]?.[2]);
    if (!Number.isFinite(first)) return null;
    let point;
    if (upper === "H") point = { x: relative ? cursor.x + first : first, y: cursor.y };
    else if (upper === "V") point = { x: cursor.x, y: relative ? cursor.y + first : first };
    else {
      if (!Number.isFinite(second)) return null;
      point = { x: relative ? cursor.x + first : first, y: relative ? cursor.y + second : second };
    }
    cursor = point;
    if (!start) start = { ...point };
    points.push(point);
    index += upper === "H" || upper === "V" ? 1 : 2;
  }
  return points.length >= 2 ? points : null;
}

function svgSourceSafety(source) {
  const value = String(source ?? "");
  const reasons = new Set();
  if (!value.trim()) reasons.add("missing-svg-source");
  if (/<\s*(?:script|foreignObject|iframe|object|embed|filter|mask|clipPath|animate|animateMotion|animateTransform|set)\b/i.test(value)) reasons.add("unsupported-compositing");
  if (/<\s*(?:image|use)\b[^>]*(?:href|xlink:href|src)\s*=\s*["'](?!#|data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,)[^"']+/i.test(value)) reasons.add("external-reference");
  if (/(?:filter|mask|clip-path)\s*=\s*["'][^"']*["']/i.test(value) || /\b(?:filter|mask|clip-path)\s*:/i.test(value)) reasons.add("unsupported-compositing");
  if (/@import\b|url\(\s*(['"]?)(?:https?:|file:|\/|\.\.?\/)/i.test(value)) reasons.add("external-reference");
  if (/\bon[a-z]+\s*=|javascript:/i.test(value)) reasons.add("script-reference");
  return [...reasons].sort();
}

function svgClassification(node, measurement) {
  if (!node || String(node.tagName ?? "").toLowerCase() !== "svg") return null;
  const metadata = measurement?.svg && typeof measurement.svg === "object" ? measurement.svg : {};
  const source = String(metadata.source ?? node.toString?.() ?? "");
  const safety = svgSourceSafety(source);
  if (safety.length > 0) return { mode: "raster-fallback", reasons: safety, source };
  const mode = metadata.tier === "B"
    ? "native"
    : ["native", "vector-preserved", "raster-fallback"].includes(metadata.mode)
    ? metadata.mode
    : "vector-preserved";
  return { mode, reasons: Array.isArray(metadata.reasons) ? metadata.reasons : [], source, metadata };
}

function unsafeSvgAssetSource(src) {
  const value = String(src ?? "").trim();
  if (!value) return "missing-image-src";
  if (/^(?:https?:|file:)/i.test(value)) return "external-reference";
  if (value.split(/[?#]/, 1)[0].split(/[\\/]+/).includes("..")) return "path-traversal";
  return null;
}

function svgImageMetadata(src) {
  const value = String(src ?? "").trim();
  const isSvg = /^data:image\/svg\+xml(?:;base64)?,/i.test(value) || /\.svg(?:[?#].*)?$/i.test(value);
  return isSvg ? { vectorPreserved: true, mediaKind: "svg", vectorSource: "local-svg" } : {};
}

function svgVectorImageElement(id, measurement, classification) {
  const source = classification?.source;
  if (!source || classification.mode === "raster-fallback") return null;
  const src = `data:image/svg+xml;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  return {
    type: "image",
    id,
    src,
    ...measuredBox(measurement),
    vectorPreserved: true,
    mediaKind: "svg",
    vectorSource: "inline-svg",
    alt: id,
    ...(classification.metadata?.semantic ? { svgSemantic: { ...classification.metadata.semantic } } : {}),
    ...(cssCombinedTransparency(cssStyle(measurement)) !== null
      ? { transparency: cssCombinedTransparency(cssStyle(measurement)) }
      : {})
  };
}

function svgNativeElements(node, measurement, classification) {
  if (!node || classification?.mode !== "native") return [];
  const svgBox = measuredBox(measurement);
  const viewBox = parseSvgViewBox(node);
  if (!viewBox) return [];
  const metadataNodes = classification.metadata?.nodes ?? [];
  const tier = classification.metadata?.tier ?? "A";
  let ordinal = 0;
  const native = [];
  const walk = (current, inheritedStyle, inheritedMatrix) => {
    const tag = String(current.tagName ?? "").toLowerCase();
    const metadataNode = metadataNodes.find((entry) => entry.index === ordinal) ?? null;
    ordinal += 1;
    const style = svgNodeStyle(current, inheritedStyle, metadataNode);
    const localMatrix = svgTransformMatrix(current.getAttribute?.("transform") ?? metadataNode?.computedTransform);
    if (!localMatrix) return false;
    const matrix = svgMatrixMultiply(inheritedMatrix, localMatrix);
    if (["svg", "g", "defs", "style", "title", "desc"].includes(tag)) {
      if (tier === "B" && tag === "g"
        && !current.getAttribute?.("id")
        && !current.getAttribute?.("data-pptx-id")
        && !current.getAttribute?.("data-id")
        && !current.getAttribute?.("data-pptx-group")
        && !current.getAttribute?.("data-pptx-kind")) return false;
      for (const child of current.childNodes ?? []) {
        if (child?.tagName && !walk(child, style, matrix)) return false;
      }
      return true;
    }
    const stableId = current.getAttribute?.("data-pptx-id") ?? current.getAttribute?.("data-id") ?? current.getAttribute?.("id") ?? null;
    if (tier === "B" && !stableId) return false;
    const baseId = stableId ?? `${measurement.id}-svg-${ordinal}`;
    const angle = svgTransformAngle(matrix);
    if (angle === null) return false;
    const point = (x, y) => svgTransformPoint(matrix, { x, y });
    const addLine = (start, end, suffix = "") => {
      const mapped = svgTransformedBounds([start, end], svgBox, viewBox);
      const line = lineElement(`${baseId}${suffix}`, {
        x: mapped.points[0].x,
        y: mapped.points[0].y,
        w: roundInches(mapped.points[1].x - mapped.points[0].x),
        h: roundInches(mapped.points[1].y - mapped.points[0].y)
      }, true, current);
      line.style = svgNativeStyle(style, true);
      if (suffix) line.semanticParentId = baseId;
      native.push(line);
    };
    if (tag === "line") {
      addLine(point(parseSvgNumber(current.getAttribute("x1")) ?? 0, parseSvgNumber(current.getAttribute("y1")) ?? 0), point(parseSvgNumber(current.getAttribute("x2")) ?? 0, parseSvgNumber(current.getAttribute("y2")) ?? 0));
      return true;
    }
    if (["polyline", "polygon"].includes(tag)) {
      const points = parseSvgPoints(current.getAttribute("points"));
      if (points.length < 2) return false;
      const transformed = points.map(({ x, y }) => point(x, y));
      const isClosed = tag === "polygon";
      if (style.fill && style.fill !== "none" && isClosed) return false;
      for (let index = 0; index < transformed.length - (isClosed ? 0 : 1); index += 1) {
        addLine(transformed[index], transformed[(index + 1) % transformed.length], `-segment-${index + 1}`);
      }
      return true;
    }
    if (["circle", "ellipse", "rect"].includes(tag)) {
      const x = parseSvgNumber(current.getAttribute("x")) ?? 0;
      const y = parseSvgNumber(current.getAttribute("y")) ?? 0;
      const width = tag === "circle" ? (parseSvgNumber(current.getAttribute("r")) ?? 0) * 2 : tag === "ellipse" ? (parseSvgNumber(current.getAttribute("rx")) ?? 0) * 2 : parseSvgNumber(current.getAttribute("width")) ?? 0;
      const height = tag === "circle" ? (parseSvgNumber(current.getAttribute("r")) ?? 0) * 2 : tag === "ellipse" ? (parseSvgNumber(current.getAttribute("ry")) ?? 0) * 2 : parseSvgNumber(current.getAttribute("height")) ?? 0;
      if (!(width > 0 && height > 0)) return false;
      const corners = [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
      const mapped = svgTransformedBounds(corners, svgBox, viewBox);
      native.push({
        type: "shape",
        id: baseId,
        shape: tag === "rect" && ((parseSvgNumber(current.getAttribute("rx")) ?? 0) > 0 || (parseSvgNumber(current.getAttribute("ry")) ?? 0) > 0) ? "roundRect" : tag === "rect" ? "rect" : "ellipse",
        ...mapped.box,
        ...(Math.abs(angle) > 0.01 ? { rotate: angle } : {}),
        style: svgNativeStyle(style)
      });
      return true;
    }
    if (tag === "path") {
      const points = svgPathPoints(current.getAttribute("d"));
      if (!points || points.length < 2) return false;
      const transformed = points.filter((entry) => !entry.close).map(({ x, y }) => point(x, y));
      const closed = points.some((entry) => entry.close);
      if (style.fill && closed) return false;
      for (let index = 0; index < transformed.length - 1; index += 1) addLine(transformed[index], transformed[index + 1], `-segment-${index + 1}`);
      if (closed) addLine(transformed.at(-1), transformed[0], "-segment-close");
      return true;
    }
    if (tag === "text") {
      const text = String(current.text ?? current.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text) return true;
      const x = parseSvgNumber(current.getAttribute("x")) ?? 0;
      const baseline = parseSvgNumber(current.getAttribute("y")) ?? style.fontSize;
      const anchor = String(style.textAnchor ?? "start").toLowerCase();
      const textWidth = Math.max(style.fontSize, text.length * style.fontSize * 0.58);
      const localX = anchor === "middle" ? x - textWidth / 2 : anchor === "end" ? x - textWidth : x;
      const mapped = svgTransformedBounds([point(localX, baseline - style.fontSize), point(localX + textWidth, baseline + style.fontSize * 0.2)], svgBox, viewBox);
      const textStyle = {
        color: style.fill ?? "#000000",
        fontSize: Math.round(style.fontSize * (svgBox.h / viewBox.h) * 72 * 100) / 100,
        fontFamily: String(style.fontFamily ?? "Arial").replace(/^['"]|['"]$/g, ""),
        fontWeight: /bold|bolder/i.test(String(style.fontWeight)) || Number(style.fontWeight) >= 700 ? 700 : Number(style.fontWeight) || 400,
        italic: /italic|oblique/i.test(String(style.fontStyle)),
        margin: 0,
        ...(anchor === "middle" ? { align: "center" } : anchor === "end" ? { align: "right" } : {}),
        ...(style.textDecoration && /underline/i.test(String(style.textDecoration)) ? { underline: { style: "sng" } } : {}),
        ...(style.fill ? { transparency: Math.round((1 - style.fillOpacity) * 100) } : {})
      };
      native.push({ type: "text", id: baseId, text, ...mapped.box, ...(Math.abs(angle) > 0.01 ? { rotate: angle } : {}), style: textStyle });
      return true;
    }
    return false;
  };
  const success = walk(node, {}, svgMatrixIdentity());
  return success ? native : [];
}

export function layoutCards(cards, cols, startY, slideHeight) {
  const colCount = Math.max(1, cols);
  const gap = 0.45;
  const availableWidth = CONTENT_WIDTH - gap * (colCount - 1);
  const cardWidth = availableWidth / colCount;
  const rows = Math.ceil(cards.length / colCount);
  const remaining = slideHeight - startY - 0.5;
  const maxCardHeight = (remaining - gap * (rows - 1)) / rows;
  const requiredCardHeight = cards.reduce(
    (maximum, card) => Math.max(maximum, estimateCardHeight(card, cardWidth)),
    1.55
  );
  const cardHeight = Math.min(requiredCardHeight, maxCardHeight);
  const positioned = [];

  cards.forEach((card, index) => {
    const row = Math.floor(index / colCount);
    const col = index % colCount;
    const x = MARGIN + col * (cardWidth + gap);
    const y = startY + row * (cardHeight + gap);
    positioned.push({ card, box: { x, y, w: cardWidth, h: cardHeight } });
  });

  const bottomY = startY + rows * cardHeight + Math.max(0, rows - 1) * gap;
  return { items: positioned, bottomY };
}

function estimatedTextHeight(text, width, options = {}) {
  const value = String(text ?? "");
  const fontSize = options.fontSize ?? 12;
  const lineHeight = options.lineHeight ?? 1.35;
  const boldFactor = options.bold ? 1.1 : 1;
  const availableWidthPt = Math.max(0.25, width) * 72;
  const measuredWidth = (content) => [...String(content ?? "")].reduce(
    (total, char) => total + (/[　-〿぀-ヿ一-鿿＀-￯]/.test(char) ? 1 : 0.55) * fontSize * boldFactor,
    0
  );
  const paragraphs = value.split("\n");
  const lines = paragraphs.reduce((total, paragraph) => {
    const segments = /\s/.test(paragraph) ? (paragraph.match(/\S+\s*|\s+/g) ?? [paragraph]) : [...paragraph];
    let current = "";
    let paragraphLines = 1;
    for (const segment of segments) {
      const candidate = `${current}${segment}`;
      if (current && measuredWidth(candidate) > availableWidthPt) {
        paragraphLines += 1;
        current = segment.trimStart();
      } else {
        current = candidate;
      }
    }
    return total + paragraphLines;
  }, 0);
  return Math.max(fontSize / 72 * lineHeight, lines * (fontSize / 72) * lineHeight + 0.05);
}

function estimateCardHeight(cardNode, cardWidth) {
  if (!cardNode || typeof cardNode.querySelector !== "function" || typeof cardNode.querySelectorAll !== "function") {
    return 1.55;
  }
  const padding = 0.2;
  const innerW = Math.max(0.25, cardWidth - padding * 2);
  let height = padding * 2;
  const heading = cardNode.querySelector("h3") ?? cardNode.querySelector("h2");
  if (heading) height += estimatedTextHeight(textContent(heading), innerW, { fontSize: 18, lineHeight: 1.2, bold: true }) + 0.08;
  const metric = cardNode.querySelector(".metric, [data-metric]");
  if (metric) height += estimatedTextHeight(textContent(metric), innerW, { fontSize: 28, lineHeight: 1 }) + 0.05;
  const paragraphs = cardNode.querySelectorAll("p").filter((p) => {
    const cls = p.getAttribute("class") ?? "";
    return !cls.split(/\s+/).includes("metric") && !p.getAttribute("data-metric");
  });
  for (const paragraph of paragraphs) {
    height += estimatedTextHeight(textContent(paragraph), innerW, { fontSize: 16, lineHeight: 1.35 }) + 0.05;
  }
  const listItems = cardNode.querySelectorAll("li");
  if (listItems.length > 0) {
    for (const item of listItems) {
      height += estimatedTextHeight(`• ${textContent(item)}`, innerW, { fontSize: 16, lineHeight: 1.35 }) + (16 / 72) * 0.35;
    }
  }
  return height;
}

function cardInnerElements(cardNode, outerBox, shapeId = nextId("card")) {
  const elements = [];
  elements.push(applyNodeLayoutSemantics(shapeElement(shapeId, outerBox, "{components.content-card}"), cardNode));

  const padding = 0.2;
  let cursorY = outerBox.y + padding;
  const innerW = outerBox.w - padding * 2;
  const innerX = outerBox.x + padding;

  const heading = cardNode.querySelector("h3") ?? cardNode.querySelector("h2");
  if (heading) {
    const h = estimatedTextHeight(textContent(heading), innerW, { fontSize: 18, lineHeight: 1.2, bold: true });
    elements.push(
      applyNodeLayoutSemantics(textElement(nextId("card-title"), textContent(heading), { x: innerX, y: cursorY, w: innerW, h }, "h3", "{colors.primary}", {
        role: "card-title",
        semanticParentId: shapeId,
        style: { fontSize: 18, lineHeight: 1.2, bold: true, margin: 0 }
      }), heading)
    );
    cursorY += h + 0.08;
  }

  const metric = cardNode.querySelector(".metric, [data-metric]");
  if (metric) {
    const h = estimatedTextHeight(textContent(metric), innerW, { fontSize: 28, lineHeight: 1 });
    elements.push(
      applyNodeLayoutSemantics(textElement(nextId("card-metric"), textContent(metric), { x: innerX, y: cursorY, w: innerW, h }, "metric", "{colors.text}", {
        role: "card-metric",
        semanticParentId: shapeId,
        style: { fontSize: 28, lineHeight: 1, bold: true, margin: 0 }
      }), metric)
    );
    cursorY += h + 0.05;
  }

  const paragraphs = cardNode.querySelectorAll("p").filter((p) => {
    const cls = p.getAttribute("class") ?? "";
    return !cls.split(/\s+/).includes("metric") && !p.getAttribute("data-metric");
  });
  for (const paragraph of paragraphs) {
    const h = estimatedTextHeight(textContent(paragraph), innerW, { fontSize: 16, lineHeight: 1.35 });
    elements.push(
      applyNodeLayoutSemantics(textElement(nextId("card-body"), textContent(paragraph), { x: innerX, y: cursorY, w: innerW, h }, "body", "{colors.textMuted}", {
        role: "body",
        semanticParentId: shapeId,
        style: { fontSize: 16, lineHeight: 1.35, margin: 0 }
      }), paragraph)
    );
    cursorY += h + 0.05;
  }

  const listItems = cardNode.querySelectorAll("li");
  if (listItems.length > 0) {
    const listParentId = cardNode.querySelector("ul,ol")?.getAttribute("data-pptx-id") ?? `${shapeId}-list`;
    for (const [index, item] of [...listItems].entries()) {
      const value = `• ${textContent(item)}`;
      const required = estimatedTextHeight(value, innerW, { fontSize: 16, lineHeight: 1.35 });
      elements.push(applyNodeLayoutSemantics(textElement(
        item.getAttribute("data-pptx-id") ?? item.getAttribute("data-id") ?? nextId("card-list-item"),
        value,
        { x: innerX, y: cursorY, w: innerW, h: required },
        "body",
        "{colors.text}",
        { role: "list-item", semanticParentId: shapeId, listParentId, listIndex: index, style: { fontSize: 16, lineHeight: 1.35, margin: 0 } }
      ), item));
      cursorY += required + (16 / 72) * 0.35;
    }
  }

  return elements;
}

function classSet(node) {
  return new Set((node?.getAttribute?.("class") ?? "").split(/\s+/).filter(Boolean));
}

function isLayoutContainer(node) {
  if (!node || !node.tagName) return false;
  const classes = classSet(node);
  return node.getAttribute?.("data-cards") !== undefined
    || ["cards", "panes", "layers", "grid-2", "grid-3", "phases"].some((name) => classes.has(name));
}

function layoutContainerColumns(node) {
  const explicit = Number(node?.getAttribute?.("data-cols"));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const classes = classSet(node);
  if (classes.has("grid-3") || classes.has("layers")) return 3;
  if (classes.has("phases")) return 4;
  return 2;
}

function directElementChildren(node) {
  return (node?.childNodes ?? []).filter((child) => child?.tagName);
}

function hasAncestor(node, predicate, stopNode) {
  let cursor = node?.parentNode;
  while (cursor && cursor !== stopNode) {
    if (predicate(cursor)) return true;
    cursor = cursor.parentNode;
  }
  return false;
}

function isSubtitleNode(node) {
  return classSet(node).has("subtitle") || node?.getAttribute?.("data-subtitle") !== undefined;
}

function isCardNode(node) {
  return classSet(node).has("card") || node?.getAttribute?.("data-card") !== undefined;
}

function appendUnmappedSemanticText(slideNode, elements, startY) {
  let cursorY = startY;
  const candidates = slideNode.querySelectorAll("h2,h3,p,li,blockquote,div,span");
  for (const node of candidates) {
    if (isSubtitleNode(node)) continue;
    if (hasAncestor(node, isLayoutContainer, slideNode)) continue;
    if (hasAncestor(node, isCardNode, slideNode)) continue;
    if (hasAncestor(node, (ancestor) => ["ul", "ol"].includes(String(ancestor.tagName).toLowerCase()), slideNode)) continue;
    if (hasAncestor(node, (ancestor) => String(ancestor.tagName).toLowerCase() === "table", slideNode)) continue;
    if (String(node.tagName).toLowerCase() === "blockquote" && node.querySelector("p,li,h2,h3")) continue;
    if (["div", "span"].includes(String(node.tagName).toLowerCase()) && (node.childNodes ?? []).some((child) => child?.tagName)) continue;
    const value = textContent(node);
    if (!value) continue;
    const tag = String(node.tagName).toLowerCase();
    const typography = tag === "h2" || tag === "h3" ? "heading" : "body";
    const prefix = tag === "li" ? "• " : "";
    const h = tag === "h2" || tag === "h3"
      ? estimatedTextHeight(value, CONTENT_WIDTH, { fontSize: 22, lineHeight: 1.25, bold: true })
      : estimatedTextHeight(`${prefix}${value}`, CONTENT_WIDTH, { fontSize: 16, lineHeight: 1.55 });
    const box = parseCoords(node) ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h };
    elements.push(applyNodeLayoutSemantics(textElement(nextId(tag), `${prefix}${value}`, box, typography, "{colors.text}", {
      style: tag === "h2" || tag === "h3" ? {} : { fontSize: 16 }
    }), node));
    cursorY = box.y + box.h + 0.1;
  }
  return cursorY;
}

function listItemElements(list, startY) {
  const items = list.querySelectorAll("li");
  const explicit = parseCoords(list);
  const width = explicit?.w ?? CONTENT_WIDTH;
  const x = explicit?.x ?? MARGIN;
  const ordered = String(list.tagName ?? "").toLowerCase() === "ol";
  const listParentId = list.getAttribute("data-pptx-id") ?? list.getAttribute("data-id") ?? list.getAttribute("id") ?? nextId("list-group");
  const elements = [];
  let cursorY = explicit?.y ?? startY;
  for (const [index, item] of [...items].entries()) {
    const prefix = ordered ? `${index + 1}. ` : "• ";
    const value = `${prefix}${textContent(item)}`;
    const h = estimatedTextHeight(value, width, { fontSize: 16, lineHeight: 1.35 });
    let element = textElement(
      item.getAttribute("data-pptx-id") ?? item.getAttribute("data-id") ?? item.getAttribute("id") ?? nextId("list-item"),
      value,
      { x, y: cursorY, w: width, h },
      "body",
      "{colors.text}",
      { role: "list-item", listParentId, listIndex: index, style: { fontSize: 16, lineHeight: 1.35 } }
    );
    element = applyNodeLayoutSemantics(applyNodeLayoutSemantics(element, list), item);
    elements.push(element);
    cursorY += h + (16 / 72) * 0.35;
  }
  return { elements, bottomY: cursorY };
}

function nodeLayoutRegion(node) {
  let cursor = node;
  while (cursor) {
    const value = cursor.getAttribute?.("data-layout-region");
    if (value) return value;
    cursor = cursor.parentNode;
  }
  return null;
}

function applyNodeLayoutSemantics(element, node) {
  const tagName = String(node.tagName ?? "").toLowerCase();
  const role = node.getAttribute("data-layout-role") || (tagName === "h1" ? "title" : null);
  const rawMaxLines = node.getAttribute("data-max-lines");
  const parsedMaxLines = rawMaxLines === null && tagName === "h1" ? 1 : Number(rawMaxLines);
  const maxLines = Number.isInteger(parsedMaxLines) && parsedMaxLines >= 1 && parsedMaxLines <= 2 ? parsedMaxLines : null;
  const rawSafeInset = node.getAttribute("data-safe-inset");
  const explicitSafeInset = Number(rawSafeInset);
  const safeInset = rawSafeInset !== null && Number.isFinite(explicitSafeInset) && explicitSafeInset >= 0
    ? explicitSafeInset
    : element.shape === "roundRect" ? 0.12 : null;
  const axisDirection = node.getAttribute("data-axis-direction");
  const semanticParentId = node.getAttribute("data-semantic-parent-id");
  const layoutRegion = nodeLayoutRegion(node);
  const allowOverlapWith = String(node.getAttribute("data-allow-overlap-with") || "")
    .split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const anchor = String(node.tagName ?? "").toLowerCase() === "a" ? node : node.querySelector?.("a[href]");
  const href = anchor?.getAttribute?.("href");
  const tooltip = anchor?.getAttribute?.("title") ?? anchor?.getAttribute?.("data-tooltip");
  const evidenceKind = node.getAttribute("data-evidence-kind");
  const sourceIds = [...new Set(String(node.getAttribute("data-source-ids") || "")
    .split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
  const asOf = node.getAttribute("data-as-of");
  return {
    ...element,
    ...(role ? { role } : {}),
    ...(maxLines ? { maxLines } : {}),
    ...(safeInset !== null ? { safeInset } : {}),
    ...(axisDirection ? { axisDirection } : {}),
    ...(semanticParentId ? { semanticParentId } : {}),
    ...(layoutRegion ? { layoutRegion } : {}),
    ...(allowOverlapWith.length > 0 ? { allowOverlapWith } : {}),
    ...(/^https?:\/\//i.test(String(href ?? "")) ? {
      hyperlink: { url: href, ...(tooltip ? { tooltip } : {}) }
    } : {}),
    ...(sourceIds.length > 0 ? { sourceRefs: sourceIds } : {}),
    ...(evidenceKind ? {
      evidence: {
        kind: evidenceKind,
        ...(sourceIds.length > 0 ? { sourceIds } : {}),
        ...(asOf ? { asOf } : {})
      }
    } : {})
  };
}

function convertKindElement(node, lookup, options = {}) {
  const kind = node.getAttribute("data-pptx-kind");
  const id = node.getAttribute("data-pptx-id") ?? node.getAttribute("data-id") ?? nextId(kind ?? "element");
  const coords =
    getMeasurementBox(lookup, id) ??
    parseCoords(node) ??
    null;
  if (!coords) return [];

  if (kind === "text") {
    const measurement = lookup?.get(id);
    return [
      applyNodeLayoutSemantics(measurement
        ? replicaTextElement(id, measurementWithSourceText(measurement, node), { designMode: options.designMode })
        : textElement(
          id,
          textContent(node),
          coords,
          node.getAttribute("data-typography") ?? "body",
          node.getAttribute("data-color") ?? "{colors.text}",
          (() => {
            const runs = nodeRichRuns(node);
            return runs.length > 0 ? { runs } : {};
          })()
        ), node)
    ];
  }
  if (kind === "shape") {
    const element = shapeElement(id, coords, node.getAttribute("data-component") ?? "{components.content-card}");
    const shapeOverride = shapeOverrideFromNode(node);
    if (shapeOverride) { element.shape = shapeOverride; element.shapeOverride = shapeOverride; }
    return [applyNodeLayoutSemantics(element, node)];
  }
  if (kind === "card") {
    return cardInnerElements(node, coords, id);
  }
  if (kind === "table") {
    return [applyNodeLayoutSemantics(tableElement(id, node, coords, null, lookup?.get(id)), node)];
  }
  if (kind === "line") {
    const tag = String(node.tagName ?? "").toLowerCase();
    const preserveHeight = ["line", "path", "polyline"].includes(tag) || node.getAttribute("data-connector") !== undefined;
    return [applyNodeLayoutSemantics(lineElement(id, coords, preserveHeight, node), node)];
  }
  if (kind === "image") {
    const src = node.getAttribute("src") ?? node.getAttribute("data-src");
    return src ? [applyNodeLayoutSemantics({ type: "image", id, src, ...coords }, node)] : [];
  }
  return [];
}

function convertMeasuredSlide(slideNode, lookup, slideId, options = {}) {
  const elements = [];
  const kindNodes = slideNode.querySelectorAll("[data-pptx-kind]");
  for (const node of kindNodes) {
    elements.push(...convertKindElement(node, lookup, options));
  }
  const explicitNodes = slideNode.querySelectorAll("[data-pptx-type]");
  for (const node of explicitNodes) {
    const coords = parseCoords(node);
    if (!coords) continue;
    const pptxType = node.getAttribute("data-pptx-type");
    const id = node.getAttribute("data-id") ?? nextId(pptxType);
    if (pptxType === "text") {
      const runs = nodeRichRuns(node);
      elements.push(applyNodeLayoutSemantics(textElement(
        id,
        textContent(node),
        coords,
        node.getAttribute("data-typography") ?? "body",
        "{colors.text}",
        runs.length > 0 ? { runs } : {}
      ), node));
    } else if (pptxType === "shape") {
      const element = shapeElement(id, coords, node.getAttribute("data-component") ?? "{components.content-card}");
      const shapeOverride = shapeOverrideFromNode(node);
      if (shapeOverride) { element.shape = shapeOverride; element.shapeOverride = shapeOverride; }
      elements.push(applyNodeLayoutSemantics(element, node));
    } else if (pptxType === "table") {
      elements.push(tableElement(id, node, coords, null, lookup?.get(id)));
    } else if (pptxType === "line") {
      elements.push(lineElement(id, coords, node.getAttribute("data-connector") !== undefined, node));
    } else if (pptxType === "image") {
      const src = node.getAttribute("src") ?? node.getAttribute("data-src");
      if (src) {
        elements.push({ type: "image", id, src, ...coords });
      }
    }
  }
  return {
    id: slideId,
    type: slideNode.getAttribute("data-type") ?? "content",
    title:
      slideNode.getAttribute("data-title") ??
      (() => {
        const titleNode = slideNode.querySelector("h1, [data-pptx-kind='text'][data-typography='h1']");
        return titleNode ? textContent(titleNode) : "";
      })(),
    notes: slideNode.getAttribute("data-notes") ?? "",
    background: { type: "solid", color: "{colors.background}" },
    elements
  };
}

function findNodeByMeasurementId(slideNode, id) {
  if (!id) return null;
  const escaped = String(id).replace(/"/g, '\\"');
  return (
    slideNode.querySelector(`[data-pptx-id="${escaped}"]`) ??
    slideNode.querySelector(`[data-id="${escaped}"]`) ??
    slideNode.querySelector(`[id="${escaped}"]`)
  );
}

function convertReplicaSlide(slideNode, measurements, slideIndex, slideId) {
  const layers = [];
  const slideMeasurements = measurementElementsForSlide(measurements, slideIndex);
  const slideMeasurement = measurementSlideForSlide(measurements, slideIndex);
  const slideStyle = cssStyle(slideMeasurement);
  const unsupportedEffects = [];
  const coveredMeasurementIds = new Set();
  const droppedElements = [];

  const slideBackgroundPlan = planReplicaSlideBackground(
    slideMeasurement?.replica?.backgroundImage ?? slideStyle.backgroundImage,
    slideStyle.backgroundColor,
    SLIDE_SIZE
  );
  slideBackgroundPlan.overlays = slideBackgroundPlan.overlays.map((overlay) => ({
    ...overlay,
    id: `${slideId}-${overlay.id.replace(/^__/, "")}`
  }));
  const unsupportedSlideBackgroundImage = slideBackgroundPlan.unsupported.length > 0
    ? slideBackgroundPlan.unsupported.join(", ")
    : null;
  if (
    slideMeasurement?.replica?.hasUnsupportedEffects &&
    (slideMeasurement.replica.filter ||
      slideMeasurement.replica.backdropFilter ||
      slideMeasurement.replica.clipPath ||
      unsupportedSlideBackgroundImage ||
      slideMeasurement.replica.unsupportedCompositing)
  ) {
    unsupportedEffects.push({
      elementId: "__slide-background",
      filter: slideMeasurement.replica.filter ?? null,
      backdropFilter: slideMeasurement.replica.backdropFilter ?? null,
      clipPath: slideMeasurement.replica.clipPath ?? null,
      backgroundImage: unsupportedSlideBackgroundImage,
      ...(slideMeasurement.replica.unsupportedCompositing
        ? { unsupportedCompositing: slideMeasurement.replica.unsupportedCompositing }
        : {})
    });
  }

  function addLayer(measurement, measurementIndex, layerElements) {
    const normalized = (Array.isArray(layerElements) ? layerElements : [layerElements]).map((element) => {
      if (element?.id !== measurement.id) {
        // Generated paint layers (text boxes, border sides, outlines, and
        // background tiles) remain structurally owned by their measured
        // source element so explicit groups can be rebuilt after later
        // suppression/fallback mutations without broad ID matching.
        return element && !element.semanticParentId
          ? { ...element, semanticParentId: measurement.id }
          : element;
      }
      const semantics = measurement.semantics ?? {};
      const measuredElement = {
        ...element,
        ...(semantics.role ? { role: semantics.role } : {}),
        ...(Number.isInteger(semantics.maxLines) ? { maxLines: semantics.maxLines } : {}),
        ...(Number.isFinite(Number(semantics.safeInset)) ? { safeInset: Number(semantics.safeInset) } : {}),
        ...(semantics.axisDirection ? { axisDirection: semantics.axisDirection } : {}),
        ...(semantics.semanticParentId ? { semanticParentId: semantics.semanticParentId } : {}),
        ...(semantics.layoutRegion ? { layoutRegion: semantics.layoutRegion } : {}),
        ...(semantics.listParentId ? { listParentId: semantics.listParentId } : {}),
        ...(Number.isInteger(semantics.listIndex) && semantics.listIndex >= 0 ? { listIndex: semantics.listIndex } : {}),
        ...(Array.isArray(semantics.allowOverlapWith) && semantics.allowOverlapWith.length > 0
          ? { allowOverlapWith: semantics.allowOverlapWith }
          : {}),
        ...(evidenceFromSemantics(semantics) ? { evidence: evidenceFromSemantics(semantics) } : {})
      };
      if (measurement.transform && typeof measurement.transform === "object") {
        measuredElement.transform = {
          ...measurement.transform,
          ...(Array.isArray(measurement.transform.matrix) ? { matrix: [...measurement.transform.matrix] } : {}),
          ...(measurement.transform.transformOrigin && typeof measurement.transform.transformOrigin === "object"
            ? { transformOrigin: { ...measurement.transform.transformOrigin } }
            : {})
        };
      }
      const sourceNode = findNodeByMeasurementId(slideNode, measurement.id);
      return sourceNode ? applyNodeLayoutSemantics(measuredElement, sourceNode) : measuredElement;
    });
    layers.push({
      zIndex: replicaZIndex(measurement),
      paintOrder: Number.isFinite(Number(measurement.paintOrder)) ? Number(measurement.paintOrder) : null,
      stackingContextPath: Array.isArray(measurement.stackingContextPath) ? measurement.stackingContextPath : [],
      measurementIndex,
      measurementId: measurement.id,
      pseudo: measurement.pseudo ?? null,
      pseudoOwnerId: measurement.pseudoOwnerId ?? null,
      elements: normalized
    });
  }

  for (const [measurementIndex, measurement] of slideMeasurements.entries()) {
    if (!measurement || !measurement.id || !measurement.kind) {
      droppedElements.push({
        elementId: measurement?.id ?? null,
        kind: measurement?.kind ?? null,
        reason: "missing-id-or-kind"
      });
      continue;
    }
    const box = measuredBox(measurement);
    const kind = measurement.kind;
    const hasValidSpan = kind === "line"
      ? Math.abs(box.w) > 0 || Math.abs(box.h) > 0
      : box.w > 0 && box.h > 0;
    if (![box.x, box.y, box.w, box.h].every((value) => Number.isFinite(value)) || !hasValidSpan) {
      droppedElements.push({
        elementId: measurement.id,
        kind: measurement.kind,
        reason: "invalid-measurement-box"
      });
      continue;
    }
    // An explicit group is a structural wrapper only. It contributes no
    // paint layer, but it is still covered for replica accounting before any
    // effect/fallback/unsupported-kind routing can mark it as dropped.
    if (kind === "group") {
      coveredMeasurementIds.add(measurement.id);
      continue;
    }
    const style = cssStyle(measurement);
    const sourceNode = findNodeByMeasurementId(slideNode, measurement.id);
    const svgInfo = kind === "shape" && String(measurement.tagName ?? "").toLowerCase() === "svg"
      ? svgClassification(sourceNode, measurement)
      : null;

    const unsupportedEffect = replicaUnsupportedEffect(measurement, style);
    if (unsupportedEffect) unsupportedEffects.push(unsupportedEffect);
    if (hasCssBoxShadow(style) && !parseCssBoxShadow(style.boxShadow)) {
      unsupportedEffects.push({
        elementId: measurement.id,
        boxShadow: style.boxShadow,
        reason: "unsupported-box-shadow"
      });
    }

    if (svgInfo && svgInfo.mode !== "raster-fallback") {
      const nativeElements = svgNativeElements(sourceNode, measurement, svgInfo);
      if (nativeElements.length > 0) {
        addLayer(measurement, measurementIndex, nativeElements);
        coveredMeasurementIds.add(measurement.id);
        continue;
      }
      const vectorElement = svgVectorImageElement(measurement.id, measurement, {
        ...svgInfo,
        mode: "vector-preserved"
      });
      if (vectorElement) {
        addLayer(measurement, measurementIndex, vectorElement);
        coveredMeasurementIds.add(measurement.id);
        continue;
      }
    }

    if (kind === "shape") {
      addLayer(measurement, measurementIndex, replicaPaintLayerElements(measurement.id, measurement));
      coveredMeasurementIds.add(measurement.id);
    } else if (kind === "card") {
      const cardNode = findNodeByMeasurementId(slideNode, measurement.id);
      if (cardNode) {
        const inner = cardInnerElements(cardNode, box, measurement.id).map((element) => {
          if (element.id === measurement.id && element.type === "shape") {
            return replicaPaintLayerElements(measurement.id, measurement);
          }
          return element;
        }).flat();
        addLayer(measurement, measurementIndex, inner);
      } else {
        addLayer(measurement, measurementIndex, replicaPaintLayerElements(measurement.id, measurement));
      }
      coveredMeasurementIds.add(measurement.id);
    } else if (kind === "text") {
      const layerElements = [];
      if (hasReplicaPaint(style)) {
        layerElements.push(...replicaPaintLayerElements(`${measurement.id}-box`, measurement));
      }
      const textNode = findNodeByMeasurementId(slideNode, measurement.id);
      layerElements.push(replicaTextElement(
        measurement.id,
        measurementWithSourceText(measurement, textNode),
        { designMode: "replica" }
      ));
      addLayer(measurement, measurementIndex, layerElements);
      coveredMeasurementIds.add(measurement.id);
    } else if (kind === "image") {
      if (measurement.src) {
        const unsafeSource = unsafeSvgAssetSource(measurement.src);
        if (unsafeSource) {
          unsupportedEffects.push({ elementId: measurement.id, unsupportedVisual: unsafeSource, reason: unsafeSource });
        }
        const imageLayers = replicaImageLayerElements(measurement, box).map((element) => element.type === "image"
          ? { ...element, ...svgImageMetadata(measurement.src) }
          : element);
        addLayer(measurement, measurementIndex, imageLayers);
        coveredMeasurementIds.add(measurement.id);
      } else {
        droppedElements.push({
          elementId: measurement.id,
          kind,
          reason: "missing-image-src"
        });
      }
    } else if (kind === "table") {
      const tableNode = findNodeByMeasurementId(slideNode, measurement.id);
      if (tableNode) {
        addLayer(measurement, measurementIndex, tableElement(measurement.id, tableNode, box, style, measurement));
        coveredMeasurementIds.add(measurement.id);
      } else {
        droppedElements.push({
          elementId: measurement.id,
          kind,
          reason: "table-node-not-found"
        });
      }
    } else if (kind === "line") {
      const lineNode = findNodeByMeasurementId(slideNode, measurement.id);
      const line = applyReplicaRotation(lineElement(measurement.id, box, true, lineNode), style, measurement);
      line.style = {
        ...line.style,
        color: line.style?.color ?? style.borderColor ?? style.backgroundColor ?? style.color ?? "{colors.border}",
        width: Number(line.style?.width ?? 0) > 0
          ? Number(line.style.width)
          : Number(style.borderWidth ?? 0) > 0 ? Math.max(0.25, Number(style.borderWidth) * 0.75) : 1
      };
      addLayer(measurement, measurementIndex, line);
      coveredMeasurementIds.add(measurement.id);
    } else {
      droppedElements.push({
        elementId: measurement.id,
        kind,
        reason: "unsupported-kind"
      });
    }
  }
  const measuredElements = slideMeasurements.length;
  const coveredElements = coveredMeasurementIds.size;
  const coverage = measuredElements === 0 ? 1 : Math.round((coveredElements / measuredElements) * 10000) / 10000;
  const sortedLayers = layers
    .sort((a, b) => {
      const aPaint = Number.isFinite(a.paintOrder) ? a.paintOrder : null;
      const bPaint = Number.isFinite(b.paintOrder) ? b.paintOrder : null;
      if (aPaint !== null || bPaint !== null) {
        if (aPaint === null) return -1;
        if (bPaint === null) return 1;
        if (aPaint !== bPaint) return aPaint - bPaint;
      }
      const aContext = a.stackingContextPath.join("/");
      const bContext = b.stackingContextPath.join("/");
      return aContext.localeCompare(bContext) || a.zIndex - b.zIndex || a.measurementIndex - b.measurementIndex;
    });

  // DOMSnapshot paint orders are a flat list, while CSS pseudo-elements have
  // a local sequence: owner background, ::before, owner descendants,
  // ::after. Reconcile only generated pseudo layers so unrelated stacking
  // contexts retain the browser order and the owner stays editable.
  const measurementNodes = new Map(slideMeasurements
    .map((measurement) => [measurement.id, findNodeByMeasurementId(slideNode, measurement.id)])
    .filter(([, node]) => node));
  const isDescendantOf = (candidateId, ownerId) => {
    const candidate = measurementNodes.get(candidateId);
    const owner = measurementNodes.get(ownerId);
    if (!candidate || !owner) return false;
    let cursor = candidate.parentNode;
    while (cursor && cursor !== slideNode) {
      if (cursor === owner) return true;
      cursor = cursor.parentNode;
    }
    return false;
  };
  const pseudoOwnerIds = [...new Set(sortedLayers
    .filter((layer) => layer.pseudoOwnerId)
    .map((layer) => layer.pseudoOwnerId))];
  for (const ownerId of pseudoOwnerIds) {
    const ownerLayer = sortedLayers.find((layer) => layer.measurementId === ownerId);
    if (!ownerLayer) continue;
    const beforeLayers = sortedLayers.filter((layer) => layer.pseudoOwnerId === ownerId && layer.pseudo === "before");
    const afterLayers = sortedLayers.filter((layer) => layer.pseudoOwnerId === ownerId && layer.pseudo === "after");
    const descendantLayers = sortedLayers.filter((layer) =>
      layer.measurementId !== ownerId
      && !layer.pseudoOwnerId
      && isDescendantOf(layer.measurementId, ownerId)
    );
    const block = [ownerLayer, ...beforeLayers, ...descendantLayers, ...afterLayers];
    if (block.length < 2) continue;
    const blockSet = new Set(block);
    const ownerIndex = sortedLayers.indexOf(ownerLayer);
    const removedBeforeOwner = block
      .filter((layer) => sortedLayers.indexOf(layer) >= 0 && sortedLayers.indexOf(layer) < ownerIndex)
      .length;
    const insertAt = Math.max(0, ownerIndex - removedBeforeOwner);
    const remaining = sortedLayers.filter((layer) => !blockSet.has(layer));
    remaining.splice(Math.min(insertAt, remaining.length), 0, ...block);
    sortedLayers.splice(0, sortedLayers.length, ...remaining);
  }
  const elements = [
    ...slideBackgroundPlan.overlays,
    ...sortedLayers
    .flatMap((layer) => layer.elements)
  ];

  return {
    id: slideId,
    type: slideNode.getAttribute("data-type") ?? "replica",
    title:
      slideNode.getAttribute("data-title") ??
      (() => {
        const titleNode = slideNode.querySelector("h1, [data-pptx-kind='text'][data-typography='h1']");
        return titleNode ? textContent(titleNode) : "";
      })(),
    notes: slideNode.getAttribute("data-notes") ?? "",
    background: slideBackgroundPlan.background,
    elements,
    replicaUnsupportedEffects: unsupportedEffects,
    replicaCoverage: {
      measuredElements,
      coveredElements,
      coverage,
      droppedElements,
      unsupportedEffects
    }
  };
}

function convertAutoLayoutSlide(slideNode, lookup, slideId) {
  const elements = [];
  let cursorY = 0.55;

  const h1 = slideNode.querySelector("h1");
  if (h1) {
    const titleId = h1.getAttribute("data-pptx-id") ?? nextId("title");
    const coords = getMeasurementBox(lookup, titleId) ?? parseCoords(h1);
    const box = coords ?? {
      x: MARGIN,
      y: cursorY,
      w: CONTENT_WIDTH,
      h: estimatedTextHeight(textContent(h1), CONTENT_WIDTH, { fontSize: 34, lineHeight: 1.2, bold: true })
    };
    const title = textElement(titleId, textContent(h1), box, "h1", "{colors.text}");
    const rawMaxLines = h1.getAttribute("data-max-lines");
    const parsedMaxLines = rawMaxLines === null ? 1 : Number(rawMaxLines);
    title.role = "title";
    if (Number.isInteger(parsedMaxLines) && parsedMaxLines >= 1 && parsedMaxLines <= 2) title.maxLines = parsedMaxLines;
    elements.push(title);
    cursorY = box.y + box.h + 0.15;
  }

  const subtitle = slideNode.querySelector(".subtitle, p.subtitle, [data-subtitle]");
  if (subtitle) {
    const box = parseCoords(subtitle) ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.45 };
    elements.push(textElement(nextId("subtitle"), textContent(subtitle), box, "subtitle", "{colors.textMuted}"));
    cursorY = box.y + box.h + 0.25;
  }

  const cardsContainer = slideNode.querySelector(".cards, [data-cards], .panes, .layers, .grid-2, .grid-3, .phases");
  if (cardsContainer) {
    const cols = layoutContainerColumns(cardsContainer);
    const cards = directElementChildren(cardsContainer);
    const { items, bottomY } = layoutCards([...cards], cols, cursorY, SLIDE_SIZE.height);
    for (const { card, box } of items) {
      const explicit = parseCoords(card);
      elements.push(...cardInnerElements(card, explicit ?? box));
    }
    cursorY = bottomY + 0.35;
  }

  const standaloneCards = slideNode.childNodes.filter(
    (node) =>
      node.tagName === "DIV" &&
      ((node.getAttribute("class") ?? "").split(/\s+/).includes("card") || node.getAttribute("data-card") !== undefined)
  );
  if (!cardsContainer && standaloneCards.length > 0) {
    const { items, bottomY } = layoutCards([...standaloneCards], 2, cursorY, SLIDE_SIZE.height);
    for (const { card, box } of items) {
      elements.push(...cardInnerElements(card, box));
    }
    cursorY = bottomY + 0.35;
  }

  const table = slideNode.querySelector("table");
  if (table) {
    const coords = parseCoords(table);
    const box = coords ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: Math.min(1.8, SLIDE_SIZE.height - cursorY - 0.4) };
    elements.push(tableElement(nextId("table"), table, box));
    cursorY = box.y + box.h + 0.2;
  }

  const hr = slideNode.querySelector("hr");
  if (hr) {
    const coords = parseCoords(hr);
    const box = coords ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.02 };
    elements.push(lineElement(nextId("line"), box));
  }

  const images = slideNode.querySelectorAll("img");
  for (const img of images) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const coords = parseCoords(img);
    if (!coords) continue;
    elements.push({ type: "image", id: nextId("image"), src, ...coords });
  }

  elements.push(...svgPrimitiveShapeElements(slideNode));
  elements.push(...svgPathLineElements(slideNode));

  const lists = slideNode.childNodes.filter((node) => node.tagName === "UL" || node.tagName === "OL");
  for (const list of lists) {
    const converted = listItemElements(list, cursorY);
    elements.push(...converted.elements);
    cursorY = converted.bottomY + 0.2;
  }

  cursorY = appendUnmappedSemanticText(slideNode, elements, cursorY);

  return {
    id: slideId,
    type: slideNode.getAttribute("data-type") ?? "content",
    title: h1 ? textContent(h1) : slideNode.getAttribute("data-title") ?? "",
    notes: slideNode.getAttribute("data-notes") ?? "",
    background: { type: "solid", color: "{colors.background}" },
    elements
  };
}

/**
 * Hybrid path: per-element branching. Elements with markers take the
 * measured path; unmarked siblings take the auto-layout path. The two
 * outputs are concatenated in document order.
 */
function convertHybridSlide(slideNode, lookup, slideId) {
  const elements = [];
  let cursorY = 0.55;

  // First, build a measured element set from all marked nodes.
  const measuredSlide = convertMeasuredSlide(slideNode, lookup, slideId);
  const measuredIds = new Set();
  for (const el of measuredSlide.elements) {
    el._slideId = slideId;
    elements.push(el);
    if (el.id) measuredIds.add(el.id);
  }
  // Bump cursorY past any positioned markers with y+h so unmarked siblings
  // don't visually overlap.
  for (const el of measuredSlide.elements) {
    const bottom = (el.y ?? 0) + (el.h ?? 0);
    if (bottom > cursorY) cursorY = bottom;
  }
  cursorY += 0.15;

  // Then, render auto-layout primitives that aren't already covered by a
  // marker with the same id.
  const h1 = slideNode.querySelector("h1");
  if (h1) {
    const titleId = h1.getAttribute("data-pptx-id") ?? nextId("title");
    if (!measuredIds.has(titleId)) {
      const coords = getMeasurementBox(lookup, titleId) ?? parseCoords(h1);
      const box = coords ?? {
        x: MARGIN,
        y: cursorY,
        w: CONTENT_WIDTH,
        h: estimatedTextHeight(textContent(h1), CONTENT_WIDTH, { fontSize: 34, lineHeight: 1.2, bold: true })
      };
      const el = textElement(titleId, textContent(h1), box, "h1", "{colors.text}");
      el._slideId = slideId;
      elements.push(el);
      cursorY = box.y + box.h + 0.15;
    }
  }

  const subtitle = slideNode.querySelector(".subtitle, p.subtitle, [data-subtitle]");
  if (subtitle) {
    const box = parseCoords(subtitle) ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.45 };
    const el = textElement(nextId("subtitle"), textContent(subtitle), box, "subtitle", "{colors.textMuted}");
    el._slideId = slideId;
    elements.push(el);
    cursorY = box.y + box.h + 0.25;
  }

  const cardsContainer = slideNode.querySelector(".cards, [data-cards], .panes, .layers, .grid-2, .grid-3, .phases");
  if (cardsContainer) {
    const cols = layoutContainerColumns(cardsContainer);
    const cards = directElementChildren(cardsContainer);
    const { items, bottomY } = layoutCards([...cards], cols, cursorY, SLIDE_SIZE.height);
    for (const { card, box } of items) {
      const cardId = card.getAttribute("data-pptx-id") ?? card.getAttribute("data-id");
      if (cardId && measuredIds.has(cardId)) continue;
      const explicit = parseCoords(card);
      const inner = cardInnerElements(card, explicit ?? box);
      for (const el of inner) {
        el._slideId = slideId;
        elements.push(el);
      }
    }
    cursorY = bottomY + 0.35;
  }

  const standaloneCards = slideNode.childNodes.filter(
    (node) =>
      node.tagName === "DIV" &&
      ((node.getAttribute("class") ?? "").split(/\s+/).includes("card") || node.getAttribute("data-card") !== undefined)
  );
  if (!cardsContainer && standaloneCards.length > 0) {
    const { items, bottomY } = layoutCards([...standaloneCards], 2, cursorY, SLIDE_SIZE.height);
    for (const { card, box } of items) {
      const cardId = card.getAttribute("data-pptx-id") ?? card.getAttribute("data-id");
      if (cardId && measuredIds.has(cardId)) continue;
      const inner = cardInnerElements(card, box);
      for (const el of inner) {
        el._slideId = slideId;
        elements.push(el);
      }
    }
    cursorY = bottomY + 0.35;
  }

  const table = slideNode.querySelector("table");
  if (table) {
    const tableId = table.getAttribute("data-pptx-id") ?? table.getAttribute("data-id");
    if (!tableId || !measuredIds.has(tableId)) {
      const coords = parseCoords(table);
      const box = coords ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: Math.min(1.8, SLIDE_SIZE.height - cursorY - 0.4) };
      const el = tableElement(nextId("table"), table, box);
      el._slideId = slideId;
      elements.push(el);
      cursorY = box.y + box.h + 0.2;
    }
  }

  const images = slideNode.querySelectorAll("img");
  for (const img of images) {
    const imgId = img.getAttribute("data-pptx-id") ?? img.getAttribute("data-id");
    if (imgId && measuredIds.has(imgId)) continue;
    const src = img.getAttribute("src");
    if (!src) continue;
    const coords = parseCoords(img);
    if (!coords) continue;
    const el = { type: "image", id: nextId("image"), src, ...coords };
    el._slideId = slideId;
    elements.push(el);
  }

  const lists = slideNode.childNodes.filter((node) => node.tagName === "UL" || node.tagName === "OL");
  for (const list of lists) {
    const converted = listItemElements(list, cursorY);
    for (const el of converted.elements) {
      el._slideId = slideId;
      elements.push(el);
    }
    cursorY = converted.bottomY + 0.2;
  }


  cursorY = appendUnmappedSemanticText(slideNode, elements, cursorY);

  return {
    id: slideId,
    type: slideNode.getAttribute("data-type") ?? "content",
    title: h1 ? textContent(h1) : slideNode.getAttribute("data-title") ?? "",
    notes: slideNode.getAttribute("data-notes") ?? "",
    background: { type: "solid", color: "{colors.background}" },
    elements
  };
}

function stableNodeId(node) {
  const value = node?.getAttribute?.("data-pptx-id")
    ?? node?.getAttribute?.("data-id")
    ?? node?.getAttribute?.("id");
  const id = String(value ?? "").trim();
  return id || null;
}

function explicitChartMarker(node) {
  const id = stableNodeId(node);
  let spec = null;
  try {
    spec = JSON.parse(node.getAttribute("data-pptx-chart") ?? "null");
  } catch {
    return { id, spec: null, invalid: true };
  }
  return { id, spec, invalid: false };
}

function rejectUnsupportedGroupedCharts(node, groupId) {
  for (const chartNode of node.querySelectorAll("[data-pptx-chart]")) {
    const marker = explicitChartMarker(chartNode);
    const chartId = marker.id ?? "(missing-id)";
    if (marker.invalid || !marker.spec || typeof marker.spec !== "object") continue;
    const renderMode = marker.spec.renderMode ?? marker.spec.mode ?? marker.spec.style?.renderMode;
    const chart = {
      type: "chart",
      id: chartId,
      kind: marker.spec.kind,
      ...(renderMode !== undefined ? { renderMode } : {})
    };
    if (!isNativeChartElement(chart) && FIDELITY_CHART_KINDS.has(marker.spec.kind)) {
      throw new Error(`invalid explicit group ${groupId}: non-native expanding chart ${chartId} cannot be grouped`);
    }
  }
}

function generatedLayerOwnedBy(elementId, sourceId) {
  if (typeof elementId !== "string" || typeof sourceId !== "string" || elementId === sourceId) return false;
  if (elementId.startsWith(`${sourceId}__chart__`)) return true;
  if (!elementId.startsWith(`${sourceId}-`)) return false;
  const suffix = elementId.slice(sourceId.length + 1);
  return /^(?:box|border|outline|top-border|right-border|bottom-border|left-border|background-image(?:-\d+)?|background-gradient(?:-\d+)?|radial-glow(?:-\d+)?|localized-fallback|fallback|text(?:-|$)|svg(?:-|$))/.test(suffix);
}

function elementOwnedBySource(element, sourceIds, byId, seen = new Set()) {
  const elementId = element?.id;
  if (typeof elementId !== "string" || seen.has(elementId)) return false;
  seen.add(elementId);
  if (sourceIds.has(elementId)) return true;
  for (const sourceId of sourceIds) {
    if (generatedLayerOwnedBy(elementId, sourceId)) return true;
  }
  const parentId = element?.semanticParentId;
  if (!parentId) return false;
  if (sourceIds.has(parentId)) return true;
  const parent = byId.get(parentId);
  return parent ? elementOwnedBySource(parent, sourceIds, byId, seen) : false;
}

function explicitGroupDescriptor(node, elements, lookup, slideId, options = {}) {
  const id = stableNodeId(node);
  if (!id) throw new Error(`invalid explicit group on ${slideId}: group requires data-pptx-id, data-id, or id`);
  const backgroundKind = node.getAttribute("data-pptx-background");
  if (backgroundKind !== undefined && backgroundKind !== null && backgroundKind !== "grid") throw new Error(`invalid explicit group ${id}: unsupported background kind ${backgroundKind}`);
  if (node.querySelector("[data-pptx-kind='group']")) throw new Error(`invalid explicit group ${id}: nested groups are not supported`);
  rejectUnsupportedGroupedCharts(node, id);
  const descendantIds = [];
  const seenDescendantIds = new Set();
  for (const descendant of node.querySelectorAll("[data-pptx-id], [data-id], [id]")) {
    const childId = stableNodeId(descendant);
    if (childId && childId !== id && !seenDescendantIds.has(childId)) {
      seenDescendantIds.add(childId);
      descendantIds.push(childId);
    }
  }
  const byId = new Map(elements.filter((element) => typeof element?.id === "string").map((element) => [element.id, element]));
  const children = elements
    .filter((element) => element?.id !== id && elementOwnedBySource(element, new Set(descendantIds), byId))
    .map((element) => element.id);
  if (children.length === 0) {
    const hasPendingNativeChart = options.allowPendingNativeCharts === true
      && [...node.querySelectorAll("[data-pptx-chart]")].some((chartNode) => {
        const marker = explicitChartMarker(chartNode);
        const renderMode = marker.spec?.renderMode ?? marker.spec?.mode ?? marker.spec?.style?.renderMode;
        return marker.spec && isNativeChartElement({ type: "chart", kind: marker.spec.kind, renderMode });
      });
    if (!hasPendingNativeChart) throw new Error(`invalid explicit group ${id}: no stable rendered children`);
    return null;
  }
  const measuredBox = getMeasurementBox(lookup, id);
  // Use the resolved rendered children rather than source descendant IDs.
  // Polyline/path sources are expanded into segment IDs, and line segments
  // may run in either direction (negative w/h), so normalize each endpoint
  // before taking the union.
  const fallbackBoxes = children
    .map((childId) => elements.find((element) => element?.id === childId))
    .filter((element) => element && ["x", "y", "w", "h"].every((key) => Number.isFinite(Number(element[key]))));
  const unionBox = fallbackBoxes.length > 0
    ? (() => {
      const bounds = fallbackBoxes.map((element) => {
        const x = Number(element.x);
        const y = Number(element.y);
        const right = x + Number(element.w);
        const bottom = y + Number(element.h);
        return {
          left: Math.min(x, right),
          top: Math.min(y, bottom),
          right: Math.max(x, right),
          bottom: Math.max(y, bottom)
        };
      });
      const x = Math.min(...bounds.map((box) => box.left));
      const y = Math.min(...bounds.map((box) => box.top));
      const right = Math.max(...bounds.map((box) => box.right));
      const bottom = Math.max(...bounds.map((box) => box.bottom));
      return { x, y, w: right - x, h: bottom - y };
    })()
    : null;
  const box = measuredBox ?? parseCoords(node) ?? unionBox;
  if (!box || ![box.x, box.y, box.w, box.h].every((value) => Number.isFinite(Number(value))) || Number(box.x) < 0 || Number(box.y) < 0 || Number(box.w) <= 0 || Number(box.h) <= 0) {
    throw new Error(`invalid explicit group ${id}: illegal geometry`);
  }
  return {
    id,
    children,
    x: Number(box.x),
    y: Number(box.y),
    w: Number(box.w),
    h: Number(box.h),
    ...(backgroundKind === "grid" ? { role: "background", backgroundKind: "grid" } : {})
  };
}

function applyExplicitGroups(slideNode, elements, lookup, slideId, options = {}) {
  const groupNodes = slideNode.querySelectorAll("[data-pptx-kind='group']").filter((node) => {
    // Inline SVG groups participate in explicit-group reconciliation only for
    // Tier-B native SVGs. Tier-C SVGs remain one vector/media element; a
    // missing or unsupported group ID must not be reinterpreted as an HTML
    // group and fail after classification.
    let cursor = node.parentNode;
    let svgAncestor = null;
    while (cursor && cursor !== slideNode) {
      if (String(cursor.tagName ?? "").toLowerCase() === "svg") {
        svgAncestor = cursor;
        break;
      }
      cursor = cursor.parentNode;
    }
    if (!svgAncestor) return true;
    const svgMeasurement = lookup?.get(stableNodeId(svgAncestor));
    return svgMeasurement?.svg?.tier === "B" && svgMeasurement?.svg?.mode === "native";
  });
  if (groupNodes.length === 0) return elements;
  const gridNodes = groupNodes.filter((node) => node.getAttribute("data-pptx-background") === "grid");
  if (gridNodes.length > 1) throw new Error(`invalid explicit groups on ${slideId}: more than one grid background group`);
  const baseElements = elements.filter((element) => element?.type !== "group");
  const existingIds = new Set();
  for (const element of baseElements) {
    if (typeof element?.id !== "string") continue;
    if (existingIds.has(element.id)) throw new Error(`invalid explicit groups on ${slideId}: duplicate rendered element id ${element.id}`);
    existingIds.add(element.id);
  }
  const groupIds = new Set();
  const claims = new Map();
  const descriptors = [];
  for (const node of groupNodes) {
    const id = stableNodeId(node);
    if (!id) throw new Error(`invalid explicit group on ${slideId}: group requires data-pptx-id, data-id, or id`);
    if (groupIds.has(id) || existingIds.has(id)) throw new Error(`invalid explicit group ${id}: duplicate group id`);
    groupIds.add(id);
    const descriptor = explicitGroupDescriptor(node, baseElements, lookup, slideId, options);
    if (!descriptor) continue;
    for (const childId of descriptor.children) {
      const owner = claims.get(childId);
      if (owner && owner !== id) throw new Error(`invalid explicit groups ${owner} and ${id}: overlapping child ${childId}`);
      claims.set(childId, id);
    }
    descriptors.push(descriptor);
  }
  const insertionByIndex = new Map();
  const memberIndices = new Set();
  for (const descriptor of descriptors) {
    const indexes = descriptor.children
      .map((id) => baseElements.findIndex((element) => element.id === id))
      .filter((index) => index >= 0);
    const first = Math.min(...indexes);
    if (!Number.isFinite(first)) throw new Error(`invalid explicit group ${descriptor.id}: no stable rendered children`);
    if (insertionByIndex.has(first)) throw new Error(`invalid explicit groups: multiple groups share child insertion position ${first}`);
    descriptor.children = descriptor.children
      .map((id) => ({ id, index: baseElements.findIndex((element) => element.id === id) }))
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.id);
    insertionByIndex.set(first, { type: "group", ...descriptor });
    for (const childId of descriptor.children) memberIndices.add(baseElements.findIndex((element) => element.id === childId));
  }
  if (descriptors.length === 0) return baseElements;
  const output = [];
  const emittedMemberIndices = new Set();
  for (const [index, element] of baseElements.entries()) {
    const insertion = insertionByIndex.get(index);
    if (insertion) {
      output.push(insertion);
      for (const childId of insertion.children) {
        const childIndex = baseElements.findIndex((candidate) => candidate.id === childId);
        if (childIndex < 0 || emittedMemberIndices.has(childIndex)) continue;
        emittedMemberIndices.add(childIndex);
        output.push(baseElements[childIndex]);
      }
      continue;
    }
    if (memberIndices.has(index)) continue;
    output.push(element);
  }
  return output;
}

/**
 * Rebuild explicit groups after post-conversion mutations (native chart
 * injection, preview suppression, and localized fallbacks).  The source DOM
 * remains authoritative for membership; only stable source IDs, semantic
 * parent ownership, and known generated paint-layer suffixes are accepted.
 */
export function reconcileExplicitGroups(sourceRoot, manifest, measurements) {
  if (!sourceRoot || !manifest?.slides?.length) return manifest;
  const lookup = measurements ? buildMeasurementLookup(measurements) : null;
  const slideNodes = sourceRoot.querySelectorAll?.(".pptx-slide, [data-slide]") ?? [];
  const sources = slideNodes.length > 0 ? [...slideNodes] : [sourceRoot];
  for (const [slideIndex, slide] of manifest.slides.entries()) {
    const source = sources[slideIndex];
    if (!source) continue;
    slide.elements = applyExplicitGroups(source, slide.elements ?? [], lookup, slide.id ?? `slide-${slideIndex + 1}`, {
      allowPendingNativeCharts: false
    });
  }
  return manifest;
}

function convertSlide(slideNode, slideIndex, options = {}) {
  const lookup = options.measurementLookup ?? null;
  const slideId = `slide-${String(slideIndex + 1).padStart(3, "0")}`;
  const detection =
    options.designMode === "replica" && options.measurements
      ? { path: "replica", markers: -1, autoLayoutContainers: -1 }
      : options._detection ?? detectLayoutMode(slideNode, options);
  const sourceCoordinates = options._sourceCoordinates ?? [];

  let result;
  if (detection.path === "replica") {
    result = convertReplicaSlide(slideNode, options.measurements, slideIndex, slideId);
  } else if (detection.path === "measured") {
    result = convertMeasuredSlide(slideNode, lookup, slideId, options);
  } else if (detection.path === "auto-layout") {
    result = convertAutoLayoutSlide(slideNode, lookup, slideId);
  } else {
    result = convertHybridSlide(slideNode, lookup, slideId);
  }

  result.elements = applyExplicitGroups(slideNode, result.elements, lookup, slideId, {
    allowPendingNativeCharts: true
  });

  // Selective sourceCoordinates: image-anchored elements are always
  // recorded; non-image elements are recorded at most once per 2x2 region.
  const recordedRegions = new Set();
  for (const element of result.elements) {
    attachSourceCoordinate(element, sourceCoordinates, recordedRegions);
  }
  // Strip the internal helper props before returning.
  for (const element of result.elements) {
    delete element._slideId;
  }

  // U9: resolve inline hex colors in element styles against DESIGN.md
  // tokens. Strict replica mode bypasses; otherwise exact matches become
  // token references and unmatched colors are tracked for the consistency
  // report. The per-slide paletteResolution is bubbled up so callers can
  // aggregate it for `paletteMatch`.
  const inline = resolveInlineStyles(result.elements, options.designTokens, {
    isReplica: options.designMode === "replica"
  });
  // `resolveInlineStyles` mutates element.style in place; assign the
  // refreshed array (same identity) back so the loop above's elements
  // reference is preserved.
  result.elements = inline.elements;

  // Pass through any extra metadata fields the detector produced (e.g.
  // `archetype` and `archetypeRoot` when data-archetype short-circuited
  // the heuristic), without overwriting the standard path/markers/...
  // fields already declared above.
  const { path: _ignoredPath, markers: _ignoredMarkers, autoLayoutContainers: _ignoredAuto, ...detectionExtras } = detection;
  const whitespaceIntent = slideNode.getAttribute("data-whitespace-intent")
    ?? slideNode.getAttribute("data-gap-intent");

  return {
    ...result,
    ...(whitespaceIntent ? { whitespaceIntent } : {}),
    path: detection.path,
    markers: detection.markers,
    autoLayoutContainers: detection.autoLayoutContainers,
    ...detectionExtras,
    paletteResolution: inline.paletteResolution
  };
}

function canAutoPaginateCards(slideNode, options = {}) {
  if (options.autoPaginate === false || options.measurementLookup) return false;
  if (options.forceMeasured || options.forceHybrid) return false;
  if (slideNode.querySelectorAll("[data-pptx-kind], [data-pptx-type]").length > 0) return false;
  const cardsContainer = slideNode.querySelector(".cards, [data-cards]");
  if (!cardsContainer) return false;
  const cards = cardsContainer.querySelectorAll(".card, [data-card]");
  const cardsPerSlide = Number(cardsContainer.getAttribute("data-cards-per-slide") ?? options.cardsPerSlide ?? "4") || 4;
  return cards.length > cardsPerSlide;
}

function convertAutoPaginatedCards(slideNode, startIndex, options = {}) {
  const cardsContainer = slideNode.querySelector(".cards, [data-cards]");
  const cards = cardsContainer ? [...cardsContainer.querySelectorAll(".card, [data-card]")] : [];
  const cardsPerSlide = Number(cardsContainer?.getAttribute("data-cards-per-slide") ?? options.cardsPerSlide ?? "4") || 4;
  const cols = Number(cardsContainer?.getAttribute("data-cols") ?? "2") || 2;
  const chunks = [];
  for (let i = 0; i < cards.length; i += cardsPerSlide) {
    chunks.push(cards.slice(i, i + cardsPerSlide));
  }

  const h1 = slideNode.querySelector("h1");
  const subtitle = slideNode.querySelector(".subtitle, p.subtitle, [data-subtitle]");

  return chunks.map((chunk, pageIndex) => {
    const elements = [];
    let cursorY = 0.55;
    const slideId = `slide-${String(startIndex + pageIndex + 1).padStart(3, "0")}`;

    if (h1) {
      const titleH = estimatedTextHeight(textContent(h1), CONTENT_WIDTH, { fontSize: 34, lineHeight: 1.2, bold: true });
      elements.push(textElement(nextId("title"), textContent(h1), { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: titleH }, "h1", "{colors.text}"));
      cursorY += titleH + 0.15;
    }

    if (subtitle) {
      elements.push(textElement(nextId("subtitle"), textContent(subtitle), { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.45 }, "subtitle", "{colors.textMuted}"));
      cursorY += 0.7;
    }

    const { items } = layoutCards(chunk, cols, cursorY, SLIDE_SIZE.height);
    for (const { card, box } of items) {
      elements.push(...cardInnerElements(card, box));
    }

    return {
      id: slideId,
      type: slideNode.getAttribute("data-type") ?? "content",
      title: h1 ? textContent(h1) : slideNode.getAttribute("data-title") ?? "",
      notes: slideNode.getAttribute("data-notes") ?? `Auto-paginated card page ${pageIndex + 1} of ${chunks.length}`,
      background: { type: "solid", color: "{colors.background}" },
      elements
    };
  });
}

function collectImageDimensions(slideNode) {
  const dims = [];
  const imgs = slideNode.querySelectorAll("img");
  for (const img of imgs) {
    const w = Number(img.getAttribute("width")) || null;
    const h = Number(img.getAttribute("height")) || null;
    const src = img.getAttribute("src");
    if (src) dims.push({ src, width: w, height: h });
  }
  return dims;
}

function collectDetectedPalette(slideNode) {
  const palette = new Set();
  const elements = slideNode.querySelectorAll("*");
  for (const el of elements) {
    const style = el.getAttribute("style") ?? "";
    const matches = style.match(/#[0-9a-fA-F]{3,8}/g);
    if (matches) {
      for (const m of matches) palette.add(m.toLowerCase());
    }
  }
  return [...palette].slice(0, 16);
}

function collectMetadataSources(root) {
  const byId = new Map();
  for (const node of root.querySelectorAll("a[data-source-id][href]")) {
    const id = String(node.getAttribute("data-source-id") ?? "").trim();
    const url = String(node.getAttribute("href") ?? "").trim();
    if (!id || !/^https?:\/\//i.test(url) || byId.has(id)) continue;
    byId.set(id, {
      id,
      url,
      ...(node.getAttribute("data-source-title") || textContent(node) ? { title: node.getAttribute("data-source-title") || textContent(node) } : {}),
      ...(node.getAttribute("data-source-publisher") ? { publisher: node.getAttribute("data-source-publisher") } : {}),
      ...(node.getAttribute("data-accessed-at") ? { accessedAt: node.getAttribute("data-accessed-at") } : {})
    });
  }
  return [...byId.values()];
}

function buildInputHints(slideNodes, measurements, options = {}) {
  const viewport = measurements?.viewport ?? { width: 1280, height: 720 };
  const imageDimensions = [];
  const palette = new Set();
  for (const slideNode of slideNodes) {
    for (const dim of collectImageDimensions(slideNode)) imageDimensions.push(dim);
    for (const c of collectDetectedPalette(slideNode)) palette.add(c);
  }
  return {
    viewportSize: { w: viewport.width, h: viewport.height },
    imageDimensions,
    detectedPalette: [...palette],
    ocrAvailability: options.ocrAvailability ?? "deferred"
  };
}

function normalizeCoverageText(value) {
  return String(value ?? "")
    .replace(/^[•·\-]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .trim();
}

function isCoverageHidden(node, slide) {
  let current = node;
  while (current && current !== slide) {
    const tag = String(current.tagName ?? "").toLowerCase();
    const className = String(current.getAttribute?.("class") ?? "");
    const style = String(current.getAttribute?.("style") ?? "").toLowerCase();
    if (
      ["style", "script", "noscript", "template"].includes(tag)
      || current.hasAttribute?.("hidden")
      || current.getAttribute?.("aria-hidden") === "true"
      || /(?:^|\s)(?:speaker|presenter)[-_]?notes?(?:\s|$)/i.test(className)
      || /(?:^|;)\s*display\s*:\s*none\b/.test(style)
      || /(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style)
    ) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function hasMarkedContentDescendant(node, slide) {
  return node.querySelectorAll?.("[data-pptx-kind],[data-pptx-type],[data-pptx-id]")
    .some((descendant) =>
      !isCoverageHidden(descendant, slide)
      && normalizeCoverageText(textContent(descendant)).length > 0) ?? false;
}

function sourceContentBlocks(slides) {
  const blocks = [];
  for (const slide of slides) {
    const nodes = slide.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,th,td,.metric,[data-metric]");
    const seen = new Set();
    for (const node of nodes) {
      if (isCoverageHidden(node, slide)) continue;
      if (hasMarkedContentDescendant(node, slide)) continue;
      const value = normalizeCoverageText(textContent(node));
      if (!value || seen.has(node)) continue;
      seen.add(node);
      blocks.push(value);
    }
    for (const node of slide.querySelectorAll("*")) {
      const tag = String(node.tagName ?? "").toLowerCase();
      if (isCoverageHidden(node, slide)) continue;
      if ((node.childNodes ?? []).some((child) => child?.tagName)) continue;
      const semantic = node.hasAttribute?.("data-pptx-kind")
        || node.hasAttribute?.("data-pptx-type")
        || node.hasAttribute?.("data-pptx-id")
        || node.hasAttribute?.("data-metric");
      if (!semantic) continue;
      const value = normalizeCoverageText(textContent(node));
      if (value) blocks.push(value);
    }
  }
  return [...new Set(blocks)];
}

function emittedContentBlocks(slides) {
  const blocks = [];
  for (const slide of slides) {
    for (const element of slide.elements ?? []) {
      if (typeof element.text === "string") blocks.push(normalizeCoverageText(element.text));
      for (const header of element.headers ?? []) blocks.push(normalizeCoverageText(header));
      for (const row of element.rows ?? []) {
        for (const cell of row ?? []) blocks.push(normalizeCoverageText(cell?.text ?? cell));
      }
    }
  }
  return blocks.filter(Boolean);
}

export function measureContentCoverage(sourceSlides, manifestSlides) {
  const source = sourceContentBlocks(sourceSlides);
  const emitted = emittedContentBlocks(manifestSlides);
  const missing = source.filter((block) => !emitted.some((candidate) => candidate.includes(block)));
  const covered = source.length - missing.length;
  return {
    sourceBlocks: source.length,
    coveredBlocks: covered,
    ratio: source.length === 0 ? 1 : Math.round((covered / source.length) * 10000) / 10000,
    missing
  };
}

export function convertHtmlToManifest(html, options = {}) {
  resetIds();
  const measurementLookup = options.measurements ? buildMeasurementLookup(options.measurements) : null;
  const root = parse(html, { lowerCaseTagName: false });
  const deckNode =
    root.querySelector(".pptx-deck") ??
    root.querySelector("[data-pptx-deck]") ??
    root.querySelector("body") ??
    root;

  const designId = options.designSystem ?? deckNode.getAttribute("data-design-system") ?? "business-neutral";
  const deckTitle =
    options.deckTitle ??
    deckNode.getAttribute("data-deck-title") ??
    root.querySelector("title")?.text?.trim() ??
    "Untitled Deck";
  const language = options.language ?? deckNode.getAttribute("data-language") ?? "zh-CN";
  const metadataSources = collectMetadataSources(root);

  const slideNodes = deckNode.querySelectorAll(".pptx-slide, [data-slide]");
  const sourceSlides = slideNodes.length > 0 ? [...slideNodes] : [deckNode];
  const slides = [];
  const layoutPaths = [];
  const sourceCoordinates = [];
  const paletteResolutions = [];
  const replicaCoverageBySlide = [];
  for (const slideNode of sourceSlides) {
    if (canAutoPaginateCards(slideNode, { ...options, measurementLookup })) {
      const pageSlides = convertAutoPaginatedCards(slideNode, slides.length, options);
      slides.push(...pageSlides);
      for (const s of pageSlides) {
        layoutPaths.push({ slideId: s.id, path: "auto-paginated" });
      }
    } else {
      const detection = detectLayoutMode(slideNode, options);
      const result = convertSlide(slideNode, slides.length, {
        measurementLookup,
        _detection: detection,
        _sourceCoordinates: sourceCoordinates,
        forceMeasured: options.forceMeasured,
        forceAutoLayout: options.forceAutoLayout,
        forceHybrid: options.forceHybrid,
        designTokens: options.designTokens,
        designMode: options.designMode,
        measurements: options.measurements
      });
      slides.push(result);
      if (result.paletteResolution) {
        paletteResolutions.push({
          slideId: result.id,
          ...result.paletteResolution
        });
      }
      if (result.replicaCoverage) {
        replicaCoverageBySlide.push({
          slideId: result.id,
          ...result.replicaCoverage
        });
      }
      layoutPaths.push({
        slideId: result.id,
        path: result.path,
        markers: result.markers,
        autoLayoutContainers: result.autoLayoutContainers,
        ...(result.archetype ? { archetype: result.archetype } : {}),
        ...(result.archetypeRoot ? { archetypeRoot: result.archetypeRoot } : {})
      });
    }
  }

  // Aggregate per-slide palette resolutions into a deck-level summary so
  // downstream consumers (consistency report, CLI logging) can read a
  // single 0..1 paletteMatch score without re-walking the slides.
  const aggregatedPalette = aggregatePaletteResolutions(paletteResolutions, {
    isReplica: options.designMode === "replica"
  });
  const aggregatedReplicaCoverage = aggregateReplicaCoverage(replicaCoverageBySlide);

  const manifest = {
    version: "0.2.0",
    metadata: {
      mode: options.designMode === "replica" ? "replica" : "creative",
      inputType: "html",
      qualityProfile: options.designMode === "replica" ? "replica" : "creative",
      ...(options.designMode === "replica" ? {
        replicaSource: {
          type: "html",
          ...(options.replicaSourcePath ? { path: options.replicaSourcePath } : {}),
          coverage: aggregatedReplicaCoverage
        }
      } : {}),
      generator: { name: "html-to-manifest-core.mjs" },
      ...(metadataSources.length > 0 ? { sources: metadataSources } : {})
    },
    designSystem: {
      source: options.designSystemSource ?? designSystemSource(designId, options),
      name: options.designSystemName ?? designSystemName(designId)
    },
    deck: {
      title: deckTitle,
      language,
      size: { ...SLIDE_SIZE }
    },
    assets: options.assets ?? [],
    slides
  };

  if (options.measurements) {
    mergeMeasurementsIntoManifest(manifest, options.measurements);
  }
  for (const slide of manifest.slides) {
    slide.elements = resolveSemanticConnectors(slide.elements);
  }

  const inputHints = buildInputHints(sourceSlides, options.measurements, options);
  const contentCoverage = measureContentCoverage(sourceSlides, slides);

  // Return shape: by default a manifest. When `options.returnMetadata` is
  // true, wrap the result so downstream consumers (consistency report,
  // CLI logging) can read per-slide path info + input hints without
  // changing the existing manifest schema.
  if (options.returnMetadata) {
    return {
      manifest,
      layoutPaths,
      sourceCoordinates,
      inputHints,
      contentCoverage,
      paletteResolution: aggregatedPalette,
      paletteResolutions,
      replicaCoverage: aggregatedReplicaCoverage,
      replicaCoverageBySlide
    };
  }
  return manifest;
}

function aggregateReplicaCoverage(perSlide) {
  if (!Array.isArray(perSlide) || perSlide.length === 0) {
    return { measuredElements: 0, coveredElements: 0, coverage: 1, droppedElements: [], unsupportedEffects: [], slides: [] };
  }
  const measuredElements = perSlide.reduce((sum, slide) => sum + (slide.measuredElements ?? 0), 0);
  const coveredElements = perSlide.reduce((sum, slide) => sum + (slide.coveredElements ?? 0), 0);
  const coverage = measuredElements === 0 ? 1 : Math.round((coveredElements / measuredElements) * 10000) / 10000;
  const droppedElements = perSlide.flatMap((slide) =>
    (slide.droppedElements ?? []).map((entry) => ({ ...entry, slideId: slide.slideId }))
  );
  const unsupportedEffects = perSlide.flatMap((slide) =>
    (slide.unsupportedEffects ?? []).map((entry) => ({ ...entry, slideId: slide.slideId }))
  );
  return {
    measuredElements,
    coveredElements,
    coverage,
    droppedElements,
    unsupportedEffects,
    slides: perSlide
  };
}

/**
 * Aggregate per-slide palette resolutions into a deck-level summary.
 * Returns the same shape as a single slide's `paletteResolution`:
 *   { matches, unmapped, paletteMatch, skipped }
 *
 * Aggregation rules:
 *   - skipped: true if any per-slide resolution was skipped (replica mode).
 *   - paletteMatch: weighted by the count of inline color references.
 *     If no per-slide resolutions, defaults to 1 (no mismatch).
 *   - matches / unmapped: concatenations of per-slide lists, each tagged
 *     with the originating slideId for traceability.
 */
function aggregatePaletteResolutions(perSlide, options = {}) {
  if (!Array.isArray(perSlide) || perSlide.length === 0) {
    return { matches: [], unmapped: [], paletteMatch: 1, skipped: Boolean(options.isReplica) };
  }
  const skipped = perSlide.some((entry) => entry?.skipped);
  if (skipped) {
    return { matches: [], unmapped: [], paletteMatch: 0, skipped: true };
  }
  const matches = [];
  const unmapped = [];
  let weighted = 0;
  let total = 0;
  for (const entry of perSlide) {
    const slideId = entry.slideId;
    for (const match of entry.matches ?? []) {
      matches.push({ ...match, slideId });
      weighted += 1;
      total += 1;
    }
    for (const miss of entry.unmapped ?? []) {
      unmapped.push({ ...miss, slideId });
      total += 1;
    }
  }
  const paletteMatch = total === 0 ? 1 : Math.round((weighted / total) * 10000) / 10000;
  return { matches, unmapped, paletteMatch, skipped: false };
}
