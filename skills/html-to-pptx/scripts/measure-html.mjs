import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_VIEWPORT,
  buildMeasurementsDocument,
  convertMeasurementPxToInches
} from "./lib/html-measurement-core.mjs";
import { SLIDE_SIZE } from "./lib/html-to-manifest-core.mjs";
import {
  countConvertibleSlides,
  withSettledHtmlPage,
  withTemporarilyVisibleSlide
} from "./lib/html-layout-audit.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Chromium's DOMSnapshot is the only browser-owned source for paint order and
 * stacking-context boundaries.  It is intentionally best-effort: WebKit,
 * Firefox, older Chromium builds, and restricted CDP sessions all fall back to
 * the deterministic DOM/z-index ordering already used by the converter.
 */
async function captureDomSnapshotMetadata(page) {
  try {
    const client = await page.context().newCDPSession(page);
    try {
      const snapshot = await client.send("DOMSnapshot.captureSnapshot", {
        computedStyles: ["opacity", "transform", "transform-origin", "z-index"],
        includePaintOrder: true,
        includeDOMRects: true
      });
      const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
      const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
      const byId = {};
      let layoutCount = 0;
      const stringAt = (index) => (Number.isInteger(index) ? strings[index] ?? "" : "");
      const attributesFor = (nodes, index) => {
        const raw = nodes?.attributes?.[index];
        if (!Array.isArray(raw)) return {};
        const attributes = {};
        for (let offset = 0; offset + 1 < raw.length; offset += 2) {
          attributes[stringAt(raw[offset])] = stringAt(raw[offset + 1]);
        }
        return attributes;
      };
      const nodeNameFor = (nodes, index) => stringAt(nodes?.nodeName?.[index]).toLowerCase();

      for (const document of documents) {
        const nodes = document?.nodes ?? {};
        const parentIndex = Array.isArray(nodes.parentIndex) ? nodes.parentIndex : [];
        const layout = document?.layout ?? {};
        const layoutNodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
        const paintOrders = Array.isArray(layout.paintOrders) ? layout.paintOrders : [];
        const stackingIndexes = new Set(layout.stackingContexts?.index ?? []);
        const layoutByDomNode = new Map();
        for (let index = 0; index < layoutNodeIndexes.length; index += 1) {
          layoutByDomNode.set(layoutNodeIndexes[index], index);
        }

        const ownStableId = (nodeIndex) => {
          const attributes = attributesFor(nodes, nodeIndex);
          return attributes["data-pptx-id"] || attributes["data-id"] || attributes.id || null;
        };
        const nearestStableId = (nodeIndex) => {
          let cursor = nodeIndex;
          while (Number.isInteger(cursor) && cursor >= 0) {
            const stableId = ownStableId(cursor);
            if (stableId) return stableId;
            cursor = parentIndex[cursor];
          }
          return null;
        };
        const stackingPathFor = (nodeIndex) => {
          const path = [];
          let cursor = nodeIndex;
          while (Number.isInteger(cursor) && cursor >= 0) {
            const layoutIndex = layoutByDomNode.get(cursor);
            if (Number.isInteger(layoutIndex) && stackingIndexes.has(layoutIndex)) {
              path.unshift(nearestStableId(cursor) || `dom-${cursor}`);
            }
            cursor = parentIndex[cursor];
          }
          return path;
        };

        for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
          const nodeIndex = layoutNodeIndexes[layoutIndex];
          const stableId = nearestStableId(nodeIndex);
          if (!stableId) continue;
          const paintOrder = Number(paintOrders[layoutIndex]);
          const metadata = {
            source: "cdp-dom-snapshot",
            nodeName: nodeNameFor(nodes, nodeIndex),
            ...(Number.isFinite(paintOrder) ? { paintOrder } : {}),
            stackingContext: stackingIndexes.has(layoutIndex),
            stackingContextPath: stackingPathFor(nodeIndex)
          };
          // A stable element ID can own several layout nodes (e.g. text and
          // its generated inline fragments). Keep the highest paint order so
          // the manifest remains deterministic and reflects the topmost paint.
          const previous = byId[stableId];
          if (!previous || (metadata.paintOrder ?? -Infinity) >= (previous.paintOrder ?? -Infinity)) {
            byId[stableId] = metadata;
          }
          layoutCount += 1;
        }
      }
      return {
        available: true,
        source: "cdp-dom-snapshot",
        layoutCount,
        byId
      };
    } finally {
      await client.detach().catch(() => {});
    }
  } catch {
    return { available: false, source: "dom-evaluation-fallback", byId: {} };
  }
}

function parseArgs(argv) {
  const args = {
    viewportWidth: DEFAULT_VIEWPORT.width,
    viewportHeight: DEFAULT_VIEWPORT.height,
    slideWidth: SLIDE_SIZE.width,
    slideHeight: SLIDE_SIZE.height,
    selector: "[data-pptx-kind],[data-pptx-type]",
    replica: false
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--viewport-width") {
      args.viewportWidth = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--viewport-height") {
      args.viewportHeight = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--slide-width") {
      args.slideWidth = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--slide-height") {
      args.slideHeight = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--selector") {
      args.selector = argv[i + 1];
      i += 1;
    } else if (arg === "--replica") {
      args.replica = true;
    } else {
      positional.push(arg);
    }
  }

  return { ...args, input: positional[0], output: positional[1] };
}

export async function measureHtmlFile(inputPath, options = {}) {
  const resolvedInput = resolve(inputPath);
  const viewport = {
    width: options.viewportWidth ?? DEFAULT_VIEWPORT.width,
    height: options.viewportHeight ?? DEFAULT_VIEWPORT.height
  };
  const slideSize = {
    preset: "wide",
    width: options.slideWidth ?? SLIDE_SIZE.width,
    height: options.slideHeight ?? SLIDE_SIZE.height,
    unit: "in"
  };
  const selector = options.selector ?? "[data-pptx-kind],[data-pptx-type]";
  const replica = Boolean(options.replica);

  return withSettledHtmlPage(resolvedInput, {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    javaScriptEnabled: false,
    networkEnabled: false,
    totalTimeoutMs: options.totalTimeoutMs
  }, async (page) => {
    const measureVisibleSlide = async (visibleSlideIndex) => {
      const domSnapshot = await captureDomSnapshotMetadata(page);
      return page.evaluate(({ measureSelector, replicaMode, visibleSlideIndex, domSnapshot }) => {
      function parseCssColor(value) {
        if (!value || value === "transparent") return null;
        if (String(value).startsWith("#")) return value;
        const match = String(value).match(/rgba?\(([^)]+)\)/i);
        if (!match) return null;
        const body = match[1].trim();
        const slashParts = body.split("/").map((part) => part.trim());
        const parts = slashParts[0].includes(",")
          ? slashParts[0].split(",").map((part) => part.trim())
          : slashParts[0].split(/\s+/);
        if (parts.length < 3) return null;
        const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
        if (channels.some((part) => Number.isNaN(part))) return null;
        const alpha = Number.parseFloat(slashParts[1] ?? (parts[3] ?? "1"));
        return {
          hex: `#${channels
            .map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()}`,
          transparency: alpha < 1 ? Math.round((1 - Math.max(0, Math.min(1, alpha))) * 100) : null
        };
      }

      function rgbaToHex(value) {
        const parsed = parseCssColor(value);
        if (typeof parsed === "string") return parsed;
        return parsed?.hex ?? null;
      }

      function rgbaToTransparency(value) {
        const parsed = parseCssColor(value);
        return typeof parsed === "object" && parsed ? parsed.transparency : null;
      }

      function pxToPt(value) {
        const num = Number.parseFloat(String(value || "0"));
        return Number.isFinite(num) ? Math.round(num * 0.75 * 100) / 100 : null;
      }

      function cssRotationDegrees(transform) {
        if (!transform || transform === "none") return null;
        try {
          const matrix = new DOMMatrixReadOnly(transform);
          const degrees = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
          const rounded = Math.round(degrees * 100) / 100;
          return Math.abs(rounded) > 0.01 ? rounded : null;
        } catch {
          return null;
        }
      }

      function roundNumber(value, digits = 4) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        const factor = 10 ** digits;
        return Math.round(number * factor) / factor;
      }

      function parseTransformOrigin(value) {
        const parts = String(value || "0 0").trim().split(/\s+/).map((part) => Number.parseFloat(part));
        return {
          x: roundNumber(parts[0] ?? 0, 3) ?? 0,
          y: roundNumber(parts[1] ?? 0, 3) ?? 0,
          z: roundNumber(parts[2] ?? 0, 3) ?? 0,
          raw: String(value || "0 0")
        };
      }

      function cssTransformData(style) {
        const raw = style?.transform;
        if (!raw || raw === "none") return null;
        try {
          const matrix = new DOMMatrixReadOnly(raw);
          const values = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map((value) => roundNumber(value));
          const has3d = matrix.is2D === false
            || [matrix.m13, matrix.m14, matrix.m23, matrix.m24, matrix.m31, matrix.m32, matrix.m34, matrix.m43]
              .some((value) => Number.isFinite(Number(value)) && Math.abs(Number(value)) > 0.0001)
            || Math.abs(Number(matrix.m33 ?? 1) - 1) > 0.0001
            || Math.abs(Number(matrix.m44 ?? 1) - 1) > 0.0001;
          const [a, b, c, d, e, f] = values.map((value) => Number(value ?? 0));
          const matrix3d = [
            matrix.m11, matrix.m12, matrix.m13, matrix.m14,
            matrix.m21, matrix.m22, matrix.m23, matrix.m24,
            matrix.m31, matrix.m32, matrix.m33, matrix.m34,
            matrix.m41, matrix.m42, matrix.m43, matrix.m44
          ].map((value) => roundNumber(value));
          const scaleX = Math.hypot(a, b);
          const determinant = a * d - b * c;
          const rotate = scaleX > 0 ? (Math.atan2(b, a) * 180) / Math.PI : 0;
          const orthogonality = scaleX > 0 ? (a * c + b * d) / scaleX : 0;
          const unsupported = has3d || Math.abs(orthogonality) > 0.0005;
          const scaleY = scaleX > 0 ? determinant / scaleX : Math.hypot(c, d);
          const transformOrigin = parseTransformOrigin(style.transformOrigin);
          return {
            raw,
            matrix: values,
            matrix3d,
            is2D: !has3d,
            transformOrigin,
            translateX: roundNumber(e),
            translateY: roundNumber(f),
            scaleX: roundNumber(scaleX),
            scaleY: roundNumber(Math.abs(scaleY)),
            rotate: roundNumber(rotate, 2),
            flipH: false,
            flipV: scaleY < 0,
            supported: !unsupported,
            fallback: unsupported ? (has3d ? "3d-transform" : "skew-transform") : null
          };
        } catch {
          return {
            raw,
            supported: false,
            fallback: "invalid-transform",
            transformOrigin: parseTransformOrigin(style.transformOrigin)
          };
        }
      }

      function effectiveOpacityFor(node) {
        let alpha = 1;
        let cursor = node;
        while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
          const value = Number.parseFloat(window.getComputedStyle(cursor).opacity || "1");
          if (Number.isFinite(value)) alpha *= Math.max(0, Math.min(1, value));
          cursor = cursor.parentElement;
        }
        return Math.round(alpha * 10000) / 10000;
      }

      function unsupportedCompositing(style, transformData, options = {}) {
        const blendMode = style?.mixBlendMode && style.mixBlendMode !== "normal" ? style.mixBlendMode : null;
        // A slide root commonly establishes its own stacking context with
        // `isolation:isolate`; this is a container boundary, not an effect
        // requiring a full-slide raster fallback. Keep the same property on
        // ordinary elements unsupported so their local fallback remains.
        const isolation = style?.isolation && style.isolation !== "auto"
          && !(options.slideRoot === true && style.isolation === "isolate")
          ? style.isolation
          : null;
        const maskImage = style?.maskImage && style.maskImage !== "none" ? style.maskImage : null;
        const maskComposite = style?.maskComposite && style.maskComposite !== "add" ? style.maskComposite : null;
        return {
          blendMode,
          isolation,
          maskImage,
          maskComposite,
          transformFallback: transformData?.supported === false ? transformData.fallback : null
        };
      }

      function hasUnsupportedCompositing(compositing) {
        return Object.values(compositing ?? {}).some(Boolean);
      }

      function replicaEffects(style, unsupportedVisual, node, options = {}) {
        const transformData = cssTransformData(style);
        const compositing = unsupportedCompositing(style, transformData, options);
        const effectiveOpacity = Number.isFinite(Number(options.effectiveOpacity))
          ? Number(options.effectiveOpacity)
          : effectiveOpacityFor(node);
        return {
          hasUnsupportedEffects:
            style.filter !== "none" ||
            style.backdropFilter !== "none" ||
            style.clipPath !== "none" ||
            style.backgroundImage !== "none" ||
            unsupportedVisual !== null ||
            hasUnsupportedCompositing(compositing),
          unsupportedVisual,
          filter: style.filter === "none" ? null : style.filter,
          backdropFilter: style.backdropFilter === "none" ? null : style.backdropFilter,
          clipPath: style.clipPath === "none" ? null : style.clipPath,
          backgroundImage: style.backgroundImage === "none" ? null : style.backgroundImage,
          effectiveOpacity,
          ...(hasUnsupportedCompositing(compositing) ? { unsupportedCompositing: compositing } : {})
        };
      }

      function domSnapshotMetadata(node) {
        const snapshot = domSnapshot?.byId ?? {};
        let cursor = node;
        while (cursor && cursor !== document.documentElement) {
          const stableId = cursor.getAttribute?.("data-pptx-id")
            || cursor.getAttribute?.("data-id")
            || cursor.id;
          if (stableId && snapshot[stableId]) return snapshot[stableId];
          cursor = cursor.parentElement;
        }
        return null;
      }

      function isVisible(node) {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        let visibleGeometry = false;
        if (node instanceof SVGGeometryElement && !node.closest("defs") && typeof node.getTotalLength === "function") {
          try { visibleGeometry = node.getTotalLength() > 0 && style.stroke !== "none"; } catch {}
        }
        return (
          ((rect.width > 0 && rect.height > 0) || visibleGeometry) &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          effectiveOpacityFor(node) > 0.01
        );
      }

      function normalizeLineEndings(value) {
        return String(value ?? "").replace(/\r\n?/g, "\n");
      }

      function whiteSpaceMode(value) {
        const mode = String(value ?? "normal").trim().toLowerCase();
        return ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"].includes(mode)
          ? mode
          : "normal";
      }

      function normalizeTextNodeContent(value, whiteSpace, options = {}) {
        const source = normalizeLineEndings(value);
        const mode = whiteSpaceMode(whiteSpace);
        const trim = options.trim === true;
        // CSS `pre`, `pre-wrap`, and `break-spaces` preserve every source
        // newline and space.  Do not trim or collapse these values: later
        // manifest/render stages must see the same code indentation.
        if (["pre", "pre-wrap", "break-spaces"].includes(mode)) return source;
        // CSS `pre-line` preserves newlines but collapses other whitespace.
        if (mode === "pre-line") {
          // Chromium drops collapsible whitespace at each preserved line
          // boundary. Keep the line count, but normalize every line as an
          // independent inline formatting context.
          return source
            .split("\n")
            .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
            .join("\n");
        }
        // `normal` and `nowrap` collapse all whitespace runs into one space.
        const collapsed = source.replace(/[ \t\f\v\n]+/g, " ");
        return trim ? collapsed.trim() : collapsed;
      }

      function directText(node, style) {
        const whiteSpace = whiteSpaceMode(style?.whiteSpace);
        const parts = [];
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            parts.push(normalizeTextNodeContent(child.textContent, whiteSpace));
          } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "br") {
            parts.push("\n");
          }
        }
        const value = parts.join("");
        return normalizeTextNodeContent(value, whiteSpace, { trim: !["pre", "pre-wrap", "break-spaces"].includes(whiteSpace) });
      }

      function isSemanticConnectorSvg(node) {
        return node?.tagName?.toLowerCase() === "svg"
          && Boolean(node.querySelector("[data-connector][data-pptx-kind='line']"))
          && [...node.children].every((child) => child.tagName.toLowerCase() === "defs"
            || child.matches("[data-connector][data-pptx-kind='line']"));
      }

      function svgReference(value) {
        const source = String(value ?? "").trim();
        if (!source) return null;
        const urlMatches = [...source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((match) => match[2]);
        const href = source;
        const refs = urlMatches.length > 0 ? urlMatches : [href];
        for (const ref of refs) {
          const valueRef = String(ref ?? "").trim();
          if (!valueRef || valueRef.startsWith("#")) continue;
          if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(valueRef)) continue;
          return valueRef;
        }
        return null;
      }

      function svgTransformSafe(value) {
        const source = String(value ?? "").trim();
        if (!source || source === "none") return true;
        const matrix = source.match(/^matrix\(\s*([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)[, ]+([-+\d.e]+)\s*\)$/i);
        if (matrix) {
          const [a, b, c, d] = matrix.slice(1, 5).map(Number);
          const scaleX = Math.hypot(a, b);
          return scaleX > 0 && Math.abs((a * c + b * d) / scaleX) <= 0.0005;
        }
        const tokens = [...source.matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)];
        if (tokens.length === 0 || tokens.map((match) => match[0]).join("").replace(/\s+/g, "") !== source.replace(/\s+/g, "")) return false;
        return tokens.every((match) => ["translate", "scale", "rotate"].includes(match[1].toLowerCase()));
      }

      function serializeSvgWithComputedStyles(node) {
        const clone = node.cloneNode(true);
        const sourceNodes = [node, ...node.querySelectorAll("*")];
        const clonedNodes = [clone, ...clone.querySelectorAll("*")];
        const properties = ["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "text-decoration"];
        sourceNodes.forEach((source, index) => {
          const target = clonedNodes[index];
          if (!target) return;
          const computed = window.getComputedStyle(source);
          for (const property of properties) {
            const value = String(computed.getPropertyValue(property) ?? "").trim();
            if (value) target.setAttribute(property, value);
          }
          target.removeAttribute("class");
          target.removeAttribute("style");
          const transform = source.getAttribute("transform");
          if (transform) target.setAttribute("transform", transform);
        });
        return String(clone.outerHTML ?? "");
      }

      function svgInspection(node) {
        if (!node || node.tagName?.toLowerCase() !== "svg") return null;
        const allowedNative = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "desc", "defs", "style"]);
        const nativePath = /^\s*(?:[Mm]\s*-?[\d.]+[ ,]+-?[\d.]+\s*(?:[LlHhVv]\s*-?[\d.]+(?:[ ,]+-?[\d.]+)?\s*)*(?:[Zz]\s*)?)$/;
        const nodes = [node, ...node.querySelectorAll("*")];
        const unsafeReasons = new Set();
        const classificationReasons = new Set();
        let native = true;
        let tierBCompatible = true;
        const serializedNodes = [];
        nodes.forEach((child, index) => {
          const tag = String(child.tagName ?? "").toLowerCase();
          const computed = window.getComputedStyle(child);
          const computedFilter = [computed.filter, computed.mask, computed.maskImage, computed.clipPath]
            .map((value) => String(value ?? "").trim())
            .find((value) => value && value !== "none");
          if (["filter", "mask", "clippath", "foreignobject", "script", "iframe", "object", "embed", "animate", "animatemotion", "animatetransform", "set"].includes(tag)
            || computedFilter) unsafeReasons.add(computedFilter ? "unsupported-compositing" : `${tag}-paint`);
          if (!allowedNative.has(tag)) {
            native = false;
            tierBCompatible = false;
          }
          if (["tspan", "defs", "style"].includes(tag)) {
            native = false;
            tierBCompatible = false;
          }
          if (!["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "title", "desc"].includes(tag)) tierBCompatible = false;
          if (tag === "path") {
            const d = String(child.getAttribute("d") ?? "");
            const fill = String(computed.fill ?? child.getAttribute("fill") ?? "none").toLowerCase();
            if (!nativePath.test(d) || fill !== "none") {
              native = false;
              tierBCompatible = false;
            }
          }
          if (tag === "polyline" || tag === "polygon") {
            const hasPoints = Boolean(String(child.getAttribute("points") ?? "").trim());
            native = native && hasPoints;
            if (!hasPoints) tierBCompatible = false;
            if (tag === "polygon" && String(computed.fill ?? child.getAttribute("fill") ?? "none").toLowerCase() !== "none") {
              native = false;
              tierBCompatible = false;
            }
          }
          const declaredTransform = child.getAttribute("transform");
          if (!svgTransformSafe(declaredTransform || computed.transform)) {
            native = false;
            tierBCompatible = false;
          }
          for (const attribute of [...child.attributes]) {
            const name = String(attribute.name ?? "").toLowerCase();
            const value = String(attribute.value ?? "");
            if (name.startsWith("on") || /^javascript:/i.test(value)) unsafeReasons.add("script-reference");
            if (["href", "xlink:href", "src", "filter", "mask", "clip-path", "fill", "stroke"].includes(name)) {
              const ref = ["href", "xlink:href", "src"].includes(name)
                ? svgReference(value)
                : /^url\(/i.test(value) ? svgReference(value) : null;
              if (ref) unsafeReasons.add(ref.startsWith("#") ? "internal-reference" : "external-reference");
              if (name === "filter" || name === "mask" || name === "clip-path") unsafeReasons.add("unsupported-compositing");
            }
            if (/\b(?:filter|mask|clip-path)\s*:/i.test(value)) unsafeReasons.add("unsupported-compositing");
          }
          const inlineCss = String(child.getAttribute("style") ?? "");
          if (/@import\b|url\(\s*(['"]?)(?:https?:|file:|\/|\.\.?\/)/i.test(inlineCss)) unsafeReasons.add("external-reference");
          if (tag === "style" && /@import\b|url\(\s*(['"]?)(?:https?:|file:|\/|\.\.?\/)/i.test(String(child.textContent ?? ""))) unsafeReasons.add("external-reference");
          const style = {
            fill: rgbaToHex(computed.fill),
            fillTransparency: rgbaToTransparency(computed.fill),
            fillOpacity: Number.parseFloat(computed.fillOpacity || "1"),
            stroke: rgbaToHex(computed.stroke),
            strokeTransparency: rgbaToTransparency(computed.stroke),
            strokeOpacity: Number.parseFloat(computed.strokeOpacity || "1"),
            strokeWidth: pxToPt(computed.strokeWidth),
            opacity: Number.parseFloat(computed.opacity || "1"),
            fontFamily: computed.fontFamily,
            fontSize: pxToPt(computed.fontSize),
            fontWeight: Number.parseInt(computed.fontWeight, 10) || 400,
            fontStyle: computed.fontStyle,
            textAnchor: computed.textAnchor,
            textDecoration: computed.textDecorationLine
          };
          serializedNodes.push({
            index,
            tag,
            id: child.getAttribute("data-pptx-id") || child.getAttribute("data-id") || child.getAttribute("id") || null,
            text: tag === "text" ? String(child.textContent ?? "") : null,
            style,
            transform: child.getAttribute("transform") || null,
            computedTransform: computed.transform === "none" ? null : computed.transform
          });
        });
        const source = serializeSvgWithComputedStyles(node);
        const drawable = serializedNodes.filter((entry) => ["rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text"].includes(entry.tag));
        const stableInternalIds = drawable.length > 0 && drawable.every((entry) => Boolean(entry.id));
        const explicitSemantic = String(
          node.getAttribute("data-pptx-semantic")
            || node.getAttribute("data-pptx-svg-semantic")
            || node.getAttribute("data-pptx-role")
            || ""
        ).trim().toLowerCase();
        const markerKind = String(node.getAttribute("data-pptx-kind") || "").trim().toLowerCase();
        const textBearingMarker = ["true", "1", "yes"].includes(
          String(node.getAttribute("data-pptx-text-bearing") || "").trim().toLowerCase()
        );
        const semanticClassification = ["chart", "chart-svg", "svg-chart"].includes(explicitSemantic)
          || markerKind === "chart"
          || node.hasAttribute("data-pptx-chart")
          ? "chart"
          : ["architecture", "architecture-svg", "diagram", "diagram-svg", "svg-architecture"].includes(explicitSemantic)
            || ["architecture", "diagram"].includes(markerKind)
            ? "architecture"
            : textBearingMarker || ["text", "text-bearing", "text-bearing-svg", "svg-text"].includes(explicitSemantic)
              ? "text-bearing"
              : drawable.some((entry) => entry.tag === "text")
                ? "text-bearing"
                : "decorative";
        const semanticSource = explicitSemantic
          ? "dom-marker"
          : textBearingMarker
            ? "dom-marker"
          : markerKind === "chart" || markerKind === "architecture" || markerKind === "diagram" || node.hasAttribute("data-pptx-chart")
            ? "dom-marker"
            : drawable.some((entry) => entry.tag === "text")
              ? "svg-text-node"
              : "svg-structure-default";
        const explicitGroupNodes = nodes.filter((entry) => String(entry.tagName ?? "").toLowerCase() === "g"
          && (entry.getAttribute("data-pptx-group") === "true" || entry.getAttribute("data-pptx-kind") === "group"));
        const hasExplicitGroup = explicitGroupNodes.length > 0;
        const explicitGroupsHaveStableIds = explicitGroupNodes.every((entry) => Boolean(
          entry.getAttribute("data-pptx-id") || entry.getAttribute("data-id") || entry.getAttribute("id")
        ));
        if (hasExplicitGroup && !explicitGroupsHaveStableIds) classificationReasons.add("missing-group-id");
        const tier = unsafeReasons.size > 0
          ? "C"
          : native && !hasExplicitGroup
            ? "A"
            : tierBCompatible && hasExplicitGroup && explicitGroupsHaveStableIds && stableInternalIds
              ? "B"
              : "C";
        const mode = unsafeReasons.size > 0
          ? "raster-fallback"
          : tier === "A" || tier === "B" ? "native" : "vector-preserved";
        return {
          mode,
          tier,
          safe: unsafeReasons.size === 0,
          reasons: [...new Set([...unsafeReasons, ...classificationReasons])].sort(),
          source,
          nodes: serializedNodes,
          semantic: {
            classification: semanticClassification,
            source: semanticSource,
            ...(semanticClassification === "text-bearing" && drawable.some((entry) => entry.tag === "text")
              ? { evidence: "svg-text-node" }
              : {})
          }
        };
      }

      function splitCssPaintList(value) {
        const parts = [];
        let current = "";
        let depth = 0;
        for (const char of String(value ?? "")) {
          if (char === "(") depth += 1;
          if (char === ")") depth = Math.max(0, depth - 1);
          if (char === "," && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = "";
          } else current += char;
        }
        if (current.trim()) parts.push(current.trim());
        return parts;
      }

      function decodePseudoContent(value) {
        const source = String(value ?? "").trim();
        if (!source || ["none", "normal", '""', "''"].includes(source)) return "";
        const quoted = source.match(/^(['"])([\s\S]*)\1$/);
        if (!quoted) return null;
        return quoted[2].replace(/\\([\\"'nrt])/g, (_match, escaped) => ({ n: "\n", r: "\r", t: "\t" }[escaped] ?? escaped));
      }

      function pseudoSimpleFallbackReason(style) {
        const compositing = unsupportedCompositing(style, cssTransformData(style));
        if (hasUnsupportedCompositing(compositing)) return "pseudo-unsupported-compositing";
        if (style.filter !== "none" && !/^drop-shadow\(/i.test(String(style.filter ?? ""))) return "pseudo-unsupported-filter";
        if (style.clipPath !== "none" || style.maskImage !== "none" || style.mixBlendMode !== "normal") return "pseudo-unsupported-compositing";
        const backgrounds = splitCssPaintList(style.backgroundImage).filter((layer) => layer && layer !== "none");
        if (backgrounds.some((layer) => !/^(?:linear|radial)-gradient\(/i.test(layer))) return "pseudo-unsupported-background";
        const shadowParts = splitCssPaintList(style.boxShadow).filter(Boolean);
        if (shadowParts.length > 1 || shadowParts.some((part) => /\binset\b/i.test(part))) return "pseudo-unsupported-shadow";
        const borderWidths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
          .map((value) => Number.parseFloat(value || "0") || 0)
          .filter((value) => value > 0);
        if (borderWidths.length > 1) return "pseudo-unsupported-border";
        return null;
      }

      function pseudoBounds(owner, pseudoStyle, contentText) {
        const ownerRect = owner.getBoundingClientRect();
        const parsePx = (value) => {
          const number = Number.parseFloat(String(value ?? ""));
          return Number.isFinite(number) ? number : null;
        };
        const position = String(pseudoStyle.position ?? "static").toLowerCase();
        const explicitWidth = parsePx(pseudoStyle.width);
        const explicitHeight = parsePx(pseudoStyle.height);
        const leftOffset = parsePx(pseudoStyle.left);
        const rightOffset = parsePx(pseudoStyle.right);
        const topOffset = parsePx(pseudoStyle.top);
        const bottomOffset = parsePx(pseudoStyle.bottom);
        let width = explicitWidth;
        let height = explicitHeight;
        if (!(width > 0)) {
          if (leftOffset !== null && rightOffset !== null) width = Math.max(0, ownerRect.width - leftOffset - rightOffset);
        }
        if (!(height > 0)) {
          if (topOffset !== null && bottomOffset !== null) height = Math.max(0, ownerRect.height - topOffset - bottomOffset);
        }
        const probe = document.createElement(contentText ? "span" : "div");
        probe.setAttribute("data-pptx-generated", "true");
        probe.textContent = contentText ?? "";
        probe.style.position = "fixed";
        probe.style.left = `${ownerRect.left}px`;
        probe.style.top = `${ownerRect.top}px`;
        probe.style.margin = "0";
        probe.style.boxSizing = "border-box";
        probe.style.pointerEvents = "none";
        probe.style.zIndex = "-2147483648";
        const copyProperties = [
          "display", "visibility", "opacity", "color", "background", "background-color", "background-image",
          "background-size", "background-position", "background-repeat", "border", "border-radius", "box-shadow",
          "font", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
          "white-space", "text-transform", "text-decoration", "text-align", "overflow", "padding", "box-sizing",
          "transform", "transform-origin"
        ];
        copyProperties.forEach((property) => {
          const value = String(pseudoStyle.getPropertyValue(property) ?? "").trim();
          if (value) probe.style.setProperty(property, value);
        });
        if (width > 0) probe.style.width = `${width}px`;
        if (height > 0) probe.style.height = `${height}px`;
        document.body.appendChild(probe);
        let rect = probe.getBoundingClientRect();
        width = width > 0 ? width : rect.width;
        height = height > 0 ? height : rect.height;
        if (!(width > 0) && contentText) width = Math.max(1, rect.width);
        if (!(height > 0) && contentText) height = Math.max(1, rect.height);
        const x = leftOffset !== null
          ? ownerRect.left + leftOffset
          : rightOffset !== null
            ? ownerRect.right - rightOffset - width
            : ownerRect.left;
        const y = topOffset !== null
          ? ownerRect.top + topOffset
          : bottomOffset !== null
            ? ownerRect.bottom - bottomOffset - height
            : ownerRect.top;
        probe.style.left = `${x}px`;
        probe.style.top = `${y}px`;
        rect = probe.getBoundingClientRect();
        const measured = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        probe.remove();
        return measured;
      }

      function maxDescendantPaintOrder(node, fallback = null) {
        let maximum = Number(fallback?.paintOrder);
        for (const descendant of node?.querySelectorAll?.("*") ?? []) {
          const metadata = domSnapshotMetadata(descendant);
          const paintOrder = Number(metadata?.paintOrder);
          if (Number.isFinite(paintOrder)) maximum = Math.max(maximum, paintOrder);
        }
        return Number.isFinite(maximum) ? maximum : null;
      }

      function materializePseudoMeasurement(node, pseudoName, ownerId, slideId, slideIndex, slideRect, nodeMeta) {
        const pseudoStyle = window.getComputedStyle(node, `::${pseudoName}`);
        const contentText = decodePseudoContent(pseudoStyle.content);
        const parsedBackground = parseCssColor(pseudoStyle.backgroundColor);
        const hasVisibleBackground = typeof parsedBackground === "string"
          || (parsedBackground && Number(parsedBackground.transparency ?? 0) < 100);
        const hasPaintedBackground = pseudoStyle.backgroundImage !== "none"
          || Boolean(hasVisibleBackground)
          || Number.parseFloat(pseudoStyle.borderTopWidth || "0") > 0
          || Number.parseFloat(pseudoStyle.borderRightWidth || "0") > 0
          || Number.parseFloat(pseudoStyle.borderBottomWidth || "0") > 0
          || Number.parseFloat(pseudoStyle.borderLeftWidth || "0") > 0
          || pseudoStyle.boxShadow !== "none";
        if (pseudoStyle.display === "none" || pseudoStyle.visibility === "hidden" || (contentText === "" && !hasPaintedBackground)) return null;
        if (contentText === null) return null;
        const pseudoRect = pseudoBounds(node, pseudoStyle, contentText);
        if (!(pseudoRect.width > 0 && pseudoRect.height > 0)) return null;
        const fallbackReason = pseudoSimpleFallbackReason(pseudoStyle);
        const id = `${ownerId}-${pseudoName}`;
        const effectiveOpacity = effectiveOpacityFor(node) * (Number.parseFloat(pseudoStyle.opacity || "1") || 1);
        const kind = contentText ? "text" : "shape";
        const ownPaintOrder = Number(nodeMeta?.paintOrder);
        const descendantPaintOrder = maxDescendantPaintOrder(node, nodeMeta);
        const pseudoPaintOrder = Number.isFinite(ownPaintOrder)
          ? pseudoName === "before"
            ? ownPaintOrder + 0.01
            : Math.max(ownPaintOrder, Number(descendantPaintOrder) || ownPaintOrder) + 0.02
          : null;
        const generatedNodeMeta = nodeMeta ? {
          ...nodeMeta,
          ...(Number.isFinite(pseudoPaintOrder) ? { paintOrder: pseudoPaintOrder } : {})
        } : null;
        return {
          id,
          slideId,
          kind,
          slideIndex,
          tagName: contentText ? "span" : "div",
          selector: `[data-pptx-generated="${id}"]`,
          text: contentText,
          visibleText: contentText || null,
          src: null,
          href: null,
          hyperlinkTooltip: null,
          generated: true,
          dataPptxGenerated: true,
          generatedBy: ownerId,
          pseudo: pseudoName,
          pseudoOwnerId: ownerId,
          semantics: { semanticParentId: ownerId, role: "generated-pseudo" },
          ...(generatedNodeMeta ? {
            paintOrder: generatedNodeMeta.paintOrder,
            stackingContext: Boolean(generatedNodeMeta.stackingContext),
            stackingContextPath: generatedNodeMeta.stackingContextPath ?? []
          } : {}),
          style: computedStyleFor(pseudoStyle, pseudoRect, effectiveOpacity),
          replica: replicaEffects(pseudoStyle, fallbackReason, node, { effectiveOpacity }),
          px: {
            x: pseudoRect.left - slideRect.left,
            y: pseudoRect.top - slideRect.top,
            w: pseudoRect.width,
            h: pseudoRect.height
          }
        };
      }

      function ownsReplicaFallback(node) {
        const tagName = node?.tagName?.toLowerCase();
        if (!tagName) return false;
        const style = window.getComputedStyle(node);
        return tagName === "canvas"
          || (tagName === "svg" && !isSemanticConnectorSvg(node))
          || style.filter !== "none"
          || style.backdropFilter !== "none"
          || style.clipPath !== "none"
          || style.mixBlendMode !== "normal"
          || style.isolation !== "auto"
          || style.maskImage !== "none";
      }

      function directTextNodes(node) {
	        return [...node.childNodes]
	          .filter((child) => child.nodeType === Node.TEXT_NODE)
	          .map((child) => ({ node: child, text: String(child.textContent ?? "") }))
	          .filter((entry) => entry.text.length > 0);
      }

      function normalizeRunText(value, whiteSpace = "normal") {
        return normalizeTextNodeContent(value, whiteSpace);
      }

      function runDecoration(style) {
        const line = String(style?.textDecorationLine ?? "").trim().toLowerCase();
        const decoration = {};
        if (/\bunderline\b/.test(line)) decoration.underline = { style: "sng" };
        if (/\bline-through\b/.test(line)) decoration.strike = "sngStrike";
        return Object.keys(decoration).length > 0 ? decoration : null;
      }

      function runStyleFor(node) {
        const owner = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        const style = owner ? window.getComputedStyle(owner) : window.getComputedStyle(document.body);
        const rect = owner?.getBoundingClientRect?.() ?? null;
        const computed = computedStyleFor(style, rect, owner ? effectiveOpacityFor(owner) : null);
        const anchor = owner?.closest?.("a[href]");
        const href = String(anchor?.getAttribute("href") ?? "").trim();
        const hyperlink = /^https?:\/\//i.test(href)
          ? { url: href, ...(anchor?.getAttribute("title") || anchor?.getAttribute("data-tooltip")
            ? { tooltip: anchor.getAttribute("title") || anchor.getAttribute("data-tooltip") }
            : {}) }
          : null;
        return {
          fontFamily: computed.fontFamily,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          fontStyle: computed.fontStyle,
          color: computed.webkitTextFillColor ?? computed.color,
          decoration: runDecoration(style),
          ...(hyperlink ? { hyperlink } : {})
        };
      }

      function collectRichTextRuns(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return [];
        const runs = [];
        const parentStyle = window.getComputedStyle(node);
        const whiteSpace = whiteSpaceMode(parentStyle.whiteSpace);
        const walk = (current) => {
          for (const child of current.childNodes ?? []) {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = normalizeRunText(child.textContent, whiteSpace);
              if (!text || (!text.trim() && !["pre", "pre-wrap", "break-spaces"].includes(whiteSpace))) continue;
              runs.push({ text, ...runStyleFor(child) });
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const tagName = child.tagName.toLowerCase();
              if (tagName === "br") {
                runs.push({ text: "\n", ...runStyleFor(child) });
                continue;
              }
              // A nested semantic marker owns its own text object. Do not
              // duplicate it inside the enclosing explicit text run list.
              if (child !== node && (child.hasAttribute("data-pptx-kind") || child.hasAttribute("data-pptx-type")
                || child.hasAttribute("data-pptx-id") || child.hasAttribute("data-id"))) continue;
              walk(child);
            }
          }
        };
        walk(node);
        if (runs.length > 0 && !["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
          runs[0].text = runs[0].text.replace(/^\s+/, "");
          const last = runs.at(-1);
          last.text = last.text.replace(/\s+$/, "");
        }
        return runs.filter((run) => run.text);
      }

      function tableCellRows(section) {
        return [...(section?.children ?? [])].filter((child) => child.tagName?.toLowerCase() === "tr");
      }

      function tableCellMeta(cell, slideRect) {
        const rect = cell.getBoundingClientRect();
        const style = window.getComputedStyle(cell);
        const runs = collectRichTextRuns(cell);
        const text = normalizeTextNodeContent(cell.innerText ?? cell.textContent ?? "", style.whiteSpace);
        const anchor = cell.matches?.("a[href]") ? cell : cell.querySelector?.("a[href]");
        const colspan = Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1);
        const rowspan = Math.max(1, Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1);
        return {
          tagName: cell.tagName.toLowerCase(),
          text,
          ...(runs.length > 0 ? { runs } : {}),
          colspan,
          rowspan,
          href: anchor?.getAttribute("href") ?? null,
          hyperlinkTooltip: anchor?.getAttribute("title") || anchor?.getAttribute("data-tooltip") || null,
          style: computedStyleFor(style, rect, effectiveOpacityFor(cell)),
          px: {
            x: rect.left - slideRect.left,
            y: rect.top - slideRect.top,
            w: rect.width,
            h: rect.height
          }
        };
      }

      function collectTableMeta(table, tableRect, slideRect) {
        const sections = [];
        const directRows = [];
        for (const child of table.children ?? []) {
          const tagName = child.tagName.toLowerCase();
          if (["thead", "tbody", "tfoot"].includes(tagName)) {
            const rows = tableCellRows(child).map((row) => ({
              px: (() => { const rect = row.getBoundingClientRect(); return { x: rect.left - slideRect.left, y: rect.top - slideRect.top, w: rect.width, h: rect.height }; })(),
              cells: [...row.children].filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
                .map((cell) => tableCellMeta(cell, slideRect))
            }));
            sections.push({ type: tagName, rows });
          } else if (tagName === "tr") {
            directRows.push(child);
          }
        }
        if (directRows.length > 0) {
          sections.push({
            type: "tbody",
            rows: directRows.map((row) => ({
              px: (() => { const rect = row.getBoundingClientRect(); return { x: rect.left - slideRect.left, y: rect.top - slideRect.top, w: rect.width, h: rect.height }; })(),
              cells: [...row.children].filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
                .map((cell) => tableCellMeta(cell, slideRect))
            }))
          });
        }
        const rows = sections.flatMap((section) => section.rows);
        const maxColumns = Math.max(1, ...rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.colspan, 0)));
        const columnWidths = Array.from({ length: maxColumns }, () => 0);
        for (const row of rows) {
          let cursor = 0;
          for (const cell of row.cells) {
            const each = Number(cell.px.w) / Math.max(1, cell.colspan);
            for (let index = 0; index < cell.colspan && cursor + index < columnWidths.length; index += 1) {
              columnWidths[cursor + index] = Math.max(columnWidths[cursor + index], each);
            }
            cursor += cell.colspan;
          }
        }
        const sum = columnWidths.reduce((total, value) => total + value, 0);
        if (sum > 0 && tableRect.width > 0) {
          const scale = tableRect.width / sum;
          for (let index = 0; index < columnWidths.length; index += 1) columnWidths[index] *= scale;
        }
        const captionNode = [...table.children ?? []].find((child) => child.tagName?.toLowerCase() === "caption");
        const caption = captionNode ? (() => {
          const rect = captionNode.getBoundingClientRect();
          return {
            text: normalizeTextNodeContent(captionNode.innerText ?? captionNode.textContent ?? "", window.getComputedStyle(captionNode).whiteSpace),
            runs: collectRichTextRuns(captionNode),
            px: { x: rect.left - slideRect.left, y: rect.top - slideRect.top, w: rect.width, h: rect.height }
          };
        })() : null;
        return {
          sections,
          columnsPx: columnWidths,
          rowHeightsPx: rows.map((row) => row.px.h),
          ...(caption ? { caption } : {})
        };
      }

      function inlineTextLineFragments(textNode, style) {
        const raw = String(textNode?.textContent ?? "");
        const mode = whiteSpaceMode(style?.whiteSpace);
        if (!raw.length || (!raw.trim() && !["pre", "pre-wrap", "break-spaces"].includes(mode))) return [];
        const range = document.createRange();
        const lines = [];
        const lineForRect = (rect) => {
          const top = Math.round(rect.top * 10) / 10;
          const bottom = Math.round(rect.bottom * 10) / 10;
          let line = lines.find((candidate) => Math.abs(candidate.top - top) <= 1.5 && Math.abs(candidate.bottom - bottom) <= 2);
          if (!line) {
            line = { top, bottom, left: rect.left, right: rect.right, start: null, end: null };
            lines.push(line);
          }
          line.left = Math.min(line.left, rect.left);
          line.right = Math.max(line.right, rect.right);
          return line;
        };
        try {
          for (let index = 0; index < raw.length; index += 1) {
            range.setStart(textNode, index);
            range.setEnd(textNode, index + 1);
            const rect = [...range.getClientRects()].find((candidate) => candidate.width > 0 && candidate.height > 0);
            if (!rect) continue;
            const line = lineForRect(rect);
            if (line.start === null) line.start = index;
            line.end = index + 1;
          }
        } finally {
          range.detach();
        }
        return lines
          .filter((line) => line.start !== null && line.end > line.start)
          .sort((left, right) => left.top - right.top || left.left - right.left)
          .map((line, index) => {
            const text = normalizeTextNodeContent(raw.slice(line.start, line.end), mode, {
              // Keep fragment-edge spaces until all inline fragments sharing
              // the same visual line are merged. CSS whitespace normalization
              // is applied once at that line boundary in keyHeadingMetadata.
              trim: false
            });
            return {
              index,
              text,
              rect: {
                left: line.left,
                top: line.top,
                width: Math.max(0, line.right - line.left),
                height: Math.max(0, line.bottom - line.top)
              }
            };
          })
          .filter((line) => line.text.length > 0);
      }

      function keyHeadingMetadata(node, style, text) {
        const tagName = String(node?.tagName ?? "").toLowerCase();
        const role = String(node?.getAttribute?.("data-layout-role") ?? "").trim().toLowerCase();
        const maxLines = node?.getAttribute?.("data-max-lines");
        const fontSize = Number.parseFloat(style?.fontSize ?? "0") || 0;
        const isKeyHeading = ["h1", "h2"].includes(tagName)
          || role === "title"
          || maxLines !== null
          || fontSize >= 28;
        if (!isKeyHeading) return null;

        const fragments = [];
        const textNodes = [];
        const walk = (current) => {
          for (const child of current?.childNodes ?? []) {
            if (child.nodeType === Node.TEXT_NODE) textNodes.push(child);
            else if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() !== "br") walk(child);
          }
        };
        walk(node);
        for (const textNode of textNodes) {
          for (const fragment of inlineTextLineFragments(textNode, style)) {
            fragments.push({ ...fragment, text: fragment.text });
          }
        }
        fragments.sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
        const renderedLines = [];
        for (const fragment of fragments) {
          const previous = renderedLines.at(-1);
          if (previous && Math.abs(previous.top - fragment.rect.top) <= 1.5) {
            previous.text += fragment.text;
          } else {
            renderedLines.push({ top: fragment.rect.top, text: fragment.text });
          }
        }
        const preserveLineWhitespace = ["pre", "pre-wrap", "break-spaces"].includes(whiteSpaceMode(style?.whiteSpace));
        const renderedLineTexts = renderedLines.map((line) => normalizeTextNodeContent(
          line.text,
          style?.whiteSpace,
          { trim: !preserveLineWhitespace }
        ));
        const canonical = String(text ?? "");
        const fallbackLines = canonical.split("\n");
        const lines = renderedLineTexts.length > 0 ? renderedLineTexts : fallbackLines;
        const lineBreakOffsets = [];
        let sourceCursor = 0;
        for (let index = 0; index < Math.max(0, lines.length - 1); index += 1) {
          const line = String(lines[index] ?? "");
          const directStart = canonical.indexOf(line, sourceCursor);
          let sourceEnd = directStart >= 0 ? directStart + line.length : sourceCursor;
          if (directStart < 0) {
            // Fallback for a line whose visual whitespace was normalized
            // differently from the canonical source. Match non-whitespace
            // characters in order while consuming every source whitespace
            // run, so the returned coordinate still points into `canonical`.
            let cursor = sourceCursor;
            for (const character of line) {
              if (/\s/.test(character)) {
                while (cursor < canonical.length && /\s/.test(canonical[cursor])) cursor += 1;
                continue;
              }
              const match = canonical.indexOf(character, cursor);
              if (match < 0) break;
              cursor = match + 1;
            }
            sourceEnd = cursor;
          }
          lineBreakOffsets.push(sourceEnd);
          sourceCursor = sourceEnd;
          while (sourceCursor < canonical.length && /\s/.test(canonical[sourceCursor])) sourceCursor += 1;
        }
        return {
          renderedLines: lines,
          lineBreakOffsets,
          renderedLineCount: lines.length
        };
      }

	      function renderedEllipsisText(node, style, text) {
	        if (
	          !text ||
	          style.textOverflow !== "ellipsis" ||
	          style.whiteSpace !== "nowrap" ||
	          !["hidden", "clip"].includes(style.overflowX)
	        ) {
	          return null;
	        }
	        if (node.scrollWidth <= node.clientWidth + 1) return null;
	        const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
	        const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
	        const available = Math.max(0, node.clientWidth - paddingLeft - paddingRight);
	        const context = document.createElement("canvas").getContext("2d");
	        if (!context || available <= 0) return "…";
	        context.font = style.font;
	        const ellipsis = "…";
	        if (context.measureText(ellipsis).width >= available) return ellipsis;
	        let low = 0;
	        let high = text.length;
	        while (low < high) {
	          const mid = Math.ceil((low + high) / 2);
	          const candidate = `${text.slice(0, mid).trimEnd()}${ellipsis}`;
	          if (context.measureText(candidate).width <= available) {
	            low = mid;
	          } else {
	            high = mid - 1;
	          }
	        }
	        return `${text.slice(0, low).trimEnd()}${ellipsis}`;
	      }

      function hasVisibleChildElements(node) {
        return [...node.children].some((child) => isVisible(child));
      }

      function hasPaint(style) {
        const borderWidths = [
          Number.parseFloat(style.borderTopWidth || "0"),
          Number.parseFloat(style.borderRightWidth || "0"),
          Number.parseFloat(style.borderBottomWidth || "0"),
          Number.parseFloat(style.borderLeftWidth || "0")
        ];
        const outlineWidth = Number.parseFloat(style.outlineWidth || "0") || 0;
        const background = parseCssColor(style.backgroundColor);
        const hasOpaqueBackground = typeof background === "string"
          || (background && Number(background.transparency ?? 0) < 100);
        return (
          Boolean(hasOpaqueBackground) ||
          style.backgroundImage !== "none" ||
          borderWidths.some((width) => width > 0) ||
          (outlineWidth > 0 && style.outlineStyle !== "none" && style.outlineStyle !== "hidden") ||
          style.boxShadow !== "none"
        );
      }

      function inferKind(node, style) {
        const explicit = node.getAttribute("data-pptx-kind") || node.getAttribute("data-pptx-type");
        const tag = node.tagName.toLowerCase();
        // SVG semantic markers describe the vector's meaning; they do not
        // route the SVG into the HTML chart/architecture converters. Keep
        // the source kind as shape so Tier A/B/C SVG handling remains intact.
        if (tag === "svg" && ["chart", "architecture", "diagram"].includes(String(explicit ?? "").trim().toLowerCase())) {
          return "shape";
        }
        if (explicit) return explicit;
        if (tag === "img") return "image";
        if (tag === "table") return "table";
        if (tag === "hr") return "line";
        if (directText(node, style) && !hasVisibleChildElements(node)) return "text";
        if (hasPaint(style)) return "shape";
        return null;
      }

      function generatedSemanticParentId(node) {
        if (node.hasAttribute("data-pptx-id") || node.hasAttribute("data-pptx-type") || node.hasAttribute("data-id") || node.id) {
          return null;
        }
        const parent = node.parentElement?.closest("[data-pptx-kind='text'],[data-pptx-type='text']");
        return parent?.getAttribute("data-pptx-id") ?? parent?.getAttribute("data-id") ?? parent?.id ?? null;
      }

      function cssRadiusAxis(value, basis) {
        const source = String(value ?? "0").trim().toLowerCase();
        if (!source) return 0;
        const numeric = Number.parseFloat(source);
        if (!Number.isFinite(numeric)) return 0;
        if (source.endsWith("%")) return Math.max(0, (basis * numeric) / 100);
        return Math.max(0, numeric);
      }

      function cssRadiusPair(value, rect) {
        const source = String(value ?? "0").trim();
        const [horizontal, vertical] = source.split("/").map((part) => part.trim());
        const xParts = String(horizontal || "0").split(/\s+/).filter(Boolean);
        const yParts = vertical
          ? String(vertical).split(/\s+/).filter(Boolean)
          : xParts.slice(1);
        const x = cssRadiusAxis(xParts[0] || "0", Number(rect?.width ?? 0));
        const y = cssRadiusAxis(yParts[0] || xParts[0] || "0", Number(rect?.height ?? 0));
        const pair = {
          rx: Math.round(x * 100) / 100,
          ry: Math.round(y * 100) / 100
        };
        return pair;
      }

      function normalizeCornerRadii(corners, rect) {
        const width = Math.max(0, Number(rect?.width ?? 0));
        const height = Math.max(0, Number(rect?.height ?? 0));
        const values = corners.map((corner) => ({ rx: Math.max(0, Number(corner?.rx) || 0), ry: Math.max(0, Number(corner?.ry) || 0) }));
        const scale = Math.min(
          1,
          width > 0 ? width / Math.max(1, values[0].rx + values[1].rx, values[2].rx + values[3].rx) : 1,
          height > 0 ? height / Math.max(1, values[0].ry + values[3].ry, values[1].ry + values[2].ry) : 1
        );
        return values.map((corner) => ({
          rx: Math.round(corner.rx * scale * 100) / 100,
          ry: Math.round(corner.ry * scale * 100) / 100
        }));
      }

      function computedStyleFor(style, rect = null, effectiveOpacity = null) {
        const fontSize = pxToPt(style.fontSize);
        const lineHeight = style.lineHeight === "normal"
          ? Math.round((fontSize ?? 0) * 1.2 * 100) / 100
          : pxToPt(style.lineHeight);
        const transformData = cssTransformData(style);
        const whiteSpace = whiteSpaceMode(style.whiteSpace);
        const parsedTabSize = Number.parseFloat(style.tabSize);
        const tabSize = Number.isFinite(parsedTabSize) && parsedTabSize > 0 ? parsedTabSize : 8;
        const cornerRadii = normalizeCornerRadii([
          cssRadiusPair(style.borderTopLeftRadius, rect),
          cssRadiusPair(style.borderTopRightRadius, rect),
          cssRadiusPair(style.borderBottomRightRadius, rect),
          cssRadiusPair(style.borderBottomLeftRadius, rect)
        ], rect);
        return {
          color: rgbaToHex(style.color),
          colorTransparency: rgbaToTransparency(style.color),
          backgroundColor: rgbaToHex(style.backgroundColor),
          backgroundTransparency: rgbaToTransparency(style.backgroundColor),
          backgroundImage: style.backgroundImage === "none" ? null : style.backgroundImage,
          backgroundSize: style.backgroundSize,
          backgroundPosition: style.backgroundPosition,
          backgroundRepeat: style.backgroundRepeat,
          borderColor: rgbaToHex(style.borderColor || style.borderTopColor),
          borderTransparency: rgbaToTransparency(style.borderColor || style.borderTopColor),
          borderWidth: Number.parseFloat(style.borderTopWidth || "0") || 0,
          borderStyle: style.borderTopStyle,
          borderTopColor: rgbaToHex(style.borderTopColor),
          borderRightColor: rgbaToHex(style.borderRightColor),
          borderBottomColor: rgbaToHex(style.borderBottomColor),
          borderLeftColor: rgbaToHex(style.borderLeftColor),
          borderTopTransparency: rgbaToTransparency(style.borderTopColor),
          borderRightTransparency: rgbaToTransparency(style.borderRightColor),
          borderBottomTransparency: rgbaToTransparency(style.borderBottomColor),
          borderLeftTransparency: rgbaToTransparency(style.borderLeftColor),
          borderTopWidth: Number.parseFloat(style.borderTopWidth || "0") || 0,
          borderRightWidth: Number.parseFloat(style.borderRightWidth || "0") || 0,
          borderBottomWidth: Number.parseFloat(style.borderBottomWidth || "0") || 0,
          borderLeftWidth: Number.parseFloat(style.borderLeftWidth || "0") || 0,
          borderTopStyle: style.borderTopStyle,
          borderRightStyle: style.borderRightStyle,
          borderBottomStyle: style.borderBottomStyle,
          borderLeftStyle: style.borderLeftStyle,
          outlineColor: rgbaToHex(style.outlineColor),
          outlineTransparency: rgbaToTransparency(style.outlineColor),
          outlineWidth: Number.parseFloat(style.outlineWidth || "0") || 0,
          outlineStyle: style.outlineStyle,
          outlineOffset: Number.parseFloat(style.outlineOffset || "0") || 0,
          // Keep the legacy scalar radius while exposing normalized two-axis
          // radii for structure-preserving shape classification.
          borderRadius: cornerRadii[0].rx,
          borderRadiusX: cornerRadii[0].rx,
          borderRadiusY: cornerRadii[0].ry,
          borderTopLeftRadius: cornerRadii[0].rx,
          borderTopRightRadius: cornerRadii[1].rx,
          borderBottomRightRadius: cornerRadii[2].rx,
          borderBottomLeftRadius: cornerRadii[3].rx,
          borderTopLeftRadiusX: cornerRadii[0].rx,
          borderTopLeftRadiusY: cornerRadii[0].ry,
          borderTopRightRadiusX: cornerRadii[1].rx,
          borderTopRightRadiusY: cornerRadii[1].ry,
          borderBottomRightRadiusX: cornerRadii[2].rx,
          borderBottomRightRadiusY: cornerRadii[2].ry,
          borderBottomLeftRadiusX: cornerRadii[3].rx,
          borderBottomLeftRadiusY: cornerRadii[3].ry,
          cornerRadii,
          opacity: Number.parseFloat(style.opacity || "1"),
          ...(Number.isFinite(Number(effectiveOpacity)) ? { effectiveOpacity: Number(effectiveOpacity) } : {}),
          fontFamily: style.fontFamily,
          fontSize,
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          fontStyle: style.fontStyle,
          fontVariantCaps: style.fontVariantCaps,
          lineHeight,
          display: style.display,
          writingMode: style.writingMode,
	          listStyleType: style.listStyleType,
	          listStylePosition: style.listStylePosition,
	          verticalAlign: style.verticalAlign,
	          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          letterSpacing: style.letterSpacing === "normal" ? null : pxToPt(style.letterSpacing),
          textTransform: style.textTransform,
	          textDecorationLine: style.textDecorationLine,
	          textAlign: style.textAlign,
	          direction: style.direction,
	          textIndent: Number.parseFloat(style.textIndent || "0") || 0,
	          overflowX: style.overflowX,
	          overflowY: style.overflowY,
	          textOverflow: style.textOverflow,
	          webkitTextFillColor: rgbaToHex(style.webkitTextFillColor),
          webkitTextFillTransparency: rgbaToTransparency(style.webkitTextFillColor),
          webkitTextStrokeColor: rgbaToHex(style.webkitTextStrokeColor),
          webkitTextStrokeTransparency: rgbaToTransparency(style.webkitTextStrokeColor),
          webkitTextStrokeWidth: Number.parseFloat(style.webkitTextStrokeWidth || "0") || 0,
          whiteSpace,
          tabSize,
          preserveWhitespace: ["pre", "pre-wrap", "break-spaces"].includes(whiteSpace),
          paddingTop: pxToPt(style.paddingTop),
          paddingRight: pxToPt(style.paddingRight),
          paddingBottom: pxToPt(style.paddingBottom),
          paddingLeft: pxToPt(style.paddingLeft),
          zIndex: style.zIndex === "auto" ? null : Number.parseInt(style.zIndex, 10),
          boxShadow: style.boxShadow === "none" ? null : style.boxShadow,
          textShadow: style.textShadow === "none" ? null : style.textShadow,
          transform: style.transform === "none" ? null : style.transform,
          transformOrigin: style.transformOrigin === "none" ? null : style.transformOrigin,
          ...(transformData ? { transformData } : {}),
          rotate: cssRotationDegrees(style.transform),
          mixBlendMode: style.mixBlendMode,
          isolation: style.isolation,
          maskImage: style.maskImage,
          maskComposite: style.maskComposite,
          objectFit: style.objectFit,
          objectPosition: style.objectPosition
        };
      }

      const slides = [...document.querySelectorAll(".pptx-slide, [data-slide]")];
      const allSourceSlides = slides.length > 0
        ? slides
        : [document.querySelector(".pptx-deck") ?? document.body];
      const sourceSlides = Number.isInteger(visibleSlideIndex)
        ? [allSourceSlides[visibleSlideIndex]].filter(Boolean)
        : allSourceSlides;
      const raw = [];
      const rawSlides = [];

      sourceSlides.forEach((slide) => {
        const slideIndex = allSourceSlides.indexOf(slide);
        const slideRect = slide.getBoundingClientRect();
        const slideStyle = window.getComputedStyle(slide);
        const slideId = slide.getAttribute("data-slide-id") || slide.id || `slide-${String(slideIndex + 1).padStart(3, "0")}`;
        const slideMeta = domSnapshotMetadata(slide);
        rawSlides.push({
          slideId,
          slideIndex,
          selector: slide.id ? `#${slide.id}` : slide.matches(".pptx-slide") ? ".pptx-slide" : slide.tagName.toLowerCase(),
          style: computedStyleFor(slideStyle, slideRect, effectiveOpacityFor(slide)),
          ...(slideMeta ? {
            paintOrder: slideMeta.paintOrder ?? null,
            stackingContext: Boolean(slideMeta.stackingContext),
            stackingContextPath: slideMeta.stackingContextPath ?? []
          } : {}),
          replica: replicaEffects(slideStyle, null, slide, { slideRoot: true })
        });
        const nodes = [...slide.querySelectorAll(measureSelector)];
        nodes.forEach((node, nodeIndex) => {
          if (replicaMode) {
            let ancestor = node.parentElement;
            while (ancestor && ancestor !== slide) {
              if (ownsReplicaFallback(ancestor)) return;
              ancestor = ancestor.parentElement;
            }
          }
          if (!isVisible(node)) return;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const generatedId = `html-${String(slideIndex + 1).padStart(3, "0")}-${String(nodeIndex + 1).padStart(3, "0")}`;
          const id = node.getAttribute("data-pptx-id") || node.getAttribute("data-id") || node.id || generatedId;
          const tagName = node.tagName.toLowerCase();
          const nodeMeta = domSnapshotMetadata(node) ?? slideMeta;
          const pseudoBeforeMeasurement = replicaMode
            ? materializePseudoMeasurement(node, "before", id, slideId, slideIndex, slideRect, nodeMeta)
            : null;
          const pseudoAfterMeasurement = replicaMode
            ? materializePseudoMeasurement(node, "after", id, slideId, slideIndex, slideRect, nodeMeta)
            : null;
          if (pseudoBeforeMeasurement) raw.push(pseudoBeforeMeasurement);
          const semanticConnectorSvg = isSemanticConnectorSvg(node);
          const svg = tagName === "svg" ? svgInspection(node) : null;
          const unsupportedVisual = tagName === "canvas"
            ? "canvas-paint"
            : tagName === "svg" && !semanticConnectorSvg && svg?.mode === "raster-fallback"
              ? "svg-paint"
              : null;
          const pushInlineTextFragments = (allowLeaf = false) => {
            if (!replicaMode || (!hasVisibleChildElements(node) && !allowLeaf)) return false;
            let pushed = false;
            directTextNodes(node).forEach((entry, textIndex) => {
              const lineFragments = inlineTextLineFragments(entry.node, style);
              lineFragments.forEach((fragment) => {
                const textRect = fragment.rect;
                if (textRect.width <= 0 || textRect.height <= 0) return;
                pushed = true;
                raw.push({
                  id: `${id}-text-${textIndex + 1}-line-${fragment.index + 1}`,
                  slideId,
                  kind: "text",
                  slideIndex,
                  tagName,
                  selector: node.id ? `#${node.id}::text(${textIndex + 1})::line(${fragment.index + 1})` : `[data-pptx-id="${id}"]::text(${textIndex + 1})::line(${fragment.index + 1})`,
                  text: fragment.text,
                  src: null,
                  semantics: {
                    semanticParentId: node.getAttribute("data-semantic-parent-id") || generatedSemanticParentId(node)
                  },
                  ...(nodeMeta ? {
                    paintOrder: nodeMeta.paintOrder ?? null,
                    stackingContext: Boolean(nodeMeta.stackingContext),
                    stackingContextPath: nodeMeta.stackingContextPath ?? []
                  } : {}),
                  style: computedStyleFor(style, textRect, effectiveOpacityFor(node)),
                  replica: replicaEffects(style, null, node),
                  px: {
                    x: textRect.left - slideRect.left,
                    y: textRect.top - slideRect.top,
                    w: textRect.width,
                    h: textRect.height
                  }
                });
              });
            });
            return pushed;
          };
          if (semanticConnectorSvg) {
            if (pseudoAfterMeasurement) raw.push(pseudoAfterMeasurement);
            return;
          }
          const kind = inferKind(node, style) ?? (svg ? "shape" : unsupportedVisual ? "shape" : null);
          if (!kind) {
            pushInlineTextFragments();
            if (pseudoAfterMeasurement) raw.push(pseudoAfterMeasurement);
            return;
          }
          const isExplicitText = node.hasAttribute("data-pptx-kind") || node.hasAttribute("data-pptx-type") || node.hasAttribute("data-pptx-id") || node.hasAttribute("data-id") || Boolean(node.id);
          const hasInlineChildren = [...node.children].some((child) => child.tagName.toLowerCase() !== "br");
          const text = isExplicitText && hasInlineChildren
            ? normalizeTextNodeContent(node.innerText, style.whiteSpace)
            : directText(node, style)
              || (node.getAttribute("data-pptx-kind") === "text"
                ? normalizeTextNodeContent(node.innerText, style.whiteSpace)
                : "");
          if (kind === "text" && !text) {
            if (pseudoAfterMeasurement) raw.push(pseudoAfterMeasurement);
            return;
          }
          const visibleText = kind === "text" ? renderedEllipsisText(node, style, text) : null;
          if (kind === "text" && !isExplicitText && !hasPaint(style) && pushInlineTextFragments(true)) {
            if (pseudoAfterMeasurement) raw.push(pseudoAfterMeasurement);
            return;
          }
          const anchor = kind === "table"
            ? null
            : node.matches?.("a[href]") ? node : node.querySelector?.("a[href]") || node.closest?.("a[href]");
	          const list = node.closest?.("ul,ol");
	          const listNodes = list ? [...slide.querySelectorAll("ul,ol")] : [];
	          const listParentId = list
	            ? list.getAttribute("data-pptx-id") || list.getAttribute("data-id") || list.id || `${slideId}-list-${listNodes.indexOf(list) + 1}`
	            : null;
          const listIndex = list && node.tagName.toLowerCase() === "li" ? [...list.children].indexOf(node) : null;
          const richRuns = kind === "text" && isExplicitText ? collectRichTextRuns(node) : [];
          const tableMeta = kind === "table" ? collectTableMeta(node, rect, slideRect) : null;
          const lineMetadata = kind === "text" ? keyHeadingMetadata(node, style, text) : null;
          raw.push({
	            id,
	            slideId,
	            kind,
            slideIndex,
            tagName,
	            selector: node.id ? `#${node.id}` : `[data-pptx-id="${id}"]`,
		            text,
		            visibleText,
	            src: node.getAttribute("src") ?? null,
	            href: anchor?.getAttribute("href") ?? null,
	            hyperlinkTooltip: anchor?.getAttribute("title") || anchor?.getAttribute("data-tooltip") || null,
	              semantics: {
		              role: node.getAttribute("data-layout-role") || (tagName === "h1" ? "title" : null),
		              maxLines: (() => {
		                const raw = node.getAttribute("data-max-lines");
		                if (raw === null && tagName === "h1") return 1;
		                const value = Number(raw);
		                return Number.isInteger(value) && value >= 1 && value <= 2 ? value : null;
		              })(),
		              safeInset: (() => {
		                const raw = node.getAttribute("data-safe-inset");
		                const value = Number(raw);
		                return raw !== null && Number.isFinite(value) && value >= 0 ? value : null;
		              })(),
		              pptxLineHeightScale: (() => {
		                const owner = node.closest("[data-pptx-line-height-scale]");
		                const raw = owner?.getAttribute("data-pptx-line-height-scale");
		                const value = Number(raw);
		                return raw !== null && Number.isFinite(value) && value >= 0.5 && value <= 1.5 ? value : null;
		              })(),
		              axisDirection: node.getAttribute("data-axis-direction") || null,
	              semanticParentId: node.getAttribute("data-semantic-parent-id") || generatedSemanticParentId(node),
	              layoutRegion: node.getAttribute("data-layout-region")
	                || node.closest("[data-layout-region]")?.getAttribute("data-layout-region")
	                || null,
	              allowOverlapWith: String(node.getAttribute("data-allow-overlap-with") || "")
	                .split(/[\s,]+/)
	                .map((value) => value.trim())
	                .filter(Boolean),
	              listParentId,
	              listIndex,
	              evidenceKind: node.getAttribute("data-evidence-kind") || null,
	              sourceIds: String(node.getAttribute("data-source-ids") || "")
	                .split(/[\s,]+/)
	                .map((value) => value.trim())
	                .filter(Boolean),
	              asOf: node.getAttribute("data-as-of") || null,
              ...(lineMetadata ? {
                renderedLines: lineMetadata.renderedLines,
                lineBreakOffsets: lineMetadata.lineBreakOffsets,
                renderedLineCount: lineMetadata.renderedLineCount
              } : {})
	            },
            ...(lineMetadata ? {
              renderedLines: lineMetadata.renderedLines,
              lineBreakOffsets: lineMetadata.lineBreakOffsets,
              renderedLineCount: lineMetadata.renderedLineCount
            } : {}),
            ...(kind === "image" ? { naturalWidth: node.naturalWidth || null, naturalHeight: node.naturalHeight || null } : {}),
            ...(node.getAttribute("data-pptx-shape") ? { shapeOverride: node.getAttribute("data-pptx-shape") } : {}),
            ...(richRuns.length > 0 ? { runs: richRuns } : {}),
            ...(tableMeta ? { table: tableMeta } : {}),
	            ...(svg ? { svg } : {}),
	            ...(nodeMeta ? {
              paintOrder: nodeMeta.paintOrder ?? null,
              stackingContext: Boolean(nodeMeta.stackingContext),
              stackingContextPath: nodeMeta.stackingContextPath ?? []
            } : {}),
	            style: computedStyleFor(style, rect, effectiveOpacityFor(node)),
            replica: replicaEffects(style, unsupportedVisual, node),
            px: {
              x: rect.left - slideRect.left,
              y: rect.top - slideRect.top,
              w: rect.width,
              h: rect.height
            }
          });

          if (kind !== "text") pushInlineTextFragments();
          if (pseudoAfterMeasurement) raw.push(pseudoAfterMeasurement);
        });
      });

      return { elements: raw, slides: rawSlides };
    }, {
      measureSelector: replica ? "*" : selector,
      replicaMode: replica,
      visibleSlideIndex,
      domSnapshot
    });
    };

    const slideCount = await countConvertibleSlides(page);
    const measuredSlides = [];
    for (let slideIndex = 0; slideIndex < slideCount; slideIndex += 1) {
      measuredSlides.push(await withTemporarilyVisibleSlide(
        page,
        slideIndex,
        () => measureVisibleSlide(slideIndex)
      ));
    }
    const rawElements = {
      elements: measuredSlides.flatMap((measurement) => measurement.elements ?? []),
      slides: measuredSlides.flatMap((measurement) => measurement.slides ?? [])
    };

    const rawElementList = Array.isArray(rawElements) ? rawElements : rawElements.elements ?? [];
    const rawSlides = Array.isArray(rawElements) ? [] : rawElements.slides;
    const elements = rawElementList
      .filter((element) => element.id && element.kind)
      .map((element) => ({
        ...element,
        inches: convertMeasurementPxToInches(element.px, viewport, slideSize)
      }));

    return buildMeasurementsDocument({
      source: resolvedInput,
      viewport,
      slideSize,
      elements,
      slides: rawSlides
    });
  });
}

export async function writeMeasurements(inputPath, outputPath, options = {}) {
  const measurements = await measureHtmlFile(inputPath, options);
  const resolvedOutput = resolve(outputPath);
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(measurements, null, 2)}\n`, "utf8");
  return measurements;
}

async function main() {
  const { input, output, viewportWidth, viewportHeight, slideWidth, slideHeight, selector, replica } = parseArgs(
    process.argv.slice(2)
  );
  if (!input || !output) {
    fail(
      "usage: measure-html.mjs <input.html> <output/layout-measurements.json> [--viewport-width 1280] [--viewport-height 720] [--selector \"[data-pptx-kind],[data-pptx-type]\"] [--replica]"
    );
  }

  const measurements = await writeMeasurements(input, output, {
    viewportWidth,
    viewportHeight,
    slideWidth,
    slideHeight,
    selector,
    replica,
    packageRoot
  });

  console.log(
    JSON.stringify(
      {
        measurementsPath: resolve(output),
        elements: measurements.elements.length,
        viewport: measurements.viewport,
        slideSize: measurements.slideSize,
        replica
      },
      null,
      2
    )
  );
}

const invokedDirectly =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href);

if (invokedDirectly) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
