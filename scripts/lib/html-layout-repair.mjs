import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditHtmlFile, auditHtmlPage, withSettledHtmlPage } from "./html-layout-audit.mjs";

export const HTML_REPAIR_REPORT_VERSION = "0.1.0";

function injectBaseHref(html, sourceDir) {
  if (/<base\b/i.test(html)) return html;
  const base = `<base href="${pathToFileURL(`${resolve(sourceDir)}/`).href}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n  ${base}`);
  return `${base}\n${html}`;
}

function summaryFromRawAudit(raw) {
  const criticalCount = raw.checks.filter((check) => check.severity === "critical").length;
  return { criticalCount, blocked: criticalCount > 0 };
}

async function applyRepairPass(inputPath, outputPath, attempt) {
  return withSettledHtmlPage(inputPath, {}, async (page) => {
    const rawAudit = await auditHtmlPage(page);
    const operations = await page.evaluate(({ checks, attemptNumber }) => {
      const slideSelector = ".pptx-slide, [data-slide]";
      const applied = [];
      const touched = new Set();
      const nodeFor = (selector) => {
        try { return document.querySelector(selector); } catch { return null; }
      };
      const semanticId = (node) => node?.getAttribute("data-pptx-id")
        || node?.getAttribute("data-id")
        || node?.id
        || node?.getAttribute("data-pptx-audit-id")
        || "unknown";
      const slideIdFor = (node) => node?.closest(slideSelector)?.getAttribute("data-pptx-audit-slide-id") || "slide-unknown";
      const record = (kind, node, description, before, after) => {
        const key = `${attemptNumber}:${kind}:${semanticId(node)}:${JSON.stringify(after)}`;
        if (touched.has(key)) return;
        touched.add(key);
        applied.push({
          kind,
          slideId: slideIdFor(node),
          elementId: semanticId(node),
          description,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {})
        });
      };
      const px = (value) => `${Math.max(0, Math.round(value))}px`;
      const minFontSize = (node) => node.matches("h1") ? 28 : node.matches("h2,h3") ? 18 : 14;
      const boundaryAnchor = (rect, toward) => {
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const target = { x: toward.left + toward.width / 2, y: toward.top + toward.height / 2 };
        const dx = target.x - center.x;
        const dy = target.y - center.y;
        if (Math.abs(dx) > Math.abs(dy)) return { x: dx >= 0 ? rect.right : rect.left, y: center.y };
        return { x: center.x, y: dy >= 0 ? rect.bottom : rect.top };
      };
      const ensureArrowMarker = (connector) => {
        const svg = connector.ownerSVGElement;
        if (!svg) return null;
        const markerId = `pptx-auto-arrowhead-${semanticId(connector).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        let defs = svg.querySelector("defs");
        if (!defs) {
          defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
          svg.insertBefore(defs, svg.firstChild);
        }
        let marker = defs.querySelector(`#${CSS.escape(markerId)}`);
        if (!marker) {
          marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
          marker.setAttribute("id", markerId);
          marker.setAttribute("viewBox", "0 0 10 10");
          marker.setAttribute("refX", "9");
          marker.setAttribute("refY", "5");
          marker.setAttribute("markerWidth", "6");
          marker.setAttribute("markerHeight", "6");
          marker.setAttribute("orient", "auto");
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
          path.setAttribute("fill", "context-stroke");
          marker.appendChild(path);
          defs.appendChild(marker);
        }
        connector.setAttribute("marker-end", `url(#${markerId})`);
        connector.removeAttribute("marker-start");
        return marker;
      };

      // Phase 1: normalize the slide canvas so browser pixels map exactly to 16:9 PPT inches.
      for (const check of checks.filter((item) => item.kind === "slide-size-mismatch")) {
        const slide = nodeFor(check.selector);
        if (!slide) continue;
        const before = { width: getComputedStyle(slide).width, height: getComputedStyle(slide).height };
        Object.assign(slide.style, {
          boxSizing: "border-box",
          height: "720px",
          maxHeight: "720px",
          minHeight: "720px",
          overflow: "visible",
          position: getComputedStyle(slide).position === "static" ? "relative" : getComputedStyle(slide).position,
          width: "1280px"
        });
        record("normalize-slide-canvas", slide, "Normalized creative slide canvas to 1280x720px.", before, { width: "1280px", height: "720px" });
      }

      // Phase 2: repair card containers before touching individual text boxes.
      const overlapChecks = checks.filter((item) => item.kind === "overlap");
      for (const check of overlapChecks) {
        const a = nodeFor(check.selector);
        const b = nodeFor(check.relatedSelector);
        if (!a || !b) continue;
        const parent = a.parentElement === b.parentElement ? a.parentElement : null;
        const layoutParent = a.closest(".cards,[data-cards],.panes,.layers,.grid-2,.grid-3,.phases")
          || b.closest(".cards,[data-cards],.panes,.layers,.grid-2,.grid-3,.phases")
          || parent;
        const cards = layoutParent ? [...layoutParent.children].filter((child) => child.matches(".card,[data-card],[data-pptx-kind='card'],.pane,.layer,.phase")) : [];
        if (layoutParent && cards.length >= 2) {
          const explicit = Number(layoutParent.getAttribute("data-cols"));
          const columns = Number.isFinite(explicit) && explicit > 0
            ? explicit
            : layoutParent.matches(".grid-3,.layers") ? 3 : layoutParent.matches(".phases") ? 4 : 2;
          const before = { display: getComputedStyle(layoutParent).display, gap: getComputedStyle(layoutParent).gap };
          Object.assign(layoutParent.style, {
            alignItems: "stretch",
            display: "grid",
            gap: attemptNumber === 1 ? "18px" : attemptNumber === 2 ? "12px" : "8px",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            height: "auto",
            maxHeight: "none",
            position: "relative"
          });
          for (const card of cards) {
            Object.assign(card.style, { height: "auto", minWidth: "0", overflow: "visible", position: "relative", inset: "auto", transform: "none" });
          }
          record("reflow-card-grid", layoutParent, "Converted overlapping card siblings to a deterministic CSS grid.", before, { columns, gap: layoutParent.style.gap });
        }
      }

      // Phase 3: expose and fit overflowing text without deleting or truncating content.
      for (const check of checks.filter((item) => ["text-overflow", "content-clipped"].includes(item.kind))) {
        const node = nodeFor(check.selector);
        if (!node) continue;
        const before = {
          fontSize: getComputedStyle(node).fontSize,
          height: getComputedStyle(node).height,
          overflow: getComputedStyle(node).overflow
        };
        Object.assign(node.style, {
          height: "auto",
          maxHeight: "none",
          maxWidth: "100%",
          minHeight: px(node.scrollHeight),
          minWidth: "0",
          overflow: "visible",
          textOverflow: "clip",
          whiteSpace: "normal",
          WebkitLineClamp: "unset"
        });
        let size = parseFloat(getComputedStyle(node).fontSize) || 16;
        const minimum = minFontSize(node);
        const slide = node.closest(slideSelector);
        while (slide && node.getBoundingClientRect().bottom > slide.getBoundingClientRect().bottom - 8 && size > minimum) {
          size = Math.max(minimum, size - 1);
          node.style.fontSize = `${size}px`;
          node.style.minHeight = px(node.scrollHeight);
        }
        const card = node.closest(".card,[data-card],[data-pptx-kind='card'],.pane,.layer,.phase");
        if (card) {
          card.style.height = "auto";
          card.style.minHeight = px(Math.max(card.scrollHeight, card.getBoundingClientRect().height));
          card.style.overflow = "visible";
        }
        record("fit-text", node, "Expanded the text box and reduced font size only as far as the minimum readability threshold.", before, {
          fontSize: getComputedStyle(node).fontSize,
          minHeight: node.style.minHeight,
          overflow: node.style.overflow
        });
      }

      // Phase 4: fit general bounds and move absolute-positioned siblings to legal space.
      for (const check of checks.filter((item) => item.kind === "slide-bounds")) {
        const node = nodeFor(check.selector);
        const slide = node?.closest(slideSelector);
        if (!node || !slide || node === slide) continue;
        const slideRect = slide.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        const before = { left: getComputedStyle(node).left, top: getComputedStyle(node).top, width: getComputedStyle(node).width };
        const style = getComputedStyle(node);
        if (rect.width > slideRect.width - 16) node.style.width = px(slideRect.width - 16);
        if (["absolute", "fixed"].includes(style.position)) {
          const left = Math.min(Math.max(8, rect.left - slideRect.left), Math.max(8, slideRect.width - rect.width - 8));
          const top = Math.min(Math.max(8, rect.top - slideRect.top), Math.max(8, slideRect.height - rect.height - 8));
          node.style.left = px(left);
          node.style.top = px(top);
          node.style.right = "auto";
          node.style.bottom = "auto";
        }
        record("fit-within-slide", node, "Moved or resized an out-of-bounds component into the slide canvas.", before, {
          left: node.style.left || before.left,
          top: node.style.top || before.top,
          width: node.style.width || before.width
        });
      }

      for (const check of overlapChecks) {
        const a = nodeFor(check.selector);
        const b = nodeFor(check.relatedSelector);
        if (!a || !b) continue;
        if (a.closest(".cards,[data-cards],.panes,.layers,.grid-2,.grid-3,.phases") || b.closest(".cards,[data-cards],.panes,.layers,.grid-2,.grid-3,.phases")) continue;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const later = ar.top <= br.top ? b : a;
        const earlier = later === b ? a : b;
        const earlierRect = earlier.getBoundingClientRect();
        const laterRect = later.getBoundingClientRect();
        const delta = Math.max(0, earlierRect.bottom - laterRect.top + 12);
        const before = { top: getComputedStyle(later).top, marginTop: getComputedStyle(later).marginTop };
        if (["absolute", "fixed"].includes(getComputedStyle(later).position)) {
          const parentRect = later.offsetParent?.getBoundingClientRect?.() ?? { top: 0 };
          later.style.top = px((laterRect.top - parentRect.top) + delta);
        } else {
          later.style.marginTop = px((parseFloat(getComputedStyle(later).marginTop) || 0) + delta);
        }
        record("separate-overlap", later, "Moved the later sibling below the component it obscured.", before, {
          top: later.style.top || before.top,
          marginTop: later.style.marginTop || before.marginTop
        });
      }

      // Deduplicate ids before connector lookup. Moved cards retain ids; cloned headings receive page suffixes.
      const seenIds = new Map();
      for (const node of document.querySelectorAll("[id],[data-pptx-id]")) {
        const values = [...new Set([node.id, node.getAttribute("data-pptx-id")].filter(Boolean))];
        for (const value of values) {
          const count = (seenIds.get(value) || 0) + 1;
          seenIds.set(value, count);
          if (count === 1) continue;
          const replacement = `${value}-${count}`;
          const slide = node.closest(slideSelector);
          if (node.id === value) node.id = replacement;
          if (node.getAttribute("data-pptx-id") === value) node.setAttribute("data-pptx-id", replacement);
          for (const connector of slide?.querySelectorAll(`[data-source-id="${value}"],[data-target-id="${value}"]`) || []) {
            if (connector.getAttribute("data-source-id") === value) connector.setAttribute("data-source-id", replacement);
            if (connector.getAttribute("data-target-id") === value) connector.setAttribute("data-target-id", replacement);
          }
          record("deduplicate-id", node, `Renamed duplicate identifier ${value} to ${replacement}.`, value, replacement);
        }
      }

      // Move whole cards to continuation slides when a normalized grid still exceeds the canvas.
      for (const slide of [...document.querySelectorAll(slideSelector)]) {
        const container = slide.querySelector(".cards,[data-cards],.panes,.layers,.grid-2,.grid-3,.phases");
        if (!container) continue;
        const cardSelector = ":scope > .card,:scope > [data-card],:scope > [data-pptx-kind='card'],:scope > .pane,:scope > .layer,:scope > .phase";
        let cards = [...container.querySelectorAll(cardSelector)];
        if (cards.length < 2) continue;
        const slideRect = slide.getBoundingClientRect();
        const overflows = () => cards.some((card) => card.getBoundingClientRect().bottom > slideRect.bottom - 12);
        if (!overflows()) continue;
        const clone = slide.cloneNode(false);
        clone.removeAttribute("id");
        const page = Number(slide.getAttribute("data-auto-page") || "1") + 1;
        clone.setAttribute("data-auto-page", String(page));
        clone.setAttribute("data-slide-id", `${slide.getAttribute("data-pptx-audit-slide-id") || "slide"}-page-${page}`);
        for (const header of [...slide.children].filter((child) => child.matches("h1,.subtitle,[data-subtitle]"))) {
          const copied = header.cloneNode(true);
          if (copied.id) copied.id = `${copied.id}-page-${page}`;
          if (copied.hasAttribute("data-pptx-id")) copied.setAttribute("data-pptx-id", `${copied.getAttribute("data-pptx-id")}-page-${page}`);
          clone.appendChild(copied);
        }
        const newContainer = container.cloneNode(false);
        clone.appendChild(newContainer);
        slide.after(clone);
        let moved = 0;
        while (cards.length > 1 && overflows()) {
          newContainer.prepend(cards.pop());
          moved += 1;
        }
        if (moved > 0) record("paginate-cards", container, `Moved ${moved} complete card(s) to a continuation slide without splitting content.`, { cards: cards.length + moved }, { cards: cards.length, moved });
      }

      // Phase 5: connectors are always repaired after component geometry stabilizes.
      for (const connector of document.querySelectorAll("[data-connector], [data-source-id][data-target-id]")) {
        const sourceId = connector.getAttribute("data-source-id");
        const targetId = connector.getAttribute("data-target-id");
        const source = sourceId ? document.querySelector(`[data-pptx-id="${CSS.escape(sourceId)}"],#${CSS.escape(sourceId)}`) : null;
        const target = targetId ? document.querySelector(`[data-pptx-id="${CSS.escape(targetId)}"],#${CSS.escape(targetId)}`) : null;
        if (!source || !target || !(connector instanceof SVGGeometryElement) || !connector.ownerSVGElement) continue;
        if (!connector.getAttribute("data-pptx-id")) connector.setAttribute("data-pptx-id", connector.id || semanticId(connector));
        connector.setAttribute("data-pptx-kind", "line");
        const svg = connector.ownerSVGElement;
        const svgRect = svg.getBoundingClientRect();
        const sourceAnchor = boundaryAnchor(source.getBoundingClientRect(), target.getBoundingClientRect());
        const targetAnchor = boundaryAnchor(target.getBoundingClientRect(), source.getBoundingClientRect());
        const start = { x: sourceAnchor.x - svgRect.left, y: sourceAnchor.y - svgRect.top };
        const end = { x: targetAnchor.x - svgRect.left, y: targetAnchor.y - svgRect.top };
        const before = connector.outerHTML;
        if (connector.tagName.toLowerCase() === "line") {
          connector.setAttribute("x1", String(start.x));
          connector.setAttribute("y1", String(start.y));
          connector.setAttribute("x2", String(end.x));
          connector.setAttribute("y2", String(end.y));
        } else if (connector.tagName.toLowerCase() === "path") {
          const d = connector.getAttribute("d") || "";
          if (/^\s*M\s*-?\d/i.test(d) && !/[CQASTZ]/i.test(d)) connector.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
        } else if (connector.tagName.toLowerCase() === "polyline") {
          connector.setAttribute("points", `${start.x},${start.y} ${end.x},${end.y}`);
        }
        ensureArrowMarker(connector);
        record("reanchor-connector", connector, `Reanchored connector from ${sourceId} to ${targetId} and oriented its end marker toward the target.`, before, connector.outerHTML);
      }

      for (const image of document.images) {
        const raw = image.getAttribute("src");
        if (!raw || /^(?:https?:|data:|\/)/i.test(raw)) continue;
        try {
          const resolved = new URL(raw, document.baseURI);
          if (resolved.protocol === "file:") image.setAttribute("src", decodeURIComponent(resolved.pathname));
        } catch { /* leave invalid source for the audit */ }
      }

      return applied;
    }, { checks: rawAudit.checks, attemptNumber: attempt });

    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const auditAfter = await auditHtmlPage(page);
    const serialized = await page.content();
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(resolve(outputPath), serialized, "utf8");
    return {
      operations,
      auditBefore: summaryFromRawAudit(rawAudit),
      auditAfter: {
        ...auditAfter,
        summary: summaryFromRawAudit(auditAfter)
      }
    };
  });
}

export async function repairHtmlLayout(inputPath, outputDir, options = {}) {
  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputDir);
  const repairedPath = join(resolvedOutput, "deck.repaired.html");
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts ?? 3)));
  await mkdir(resolvedOutput, { recursive: true });
  const source = await readFile(resolvedInput, "utf8");
  await writeFile(repairedPath, injectBaseHref(source, dirname(resolvedInput)), "utf8");

  let audit = await auditHtmlFile(repairedPath, { screenshots: false });
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts && audit.summary.criticalCount > 0; attempt += 1) {
    const before = audit.summary.criticalCount;
    const { operations, auditAfter } = await applyRepairPass(repairedPath, repairedPath, attempt);
    audit = auditAfter;
    attempts.push({
      attempt,
      criticalBefore: before,
      criticalAfter: audit.summary.criticalCount,
      operations
    });
    if (operations.length === 0) break;
  }

  const finalAudit = await auditHtmlFile(repairedPath, { outputDir: resolvedOutput, screenshots: options.screenshots !== false });
  await writeFile(join(resolvedOutput, "html-layout-report.json"), `${JSON.stringify(finalAudit, null, 2)}\n`, "utf8");
  const report = {
    version: HTML_REPAIR_REPORT_VERSION,
    source: resolvedInput,
    repairedHtml: repairedPath,
    createdAt: new Date().toISOString(),
    maxAttempts,
    attempts,
    summary: {
      status: finalAudit.summary.criticalCount === 0 ? "passed" : "blocked",
      attemptCount: attempts.length,
      criticalRemaining: finalAudit.summary.criticalCount,
      sourcePreserved: true
    }
  };
  const reportPath = join(resolvedOutput, "html-repair-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { repairedPath, reportPath, report, layoutReport: finalAudit };
}
