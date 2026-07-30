import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HTML_LAYOUT_REPORT_VERSION = "0.1.0";
export const DEFAULT_HTML_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
export const HTML_BROWSER_DEFAULTS = Object.freeze({
  javaScriptEnabled: false,
  networkEnabled: false,
  totalTimeoutMs: 90_000
});

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

export async function installBrowserSecurity(page, options = {}) {
  const networkEnabled = options.networkEnabled ?? HTML_BROWSER_DEFAULTS.networkEnabled;
  await page.route("**/*", async (route) => {
    const url = route.request?.().url?.() ?? "http://blocked.invalid";
    if (networkEnabled || /^(?:file|data|blob):/i.test(url)) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

export async function settleHtmlPage(page, inputPath) {
  const resolvedInput = resolve(inputPath);
  const source = await readFile(resolvedInput, "utf8");
  const sanitized = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const base = /<base\b[^>]*href\s*=/i.test(sanitized)
    ? ""
    : `<base href="${pathToFileURL(dirname(resolvedInput) + "/").href}">`;
  const securityHead = base
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; style-src 'unsafe-inline' file:; font-src data: file:;">`;
  const securedHtml = /<head\b[^>]*>/i.test(sanitized)
    ? sanitized.replace(/<head\b[^>]*>/i, (match) => `${match}${securityHead}`)
    : `${securityHead}${sanitized}`;
  const inputUrl = pathToFileURL(resolvedInput).href;
  await page.route(inputUrl, (route) => route.fulfill({ status: 200, contentType: "text/html", body: securedHtml }));
  await page.goto(inputUrl, { waitUntil: "load" });
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
    const snapshot = () => {
      const selector = [
        ".pptx-slide",
        "[data-slide]",
        "[data-pptx-id]",
        "[data-pptx-kind]",
        "[data-layout-role]",
        "[data-card]",
        ".card",
        "h1",
        "h2",
        "h3",
        "p",
        "li",
        "table",
        "img",
        "svg"
      ].join(",");
      return [...document.querySelectorAll(selector)].map((node) => {
        const rect = node.getBoundingClientRect();
        return [
          node.tagName,
          node.getAttribute("data-pptx-id") || node.id || "",
          Number(rect.left.toFixed(2)),
          Number(rect.top.toFixed(2)),
          Number(rect.width.toFixed(2)),
          Number(rect.height.toFixed(2)),
          node.scrollWidth,
          node.scrollHeight
        ];
      });
    };
    let previous = "";
    let consecutiveMatches = 0;
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise((done) => requestAnimationFrame(done));
      const current = JSON.stringify(snapshot());
      consecutiveMatches = current === previous ? consecutiveMatches + 1 : 0;
      previous = current;
      if (consecutiveMatches >= 2) return;
    }
    throw new Error("HTML layout did not stabilize across two consecutive geometry snapshots.");
  });
}

export async function withSettledHtmlPage(inputPath, options, callback) {
  const chromium = await loadChromium();
  const viewport = {
    width: options?.viewportWidth ?? DEFAULT_HTML_VIEWPORT.width,
    height: options?.viewportHeight ?? DEFAULT_HTML_VIEWPORT.height
  };
  const totalTimeoutMs = options?.totalTimeoutMs ?? HTML_BROWSER_DEFAULTS.totalTimeoutMs;
  const browser = await chromium.launch({ headless: true, timeout: totalTimeoutMs });
  try {
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: 1,
      // Author scripts are stripped and blocked by CSP before loading. Keep
      // the engine enabled so deterministic measurement page.evaluate calls work.
      javaScriptEnabled: true
    });
    page.setDefaultTimeout(totalTimeoutMs);
    page.setDefaultNavigationTimeout(totalTimeoutMs);
    await installBrowserSecurity(page, options);
    let timeoutId;
    try {
      return await Promise.race([
        (async () => {
          await settleHtmlPage(page, inputPath);
          return callback(page, viewport);
        })(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`HTML browser execution exceeded total timeout (${totalTimeoutMs}ms)`)), totalTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    await browser.close();
  }
}

export async function countConvertibleSlides(page) {
  return page.evaluate(() => {
    const slides = document.querySelectorAll(".pptx-slide, [data-slide]");
    return Math.max(1, slides.length);
  });
}

export async function withTemporarilyVisibleSlide(page, slideIndex, callback) {
  const state = await page.evaluate((requestedIndex) => {
    const explicitSlides = [...document.querySelectorAll(".pptx-slide, [data-slide]")];
    const slides = explicitSlides.length > 0
      ? explicitSlides
      : [document.querySelector(".pptx-deck") ?? document.body];
    const target = slides[requestedIndex];
    if (!target) throw new Error(`slide index ${requestedIndex} is out of range`);
    const snapshots = slides.map((slide) => ({
      className: slide.getAttribute("class"),
      style: slide.getAttribute("style"),
      ariaHidden: slide.getAttribute("aria-hidden"),
      hidden: slide.getAttribute("hidden"),
      auditVisible: slide.getAttribute("data-pptx-audit-visible")
    }));
    const visiblePeerDisplay = slides
      .map((slide) => getComputedStyle(slide).display)
      .find((display) => display && display !== "none");

    const restoreAttribute = (node, name, value) => {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    };
    const styleWith = (source, declarations) => {
      const probe = document.createElement("span");
      if (source !== null) probe.setAttribute("style", source);
      for (const [name, value, priority = ""] of declarations) {
        if (value === null) probe.style.removeProperty(name);
        else probe.style.setProperty(name, value, priority);
      }
      return probe.getAttribute("style");
    };
    const restoreTargetForDiscovery = () => {
      restoreAttribute(target, "class", snapshots[requestedIndex].className);
      restoreAttribute(target, "style", styleWith(
        snapshots[requestedIndex].style,
        [["display", null]]
      ));
      target.removeAttribute("hidden");
      target.setAttribute("aria-hidden", "false");
    };
    const stylesheetCandidates = () => {
      const candidates = [];
      let order = 0;
      const visitRules = (rules) => {
        for (const rule of [...(rules ?? [])]) {
          if (rule.cssRules) {
            visitRules(rule.cssRules);
            continue;
          }
          const declaredDisplay = rule.style?.display?.trim();
          if (!rule.selectorText || !declaredDisplay || declaredDisplay === "none") continue;
          for (const selector of rule.selectorText.split(",")) {
            const candidateSelector = selector.trim();
            if (!candidateSelector || candidateSelector.includes("::")) continue;
            const classNames = [...candidateSelector.matchAll(/\.([_a-zA-Z][\w-]*)/g)]
              .map((match) => match[1]);
            const existing = classNames.filter((name) => target.classList.contains(name));
            const anchored = existing.length > 0
              || candidateSelector.includes("[data-slide")
              || candidateSelector.toLowerCase().includes(target.tagName.toLowerCase());
            if (!anchored) continue;
            restoreTargetForDiscovery();
            const missing = classNames.filter((name) => !target.classList.contains(name));
            target.classList.add(...missing);
            let matches = false;
            try {
              matches = target.matches(candidateSelector);
            } catch {
              matches = false;
            }
            const computed = matches ? getComputedStyle(target).display : "none";
            if (computed && computed !== "none") {
              candidates.push({
                display: computed,
                addedClasses: missing.length,
                existingClasses: existing.length,
                order
              });
            }
            order += 1;
          }
        }
      };
      for (const sheet of [...document.styleSheets]) {
        try {
          visitRules(sheet.cssRules);
        } catch {
          // Cross-origin stylesheets are already blocked by the secured browser.
        }
      }
      restoreTargetForDiscovery();
      return candidates.sort((left, right) =>
        left.addedClasses - right.addedClasses
        || right.existingClasses - left.existingClasses
        || right.order - left.order);
    };

    restoreTargetForDiscovery();
    const ownDisplay = getComputedStyle(target).display;
    const candidate = ownDisplay !== "none"
      ? ownDisplay
      : visiblePeerDisplay
        || stylesheetCandidates()[0]?.display
        || (Number.parseFloat(getComputedStyle(target.firstElementChild ?? target).flexGrow) > 0
          ? "flex"
          : "block");
    restoreAttribute(target, "class", snapshots[requestedIndex].className);
    restoreAttribute(target, "style", snapshots[requestedIndex].style);

    slides.forEach((slide, index) => {
      if (index === requestedIndex) return;
      restoreAttribute(slide, "style", styleWith(snapshots[index].style, [
        ["display", "none", "important"],
        ["visibility", "hidden", "important"]
      ]));
      slide.setAttribute("aria-hidden", "true");
    });
    target.removeAttribute("hidden");
    target.setAttribute("aria-hidden", "false");
    target.setAttribute("data-pptx-audit-visible", "true");
    restoreAttribute(target, "style", styleWith(snapshots[requestedIndex].style, [
      ["display", candidate, "important"],
      ["visibility", "visible", "important"],
      ["opacity", "1", "important"],
      ["content-visibility", "visible", "important"]
    ]));
    const targetRect = target.getBoundingClientRect();
    const externalSnapshots = [];
    for (const node of document.body.querySelectorAll("*")) {
      if (node === target || target.contains(node) || node.contains(target)) continue;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0) continue;
      const rect = node.getBoundingClientRect();
      const intersects = rect.right > targetRect.left
        && rect.left < targetRect.right
        && rect.bottom > targetRect.top
        && rect.top < targetRect.bottom;
      if (!intersects) continue;
      const marker = `external-${externalSnapshots.length + 1}`;
      externalSnapshots.push({
        marker,
        style: node.getAttribute("style"),
        previousMarker: node.getAttribute("data-pptx-audit-external")
      });
      node.setAttribute("data-pptx-audit-external", marker);
      restoreAttribute(node, "style", styleWith(node.getAttribute("style"), [
        ["visibility", "hidden", "important"]
      ]));
    }
    return {
      slideIndex: requestedIndex,
      slideId: target.getAttribute("data-slide-id")
        || target.id
        || `slide-${String(requestedIndex + 1).padStart(3, "0")}`,
      display: candidate,
      snapshots,
      externalSnapshots
    };
  }, slideIndex);

  try {
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    return await callback(state);
  } finally {
    await page.evaluate(({ snapshots, externalSnapshots }) => {
      const explicitSlides = [...document.querySelectorAll(".pptx-slide, [data-slide]")];
      const slides = explicitSlides.length > 0
        ? explicitSlides
        : [document.querySelector(".pptx-deck") ?? document.body];
      const restore = (node, name, value) => {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      };
      slides.forEach((slide, index) => {
        const snapshot = snapshots[index];
        if (!snapshot) return;
        restore(slide, "class", snapshot.className);
        restore(slide, "aria-hidden", snapshot.ariaHidden);
        restore(slide, "hidden", snapshot.hidden);
        restore(slide, "data-pptx-audit-visible", snapshot.auditVisible);
        restore(slide, "style", snapshot.style);
      });
      for (const snapshot of externalSnapshots ?? []) {
        const node = document.querySelector(`[data-pptx-audit-external="${CSS.escape(snapshot.marker)}"]`);
        if (!node) continue;
        restore(node, "style", snapshot.style);
        restore(node, "data-pptx-audit-external", snapshot.previousMarker);
      }
    }, state);
    await page.evaluate(({ snapshots }) => {
      const explicitSlides = [...document.querySelectorAll(".pptx-slide, [data-slide]")];
      const slides = explicitSlides.length > 0
        ? explicitSlides
        : [document.querySelector(".pptx-deck") ?? document.body];
      slides.forEach((slide, index) => {
        if (snapshots[index]?.style === null) slide.removeAttribute("style");
      });
    }, state);
  }
}

export function mergeSlideAuditResults(results) {
  return {
    slides: results.flatMap((result) => result.slides ?? []),
    checks: results.flatMap((result) => result.checks ?? [])
  };
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
  for (const [slideIndex, slide] of report.slides.entries()) {
    await withTemporarilyVisibleSlide(page, slideIndex, async () => {
      const locator = page.locator(`[data-pptx-audit-slide-id="${slide.slideId}"]`).first();
      if (await locator.count() === 0) {
        throw new Error(`cannot locate slide ${slide.slideId} for screenshot`);
      }
      const safeSlideId = String(slide.slideId).replace(/[^A-Za-z0-9._-]/g, "-");
      const fileName = `slide-${String(slideIndex + 1).padStart(3, "0")}-${safeSlideId}.png`;
      const outputPath = join(previewDir, fileName);
      await locator.scrollIntoViewIfNeeded({ timeout: 90_000 });
      const box = await locator.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error(`slide ${slide.slideId} has no visible screenshot geometry`);
      }
      await page.screenshot({ path: outputPath, clip: box, animations: "disabled", timeout: 90_000 });
      screenshots.set(slide.slideId, relative(resolve(outputDir), outputPath).replace(/\\/g, "/"));
    });
  }
  return screenshots;
}

export async function auditHtmlPage(page, options = {}) {
  const tolerancePx = options.tolerancePx ?? 2;
  const profile = options.profile ?? "creative";
  return page.evaluate(({ tolerance, layoutProfile, onlySlideIndex, includeDuplicateChecks }) => {
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
      "svg [data-source-id][data-target-id]",
      "svg line[marker-end]", "svg path[marker-end]", "svg polyline[marker-end]",
      "svg line[marker-start]", "svg path[marker-start]", "svg polyline[marker-start]"
    ].join(",");
    const allSlides = [...document.querySelectorAll(slideSelector)];
    if (allSlides.length === 0) allSlides.push(document.body);
    const slides = Number.isInteger(onlySlideIndex)
      ? [allSlides[onlySlideIndex]].filter(Boolean)
      : allSlides;

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
    const overlapAllowlist = (node) => new Set(String(node.getAttribute("data-allow-overlap-with") || "")
      .split(/[\s,]+/).map((value) => value.trim()).filter(Boolean));
    const overlapAllowed = (a, b) => overlapAllowlist(a).has(semanticId(b)) || overlapAllowlist(b).has(semanticId(a));
    const isConnector = (node) => node.hasAttribute("data-connector")
      || node.hasAttribute("marker-end")
      || node.hasAttribute("marker-start")
      || node.hasAttribute("data-source-id")
      || node.hasAttribute("data-target-id");
    const rectIntersection = (a, b) => {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
    };
    const hasMeaningfulText = (node) => (node.innerText || node.textContent || "").trim().length > 0;
    const isCard = (node) => node.matches(".card,[data-card],[data-pptx-kind='card']");
    const textLineCount = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const lineTops = [];
      const lineTolerance = Math.max(2, (Number.parseFloat(getComputedStyle(node).fontSize) || 16) * 0.12);
      for (const rect of [...range.getClientRects()].filter((item) => item.width > tolerance && item.height > tolerance).sort((a, b) => a.top - b.top || a.left - b.left)) {
        if (!lineTops.some((top) => Math.abs(top - rect.top) <= lineTolerance)) lineTops.push(rect.top);
      }
      return Math.max(1, lineTops.length);
    };
    const isTitleText = (node) => {
      const role = `${node.getAttribute("data-layout-role") || ""} ${node.getAttribute("data-typography") || ""} ${node.className?.baseVal || node.className || ""}`;
      return node.matches("h1,h2,[data-layout-role='title'],[data-layout-role='headline']")
        || /(?:^|\s|[-_])(?:slide[-_]?title|hero[-_]?title|headline)(?:$|\s|[-_])/i.test(role);
    };
    const isMetricText = (node) => {
      const role = `${node.getAttribute("data-layout-role") || ""} ${node.getAttribute("data-typography") || ""} ${node.className?.baseVal || node.className || ""}`;
      return /(?:^|\s|[-_])(?:metric|kpi|stat|big[-_]?number)(?:$|\s|[-_])/i.test(role);
    };
    const whitespaceIntentional = (slide) => {
      const intent = `${slide.getAttribute("data-whitespace-intent") || ""} ${slide.getAttribute("data-gap-intent") || ""}`
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const type = `${slide.getAttribute("data-type") || ""} ${slide.getAttribute("data-page-role") || ""}`.toLowerCase();
      return intent.some((value) => ["spacious", "intentional", "sparse"].includes(value))
        || /(?:^|\s)(?:cover|section|quote|closing)(?:$|\s)/.test(type);
    };
    const isSubstantive = (node, slide) => {
      if (node === slide || isDecoration(node) || isConnector(node)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= tolerance || rect.height <= tolerance) return false;
      if (node instanceof HTMLImageElement || node.matches("table,canvas,video")) return true;
      const kind = node.getAttribute("data-pptx-kind") || node.getAttribute("data-pptx-type");
      if (kind && !["line", "connector", "decoration"].includes(kind.toLowerCase())) return true;
      return hasMeaningfulText(node) || (isCard(node) && node.children.length > 0);
    };
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
    const segmentIntersectsInterior = (start, end, rect, inset = 4) => {
      const left = rect.left + inset;
      const right = rect.right - inset;
      const top = rect.top + inset;
      const bottom = rect.bottom - inset;
      if (!(right > left && bottom > top)) return false;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      let tMin = 0;
      let tMax = 1;
      for (const [p, q] of [[-dx, start.x - left], [dx, right - start.x], [-dy, start.y - top], [dy, bottom - start.y]]) {
        if (Math.abs(p) < Number.EPSILON) {
          if (q < 0) return false;
          continue;
        }
        const ratio = q / p;
        if (p < 0) tMin = Math.max(tMin, ratio);
        else tMax = Math.min(tMax, ratio);
        if (tMin > tMax) return false;
      }
      return tMax > 1e-6 && tMin < 1 - 1e-6;
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

    slides.forEach((slide) => {
      const slideIndex = allSlides.indexOf(slide);
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
          const text = (node.innerText || node.textContent || "").trim();
          const style = getComputedStyle(node);
          const fontSize = Number.parseFloat(style.fontSize);
          const lineHeight = Number.parseFloat(style.lineHeight);
          const cjkBody = /[　-〿぀-ゟ゠-ヿ一-鿿＀-￯]/.test(text) && !node.matches("h1,h2,h3,[data-typography='title'],[data-typography='heading']");
          if (layoutProfile === "creative" && cjkBody && fontSize > 0 && lineHeight > 0) {
            const ratio = lineHeight / fontSize;
            if (ratio < 1.2) {
              pushCheck(slideId, node, "text-rhythm", `CJK body ${semanticId(node)} has computed line-height ${ratio.toFixed(2)}; minimum is 1.20.`, {
                suggestion: { operation: "setTextRhythm", lineHeight: 1.35 }
              });
            } else if (ratio < 1.35) {
              pushCheck(slideId, node, "text-rhythm", `CJK body ${semanticId(node)} has computed line-height ${ratio.toFixed(2)}; 1.35 or higher is preferred.`, {
                severity: "warning",
                suggestion: { operation: "setTextRhythm", lineHeight: 1.35 }
              });
            }
          }
          if (layoutProfile === "creative" && node.matches("li")) {
            const next = node.nextElementSibling;
            const gap = next?.matches("li") ? next.getBoundingClientRect().top - node.getBoundingClientRect().bottom : null;
            if (gap !== null && fontSize > 0 && gap < fontSize * 0.35 - tolerance) {
              pushCheck(slideId, node, "text-rhythm", `List item ${semanticId(node)} has ${gap.toFixed(1)}px paragraph spacing; minimum is 0.35em.`, {
                relatedNode: next,
                suggestion: { operation: "setListItemSpacing", marginBlockEnd: "0.35em" }
              });
            }
          }
          if (layoutProfile === "creative") {
            const lineCount = textLineCount(node);
            if (isTitleText(node)) {
              const declared = Number.parseInt(node.getAttribute("data-max-lines") || "1", 10);
              const maxLines = Number.isInteger(declared) && declared > 0 ? declared : 1;
              if (lineCount > maxLines) {
                pushCheck(slideId, node, "title-line-limit", `Title ${semanticId(node)} renders as ${lineCount} lines but allows ${maxLines}.`, {
                  suggestion: { operation: "hostReflow", alternatives: ["shorten-title", "widen-title-band", "two-line-title-layout"] }
                });
              }
            } else if (isMetricText(node) && lineCount > 1) {
              pushCheck(slideId, node, "metric-wrap", `Metric ${semanticId(node)} wraps to ${lineCount} lines; atomic values must remain on one line.`, {
                suggestion: { operation: "hostReflow", alternatives: ["wider-layout", "metric-group", "price-group"] }
              });
            }
          }
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
          if (a.contains(b) || b.contains(a) || isConnector(a) || isConnector(b) || overlapAllowed(a, b)) continue;
          if (layoutProfile !== "creative" && (isDecoration(a) || isDecoration(b))) continue;
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
          const decorative = isDecoration(a) || isDecoration(b);
          const meaningful = decorative
            || isCard(a) && isCard(b)
            || hasMeaningfulText(a)
            || hasMeaningfulText(b)
            || (aSeen && bSeen && ratio > 0.05);
          if (!meaningful) continue;
          pushCheck(slideId, a, decorative ? "decoration-occlusion" : "content-occlusion", `Elements ${semanticId(a)} and ${semanticId(b)} overlap by ${(ratio * 100).toFixed(1)}% of the smaller element.`, {
            relatedNode: b,
            suggestion: { operation: "reflowOrMove", overlapRatio: Number(ratio.toFixed(4)) }
          });
        }
      }

      if (layoutProfile === "creative") {
        if (!whitespaceIntentional(slide)) {
          const contentRects = candidates.filter((node) => isSubstantive(node, slide)).map((node) => node.getBoundingClientRect());
          if (contentRects.length >= 2) {
            const left = Math.min(...contentRects.map((rect) => rect.left));
            const top = Math.min(...contentRects.map((rect) => rect.top));
            const right = Math.max(...contentRects.map((rect) => rect.right));
            const bottom = Math.max(...contentRects.map((rect) => rect.bottom));
            const gaps = {
              left: Math.max(0, left - slideRect.left),
              right: Math.max(0, slideRect.right - right),
              top: Math.max(0, top - slideRect.top),
              bottom: Math.max(0, slideRect.bottom - bottom)
            };
            const contentWidth = Math.max(0, right - left);
            const contentHeight = Math.max(0, bottom - top);
            const horizontalDominant = Math.max(gaps.left, gaps.right) > slideRect.width * 0.40
              && Math.abs(gaps.left - gaps.right) > slideRect.width * 0.15
              && contentWidth < slideRect.width * 0.35;
            const verticalDominant = Math.max(gaps.top, gaps.bottom) > slideRect.height * 0.40
              && Math.abs(gaps.top - gaps.bottom) > slideRect.height * 0.15
              && contentHeight < slideRect.height * 0.35;
            const horizontalImbalance = Math.abs(gaps.left - gaps.right) > slideRect.width * 0.28 && contentWidth < slideRect.width * 0.72;
            const verticalImbalance = Math.abs(gaps.top - gaps.bottom) > slideRect.height * 0.28 && contentHeight < slideRect.height * 0.72;
            if (horizontalDominant || verticalDominant) {
              if (!slide.hasAttribute("data-pptx-audit-id")) slide.setAttribute("data-pptx-audit-id", `${slideId}-canvas`);
              pushCheck(slideId, slide, "excessive-whitespace", `Slide ${slideId} leaves a dominant empty ${horizontalDominant ? "horizontal" : "vertical"} band without an explicit spacious intent.`, {
                rect: false,
                suggestion: { operation: "hostReflow", axis: horizontalDominant ? "horizontal" : "vertical", contentWidth, contentHeight }
              });
            } else if (horizontalImbalance || verticalImbalance) {
              if (!slide.hasAttribute("data-pptx-audit-id")) slide.setAttribute("data-pptx-audit-id", `${slideId}-canvas`);
              pushCheck(slideId, slide, "content-imbalance", `Slide ${slideId} has strongly asymmetric edge whitespace without an explicit whitespace intent.`, {
                severity: "warning",
                rect: false,
                suggestion: { operation: "reviewBalance", axis: horizontalImbalance ? "horizontal" : "vertical" }
              });
            }
          }
        }

        for (const region of slide.querySelectorAll("[data-layout-region]")) {
          if (!region.hasAttribute("data-pptx-audit-id")) region.setAttribute("data-pptx-audit-id", `${slideId}-region-${semanticId(region)}`);
          const style = getComputedStyle(region);
          if (!["flex", "grid", "inline-flex", "inline-grid"].includes(style.display)) {
            pushCheck(slideId, region, "vertical-gap-imbalance", `Layout region ${semanticId(region)} must use CSS flex or grid.`, {
              suggestion: { operation: "normalizeLayoutRegion", display: "flex", direction: "column" }
            });
            continue;
          }
          const children = [...region.children].filter((child) => isVisible(child) && !isDecoration(child) && !isConnector(child));
          const vertical = children.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          for (let index = 0; index < vertical.length - 1; index += 1) {
            const current = vertical[index];
            const next = vertical[index + 1];
            const gap = next.getBoundingClientRect().top - current.getBoundingClientRect().bottom;
            const em = Number.parseFloat(getComputedStyle(next).fontSize) || Number.parseFloat(style.fontSize) || 16;
            const spacious = region.getAttribute("data-gap-intent") === "spacious";
            if (gap < em * 0.25 - tolerance || gap > 72 + tolerance && !spacious) {
              pushCheck(slideId, current, "vertical-gap-imbalance", `Layout region ${semanticId(region)} has an adjacent vertical gap of ${gap.toFixed(1)}px; expected at least 0.25em and at most 0.75in.`, {
                relatedNode: next,
                suggestion: { operation: "balanceVerticalGap", minEm: 0.25, maxPx: 72 }
              });
            }
          }
        }

        for (const axis of slide.querySelectorAll("[data-layout-role='axis'][data-axis-direction]")) {
          if (!axis.hasAttribute("data-pptx-audit-id")) axis.setAttribute("data-pptx-audit-id", `${slideId}-axis-${semanticId(axis)}`);
          const start = pointOnGeometry(axis, false);
          const end = pointOnGeometry(axis, true);
          const direction = axis.getAttribute("data-axis-direction");
          const valid = start && end && (direction === "left" ? end.x < start.x
            : direction === "right" ? end.x > start.x
              : direction === "up" ? end.y < start.y
                : direction === "down" ? end.y > start.y
                  : false);
          if (!valid) {
            pushCheck(slideId, axis, "connector-direction", `Axis ${semanticId(axis)} geometry does not match data-axis-direction=${direction}.`, {
              suggestion: { operation: "orientAxis", direction }
            });
          }
        }
      }

      const connectors = [...slide.querySelectorAll([
        "[data-connector]", "[data-source-id]", "[data-target-id]",
        "svg line[marker-end]", "svg path[marker-end]", "svg polyline[marker-end]",
        "svg line[marker-start]", "svg path[marker-start]", "svg polyline[marker-start]"
      ].join(","))];
      for (const connector of connectors) {
        if (!connector.hasAttribute("data-pptx-audit-id")) {
          connector.setAttribute("data-pptx-audit-id", `${slideId}-connector-${connectors.indexOf(connector) + 1}`);
        }
        if (connector.getAttribute("data-layout-role") === "axis") continue;
        const sourceId = connector.getAttribute("data-source-id");
        const targetId = connector.getAttribute("data-target-id");
        if (!connector.getAttribute("data-pptx-id") || connector.getAttribute("data-pptx-kind") !== "line") {
          pushCheck(slideId, connector, "connector-unsupported", `Connector ${semanticId(connector)} must declare data-pptx-id and data-pptx-kind="line" for editable PPTX conversion.`, {
            suggestion: { operation: "addConnectorManifestMetadata" }
          });
        }
        const source = sourceId ? slide.querySelector(`[data-pptx-id="${cssEscape(sourceId)}"],#${cssEscape(sourceId)}`) : null;
        const target = targetId ? slide.querySelector(`[data-pptx-id="${cssEscape(targetId)}"],#${cssEscape(targetId)}`) : null;
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
        const route = connector.getAttribute("data-connector-route") || "straight";
        if (route === "orthogonal" && connector.tagName.toLowerCase() === "line" && Math.abs(end.x - start.x) > 2 && Math.abs(end.y - start.y) > 2) {
          pushCheck(slideId, connector, "connector-route-invalid", `Connector ${semanticId(connector)} declares an orthogonal route but renders as one diagonal segment.`, {
            suggestion: { operation: "routeConnectorOrthogonally", sourceId, targetId }
          });
        }
        if (route !== "orthogonal") {
          const obstruction = candidates.find((candidate) => candidate !== connector
            && candidate !== source
            && candidate !== target
            && !isConnector(candidate)
            && !isDecoration(candidate)
            && segmentIntersectsInterior(start, end, candidate.getBoundingClientRect()));
          if (obstruction) {
            pushCheck(slideId, connector, "connector-obstructed", `Connector ${semanticId(connector)} crosses unrelated module ${semanticId(obstruction)}.`, {
              relatedNode: obstruction,
              suggestion: { operation: "rerouteConnector", sourceId, targetId, aroundId: semanticId(obstruction) }
            });
          }
        }
      }
    });

    if (includeDuplicateChecks) {
      for (const [id, entries] of globalIds) {
        if (entries.length < 2) continue;
        for (const entry of entries) {
          pushCheck(entry.slideId, entry.node, "duplicate-id", `Identifier ${id} is used ${entries.length} times; measurement and connector lookup require globally unique ids.`, {
            suggestion: { operation: "deduplicateId", id }
          });
        }
      }
    }

    return { slides: slideReports, checks };
  }, {
    tolerance: tolerancePx,
    layoutProfile: profile,
    onlySlideIndex: options.onlySlideIndex,
    includeDuplicateChecks: options.includeDuplicateChecks !== false
  });
}

async function auditGlobalIdentifiers(page) {
  return page.evaluate(() => {
    const slideSelector = ".pptx-slide, [data-slide]";
    const candidateSelector = [
      "[data-pptx-id]",
      "[data-pptx-kind]",
      "[data-pptx-type]",
      "[data-layout-role]",
      "[data-card]",
      ".card",
      "h1", "h2", "h3", "p", "li", "table", "img"
    ].join(",");
    const slides = [...document.querySelectorAll(slideSelector)];
    const sourceSlides = slides.length > 0 ? slides : [document.body];
    const identifiers = new Map();
    sourceSlides.forEach((slide, slideIndex) => {
      const slideId = slide.getAttribute("data-slide-id")
        || slide.id
        || `slide-${String(slideIndex + 1).padStart(3, "0")}`;
      for (const [nodeIndex, node] of [...slide.querySelectorAll(candidateSelector)].entries()) {
        if (!node.hasAttribute("data-pptx-audit-id")) {
          node.setAttribute("data-pptx-audit-id", `${slideId}-element-${String(nodeIndex + 1).padStart(3, "0")}`);
        }
        for (const id of new Set([node.id, node.getAttribute("data-pptx-id")].filter(Boolean))) {
          const entries = identifiers.get(id) ?? [];
          entries.push({ node, slideId });
          identifiers.set(id, entries);
        }
      }
    });
    const checks = [];
    for (const [id, entries] of identifiers) {
      if (entries.length < 2) continue;
      for (const entry of entries) {
        const auditId = entry.node.getAttribute("data-pptx-audit-id");
        checks.push({
          slideId: entry.slideId,
          elementId: entry.node.getAttribute("data-pptx-id") || entry.node.id || auditId,
          selector: `[data-pptx-audit-id="${CSS.escape(auditId)}"]`,
          kind: "duplicate-id",
          severity: "critical",
          message: `Identifier ${id} is used ${entries.length} times; measurement and connector lookup require globally unique ids.`,
          suggestion: { operation: "deduplicateId", id }
        });
      }
    }
    return checks;
  });
}

export async function auditHtmlFile(inputPath, options = {}) {
  return withSettledHtmlPage(inputPath, options, async (page, viewport) => {
    const slideCount = await countConvertibleSlides(page);
    const perSlide = [];
    for (let slideIndex = 0; slideIndex < slideCount; slideIndex += 1) {
      perSlide.push(await withTemporarilyVisibleSlide(page, slideIndex, () =>
        auditHtmlPage(page, {
          ...options,
          onlySlideIndex: slideIndex,
          includeDuplicateChecks: false
        })));
    }
    const result = mergeSlideAuditResults(perSlide);
    result.checks.push(...await auditGlobalIdentifiers(page));
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
