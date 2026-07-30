#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePresentationPackage } from "./validate-presentation-package.mjs";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;");

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PPTX_KIND = Object.freeze({
  image: "image",
  shape: "shape",
  table: "table",
  text: "text"
});

const mime = (path) => {
  const suffix = extname(path).toLowerCase();
  if (suffix === ".jpg" || suffix === ".jpeg") return "image/jpeg";
  if (suffix === ".webp") return "image/webp";
  return "image/png";
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function connectorEndpoints(object) {
  if (object.type !== "connector") return null;
  const sourceId = object.sourceId ?? object.connector?.sourceId ?? null;
  const targetId = object.targetId ?? object.connector?.targetId ?? null;
  if (sourceId === null && targetId === null) return null;
  if (
    typeof sourceId !== "string"
    || typeof targetId !== "string"
    || !STABLE_ID.test(sourceId)
    || !STABLE_ID.test(targetId)
  ) {
    fail(
      "E_HTML_CONNECTOR_ENDPOINTS",
      `connector ${object.id ?? "missing"} must provide stable sourceId and targetId together`
    );
  }
  return { sourceId, targetId };
}

function semanticKind(object) {
  if (object.type === "connector") {
    return connectorEndpoints(object) ? "line" : "shape";
  }
  const kind = PPTX_KIND[object.type];
  if (!kind) {
    fail(
      "E_HTML_COMPONENT_KIND",
      `component ${object.id ?? "missing"} has no interoperable HTML kind for type ${object.type ?? "missing"}`
    );
  }
  return kind;
}

function assertSemanticIds(slides) {
  const ids = new Set();
  const add = (id, label) => {
    if (typeof id !== "string" || !STABLE_ID.test(id)) {
      fail("E_HTML_COMPONENT_ID", `${label} must be a stable identifier`);
    }
    if (ids.has(id)) {
      fail("E_HTML_COMPONENT_ID", `${label} duplicates semantic identifier ${id}`);
    }
    ids.add(id);
  };
  for (const slide of slides) {
    add(slide.id, `slide ${slide.order ?? "unknown"} id`);
    for (const object of slide.objects) {
      add(object.id, `component on slide ${slide.id}`);
      semanticKind(object);
    }
  }
  for (const slide of slides) {
    for (const object of slide.objects) {
      const endpoints = connectorEndpoints(object);
      if (!endpoints) continue;
      for (const endpointId of [endpoints.sourceId, endpoints.targetId]) {
        if (!ids.has(endpointId) || endpointId === object.id) {
          fail(
            "E_HTML_CONNECTOR_ENDPOINTS",
            `connector ${object.id} references invalid endpoint ${endpointId}`
          );
        }
      }
    }
  }
}

const slideNotes = (slide) =>
  `Reconstructed from ${slide.sourceRef}; confidence is recorded in the component tree.`;

const visualBox = (object) =>
  object.type === "text" ? object.renderBox ?? object.pixelBox : object.pixelBox;

function containedHigherObjectIds(shape, slide) {
  const container = visualBox(shape);
  if (!container || !(container.w > 0) || !(container.h > 0)) return [];
  return slide.objects
    .filter((candidate) => candidate.id !== shape.id && Number(candidate.z) > Number(shape.z))
    .filter((candidate) => {
      const box = visualBox(candidate);
      if (!box || !(box.w > 0) || !(box.h > 0)) return false;
      const left = Math.max(container.x, box.x);
      const top = Math.max(container.y, box.y);
      const right = Math.min(container.x + container.w, box.x + box.w);
      const bottom = Math.min(container.y + container.h, box.y + box.h);
      const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
      return intersection / (box.w * box.h) >= 0.95;
    })
    .sort((left, right) => left.z - right.z || left.id.localeCompare(right.id))
    .map((candidate) => candidate.id);
}

function styleFor(object) {
  const box = visualBox(object);
  const common = `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;z-index:${object.z};`;
  if (object.type === "shape") {
    const radius = object.shape === "ellipse" ? "border-radius:50%;" : "";
    return `${common}${radius}${object.fill
      ? `background:${object.color};`
      : `border:${Math.max(1, object.borderWidthPx ?? 1)}px solid ${object.color};box-sizing:border-box;`}`;
  }
  if (object.type === "connector") {
    return `${common}background:${object.color};stroke:${object.color};stroke-width:${Math.max(1, object.widthPx ?? object.pixelBox.h ?? 1)};`;
  }
  if (object.type === "text") {
    const style = object.style ?? {};
    return `${common}font-family:${escapeHtml(style.fontFamily ?? "Arial")};font-size:${style.fontSizePt ?? 16}px;color:${style.color ?? "#172033"};font-weight:${style.bold ? 700 : 400};display:flex;align-items:center;white-space:nowrap;`;
  }
  return common;
}

function componentType(object) {
  if (object.type === "connector") {
    return connectorEndpoints(object) ? "connector" : "shape";
  }
  return ({
    shape: "shape",
    image: "image",
    text: "text",
    table: "table"
  })[object.type] ?? "unknown";
}

export async function buildHtmlPackage(analysisPath, qaPath, outputDir) {
  const analysis = JSON.parse(await readFile(resolve(analysisPath), "utf8"));
  const qa = JSON.parse(await readFile(resolve(qaPath), "utf8"));
  assertSemanticIds(analysis.slides);
  const packageRoot = dirname(resolve(analysisPath));
  const out = resolve(outputDir);
  await mkdir(join(out, "assets"), { recursive: true });
  await mkdir(join(out, "sources"), { recursive: true });
  const assetRecords = [];
  const assetMap = new Map();
  for (const slide of analysis.slides) {
    for (const object of slide.objects.filter((item) => item.type === "image")) {
      if (assetMap.has(object.asset)) continue;
      const source = resolve(packageRoot, object.asset);
      const name = `${slide.id}-${basename(source)}`;
      const target = join(out, "assets", name);
      await copyFile(source, target);
      const sourceRef = slide.sourceRef;
      const record = {
        id: `asset-${assetRecords.length + 1}`,
        path: `assets/${name}`,
        mime: mime(source),
        sha256: await digest(target),
        rights: "user-provided",
        sourceRef
      };
      assetRecords.push(record);
      assetMap.set(object.asset, record);
    }
  }
  const sources = [];
  for (const source of analysis.sources) {
    const normalized = resolve(packageRoot, source.normalizedPath);
    const name = `${source.id}.png`;
    await copyFile(normalized, join(out, "sources", name));
    sources.push({
      id: source.id,
      kind: "image",
      label: source.label,
      locator: `sources/${name}`,
      sha256: await digest(join(out, "sources", name)),
      factStatus: "provided"
    });
  }
  const slideHtml = analysis.slides.map((slide) => {
    const objects = [...slide.objects].sort((left, right) => left.z - right.z).map((object) => {
      const kind = semanticKind(object);
      const endpoints = connectorEndpoints(object);
      if (endpoints) {
        const box = visualBox(object);
        const color = object.color ?? "#667085";
        const width = Math.max(1, object.widthPx ?? 1);
        const middleY = Math.max(width / 2, box.h / 2);
        return `<svg class="object connector" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;z-index:${object.z};overflow:visible" viewBox="0 0 ${box.w} ${box.h}"><line data-component-id="${escapeHtml(object.id)}" data-pptx-id="${escapeHtml(object.id)}" data-pptx-kind="line" data-connector="true" data-source-id="${escapeHtml(endpoints.sourceId)}" data-target-id="${escapeHtml(endpoints.targetId)}" x1="0" y1="${middleY}" x2="${box.w}" y2="${middleY}" stroke="${escapeHtml(color)}" stroke-width="${width}" fill="none"></line></svg>`;
      }
      const containedIds = object.type === "shape" ? containedHigherObjectIds(object, slide) : [];
      const attrs = [
        `class="object ${object.type === "connector" && !endpoints ? "divider" : object.type}"`,
        `data-component-id="${escapeHtml(object.id)}"`,
        `data-pptx-id="${escapeHtml(object.id)}"`,
        `data-pptx-kind="${kind}"`,
        ...(containedIds.length > 0 ? [
          "data-layout-role=\"background\"",
          `data-allow-overlap-with="${containedIds.map(escapeHtml).join(" ")}"`
        ] : []),
        `style="${styleFor(object)}"`
      ].join(" ");
      if (object.type === "text") return `<div ${attrs}>${escapeHtml(object.text)}</div>`;
      if (object.type === "image") {
        const record = assetMap.get(object.asset);
        return `<img ${attrs} src="${escapeHtml(record.path)}" alt="Bounded source region: ${escapeHtml(object.reason)}">`;
      }
      return `<div ${attrs}></div>`;
    }).join("\n");
    const active = slide.order === 1 ? " active" : "";
    return `<section class="slide pptx-slide${active}" id="${escapeHtml(slide.id)}" data-slide="true" data-slide-id="${escapeHtml(slide.id)}" data-title="${escapeHtml(slide.title)}" data-notes="${escapeHtml(slideNotes(slide))}" aria-label="${escapeHtml(slide.title)}" style="background:${slide.background}">${objects}</section>`;
  }).join("\n");
  const width = analysis.deck.size.widthPx;
  const height = analysis.deck.size.heightPx;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(analysis.deck.title)}</title>
<style>
:root{--slide-width:${width}px;--slide-height:${height}px}
*{box-sizing:border-box}html,body{margin:0;background:#111827;color:#111}
body{min-height:100vh;display:grid;place-items:center;font-family:Arial,sans-serif}
.deck{width:var(--slide-width);height:var(--slide-height);overflow:hidden;position:relative}
.slide{position:absolute;inset:0;width:var(--slide-width);height:var(--slide-height);overflow:hidden;display:none}
.slide.active{display:block}.object{position:absolute;margin:0;padding:0}.connector{transform-origin:left center}
.hud{position:fixed;right:1rem;bottom:1rem;color:white;background:#0009;padding:.35rem .6rem;border-radius:.4rem;font:14px Arial}
@media(max-width:${width}px){.deck{transform:scale(calc(100vw / ${width}));transform-origin:center center}}
@media print{body{display:block;background:white}.deck{width:auto;height:auto}.slide{display:block!important;position:relative;page-break-after:always}.hud{display:none}}
</style>
</head>
<body><main class="deck pptx-deck" data-pptx-deck="true" data-deck-title="${escapeHtml(analysis.deck.title)}">${slideHtml}</main><div class="hud" aria-live="polite"></div>
<script>
const slides=[...document.querySelectorAll('.slide')],hud=document.querySelector('.hud');let index=0;
function show(next){index=Math.max(0,Math.min(slides.length-1,next));slides.forEach((s,i)=>s.classList.toggle('active',i===index));hud.textContent=(index+1)+' / '+slides.length}
addEventListener('keydown',event=>{if(['ArrowRight','PageDown',' '].includes(event.key))show(index+1);if(['ArrowLeft','PageUp'].includes(event.key))show(index-1);if(event.key==='Home')show(0);if(event.key==='End')show(slides.length-1)});show(0);
</script></body></html>`;
  await writeFile(join(out, "index.html"), html);
  await writeFile(join(out, "deck-manifest.json"), `${JSON.stringify({
    version: "1.0.0",
    title: analysis.deck.title,
    size: analysis.deck.size,
    slides: analysis.slides
  }, null, 2)}\n`);
  await writeFile(join(out, "design-tokens.json"), `${JSON.stringify(analysis.designTokens, null, 2)}\n`);
  await writeFile(join(out, "sources.json"), `${JSON.stringify({ version: "1.0.0", sources }, null, 2)}\n`);
  await writeFile(join(out, "qa-report.json"), `${JSON.stringify(qa, null, 2)}\n`);
  const protocol = {
    protocol: "pptx-creator.presentation-package",
    version: "1.0.0",
    kind: "image-reconstruction",
    producer: { skill: "image-to-pptx", version: "2.0.0" },
    entrypoint: "index.html",
    deck: {
      id: analysis.deck.id,
      title: analysis.deck.title,
      size: {
        width: analysis.deck.size.widthPx,
        height: analysis.deck.size.heightPx,
        unit: "px"
      },
      slides: analysis.slides.map((slide) => ({
        id: slide.id,
        order: slide.order,
        title: slide.title,
        notes: slideNotes(slide),
        sourceRefs: [slide.sourceRef],
        components: slide.objects.map((object) => ({
          id: object.id,
          type: componentType(object),
          box: { ...object.pixelBox, unit: "px" },
          z: object.z,
          editableIntent: object.type !== "image",
          sourceRefs: [slide.sourceRef],
          confidence: Number(object.confidence ?? 1)
        }))
      }))
    },
    designTokens: "design-tokens.json",
    assets: assetRecords,
    sources,
    validation: {
      status: qa.status === "passed" ? "passed" : "failed",
      reports: ["qa-report.json"]
    },
    degradations: analysis.degradations.map((item) => ({
      id: item.id,
      slideId: item.slideId,
      ...(item.componentId ? { componentId: item.componentId } : {}),
      reason: item.reason,
      editabilityImpact: item.editabilityImpact
    })),
    compatibility: {
      minReaderVersion: "1.0.0",
      features: ["image-reconstruction", "component-confidence", "design-tokens", "source-lineage"]
    }
  };
  const summary = validatePresentationPackage(protocol);
  await writeFile(join(out, "presentation-package.json"), `${JSON.stringify(protocol, null, 2)}\n`);
  return { outputDir: out, protocol: join(out, "presentation-package.json"), summary };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  buildHtmlPackage(process.argv[2], process.argv[3], process.argv[4]).then(
    (result) => process.stdout.write(`${JSON.stringify({ status: "ok", ...result }, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "E_HTML_PACKAGE", message: error.message })}\n`);
      process.exitCode = 1;
    }
  );
}
