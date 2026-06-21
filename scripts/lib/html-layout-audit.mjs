import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HTML_LAYOUT_REPORT_VERSION = "0.1.0";
export const DEFAULT_HTML_VIEWPORT = Object.freeze({ width: 1280, height: 720 });

const STABILIZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition: none !important;
  }
`;

async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new Error(
      `Playwright Chromium is required for HTML layout checks. Run npm install and npx playwright install chromium. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function settleHtmlPage(page, inputPath) {
  await page.goto(pathToFileURL(resolve(inputPath)).href, { waitUntil: "load" });
  await page.evaluate((css) => {
    if (document.querySelector("style[data-pptx-stabilize]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-pptx-stabilize", "true");
    style.textContent = css;
    document.head.appendChild(style);
  }, STABILIZE_CSS);
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const images = [...document.images];
    await Promise.all(images.map(async (image) => {
      if (!image.complete) {
        await new Promise((done) => {
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
        });
      }
      if (typeof image.decode === "function") {
        try { await image.decode(); } catch { /* reported by the audit */ }
      }
    }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

export async function withSettledHtmlPage(inputPath, options, callback) {
  const chromium = await loadChromium();
  const viewport = {
    width: options?.viewportWidth ?? DEFAULT_HTML_VIEWPORT.width,
    height: options?.viewportHeight ?? DEFAULT_HTML_VIEWPORT.height
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await settleHtmlPage(page, inputPath);
    return await callback(page, viewport);
  } finally {
    await browser.close();
  }
}

function assignScreenshots(report, screenshotsBySlide) {
  for (const slide of report.slides) {
    slide.screenshot = screenshotsBySlide.get(slide.slideId) ?? null;
  }
  for (const check of report.checks) {
    check.screenshot = screenshotsBySlide.get(check.slideId) ?? null;
  }
}

async function captureSlideScreenshots(page, report, outputDir) {
  const screenshots = new Map();
  if (!outputDir) return screenshots;
  const previewDir = resolve(outputDir, "html-preview");
  await mkdir(previewDir, { recursive: true });
  for (const slide of report.slides) {
    const locator = page.locator(`[data-pptx-audit-slide-id="${slide.slideId}"]`).first();
    if (await locator.count() === 0) continue;
    const fileName = `${slide.slideId}.png`;
    const outputPath = join(previewDir, fileName);
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      const box = await locator.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;
      await page.screenshot({ path: outputPath, clip: box, animations: "disabled", timeout: 5000 });
      screenshots.set(slide.slideId, relative(resolve(outputDir), outputPath).replace(/\\/g, "/"));
    } catch {
      // A missing screenshot must not hide the structured geometry result.
    }
  }
  return screenshots;
}

export async function auditHtmlPage(page, options = {}) {
  const tolerancePx = options.tolerancePx ?? 2;
  return page.evaluate(({ tolerance }) => {
    const slideSelector = ".pptx-slide, [data-slide]";
    const candidateSelector = [
      "[data-pptx-id]",
      "[data-pptx-kind]",
      "[data-pptx-type]",
      "[data-layout-role]",
      "[data-card]",
      ".card",
      "h1", "h2", "h3", "p", "li", "table", "img",
      "svg [data-connector]",
      "svg [data-source-id][data-target-id]"
    ].join(",");
    const slides = [...document.querySelectorAll(slideSelector)];
    if (slides.length === 0) slides.push(document.body);

    const checks = [];
    const slideReports = [];
    const globalIds = new Map();

    const roundedRect = (rect, origin) => ({
      x: Number((rect.left - origin.left).toFixed(2)),
      y: Number((rect.top - origin.top).toFixed(2)),
      w: Number(rect.width.toFixed(2)),
      h: Number(rect.height.toFixed(2))
    });
    const cssEscape = (value) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
    const elementSelector = (node) => `[data-pptx-audit-id="${cssEscape(node.getAttribute("data-pptx-audit-id"))}"]`;
    const semanticId = (node) => node.getAttribute("data-pptx-id")
      || node.getAttribute("data-id")
      || node.id
      || node.getAttribute("data-pptx-audit-id");
    const isVisible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0
        && rect.width >= 0
        && rect.height >= 0;
    };
    const isDecoration = (node) => {
      const role = `${node.getAttribute("data-layout-role") || ""} ${node.getAttribute("aria-hidden") || ""} ${node.className?.baseVal || node.className || ""}`;
      return /decoration|background|ornament|accent-rule/i.test(role) || node.getAttribute("aria-hidden") === "true";
    };
    const isConnector = (node) => node.hasAttribute("data-connector")
      || (node.hasAttribute("data-source-id") && node.hasAttribute("data-target-id"));
    const rectIntersection = (a, b) => {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
    };
    const hasMeaningfulText = (node) => (node.innerText || node.textContent || "").trim().length > 0;
    const isCard = (node) => node.matches(".card,[data-card],[data-pptx-kind='card']");
    const boundaryDistance = (point, rect) => {
      const insideX = point.x >= rect.left - 8 && point.x <= rect.right + 8;
      const insideY = point.y >= rect.top - 8 && point.y <= rect.bottom + 8;
      if (!insideX || !insideY) return Infinity;
      return Math.min(
        Math.abs(point.x - rect.left),
        Math.abs(point.x - rect.right),
        Math.abs(point.y - rect.top),
        Math.abs(point.y - rect.bottom)
      );
    };
    const pointOnGeometry = (node, atEnd) => {
      if (!(node instanceof SVGGeometryElement) || typeof node.getTotalLength !== "function") return null;
      let length;
      try { length = node.getTotalLength(); } catch { return null; }
      const local = node.getPointAtLength(atEnd ? length : 0);
      const matrix = node.getScreenCTM();
      if (!matrix) return null;
      const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y, length };
    };
    const pushCheck = (slideId, node, kind, message, extra = {}) => {
      const slide = node.closest(slideSelector) || document.body;
      const slideRect = slide.getBoundingClientRect();
      checks.push({
        slideId,
        elementId: semanticId(node),
        selector: elementSelector(node),
        kind,
        severity: extra.severity || "critical",
        message,
        ...(extra.relatedNode ? {
          relatedElementId: semanticId(extra.relatedNode),
          relatedSelector: elementSelector(extra.relatedNode)
        } : {}),
        ...(extra.rect === false ? {} : { rect: roundedRect(node.getBoundingClientRect(), slideRect) }),
        ...(extra.relatedNode ? { relatedRect: roundedRect(extra.relatedNode.getBoundingClientRect(), slideRect) } : {}),
        ...(extra.suggestion ? { suggestion: extra.suggestion } : {})
      });
    };

    slides.forEach((slide, slideIndex) => {
      const slideId = slide.getAttribute("data-slide-id") || slide.id || `slide-${String(slideIndex + 1).padStart(3, "0")}`;
      slide.setAttribute("data-pptx-audit-slide-id", slideId);
      const slideRect = slide.getBoundingClientRect();
      slideReports.push({ slideId, width: Number(slideRect.width.toFixed(2)), height: Number(slideRect.height.toFixed(2)), screenshot: null });

      const candidates = [...slide.querySelectorAll(candidateSelector)].filter((node) => isVisible(node));
      if (slide === document.body && slide.matches(candidateSelector)) candidates.unshift(slide);
      candidates.forEach((node, index) => {
        if (!node.hasAttribute("data-pptx-audit-id")) node.setAttribute("data-pptx-audit-id", `${slideId}-element-${String(index + 1).padStart(3, "0")}`);
        for (const id of new Set([node.id, node.getAttribute("data-pptx-id")].filter(Boolean))) {
          if (!globalIds.has(id)) globalIds.set(id, []);
          globalIds.get(id).push({ node, slideId });
        }
      });

      if (Math.abs(slideRect.width - 1280) > tolerance || Math.abs(slideRect.height - 720) > tolerance) {
        if (!slide.hasAttribute("data-pptx-audit-id")) slide.setAttribute("data-pptx-audit-id", `${slideId}-canvas`);
        pushCheck(slideId, slide, "slide-size-mismatch", `Slide ${slideId} renders at ${slideRect.width.toFixed(1)}x${slideRect.height.toFixed(1)}px; creative HTML must use a 1280x720 canvas.`, {
          suggestion: { operation: "normalizeSlideCanvas", width: 1280, height: 720 }
        });
      }

      for (const node of candidates) {
        const rect = node.getBoundingClientRect();
        const nearZero = isConnector(node)
          ? rect.width <= tolerance && rect.height <= tolerance
          : rect.width <= tolerance || rect.height <= tolerance;
        if (nearZero) {
          pushCheck(slideId, node, "zero-size", `Element ${semanticId(node)} has zero or near-zero rendered size.`);
          continue;
        }
        if (
          rect.left < slideRect.left - tolerance
          || rect.top < slideRect.top - tolerance
          || rect.right > slideRect.right + tolerance
          || rect.bottom > slideRect.bottom + tolerance
        ) {
          pushCheck(slideId, node, "slide-bounds", `Element ${semanticId(node)} extends outside the slide canvas.`, {
            suggestion: { operation: "fitWithinSlide" }
          });
        }

        if (hasMeaningfulText(node) && !(node instanceof SVGElement)) {
          const horizontalOverflow = node.scrollWidth > node.clientWidth + tolerance;
          const verticalOverflow = node.scrollHeight > node.clientHeight + tolerance;
          if (horizontalOverflow || verticalOverflow) {
            const style = getComputedStyle(node);
            const clipped = [style.overflow, style.overflowX, style.overflowY].some((value) => ["hidden", "clip"].includes(value))
              || style.textOverflow === "ellipsis"
              || (style.webkitLineClamp && style.webkitLineClamp !== "none");
            pushCheck(
              slideId,
              node,
              clipped ? "content-clipped" : "text-overflow",
              `Element ${semanticId(node)} content requires ${node.scrollWidth}x${node.scrollHeight}px but only ${node.clientWidth}x${node.clientHeight}px is available.`,
              { suggestion: { operation: "expandOrReflowText", scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight } }
            );
          }
        }

        if (node instanceof HTMLImageElement && (!node.complete || node.naturalWidth === 0 || node.naturalHeight === 0)) {
          pushCheck(slideId, node, "asset-not-ready", `Image ${semanticId(node)} did not load or decode.`, { severity: "critical" });
        }
      }

      for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
          const a = candidates[i];
          const b = candidates[j];
          if (a.contains(b) || b.contains(a) || isDecoration(a) || isDecoration(b) || isConnector(a) || isConnector(b)) continue;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const intersection = rectIntersection(ar, br);
          if (!intersection || intersection.width * intersection.height <= 4) continue;
          const smaller = Math.max(1, Math.min(ar.width * ar.height, br.width * br.height));
          const ratio = (intersection.width * intersection.height) / smaller;
          if (ratio <= 0.01) continue;
          const pointX = intersection.left + intersection.width / 2;
          const pointY = intersection.top + intersection.height / 2;
          const stack = document.elementsFromPoint(pointX, pointY);
          const aSeen = stack.some((node) => node === a || a.contains(node));
          const bSeen = stack.some((node) => node === b || b.contains(node));
          const meaningful = isCard(a) && isCard(b)
            || hasMeaningfulText(a)
            || hasMeaningfulText(b)
            || (aSeen && bSeen && ratio > 0.05);
          if (!meaningful) continue;
          pushCheck(slideId, a, "overlap", `Elements ${semanticId(a)} and ${semanticId(b)} overlap by ${(ratio * 100).toFixed(1)}% of the smaller element.`, {
            relatedNode: b,
            suggestion: { operation: "reflowOrMove", overlapRatio: Number(ratio.toFixed(4)) }
          });
        }
      }

      const connectors = [...slide.querySelectorAll("[data-connector], [data-source-id][data-target-id]")];
      for (const connector of connectors) {
        if (!connector.hasAttribute("data-pptx-audit-id")) {
          connector.setAttribute("data-pptx-audit-id", `${slideId}-connector-${connectors.indexOf(connector) + 1}`);
        }
        const sourceId = connector.getAttribute("data-source-id");
        const targetId = connector.getAttribute("data-target-id");
        if (!connector.getAttribute("data-pptx-id") || connector.getAttribute("data-pptx-kind") !== "line") {
          pushCheck(slideId, connector, "connector-unsupported", `Connector ${semanticId(connector)} must declare data-pptx-id and data-pptx-kind="line" for editable PPTX conversion.`, {
            suggestion: { operation: "addConnectorManifestMetadata" }
          });
        }
        const source = sourceId ? document.querySelector(`[data-pptx-id="${cssEscape(sourceId)}"],#${cssEscape(sourceId)}`) : null;
        const target = targetId ? document.querySelector(`[data-pptx-id="${cssEscape(targetId)}"],#${cssEscape(targetId)}`) : null;
        if (!(connector instanceof SVGGeometryElement)) {
          pushCheck(slideId, connector, "connector-unsupported", `Connector ${semanticId(connector)} must be an SVG line, polyline, or simple path.`);
          continue;
        }
        const start = pointOnGeometry(connector, false);
        const end = pointOnGeometry(connector, true);
        if (!source || !target || !start || !end) {
          pushCheck(slideId, connector, "connector-detached", `Connector ${semanticId(connector)} has an unresolved source, target, or SVG geometry.`);
          continue;
        }
        const sourceRect = source.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (boundaryDistance(start, sourceRect) > 8 || boundaryDistance(end, targetRect) > 8) {
          pushCheck(slideId, connector, "connector-detached", `Connector ${semanticId(connector)} does not terminate on ${sourceId} and ${targetId}.`, {
            relatedNode: target,
            suggestion: { operation: "reanchorConnector", sourceId, targetId }
          });
        }
        const markerStart = getComputedStyle(connector).markerStart || connector.getAttribute("marker-start") || "none";
        const markerEnd = getComputedStyle(connector).markerEnd || connector.getAttribute("marker-end") || "none";
        if (markerEnd === "none" && markerStart === "none") {
          pushCheck(slideId, connector, "connector-marker-missing", `Connector ${semanticId(connector)} has no marker-start or marker-end arrowhead.`, {
            suggestion: { operation: "addEndMarker" }
          });
        }
        const targetCenter = { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 };
        const tangent = { x: end.x - start.x, y: end.y - start.y };
        const towardTarget = { x: targetCenter.x - end.x, y: targetCenter.y - end.y };
        const dot = tangent.x * towardTarget.x + tangent.y * towardTarget.y;
        if (markerStart !== "none" && markerEnd === "none" || dot < -1) {
          pushCheck(slideId, connector, "connector-direction", `Connector ${semanticId(connector)} arrowhead points away from target ${targetId}.`, {
            suggestion: { operation: "orientTowardTarget", sourceId, targetId }
          });
        }
      }
    });

    for (const [id, entries] of globalIds) {
      if (entries.length < 2) continue;
      for (const entry of entries) {
        pushCheck(entry.slideId, entry.node, "duplicate-id", `Identifier ${id} is used ${entries.length} times; measurement and connector lookup require globally unique ids.`, {
          suggestion: { operation: "deduplicateId", id }
        });
      }
    }

    return { slides: slideReports, checks };
  }, { tolerance: tolerancePx });
}

export async function auditHtmlFile(inputPath, options = {}) {
  return withSettledHtmlPage(inputPath, options, async (page, viewport) => {
    const result = await auditHtmlPage(page, options);
    const report = {
      version: HTML_LAYOUT_REPORT_VERSION,
      source: resolve(inputPath),
      createdAt: new Date().toISOString(),
      viewport,
      slides: result.slides,
      checks: result.checks,
      summary: {
        criticalCount: result.checks.filter((check) => check.severity === "critical").length,
        warningCount: result.checks.filter((check) => check.severity === "warning").length,
        slideCount: result.slides.length,
        blocked: result.checks.some((check) => check.severity === "critical")
      }
    };
    const screenshots = options.screenshots === false
      ? new Map()
      : await captureSlideScreenshots(page, report, options.outputDir);
    assignScreenshots(report, screenshots);
    return report;
  });
}
