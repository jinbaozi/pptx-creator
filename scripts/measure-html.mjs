import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_VIEWPORT,
  buildMeasurementsDocument,
  convertMeasurementPxToInches
} from "./lib/html-measurement-core.mjs";
import { SLIDE_SIZE } from "./lib/html-to-manifest-core.mjs";
import { withSettledHtmlPage } from "./lib/html-layout-audit.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
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
    const rawElements = await page.evaluate(({ measureSelector, replicaMode }) => {
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

      function isVisible(node) {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0.01
        );
      }

      function normalizeTextNodeContent(value, whiteSpace) {
        const source = String(value ?? "");
        if (["pre", "pre-line", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
          return source
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }
        return source.replace(/\s+/g, " ").trim();
      }

      function directText(node, style) {
        const whiteSpace = style?.whiteSpace;
        const parts = [];
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = normalizeTextNodeContent(child.textContent, whiteSpace);
            if (text) parts.push(text);
          } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "br") {
            parts.push("\n");
          }
        }
        return parts
          .join(" ")
          .replace(/[ \t]*\n[ \t]*/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

	      function directTextNodes(node) {
	        return [...node.childNodes]
	          .filter((child) => child.nodeType === Node.TEXT_NODE)
	          .map((child) => ({ node: child, text: child.textContent.replace(/\s+/g, " ").trim() }))
	          .filter((entry) => entry.text);
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
        return (
          Boolean(rgbaToHex(style.backgroundColor)) ||
          style.backgroundImage !== "none" ||
          borderWidths.some((width) => width > 0) ||
          (outlineWidth > 0 && style.outlineStyle !== "none" && style.outlineStyle !== "hidden") ||
          style.boxShadow !== "none"
        );
      }

      function inferKind(node, style) {
        const explicit = node.getAttribute("data-pptx-kind");
        if (explicit) return explicit;
        const tag = node.tagName.toLowerCase();
        if (tag === "img") return "image";
        if (tag === "table") return "table";
        if (tag === "hr") return "line";
        if (directText(node, style) && !hasVisibleChildElements(node)) return "text";
        if (hasPaint(style)) return "shape";
        return null;
      }

      function cssRadiusPx(value, rect) {
        const source = String(value || "0").trim();
        const numeric = Number.parseFloat(source);
        if (!Number.isFinite(numeric)) return 0;
        if (source.endsWith("%")) {
          const basis = Math.min(rect?.width ?? 0, rect?.height ?? 0);
          return Math.round(((basis * numeric) / 100) * 100) / 100;
        }
        return numeric;
      }

      function computedStyleFor(style, rect = null) {
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
          borderRadius: cssRadiusPx(style.borderTopLeftRadius, rect),
          borderTopLeftRadius: cssRadiusPx(style.borderTopLeftRadius, rect),
          borderTopRightRadius: cssRadiusPx(style.borderTopRightRadius, rect),
          borderBottomRightRadius: cssRadiusPx(style.borderBottomRightRadius, rect),
          borderBottomLeftRadius: cssRadiusPx(style.borderBottomLeftRadius, rect),
          opacity: Number.parseFloat(style.opacity || "1"),
          fontFamily: style.fontFamily,
          fontSize: pxToPt(style.fontSize),
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          fontStyle: style.fontStyle,
          fontVariantCaps: style.fontVariantCaps,
          lineHeight: pxToPt(style.lineHeight),
          display: style.display,
          writingMode: style.writingMode,
          listStyleType: style.listStyleType,
          listStylePosition: style.listStylePosition,
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
          whiteSpace: style.whiteSpace,
          paddingTop: pxToPt(style.paddingTop),
          paddingRight: pxToPt(style.paddingRight),
          paddingBottom: pxToPt(style.paddingBottom),
          paddingLeft: pxToPt(style.paddingLeft),
          zIndex: style.zIndex === "auto" ? null : Number.parseInt(style.zIndex, 10),
          boxShadow: style.boxShadow === "none" ? null : style.boxShadow,
          textShadow: style.textShadow === "none" ? null : style.textShadow,
          transform: style.transform === "none" ? null : style.transform,
          rotate: cssRotationDegrees(style.transform),
          objectFit: style.objectFit,
          objectPosition: style.objectPosition
        };
      }

      const slides = [...document.querySelectorAll(".pptx-slide, [data-slide]")];
      const sourceSlides = slides.length > 0 ? slides : [document.querySelector(".pptx-deck") ?? document.body];
      const raw = [];
      const rawSlides = [];

      sourceSlides.forEach((slide, slideIndex) => {
        const slideRect = slide.getBoundingClientRect();
        const slideStyle = window.getComputedStyle(slide);
        const slideId = slide.getAttribute("data-slide-id") || slide.id || `slide-${String(slideIndex + 1).padStart(3, "0")}`;
        rawSlides.push({
          slideId,
          slideIndex,
          selector: slide.id ? `#${slide.id}` : slide.matches(".pptx-slide") ? ".pptx-slide" : slide.tagName.toLowerCase(),
          style: computedStyleFor(slideStyle, slideRect),
          replica: {
            hasUnsupportedEffects:
              slideStyle.filter !== "none" ||
              slideStyle.backdropFilter !== "none" ||
              slideStyle.clipPath !== "none" ||
              slideStyle.backgroundImage !== "none",
            filter: slideStyle.filter === "none" ? null : slideStyle.filter,
            backdropFilter: slideStyle.backdropFilter === "none" ? null : slideStyle.backdropFilter,
            clipPath: slideStyle.clipPath === "none" ? null : slideStyle.clipPath,
            backgroundImage: slideStyle.backgroundImage === "none" ? null : slideStyle.backgroundImage
          }
        });
        const nodes = [...slide.querySelectorAll(measureSelector)];
        nodes.forEach((node, nodeIndex) => {
          if (!isVisible(node)) return;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const generatedId = `html-${String(slideIndex + 1).padStart(3, "0")}-${String(nodeIndex + 1).padStart(3, "0")}`;
          const id = node.getAttribute("data-pptx-id") ?? node.getAttribute("data-id") ?? node.id ?? generatedId;
          const tagName = node.tagName.toLowerCase();
          const pushDirectTextFragments = () => {
            if (!replicaMode || !hasVisibleChildElements(node)) return;
            directTextNodes(node).forEach((entry, textIndex) => {
              const range = document.createRange();
              range.selectNodeContents(entry.node);
              const textRect = range.getBoundingClientRect();
              range.detach();
              if (textRect.width <= 0 || textRect.height <= 0) return;
              raw.push({
                id: `${id}-text-${textIndex + 1}`,
                slideId,
                kind: "text",
                slideIndex,
                tagName,
                selector: node.id ? `#${node.id}::text(${textIndex + 1})` : `[data-pptx-id="${id}"]::text(${textIndex + 1})`,
                text: entry.text,
                src: null,
                style: computedStyleFor(style, textRect),
                replica: {
                  hasUnsupportedEffects:
                    style.filter !== "none" ||
                    style.backdropFilter !== "none" ||
                    style.clipPath !== "none" ||
                    style.backgroundImage !== "none",
                  filter: style.filter === "none" ? null : style.filter,
                  backdropFilter: style.backdropFilter === "none" ? null : style.backdropFilter,
                  clipPath: style.clipPath === "none" ? null : style.clipPath,
                  backgroundImage: style.backgroundImage === "none" ? null : style.backgroundImage
                },
                px: {
                  x: textRect.left - slideRect.left,
                  y: textRect.top - slideRect.top,
                  w: textRect.width,
                  h: textRect.height
                }
              });
            });
          };
          const kind = inferKind(node, style);
          if (!kind) {
            pushDirectTextFragments();
            return;
          }
	          const text = directText(node, style);
	          if (kind === "text" && !text) return;
	          const visibleText = kind === "text" ? renderedEllipsisText(node, style, text) : null;
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
	            ...(kind === "image" ? { naturalWidth: node.naturalWidth || null, naturalHeight: node.naturalHeight || null } : {}),
	            style: computedStyleFor(style, rect),
            replica: {
              hasUnsupportedEffects:
                style.filter !== "none" ||
                style.backdropFilter !== "none" ||
                style.clipPath !== "none" ||
                style.backgroundImage !== "none",
              filter: style.filter === "none" ? null : style.filter,
              backdropFilter: style.backdropFilter === "none" ? null : style.backdropFilter,
              clipPath: style.clipPath === "none" ? null : style.clipPath,
              backgroundImage: style.backgroundImage === "none" ? null : style.backgroundImage
            },
            px: {
              x: rect.left - slideRect.left,
              y: rect.top - slideRect.top,
              w: rect.width,
              h: rect.height
            }
          });

          if (kind !== "text") pushDirectTextFragments();
        });
      });

      return { elements: raw, slides: rawSlides };
    }, { measureSelector: replica ? "*" : selector, replicaMode: replica });

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
