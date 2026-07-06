import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageSize } from "image-size";
import { parse } from "node-html-parser";
import { buildMeasurementLookup, getMeasurementBox, mergeMeasurementsIntoManifest, roundInches } from "./html-measurement-core.mjs";
import { buildTokenLookup, exactTokenRef, resolveTokens } from "./color-tokens.mjs";
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

function tableElement(id, tableNode, box, measuredStyle = null) {
  const headers = [];
  const rows = [];
  const thead = tableNode.querySelector("thead");
  const tbody = tableNode.querySelector("tbody");
  if (thead) {
    const headerCells = thead.querySelectorAll("th");
    if (headerCells.length > 0) {
      headers.push(...headerCells.map((cell) => textContent(cell)));
    } else {
      const rowCells = thead.querySelectorAll("td");
      if (rowCells.length > 0) headers.push(...rowCells.map((cell) => textContent(cell)));
    }
  }
  const bodyRows = tbody ? tbody.querySelectorAll("tr") : tableNode.querySelectorAll("tr");
  for (const row of bodyRows) {
    const cells = row.querySelectorAll("td");
    if (cells.length === 0) continue;
    rows.push(cells.map((cell) => textContent(cell)));
  }
  if (headers.length === 0 && rows.length > 0) {
    headers.push(...rows.shift());
  }
  const element = {
    type: "table",
    id,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    rows,
    style: measuredStyle ? replicaTableStyle(measuredStyle) : replicaTableStyle()
  };
  if (headers.length > 0) element.headers = headers;
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
    ...(markerEnd && markerEnd !== "none" ? { endArrowType: "triangle" } : {}),
    ...(node.getAttribute?.("data-source-id") ? { sourceId: node.getAttribute("data-source-id") } : {}),
    ...(node.getAttribute?.("data-target-id") ? { targetId: node.getAttribute("data-target-id") } : {})
  };
}

function lineElement(id, box, preserveHeight = false, node = null) {
  return {
    type: "line",
    id,
    x: box.x,
    y: box.y,
    w: box.w,
    h: preserveHeight ? box.h : 0.02,
    style: lineStyleFromNode(node)
  };
}

function measuredBox(measurement) {
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
  if (style.display === "flex" && style.alignItems === "center") return "middle";
  if (style.display === "flex" && style.alignItems === "flex-end") return "bottom";
  return "top";
}

function replicaRotate(style) {
  const value = Number(style.rotate ?? style.rotation);
  if (!Number.isFinite(value) || Math.abs(value) <= 0.01) return null;
  return Math.round(value * 100) / 100;
}

function applyReplicaRotation(element, style) {
  const rotate = replicaRotate(style);
  if (rotate !== null) element.rotate = rotate;
  return element;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function cssCombinedTransparency(style, ...transparencyKeys) {
  let alpha = 1;
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity)) alpha *= clamp01(opacity);
  for (const key of transparencyKeys) {
    const transparency = Number(style[key]);
    if (Number.isFinite(transparency)) alpha *= 1 - clamp01(transparency / 100);
  }
  const result = Math.round((1 - alpha) * 100);
  return result > 0 ? result : null;
}

function parseObjectPositionAxis(value, axis) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!token) return 0.5;
  if ((axis === "x" && token === "left") || (axis === "y" && token === "top")) return 0;
  if (token === "center") return 0.5;
  if ((axis === "x" && token === "right") || (axis === "y" && token === "bottom")) return 1;
  const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (percent) return clamp01(Number(percent[1]) / 100);
  return 0.5;
}

function parseObjectPosition(value) {
  const parts = String(value ?? "50% 50%").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return {
      x: parseObjectPositionAxis(parts[0], "x"),
      y: 0.5
    };
  }
  return {
    x: parseObjectPositionAxis(parts[0], "x"),
    y: parseObjectPositionAxis(parts[1], "y")
  };
}

function coverImageSizingForBox(sourceWidth, sourceHeight, box, objectPosition) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
  const imageRatio = sourceHeight / sourceWidth;
  const boxRatio = box.h / box.w;
  const position = parseObjectPosition(objectPosition);
  let sourceW = box.w;
  let sourceH = box.h;
  let x = 0;
  let y = 0;
  if (boxRatio > imageRatio) {
    sourceH = box.h;
    sourceW = box.h / imageRatio;
    x = Math.max(0, sourceW - box.w) * position.x;
  } else if (boxRatio < imageRatio) {
    sourceW = box.w;
    sourceH = box.w * imageRatio;
    y = Math.max(0, sourceH - box.h) * position.y;
  }
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
  return coverImageSizingForBox(Number(measurement.naturalWidth), Number(measurement.naturalHeight), box, style.objectPosition);
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
  const element = applyReplicaRotation({ type: "image", id: measurement.id, src: measurement.src, ...box }, style);
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
      return applyReplicaRotation(element, style);
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
  if (parts.length < 3) return null;
  const angle = parseCssGradientAngle(parts[0]);
  if (angle === null) return null;
  const stops = parseCssGradientStops(parts.slice(1));
  if (!stops) return null;
  return {
    type: "linear",
    angle,
    stops
  };
}

function parseCssGradientStops(stopParts) {
  const stopCount = stopParts.length;
  if (stopCount < 2) return null;
  const stops = stopParts.map((part, index) => {
    const parsedColor = parseShadowColor(part);
    if (!parsedColor?.color) return null;
    const positionSource = part.replace(parsedColor.source, "").trim();
    const positionMatch = positionSource.match(/^(\d+(?:\.\d+)?)%$/);
    return {
      color: `#${parsedColor.color}`,
      position: positionMatch ? Number(positionMatch[1]) : Math.round((index / Math.max(1, stopCount - 1)) * 10000) / 100
    };
  });
  if (stops.some((stop) => !stop)) return null;
  if (stops.some((stop) => stop.position < 0 || stop.position > 100)) return null;
  return stops;
}

function parseCssRadialGradientDescriptor(value) {
  const source = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!source || source === "at center") return { shape: "ellipse", position: "center" };
  const match = source.match(/^(?:(circle|ellipse)\s*)?(?:at\s+(.+))?$/);
  if (!match) return null;
  const shape = match[1] ?? "ellipse";
  const position = match[2] ?? "center";
  if (!["center", "50% 50%", "center center"].includes(position)) return null;
  return { shape, position: "center" };
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
    stops
  };
}

function parseCssSupportedGradient(value) {
  return parseCssLinearGradient(value) ?? parseCssRadialGradient(value);
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
  return Boolean(style.backgroundColor) || Boolean(style.borderColor && Number(style.borderWidth ?? 0) > 0) || Boolean(parseCssBoxShadow(style.boxShadow)) || hasCssOutline(style);
}

function replicaUnsupportedEffect(measurement, style) {
  if (!measurement.replica?.hasUnsupportedEffects) return null;
  const backgroundImage = measurement.replica.backgroundImage ?? style.backgroundImage ?? null;
  const supportedGradient = parseCssSupportedGradient(backgroundImage);
  const backgroundImageSrc = parseCssBackgroundImageUrl(backgroundImage);
  const supportedBackgroundImage = backgroundImageSrc && replicaBackgroundImagePlanForSrc(backgroundImageSrc, style, measuredBox(measurement));
  const unsupportedBackgroundImage = backgroundImage && !supportedGradient && !supportedBackgroundImage ? backgroundImage : null;
  const unsupportedFilter = measurement.replica.filter && !parseCssDropShadowFilter(measurement.replica.filter) ? measurement.replica.filter : null;
  if (!unsupportedFilter && !measurement.replica.backdropFilter && !measurement.replica.clipPath && !unsupportedBackgroundImage) return null;
  return {
    elementId: measurement.id,
    filter: unsupportedFilter,
    backdropFilter: measurement.replica.backdropFilter ?? null,
    clipPath: measurement.replica.clipPath ?? null,
    backgroundImage: unsupportedBackgroundImage
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
  const cornerRadii = replicaCornerRadii(style);
  const minDimensionPx = Math.min(Number(measurement?.px?.w ?? box.w * 96), Number(measurement?.px?.h ?? box.h * 96));
  if (Number.isFinite(minDimensionPx) && minDimensionPx > 0 && cornerRadii.every((radius) => radius >= minDimensionPx / 2 - 0.5)) {
    return "ellipse";
  }
  return hasUniformReplicaCornerRadius(cornerRadii) ? "roundRect" : "rect";
}

function replicaCornerRadii(style) {
  const shorthand = Number(style.borderRadius) || 0;
  return [
    style.borderTopLeftRadius ?? shorthand,
    style.borderTopRightRadius ?? shorthand,
    style.borderBottomRightRadius ?? shorthand,
    style.borderBottomLeftRadius ?? shorthand
  ].map((value) => Number(value) || 0);
}

function hasUniformReplicaCornerRadius(cornerRadii) {
  const positive = cornerRadii.filter((radius) => radius > 1);
  if (positive.length !== 4) return false;
  return cornerRadii.every((radius) => Math.abs(radius - cornerRadii[0]) <= 0.5);
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
  const line = {
    type: "line",
    id: `${id}-${border.side}-border`,
    x: border.side === "right" ? box.x + box.w : box.x,
    y: border.side === "bottom" ? box.y + box.h : box.y,
    w: border.side === "left" || border.side === "right" ? 0 : box.w,
    h: border.side === "top" || border.side === "bottom" ? 0 : box.h,
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
  if (style.backgroundColor || Number(style.borderRadius ?? 0) > 0 || hasCssBoxShadow(style)) return null;
  const borders = visibleBorderSides(style);
  if (borders.length !== 1) return null;
  return borderLineElement(id, measurement, borders[0]);
}

function hasCssBorderRadius(style) {
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
  if (!style.backgroundColor || hasCssBorderRadius(style) || hasCssBoxShadow(style)) return [];
  const borders = visibleBorderSides(style);
  if (!hasAsymmetricBorderSides(style, borders)) return [];
  return borders.map((border) => borderLineElement(id, measurement, border));
}

function replicaShapeElement(id, measurement) {
  const style = cssStyle(measurement);
  const dashType = replicaBorderDashType(style);
  const element = {
    type: "shape",
    id,
    shape: replicaShapeKind(measurement),
    ...measuredBox(measurement),
    style: {
      fill: style.backgroundColor ?? "#FFFFFF",
      backgroundColor: style.backgroundColor ?? "#FFFFFF",
      borderColor: style.borderColor ?? style.backgroundColor ?? "#FFFFFF",
      borderWidth: Number(style.borderWidth ?? 0) > 0 ? Math.max(0.25, Number(style.borderWidth) * 0.75) : 0,
      transparency: style.backgroundColor ? (cssCombinedTransparency(style, "backgroundTransparency") ?? 0) : 100
    }
  };
  const gradient = parseCssSupportedGradient(style.backgroundImage);
  if (gradient) element.style.gradient = gradient;
  const borderTransparency = cssCombinedTransparency(style, "borderTransparency");
  if (borderTransparency !== null) element.style.borderTransparency = borderTransparency;
  if (dashType) element.style.dashType = dashType;
  const shadow = parseCssBoxShadow(style.boxShadow);
  if (shadow) element.style.shadow = shadow;
  const filterShadow = parseCssDropShadowFilter(measurement.replica?.filter);
  if (filterShadow) element.style.shadow = filterShadow;
  return applyReplicaRotation(element, style);
}

function replicaPaintLayerElements(id, measurement) {
  const singleBorderLine = singleSideBorderLineElement(id, measurement);
  if (singleBorderLine) return [singleBorderLine];
  const backgroundImages = replicaBackgroundImageElements(id, measurement);
  const shape = replicaShapeElement(id, measurement);
  const outline = replicaOutlineElement(id, measurement);
  if (backgroundImages.length > 0 && !shape.style.gradient) {
    shape.style.fill = "#FFFFFF";
    shape.style.backgroundColor = "#FFFFFF";
    shape.style.transparency = 100;
  }
  const borderLines = filledBoxBorderLineElements(id, measurement);
  if (borderLines.length === 0) {
    const hasVisibleShape =
      shape.style.gradient ||
      Number(shape.style.transparency ?? 0) < 100 ||
      Number(shape.style.borderWidth ?? 0) > 0 ||
      shape.style.shadow;
    const base =
      backgroundImages.length > 0 && !hasVisibleShape
        ? backgroundImages
        : backgroundImages.length > 0
          ? [...backgroundImages, shape]
          : [shape];
    return outline ? [...base, outline] : base;
  }
  shape.style.borderWidth = 0;
  shape.style.borderColor = shape.style.fill ?? shape.style.backgroundColor ?? "#FFFFFF";
  delete shape.style.borderTransparency;
  delete shape.style.dashType;
  const base = backgroundImages.length > 0 ? [...backgroundImages, shape, ...borderLines] : [shape, ...borderLines];
  return outline ? [...base, outline] : base;
}

function replicaTextElement(id, measurement) {
  const style = cssStyle(measurement);
  const bullet = replicaTextBullet(style);
  const element = {
    type: "text",
    id,
    text: replicaTextContent(measurement, style),
    ...measuredBox(measurement),
    style: {
      color: replicaTextFillColor(style),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      italic: style.fontStyle === "italic",
      smallCaps: replicaTextSmallCaps(style) || undefined,
      align: replicaTextAlign(style),
      valign: replicaTextValign(style),
      textDirection: replicaTextDirection(style),
      rtl: replicaTextRtl(style),
      lineHeight: style.lineHeight,
      firstLineIndent: replicaTextIndent(style),
      textStroke: replicaTextStroke(style),
      charSpacing: style.letterSpacing,
      textOverflow: replicaTextOverflow(style),
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
  return applyReplicaRotation(element, style);
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
  const cjkFactor = /[\u3000-\u9fff\uff00-\uffef]/.test(value) ? 1.7 : 1;
  const availableWidth = Math.max(0.25, width);
  const paragraphs = value.split("\n");
  const lines = paragraphs.reduce((total, paragraph) => {
    const projectedWidth = (paragraph.length * fontSize * 0.55 * boldFactor * cjkFactor) / 72;
    return total + Math.max(1, Math.ceil(projectedWidth / availableWidth));
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
  if (heading) height += estimatedTextHeight(textContent(heading), innerW, { fontSize: 14, lineHeight: 1.2, bold: true }) + 0.08;
  const metric = cardNode.querySelector(".metric, [data-metric]");
  if (metric) height += estimatedTextHeight(textContent(metric), innerW, { fontSize: 28, lineHeight: 1 }) + 0.05;
  const paragraphs = cardNode.querySelectorAll("p").filter((p) => {
    const cls = p.getAttribute("class") ?? "";
    return !cls.split(/\s+/).includes("metric") && !p.getAttribute("data-metric");
  });
  for (const paragraph of paragraphs) {
    height += estimatedTextHeight(textContent(paragraph), innerW, { fontSize: 11, lineHeight: 1.35 }) + 0.05;
  }
  const listItems = cardNode.querySelectorAll("li");
  if (listItems.length > 0) {
    const lines = [...listItems].map((item) => `• ${textContent(item)}`).join("\n");
    height += estimatedTextHeight(lines, innerW, { fontSize: 12, lineHeight: 1.35 });
  }
  return height;
}

function cardInnerElements(cardNode, outerBox, shapeId = nextId("card")) {
  const elements = [];
  elements.push(shapeElement(shapeId, outerBox, "{components.content-card}"));

  const padding = 0.2;
  let cursorY = outerBox.y + padding;
  const innerW = outerBox.w - padding * 2;
  const innerX = outerBox.x + padding;

  const heading = cardNode.querySelector("h3") ?? cardNode.querySelector("h2");
  if (heading) {
    const h = estimatedTextHeight(textContent(heading), innerW, { fontSize: 14, lineHeight: 1.2, bold: true });
    elements.push(
      textElement(nextId("card-title"), textContent(heading), { x: innerX, y: cursorY, w: innerW, h }, "h3", "{colors.primary}", {
        role: "card-title",
        style: { fontSize: 14, lineHeight: 1.2, bold: true }
      })
    );
    cursorY += h + 0.08;
  }

  const metric = cardNode.querySelector(".metric, [data-metric]");
  if (metric) {
    const h = estimatedTextHeight(textContent(metric), innerW, { fontSize: 28, lineHeight: 1 });
    elements.push(
      textElement(nextId("card-metric"), textContent(metric), { x: innerX, y: cursorY, w: innerW, h }, "metric", "{colors.text}", {
        role: "card-metric",
        style: { fontSize: 28, lineHeight: 1, bold: true }
      })
    );
    cursorY += h + 0.05;
  }

  const paragraphs = cardNode.querySelectorAll("p").filter((p) => {
    const cls = p.getAttribute("class") ?? "";
    return !cls.split(/\s+/).includes("metric") && !p.getAttribute("data-metric");
  });
  for (const paragraph of paragraphs) {
    const h = estimatedTextHeight(textContent(paragraph), innerW, { fontSize: 11, lineHeight: 1.35 });
    elements.push(
      textElement(nextId("card-body"), textContent(paragraph), { x: innerX, y: cursorY, w: innerW, h }, "caption", "{colors.textMuted}", {
        style: { fontSize: 11, lineHeight: 1.35 }
      })
    );
    cursorY += h + 0.05;
  }

  const listItems = cardNode.querySelectorAll("li");
  if (listItems.length > 0) {
    const lines = [...listItems].map((item) => `• ${textContent(item)}`).join("\n");
    const required = estimatedTextHeight(lines, innerW, { fontSize: 12, lineHeight: 1.35 });
    const remaining = Math.max(required, outerBox.y + outerBox.h - padding - cursorY);
    elements.push(
      textElement(nextId("card-list"), lines, { x: innerX, y: cursorY, w: innerW, h: remaining }, "body", "{colors.text}", {
        style: { fontSize: 12, lineHeight: 1.35 }
      })
    );
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
      : estimatedTextHeight(`${prefix}${value}`, CONTENT_WIDTH, { fontSize: 15, lineHeight: 1.55 });
    const box = parseCoords(node) ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h };
    elements.push(textElement(nextId(tag), `${prefix}${value}`, box, typography));
    cursorY = box.y + box.h + 0.1;
  }
  return cursorY;
}

function convertKindElement(node, lookup) {
  const kind = node.getAttribute("data-pptx-kind");
  const id = node.getAttribute("data-pptx-id") ?? node.getAttribute("data-id") ?? nextId(kind ?? "element");
  const coords =
    getMeasurementBox(lookup, id) ??
    parseCoords(node) ??
    null;
  if (!coords) return [];

  if (kind === "text") {
    return [
      textElement(
        id,
        textContent(node),
        coords,
        node.getAttribute("data-typography") ?? "body",
        node.getAttribute("data-color") ?? "{colors.text}"
      )
    ];
  }
  if (kind === "shape") {
    return [shapeElement(id, coords, node.getAttribute("data-component") ?? "{components.content-card}")];
  }
  if (kind === "card") {
    return cardInnerElements(node, coords, id);
  }
  if (kind === "table") {
    return [tableElement(id, node, coords)];
  }
  if (kind === "line") {
    const tag = String(node.tagName ?? "").toLowerCase();
    const preserveHeight = ["line", "path", "polyline"].includes(tag) || node.getAttribute("data-connector") !== undefined;
    return [lineElement(id, coords, preserveHeight, node)];
  }
  if (kind === "image") {
    const src = node.getAttribute("src") ?? node.getAttribute("data-src");
    return src ? [{ type: "image", id, src, ...coords }] : [];
  }
  return [];
}

function convertMeasuredSlide(slideNode, lookup, slideId) {
  const elements = [];
  const kindNodes = slideNode.querySelectorAll("[data-pptx-kind]");
  for (const node of kindNodes) {
    elements.push(...convertKindElement(node, lookup));
  }
  const explicitNodes = slideNode.querySelectorAll("[data-pptx-type]");
  for (const node of explicitNodes) {
    const coords = parseCoords(node);
    if (!coords) continue;
    const pptxType = node.getAttribute("data-pptx-type");
    const id = node.getAttribute("data-id") ?? nextId(pptxType);
    if (pptxType === "text") {
      elements.push(textElement(id, textContent(node), coords, node.getAttribute("data-typography") ?? "body"));
    } else if (pptxType === "shape") {
      elements.push(shapeElement(id, coords, node.getAttribute("data-component") ?? "{components.content-card}"));
    } else if (pptxType === "table") {
      elements.push(tableElement(id, node, coords));
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

  const slideGradient = parseCssSupportedGradient(slideMeasurement?.replica?.backgroundImage ?? slideStyle.backgroundImage);
  const unsupportedSlideBackgroundImage =
    (slideMeasurement?.replica?.backgroundImage ?? slideStyle.backgroundImage) && !slideGradient
      ? slideMeasurement?.replica?.backgroundImage ?? slideStyle.backgroundImage
      : null;
  if (
    slideMeasurement?.replica?.hasUnsupportedEffects &&
    (slideMeasurement.replica.filter ||
      slideMeasurement.replica.backdropFilter ||
      slideMeasurement.replica.clipPath ||
      unsupportedSlideBackgroundImage)
  ) {
    unsupportedEffects.push({
      elementId: "__slide-background",
      filter: slideMeasurement.replica.filter ?? null,
      backdropFilter: slideMeasurement.replica.backdropFilter ?? null,
      clipPath: slideMeasurement.replica.clipPath ?? null,
      backgroundImage: unsupportedSlideBackgroundImage
    });
  }

  function addLayer(measurement, measurementIndex, layerElements) {
    const normalized = Array.isArray(layerElements) ? layerElements : [layerElements];
    layers.push({
      zIndex: replicaZIndex(measurement),
      measurementIndex,
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
    if (![box.x, box.y, box.w, box.h].every((value) => Number.isFinite(value)) || box.w <= 0 || box.h <= 0) {
      droppedElements.push({
        elementId: measurement.id,
        kind: measurement.kind,
        reason: "invalid-measurement-box"
      });
      continue;
    }
    const kind = measurement.kind;
    const style = cssStyle(measurement);

    const unsupportedEffect = replicaUnsupportedEffect(measurement, style);
    if (unsupportedEffect) unsupportedEffects.push(unsupportedEffect);
    if (hasCssBoxShadow(style) && !parseCssBoxShadow(style.boxShadow)) {
      unsupportedEffects.push({
        elementId: measurement.id,
        boxShadow: style.boxShadow,
        reason: "unsupported-box-shadow"
      });
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
      layerElements.push(replicaTextElement(measurement.id, measurement));
      addLayer(measurement, measurementIndex, layerElements);
      coveredMeasurementIds.add(measurement.id);
    } else if (kind === "image") {
      if (measurement.src) {
        addLayer(measurement, measurementIndex, replicaImageLayerElements(measurement, box));
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
        addLayer(measurement, measurementIndex, tableElement(measurement.id, tableNode, box, style));
        coveredMeasurementIds.add(measurement.id);
      } else {
        droppedElements.push({
          elementId: measurement.id,
          kind,
          reason: "table-node-not-found"
        });
      }
    } else if (kind === "line") {
      const line = lineElement(measurement.id, box, true);
      line.style = {
        color: style.borderColor ?? style.backgroundColor ?? style.color ?? "{colors.border}",
        width: Number(style.borderWidth ?? 0) > 0 ? Math.max(0.25, Number(style.borderWidth) * 0.75) : 1
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
  const elements = [...layers]
    .sort((a, b) => a.zIndex - b.zIndex || a.measurementIndex - b.measurementIndex)
    .flatMap((layer) => layer.elements);

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
    background: slideGradient
      ? { type: "gradient", gradient: slideGradient }
      : { type: "solid", color: slideStyle.backgroundColor ?? "{colors.background}" },
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
    const box = coords ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.75 };
    elements.push(textElement(titleId, textContent(h1), box, "h1", "{colors.text}"));
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
    const items = list.querySelectorAll("li");
    const lines = [...items].map((item) => `• ${textContent(item)}`).join("\n");
    const box = parseCoords(list) ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: Math.min(2.0, items.length * 0.35) };
    elements.push(textElement(nextId("list"), lines, box, "body"));
    cursorY = box.y + box.h + 0.2;
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
      const box = coords ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.75 };
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
    const items = list.querySelectorAll("li");
    const lines = [...items].map((item) => `• ${textContent(item)}`).join("\n");
    const box = parseCoords(list) ?? { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: Math.min(2.0, items.length * 0.35) };
    const el = textElement(nextId("list"), lines, box, "body");
    el._slideId = slideId;
    elements.push(el);
    cursorY = box.y + box.h + 0.2;
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
    result = convertMeasuredSlide(slideNode, lookup, slideId);
  } else if (detection.path === "auto-layout") {
    result = convertAutoLayoutSlide(slideNode, lookup, slideId);
  } else {
    result = convertHybridSlide(slideNode, lookup, slideId);
  }

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

  return {
    ...result,
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
      elements.push(textElement(nextId("title"), textContent(h1), { x: MARGIN, y: cursorY, w: CONTENT_WIDTH, h: 0.75 }, "h1", "{colors.text}"));
      cursorY += 0.9;
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
  return String(value ?? "").replace(/^[•·\-]\s*/, "").replace(/\s+/g, " ").trim();
}

function sourceContentBlocks(slides) {
  const blocks = [];
  for (const slide of slides) {
    const nodes = slide.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,th,td,.metric,[data-metric]");
    const seen = new Set();
    for (const node of nodes) {
      const value = normalizeCoverageText(textContent(node));
      if (!value || seen.has(node)) continue;
      seen.add(node);
      blocks.push(value);
    }
    for (const node of slide.querySelectorAll("*")) {
      const tag = String(node.tagName ?? "").toLowerCase();
      if (["style", "script"].includes(tag)) continue;
      if ((node.childNodes ?? []).some((child) => child?.tagName)) continue;
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
    version: "0.1.1",
    designSystem: {
      source: options.designSystemSource ?? designSystemSource(designId, options),
      name: options.designSystemName ?? designSystemName(designId),
      mode: options.designMode ?? "balanced"
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

  // Surface the aggregated palette at the manifest level (U9) so the
  // consistency report can pick it up without having to walk every slide.
  // The shape mirrors the per-slide `paletteResolution` returned above.
  if (options.returnMetadata || options.exposePaletteResolution) {
    manifest._paletteResolution = aggregatedPalette;
  }
  if (options.returnMetadata || options.designMode === "replica") {
    manifest._replicaCoverage = aggregatedReplicaCoverage;
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
