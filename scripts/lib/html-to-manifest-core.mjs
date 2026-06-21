import { relative, resolve } from "node:path";
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
  return relative(options.manifestDir, designPath).replace(/\\/g, "/");
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

function tableElement(id, tableNode, box) {
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
    style: {
      borderColor: "{colors.border}",
      color: "{colors.text}",
      fill: "{colors.background}",
      headerFill: "{colors.surfaceAlt}",
      fontSize: 12
    }
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

function isSimpleSvgLinePath(d) {
  return (
    typeof d === "string" &&
    /^\s*M\s*-?\d+(?:\.\d+)?(?:\s+|,)\s*-?\d+(?:\.\d+)?\s+L\s*-?\d+(?:\.\d+)?(?:\s+|,)\s*-?\d+(?:\.\d+)?\s*$/i.test(d)
  );
}

function svgPathLineElements(slideNode) {
  const elements = [];
  const paths = slideNode.querySelectorAll("svg path[d]");
  for (const path of paths) {
    const d = path.getAttribute("d");
    if (!isSimpleSvgLinePath(d)) continue;
    const svg = path.parentNode;
    if (!svg || String(svg.tagName).toLowerCase() !== "svg") continue;
    const coords = parseCoords(svg);
    if (!coords) continue;
    const id = path.getAttribute("id") ?? path.getAttribute("data-id") ?? nextId("svg-line");
    elements.push(lineElement(id, coords, true, path));
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
  const detection = options._detection ?? detectLayoutMode(slideNode, options);
  const sourceCoordinates = options._sourceCoordinates ?? [];

  let result;
  if (detection.path === "measured") {
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
        designMode: options.designMode
      });
      slides.push(result);
      if (result.paletteResolution) {
        paletteResolutions.push({
          slideId: result.id,
          ...result.paletteResolution
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
      paletteResolutions
    };
  }
  return manifest;
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
