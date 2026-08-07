import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { SkillError } from "./errors.mjs";
import { buildVisualProbes } from "./visual-probes.mjs";

export const DEFAULT_VIEWPORTS = [
  { name: "standard", width: 1280, height: 720 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];
export const MIN_BROWSER_TIMEOUT_MS = 90_000;

function finding(code, message, fields = {}) {
  return { severity: "error", code, message, ...fields };
}

function screenshotPath(outputDir, viewportName, order) {
  return join(outputDir, "preview", viewportName, `slide-${String(order).padStart(3, "0")}.png`);
}

function contactSheetHtml(viewports) {
  const cards = viewports.flatMap((viewport) => viewport.slides.map((slide) => {
    const relativeScreenshot = slide.screenshot.replace(/^preview\//, "");
    return `<figure><img src="${relativeScreenshot}" alt="${viewport.name} ${slide.slideId}"><figcaption>${viewport.name} · ${slide.slideId}</figcaption></figure>`;
  })).join("\n");
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Deck contact sheet</title>
<style>body{margin:24px;background:#f6f7fb;color:#172033;font:14px Arial,sans-serif}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}figure{margin:0;background:#fff;padding:10px;border:1px solid #d9deea;border-radius:12px}img{display:block;width:100%;height:auto}figcaption{margin-top:8px;color:#5b6475}</style>
<main>${cards}</main></html>\n`;
}

async function settlePage(page, timeoutMs) {
  await page.waitForFunction(async () => {
    const images = [...document.images];
    await Promise.all(images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise((resolveImage) => {
        image.addEventListener("load", resolveImage, { once: true });
        image.addEventListener("error", resolveImage, { once: true });
      })));
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    window.__deck?.layoutConnectors?.();
    return true;
  }, null, { timeout: timeoutMs });
}

async function visualFingerprint(page, screenshot) {
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const width = 16;
    const height = 9;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const luminance = [];
    for (let index = 0; index < pixels.length; index += 4) {
      luminance.push(0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]);
    }
    const average = luminance.reduce((total, value) => total + value, 0) / luminance.length;
    const bits = luminance.map((value) => value >= average ? "1" : "0").join("");
    let averageHash = "";
    for (let index = 0; index < bits.length; index += 4) averageHash += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
    const colorGrid = [];
    for (let gridY = 0; gridY < 3; gridY += 1) {
      for (let gridX = 0; gridX < 4; gridX += 1) {
        const totals = [0, 0, 0];
        let count = 0;
        for (let y = gridY * 3; y < (gridY + 1) * 3; y += 1) {
          for (let x = gridX * 4; x < (gridX + 1) * 4; x += 1) {
            const offset = (y * width + x) * 4;
            totals[0] += pixels[offset];
            totals[1] += pixels[offset + 1];
            totals[2] += pixels[offset + 2];
            count += 1;
          }
        }
        colorGrid.push(...totals.map((value) => Math.round(value / count)));
      }
    }
    return { version: "1.0.0", width, height, averageHash, colorGrid };
  }, `data:image/png;base64,${screenshot.toString("base64")}`);
}

async function inspectActiveSlide(page) {
  return page.evaluate(() => {
    const slide = document.querySelector(".pptx-slide.is-active");
    if (!slide) return { slideId: null, findings: [{ code: "E_SLIDE_HIDDEN", message: "No active slide" }], components: [] };
    const slideId = slide.dataset.slideId;
    const order = Number(slide.dataset.slideOrder);
    const findings = [];
    const slideRect = slide.getBoundingClientRect();
    const scale = slideRect.width / 1280 || 1;
    const normalizeRect = (rect) => ({
      x: Number(((rect.left - slideRect.left) / scale).toFixed(3)),
      y: Number(((rect.top - slideRect.top) / scale).toFixed(3)),
      w: Number((rect.width / scale).toFixed(3)),
      h: Number((rect.height / scale).toFixed(3))
    });
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const lineLike = element.dataset.pptxKind === "line";
      const hasArea = lineLike ? rect.width > 0 || rect.height > 0 : rect.width > 0 && rect.height > 0;
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && hasArea;
    };
    const ids = new Set();
    const components = [];
    const kindMap = { line: "connector", text: "text", shape: "shape", image: "image", svg: "svg", table: "table", chart: "chart" };
    const typeFloors = { display: 38, title: 38, section: 24, body: 22, label: 15, source: 12 };
    const validRegions = new Set(["header", "content", "footer", "decoration"]);
    const componentElements = [...slide.querySelectorAll("[data-pptx-id]")];
    const contentRoots = [...slide.querySelectorAll("[data-qa-content-root]")];
    const footers = [...slide.querySelectorAll("[data-qa-footer]")];
    if (contentRoots.length !== 1 || footers.length !== 1) {
      findings.push({
        code: "E_COMPONENT_METADATA",
        message: `${slideId} must declare exactly one content root and one footer`,
        details: { contentRootCount: contentRoots.length, footerCount: footers.length }
      });
    }
    for (const [z, element] of componentElements.entries()) {
      const id = element.dataset.pptxId;
      if (ids.has(id)) findings.push({ code: "E_DUPLICATE_COMPONENT", message: `Duplicate component id ${id}`, componentId: id });
      ids.add(id);
      const kind = element.dataset.pptxKind;
      const typeTier = element.dataset.typeTier;
      const qaRegion = element.dataset.qaRegion;
      const tierValid = kind === "text" ? Object.hasOwn(typeFloors, typeTier) : typeTier === "none";
      if (!kind || !tierValid || !validRegions.has(qaRegion)) {
        findings.push({
          code: "E_COMPONENT_METADATA",
          message: `${id || "unnamed component"} has incomplete semantic QA metadata`,
          componentId: id,
          details: { kind: kind ?? null, typeTier: typeTier ?? null, qaRegion: qaRegion ?? null }
        });
      }
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const box = normalizeRect(rect);
      const sourceRefs = (element.dataset.sourceIds ?? "").split(/\s+/).filter(Boolean);
      components.push({
        id,
        type: kindMap[element.dataset.pptxKind] ?? "unknown",
        box: { ...box, unit: "px" },
        z,
        editableIntent: element.dataset.pptxKind !== undefined && element.dataset.pptxKind !== "unknown",
        sourceRefs
      });
      const tolerance = 1.5 * scale;
      if (rect.left < slideRect.left - tolerance || rect.top < slideRect.top - tolerance
        || rect.right > slideRect.right + tolerance || rect.bottom > slideRect.bottom + tolerance) {
        findings.push({ code: "E_ELEMENT_BOUNDS", message: `${id} escapes the slide canvas`, componentId: id, box });
      }
      const card = element.closest(".card");
      if (card && card !== element) {
        const cardRect = card.getBoundingClientRect();
        if (rect.left < cardRect.left - tolerance || rect.top < cardRect.top - tolerance
          || rect.right > cardRect.right + tolerance || rect.bottom > cardRect.bottom + tolerance) {
          findings.push({ code: "E_CONTENT_CLIPPED", message: `${id} escapes its clipping card`, componentId: id });
        }
      }
    }

    const contentRoot = contentRoots[0];
    const footer = footers[0];
    const shell = slide.querySelector(".slide-shell");
    if (contentRoot && footer && shell) {
      const tolerance = 1.5 * scale;
      const rootRect = contentRoot.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      if (rootRect.left < shellRect.left - tolerance || rootRect.top < shellRect.top - tolerance
        || rootRect.right > shellRect.right + tolerance || rootRect.bottom > shellRect.bottom + tolerance) {
        findings.push({ code: "E_SAFE_AREA", message: `${slideId} content root escapes the slide safe area` });
      }
      const rootFooterWidth = Math.max(0, Math.min(footerRect.right, rootRect.right) - Math.max(footerRect.left, rootRect.left));
      const rootFooterHeight = Math.max(0, Math.min(footerRect.bottom, rootRect.bottom) - Math.max(footerRect.top, rootRect.top));
      if (rootFooterWidth * rootFooterHeight > scale * scale) {
        findings.push({
          code: "E_FOOTER_COLLISION",
          message: `${slideId} content root collides with the footer safe band`,
          overlapArea: Number((rootFooterWidth * rootFooterHeight / (scale * scale)).toFixed(3))
        });
      }
      for (const element of componentElements.filter(visible)) {
        const region = element.dataset.qaRegion;
        const rect = element.getBoundingClientRect();
        if (region === "content" && (!contentRoot.contains(element)
          || rect.left < rootRect.left - tolerance || rect.top < rootRect.top - tolerance
          || rect.right > rootRect.right + tolerance || rect.bottom > rootRect.bottom + tolerance)) {
          findings.push({
            code: "E_SAFE_AREA",
            message: `${element.dataset.pptxId} escapes the declared content safe area`,
            componentId: element.dataset.pptxId
          });
        }
        if (!["footer", "decoration"].includes(region)) {
          const width = Math.max(0, Math.min(footerRect.right, rect.right) - Math.max(footerRect.left, rect.left));
          const height = Math.max(0, Math.min(footerRect.bottom, rect.bottom) - Math.max(footerRect.top, rect.top));
          if (width * height > scale * scale) {
            findings.push({
              code: "E_FOOTER_COLLISION",
              message: `${element.dataset.pptxId} collides with the footer safe band`,
              componentId: element.dataset.pptxId,
              overlapArea: Number((width * height / (scale * scale)).toFixed(3))
            });
          }
        }
      }
    }

    const textNodes = [...slide.querySelectorAll("[data-pptx-kind='text']")].filter(visible);
    let titleOrphan = false;
    let titleLineCount = 0;
    const renderedLineRects = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((left, right) => left.top - right.top || left.left - right.left);
      const lines = [];
      for (const rect of rects) {
        const line = lines.find((entry) => Math.abs(entry.top - rect.top) <= 1);
        if (line) {
          line.left = Math.min(line.left, rect.left);
          line.right = Math.max(line.right, rect.right);
        } else {
          lines.push({ top: rect.top, left: rect.left, right: rect.right });
        }
      }
      return lines.map((line) => ({ ...line, width: line.right - line.left }));
    };
    const rgb = (value) => {
      const match = value?.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
      return match ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) } : null;
    };
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const effectiveBackground = (element) => {
      let current = element;
      while (current) {
        const color = rgb(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0.9) return color;
        current = current.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    for (const element of textNodes) {
      const id = element.dataset.pptxId;
      const style = getComputedStyle(element);
      const typeTier = element.dataset.typeTier;
      const floor = typeFloors[typeTier];
      const fontSize = Number.parseFloat(style.fontSize);
      if (Number.isFinite(floor) && fontSize + 0.01 < floor) {
        findings.push({
          code: "E_TYPE_FLOOR",
          message: `${id} uses ${fontSize}px below the ${typeTier} floor of ${floor}px`,
          componentId: id,
          metrics: { typeTier, fontSize, minimum: floor }
        });
      }
      const maxLines = Number(element.dataset.maxLines);
      if (Number.isInteger(maxLines) && maxLines > 0) {
        const lines = renderedLineRects(element);
        titleLineCount = Math.max(titleLineCount, lines.length);
        if (lines.length > maxLines) {
          findings.push({
            code: "E_TITLE_LINE_COUNT",
            message: `${id} renders on ${lines.length} lines; maximum is ${maxLines}`,
            componentId: id,
            metrics: { lineCount: lines.length, maximum: maxLines }
          });
        }
        if (lines.length > 1) {
          const widest = Math.max(...lines.map((line) => line.width));
          titleOrphan ||= lines.at(-1).width < widest * 0.28;
        }
      }
      if (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2) {
        findings.push({
          code: "E_TEXT_OVERFLOW",
          message: `${id} has scroll overflow`,
          componentId: id,
          metrics: {
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight
          }
        });
      }
      const foreground = rgb(getComputedStyle(element).color);
      if (foreground) {
        const background = effectiveBackground(element);
        const high = Math.max(luminance(foreground), luminance(background));
        const low = Math.min(luminance(foreground), luminance(background));
        const ratio = (high + 0.05) / (low + 0.05);
        const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        const required = large ? 3 : 4.5;
        if (ratio + 0.01 < required) {
          findings.push({ code: "E_CONTRAST", message: `${id} contrast ${ratio.toFixed(2)} is below ${required}`, componentId: id, ratio });
        }
      }
    }

    const qaBoxes = [...slide.querySelectorAll("[data-qa-box]")].filter(visible);
    const allowed = (first, second) => {
      const firstIds = (first.dataset.allowOverlapWith ?? "").split(/\s+/);
      const secondIds = (second.dataset.allowOverlapWith ?? "").split(/\s+/);
      return firstIds.includes(second.dataset.pptxId) || secondIds.includes(first.dataset.pptxId);
    };
    for (let firstIndex = 0; firstIndex < qaBoxes.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < qaBoxes.length; secondIndex += 1) {
        const first = qaBoxes[firstIndex];
        const second = qaBoxes[secondIndex];
        if (first.contains(second) || second.contains(first) || allowed(first, second)) continue;
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        if (width * height > 16 * scale * scale) {
          findings.push({
            code: "E_MODULE_OVERLAP",
            message: `${first.dataset.pptxId} overlaps ${second.dataset.pptxId}`,
            componentIds: [first.dataset.pptxId, second.dataset.pptxId],
            overlapArea: Number((width * height / (scale * scale)).toFixed(3))
          });
        }
      }
    }
    const controls = document.querySelector(".deck-controls");
    if (controls && visible(controls)) {
      const controlRect = controls.getBoundingClientRect();
      for (const element of [...slide.querySelectorAll("[data-pptx-id]")].filter(visible)) {
        const rect = element.getBoundingClientRect();
        const width = Math.max(0, Math.min(controlRect.right, rect.right) - Math.max(controlRect.left, rect.left));
        const height = Math.max(0, Math.min(controlRect.bottom, rect.bottom) - Math.max(controlRect.top, rect.top));
        if (width * height > 16) {
          findings.push({
            code: "E_NAVIGATION_OCCLUSION",
            message: `Navigation controls obscure ${element.dataset.pptxId}`,
            componentId: element.dataset.pptxId
          });
        }
      }
    }

    const source = slide.querySelector(".source-list");
    const sourceTruncated = Boolean(source && (source.scrollWidth > source.clientWidth + 1 || source.scrollHeight > source.clientHeight + 1));
    const sourceLineCount = source ? renderedLineRects(source).length : 0;
    if (sourceTruncated) {
      findings.push({
        code: "E_SOURCE_TRUNCATION",
        message: `${source.dataset.pptxId} truncates source evidence`,
        componentId: source.dataset.pptxId
      });
    }
    const cards = [...slide.querySelectorAll(".card")];
    const nestedCardCount = cards.filter((card) => card.parentElement?.closest(".card")).length;

    for (const image of [...slide.querySelectorAll("img")].filter(visible)) {
      const id = image.dataset.pptxId ?? image.alt ?? "image";
      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        findings.push({ code: "E_IMAGE_MISSING", message: `${id} did not load`, componentId: id });
        continue;
      }
      if (!image.alt.trim()) findings.push({ code: "E_IMAGE_ALT", message: `${id} has no alt text`, componentId: id });
      const fit = getComputedStyle(image).objectFit;
      if (!["contain", "cover"].includes(fit)) {
        findings.push({ code: "E_IMAGE_STRETCH", message: `${id} uses unsupported object-fit ${fit}`, componentId: id });
      }
      const position = getComputedStyle(image).objectPosition;
      if (!position) findings.push({ code: "E_IMAGE_CROP", message: `${id} has no object-position`, componentId: id });
    }

    const pointNear = (point, rect, edge) => {
      const tolerance = 5;
      if (edge === "right") return Math.abs(point.x - rect.right) <= tolerance && point.y >= rect.top - tolerance && point.y <= rect.bottom + tolerance;
      if (edge === "left") return Math.abs(point.x - rect.left) <= tolerance && point.y >= rect.top - tolerance && point.y <= rect.bottom + tolerance;
      return false;
    };
    const segmentIntersects = (a, b, rect) => {
      const inset = 3;
      const left = rect.left + inset;
      const right = rect.right - inset;
      const top = rect.top + inset;
      const bottom = rect.bottom - inset;
      if (Math.abs(a.y - b.y) < 0.1) {
        return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
      }
      if (Math.abs(a.x - b.x) < 0.1) {
        return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
      }
      return false;
    };
    for (const connector of slide.querySelectorAll("[data-connector]")) {
      const id = connector.dataset.pptxId;
      const source = slide.querySelector(`[data-pptx-id="${CSS.escape(connector.dataset.sourceId ?? "")}"]`);
      const target = slide.querySelector(`[data-pptx-id="${CSS.escape(connector.dataset.targetId ?? "")}"]`);
      const svg = connector.ownerSVGElement;
      if (!source || !target || !svg) {
        findings.push({ code: "E_CONNECTOR_REF", message: `${id} has unresolved endpoints`, componentId: id });
        continue;
      }
      const svgRect = svg.getBoundingClientRect();
      const toSvgRect = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: (rect.left - svgRect.left) / scale,
          right: (rect.right - svgRect.left) / scale,
          top: (rect.top - svgRect.top) / scale,
          bottom: (rect.bottom - svgRect.top) / scale
        };
      };
      const start = { x: Number(connector.dataset.x1), y: Number(connector.dataset.y1) };
      const end = { x: Number(connector.dataset.x2), y: Number(connector.dataset.y2) };
      if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) {
        findings.push({ code: "E_CONNECTOR_DETACHED", message: `${id} has no measured endpoints`, componentId: id });
        continue;
      }
      const sourceRect = toSvgRect(source);
      const targetRect = toSvgRect(target);
      if (!pointNear(start, sourceRect, "right") || !pointNear(end, targetRect, "left")) {
        findings.push({ code: "E_CONNECTOR_DETACHED", message: `${id} is detached from its declared nodes`, componentId: id });
      }
      if (end.x <= start.x) findings.push({ code: "E_CONNECTOR_DIRECTION", message: `${id} does not point toward its target`, componentId: id });
      if (!connector.getAttribute("marker-end")) findings.push({ code: "E_CONNECTOR_MARKER", message: `${id} has no end marker`, componentId: id });
      const numbers = (connector.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const points = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) points.push({ x: numbers[index], y: numbers[index + 1] });
      for (const module of qaBoxes) {
        if ([source, target].includes(module)) continue;
        const rect = toSvgRect(module);
        for (let index = 0; index + 1 < points.length; index += 1) {
          if (segmentIntersects(points[index], points[index + 1], rect)) {
            findings.push({ code: "E_CONNECTOR_CROSSING", message: `${id} crosses ${module.dataset.pptxId}`, componentIds: [id, module.dataset.pptxId] });
            break;
          }
        }
      }
    }

    if (window.innerWidth <= 700) {
      const visibleWidth = Math.max(0, Math.min(window.innerWidth, slideRect.right) - Math.max(0, slideRect.left));
      const visibleHeight = Math.max(0, Math.min(window.innerHeight, slideRect.bottom) - Math.max(0, slideRect.top));
      const visibleRatio = (visibleWidth * visibleHeight) / Math.max(1, slideRect.width * slideRect.height);
      if (visibleRatio < 0.95) {
        findings.push({ code: "E_MOBILE_CANVAS", message: `Mobile slide preview visible ratio is ${visibleRatio.toFixed(3)}` });
      }
      const reader = document.querySelector(".mobile-reader");
      const heading = document.querySelector(".mobile-reader-heading");
      const readerParagraphs = [...document.querySelectorAll(".mobile-reader-content p")];
      if (!reader || getComputedStyle(reader).display === "none" || !heading?.textContent?.trim() || readerParagraphs.length === 0) {
        findings.push({ code: "E_MOBILE_READER", message: "Mobile reading mode is missing active-slide content" });
      } else {
        if (reader.scrollWidth > reader.clientWidth + 1) {
          findings.push({ code: "E_HORIZONTAL_SCROLL", message: "Mobile reading mode has horizontal overflow" });
        }
        for (const paragraph of readerParagraphs) {
          if (Number.parseFloat(getComputedStyle(paragraph).fontSize) < 16) {
            findings.push({ code: "E_MOBILE_READER", message: "Mobile reading text is below 16px" });
            break;
          }
        }
      }
    }

    return {
      slideId,
      order,
      title: slide.querySelector(".slide-title")?.textContent?.trim() ?? "",
      findings,
      components,
      geometry: normalizeRect(slideRect),
      fontStatus: document.fonts?.status ?? "unsupported",
      visualProbe: {
        slideId,
        order,
        family: slide.dataset.layoutFamily ?? slide.dataset.slideType ?? "unknown",
        silhouette: slide.dataset.layoutSilhouette ?? slide.dataset.layoutVariant ?? "unknown",
        variant: slide.dataset.layoutVariant ?? "unknown",
        decorationCount: slide.querySelectorAll('[data-layout-role="decoration"]').length,
        cardCount: cards.length,
        nestedCardCount,
        sourceTruncated,
        sourceLineCount,
        titleOrphan,
        titleLineCount
      }
    };
  });
}

async function checkNoHorizontalScroll(page) {
  return page.evaluate(() => {
    const initial = window.scrollX;
    window.scrollTo(9999, 0);
    const moved = window.scrollX;
    window.scrollTo(initial, 0);
    return {
      moved,
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: getComputedStyle(document.documentElement).overflowX
    };
  });
}

async function checkNavigation(page, slideCount) {
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__deck.goTo(0));
  if (slideCount > 1) {
    await page.keyboard.press("ArrowRight");
    const afterRight = await page.evaluate(() => window.__deck.activeIndex);
    if (afterRight !== 1) return finding("E_NAVIGATION", `ArrowRight selected ${afterRight}, expected 1`);
  }
  await page.evaluate((last) => window.__deck.goTo(last), slideCount - 1);
  const afterJump = await page.evaluate(() => window.__deck.activeIndex);
  if (afterJump !== slideCount - 1) return finding("E_NAVIGATION", `Direct jump selected ${afterJump}, expected ${slideCount - 1}`);
  return null;
}

async function checkPrint(page, slideCount) {
  await page.emulateMedia({ media: "print" });
  return page.evaluate((expectedCount) => {
    const slides = [...document.querySelectorAll(".pptx-slide")];
    const invalid = slides.flatMap((slide) => {
      const style = getComputedStyle(slide);
      const rect = slide.getBoundingClientRect();
      const failures = [];
      if (style.display === "none") failures.push(`${slide.id}:hidden`);
      if (Math.abs(rect.width - 1280) > 1 || Math.abs(rect.height - 720) > 1) failures.push(`${slide.id}:${rect.width}x${rect.height}`);
      if (!["page", "always"].includes(style.breakAfter) && !["always"].includes(style.pageBreakAfter)) failures.push(`${slide.id}:no-page-break`);
      return failures;
    });
    const controlsVisible = getComputedStyle(document.querySelector(".deck-controls")).display !== "none";
    const noteVisible = [...document.querySelectorAll(".speaker-notes")].some((note) => getComputedStyle(note).display !== "none");
    return {
      passed: slides.length === expectedCount && invalid.length === 0 && !controlsVisible && !noteVisible,
      slideCount: slides.length,
      invalid,
      controlsVisible,
      noteVisible
    };
  }, slideCount);
}

export async function runBrowserQa(outputDir, options = {}) {
  const resolvedOutput = resolve(outputDir);
  const timeoutMs = Math.max(MIN_BROWSER_TIMEOUT_MS, Number(options.timeoutMs) || MIN_BROWSER_TIMEOUT_MS);
  const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
  const launchBrowser = options.launchBrowser ?? ((launchOptions) => chromium.launch(launchOptions));
  const previewDir = join(resolvedOutput, "preview");
  await rm(previewDir, { recursive: true, force: true });
  await mkdir(previewDir, { recursive: true });
  let browser;
  let operationError;
  try {
    try {
      browser = await launchBrowser({ headless: true, timeout: timeoutMs });
    } catch (error) {
      throw new SkillError("E_BROWSER_UNAVAILABLE", `Cannot launch Chromium: ${error.message}`, { cause: error });
    }
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai"
    });
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    const remoteRequests = [];
    page.on("request", (request) => {
      if (/^https?:/i.test(request.url())) remoteRequests.push(request.url());
    });
    try {
      await page.goto(pathToFileURL(join(resolvedOutput, "index.html")).href, { waitUntil: "load", timeout: timeoutMs });
      await settlePage(page, timeoutMs);
    } catch (error) {
      throw new SkillError("E_BROWSER_TIMEOUT", `HTML did not settle within ${timeoutMs}ms: ${error.message}`, { cause: error });
    }
    const slideCount = await page.evaluate(() => window.__deck?.slideCount ?? 0);
    const findings = [];
    const viewportResults = [];
    let canonicalSlides = [];
    for (const viewport of viewports) {
    await page.emulateMedia({ media: "screen" });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settlePage(page, timeoutMs);
    const horizontal = await checkNoHorizontalScroll(page);
    if (horizontal.moved > 0) {
      findings.push(finding("E_HORIZONTAL_SCROLL", `${viewport.name} permits horizontal scrolling`, { viewport: viewport.name, details: horizontal }));
    }
    const slideResults = [];
    await mkdir(join(previewDir, viewport.name), { recursive: true });
    for (let index = 0; index < slideCount; index += 1) {
      await page.evaluate((slideIndex) => window.__deck.goTo(slideIndex), index);
      await settlePage(page, timeoutMs);
      const inspected = await inspectActiveSlide(page);
      for (const item of inspected.findings) findings.push({ severity: "error", viewport: viewport.name, slideId: inspected.slideId, ...item });
      if (inspected.fontStatus !== "loaded") {
        findings.push(finding("E_FONT_NOT_READY", `${viewport.name}/${inspected.slideId} fonts status is ${inspected.fontStatus}`, {
          viewport: viewport.name,
          slideId: inspected.slideId
        }));
      }
      const imagePath = screenshotPath(resolvedOutput, viewport.name, inspected.order);
      const screenshot = await page.screenshot({ path: imagePath, fullPage: false });
      slideResults.push({
        slideId: inspected.slideId,
        order: inspected.order,
        screenshot: relative(resolvedOutput, imagePath).replaceAll("\\", "/"),
        componentCount: inspected.components.length,
        silhouette: inspected.visualProbe.silhouette,
        titleLineCount: inspected.visualProbe.titleLineCount,
        sourceLineCount: inspected.visualProbe.sourceLineCount,
        visualFingerprint: await visualFingerprint(page, screenshot)
      });
      if (viewport.name === "standard") canonicalSlides.push(inspected);
    }
    viewportResults.push({ ...viewport, horizontal, slides: slideResults });
  }
    const navigationFinding = await checkNavigation(page, slideCount);
    if (navigationFinding) findings.push(navigationFinding);
    const print = await checkPrint(page, slideCount);
    if (!print.passed) findings.push(finding("E_PRINT", "Print stylesheet did not preserve every canonical slide", { details: print }));
    if (remoteRequests.length > 0) findings.push(finding("E_REMOTE_REQUEST", "Deck requested non-local runtime resources", { details: [...new Set(remoteRequests)] }));
    const contactSheetPath = join(previewDir, "contact-sheet.html");
    await writeFile(contactSheetPath, contactSheetHtml(viewportResults), "utf8");
    const policy = await page.evaluate(() => ({
      renderControls: {
        maxConsecutiveFamily: Number(document.body.dataset.maxConsecutiveFamily) || 2
      }
    }));
    const visualProbes = buildVisualProbes(canonicalSlides.map((slide) => slide.visualProbe), policy);

    return {
      version: "1.0.0",
      status: findings.length === 0 ? "passed" : "failed",
      timeoutMs,
      slideCount,
      viewports: viewportResults,
      navigation: { passed: !navigationFinding },
      print,
      findings,
      contactSheets: [{ path: relative(resolvedOutput, contactSheetPath).replaceAll("\\", "/") }],
      visualProbes,
      measurements: canonicalSlides.map((slide) => ({
        slideId: slide.slideId,
        order: slide.order,
        components: slide.components
      })),
      summary: {
        passed: findings.length === 0,
        errorCount: findings.length,
        screenshotCount: viewportResults.reduce((total, viewport) => total + viewport.slides.length, 0)
      }
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        if (!operationError) throw closeError;
      }
    }
  }
}
