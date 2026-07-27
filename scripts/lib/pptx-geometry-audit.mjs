import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import JSZip from "jszip";
import { preflightLayout } from "./check-layout-safety.mjs";

export const PPTX_GEOMETRY_REPORT_VERSION = "0.4.0";

const LINEAGE_TYPES = new Set(["text", "shape", "image", "cropped-asset", "line"]);
const EMU_PER_INCH = 914400;
const POST_RENDER_SAFETY_KINDS = new Set([
  "content-occlusion",
  "decoration-occlusion",
  "semantic-container-escape",
  "semantic-safe-inset",
  "text-required-bounds",
  "title-line-limit",
  "title-content-gap",
  "excessive-whitespace",
  "connector-detached",
  "connector-direction",
  "connector-marker-missing",
  "connector-obstructed",
  "connector-route-invalid"
]);
const GENERIC_OBJECT_NAME = /^(?:Shape|Text|Picture|Image|Group|Table|Chart|Diagram)\s+\d+$/i;

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !["createdAt", "generatedAt"].includes(key)).map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function canonicalJsonHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex")}`;
}

async function manifestBindingHash(manifest, manifestPath) {
  if (manifestPath) return `sha256:${createHash("sha256").update(await readFile(resolve(manifestPath))).digest("hex")}`;
  return canonicalJsonHash(manifest);
}

async function canonicalPptxHash(zip) {
  const digest = createHash("sha256");
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  for (const name of names) {
    let bytes = await zip.file(name).async("nodebuffer");
    if (name === "docProps/core.xml") {
      bytes = Buffer.from(bytes.toString("utf8").replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, "$1TIMESTAMP-NORMALIZED$2"), "utf8");
    }
    digest.update(name);
    digest.update("\u0000");
    digest.update(bytes);
    digest.update("\u0000");
  }
  return `sha256:${digest.digest("hex")}`;
}

function slideObjects(xml) {
  const objects = [];
  const pattern = /<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1>/g;
  for (const match of xml.matchAll(pattern)) {
    const block = match[0];
    const name = decodeXml(block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1] ?? "");
    const ext = block.match(/<a:ext\b[^>]*\bcx="(-?\d+)"[^>]*\bcy="(-?\d+)"/);
    const offset = block.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/);
    objects.push({
      name,
      kind: match[1],
      order: objects.length,
      x: Number(offset?.[1] ?? 0),
      y: Number(offset?.[2] ?? 0),
      cx: Number(ext?.[1] ?? 0),
      cy: Number(ext?.[2] ?? 0),
      flipH: /<a:xfrm\b[^>]*\bflipH="1"/.test(block),
      flipV: /<a:xfrm\b[^>]*\bflipV="1"/.test(block),
      beginArrow: /<a:headEnd\b[^>]*\btype="(?!none)[^"]+"/.test(block),
      endArrow: /<a:tailEnd\b[^>]*\btype="(?!none)[^"]+"/.test(block),
      viewerAutofit: /<a:(?:normAutofit|spAutoFit)\b/.test(block)
    });
  }
  return objects;
}

function expectedLineage(slide) {
  return (slide.elements ?? [])
    .filter((element) => LINEAGE_TYPES.has(element?.type) && typeof element.id === "string" && element.id.length > 0)
    .map((element) => element.id);
}

function isCriticalTitle(element) {
  const role = String(element?.role ?? "").toLowerCase();
  const id = String(element?.id ?? "").toLowerCase();
  return ["title", "headline", "slide-title"].includes(role)
    || /(^|[-_])(title|headline)([-_]|$)/.test(id);
}

function actualElementGeometry(element, object) {
  if (!object) return element;
  const x = object.x / EMU_PER_INCH;
  const y = object.y / EMU_PER_INCH;
  const w = object.cx / EMU_PER_INCH;
  const h = object.cy / EMU_PER_INCH;
  if (element.type !== "line") return { ...element, x, y, w, h };
  return {
    ...element,
    x: object.flipH ? x + w : x,
    y: object.flipV ? y + h : y,
    w: object.flipH ? -w : w,
    h: object.flipV ? -h : h
  };
}

function postRenderSafetyFindings(manifest, slide, objectsByName, options = {}) {
  const elements = (slide.elements ?? [])
    .filter((element) => LINEAGE_TYPES.has(element?.type) && objectsByName.has(element.id))
    .map((element) => actualElementGeometry(element, objectsByName.get(element.id)));
  if (elements.length === 0) return [];
  const actualManifest = {
    ...manifest,
    slides: [{ ...slide, elements }]
  };
  const sourcePreservingReplica = ["image", "pdf"].includes(String(manifest?.metadata?.inputType ?? "").toLowerCase());
  return preflightLayout(actualManifest, { strict: true, mode: sourcePreservingReplica ? "replica" : "creative" }).checks
    .filter((check) => check.severity === "critical"
      && POST_RENDER_SAFETY_KINDS.has(check.type)
      && !(options.allowCompositionViolation === true && check.type === "excessive-whitespace"))
    .map((check) => ({
      slideId: slide.id,
      elementId: check.target ?? "__slide__",
      kind: check.type,
      severity: "critical",
      message: `Final PPTX geometry: ${check.message}`
    }));
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.slideId}\u0000${finding.elementId}\u0000${finding.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineFindings(slide, objectsByName) {
  const findings = [];
  for (const line of (slide.elements ?? []).filter((element) => element?.type === "line")) {
    const object = objectsByName.get(line.id);
    if (!object) continue;
    const style = line.style ?? {};
    if (line.connector && !object.endArrow) {
      findings.push({
        slideId: slide.id,
        elementId: line.id,
        kind: "connector-marker-missing",
        severity: "critical",
        message: `Relationship connector ${line.id} has no target-facing end marker in PPTX XML.`
      });
    }
    if (line.connector && style.beginArrowType && !style.endArrowType) {
      findings.push({
        slideId: slide.id,
        elementId: line.id,
        kind: "connector-direction",
        severity: "critical",
        message: `Relationship connector ${line.id} declares only a source-side arrow marker.`
      });
    }
    const direction = String(line.axisDirection ?? "").toLowerCase();
    const w = Number(line.w);
    const h = Number(line.h);
    const directionOk = direction === "left" ? w < 0
      : direction === "right" ? w > 0
        : direction === "up" ? h < 0
          : direction === "down" ? h > 0
            : true;
    if (line.role === "axis" && direction && !directionOk) {
      findings.push({
        slideId: slide.id,
        elementId: line.id,
        kind: "connector-direction",
        severity: "critical",
        message: `Axis ${line.id} geometry does not match axisDirection=${direction}.`
      });
    }
  }
  return findings;
}

export async function auditPptxGeometry(pptxPath, manifest, options = {}) {
  const zip = await JSZip.loadAsync(await readFile(resolve(pptxPath)));
  const findings = [];
  const slides = [];
  const manifestSlides = manifest?.slides ?? [];
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  const auditSlides = manifestSlides.length > 0
    ? manifestSlides
    : slidePaths.map((_, index) => ({ id: `slide-${String(index + 1).padStart(3, "0")}`, elements: [] }));
  for (const [slideIndex, slide] of auditSlides.entries()) {
    const path = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(path);
    if (!file) {
      findings.push({ slideId: slide.id, elementId: "__slide__", kind: "pptx-object-lineage", severity: "critical", message: `PPTX is missing ${path}.` });
      continue;
    }
    const objects = slideObjects(await file.async("string"));
    const byName = new Map(objects.filter((object) => object.name).map((object) => [object.name, object]));
    const generic = objects.filter((object) => GENERIC_OBJECT_NAME.test(object.name));
    if (generic.length > 0) {
      findings.push({
        slideId: slide.id,
        elementId: generic[0].name,
        kind: "pptx-object-lineage",
        severity: "critical",
        message: `PPTX contains generic Office object names (${generic.map((object) => object.name).join(", ")}); every rendered object must retain manifest ID lineage.`
      });
    }
    for (const object of objects.filter((item) => item.cx < 0 || item.cy < 0)) {
      findings.push({
        slideId: slide.id,
        elementId: object.name || `object-${object.order + 1}`,
        kind: "negative-line-extent",
        severity: "critical",
        message: `PPTX object ${object.name || object.order + 1} writes a negative extent (${object.cx}, ${object.cy}).`
      });
    }
    const expected = expectedLineage(slide);
    const missing = expected.filter((id) => !byName.has(id));
    const actualOrder = objects.filter((object) => expected.includes(object.name)).map((object) => object.name);
    const expectedOrder = expected.filter((id) => byName.has(id));
    if (manifestSlides.length > 0 && missing.length > 0) {
      findings.push({
        slideId: slide.id,
        elementId: missing[0],
        kind: "pptx-object-lineage",
        severity: "critical",
        message: `PPTX objects are missing manifest ids: ${missing.join(", ")}.`
      });
    }
    if (manifestSlides.length > 0 && options.requireOrder !== false && actualOrder.join("\u0000") !== expectedOrder.join("\u0000")) {
      findings.push({
        slideId: slide.id,
        elementId: expectedOrder[0] ?? "__slide__",
        kind: "pptx-object-lineage",
        severity: "critical",
        message: "PPTX object order does not match manifest order."
      });
    }
    if (manifestSlides.length > 0) {
      for (const element of (slide.elements ?? []).filter((item) => item?.type === "text" && isCriticalTitle(item) && byName.has(item.id))) {
        const object = byName.get(element.id);
        if (!object?.viewerAutofit) continue;
        findings.push({
          slideId: slide.id,
          elementId: element.id,
          kind: "viewer-dependent-autofit",
          severity: "critical",
          message: `Critical title ${element.id} relies on viewer-dependent autofit; author explicit font size and measured geometry instead.`
        });
      }
      findings.push(...lineFindings(slide, byName));
      findings.push(...postRenderSafetyFindings(manifest, slide, byName, options));
    }
    slides.push({ slideId: slide.id, expectedObjectCount: expected.length, matchedObjectCount: expected.length - missing.length, objectCount: objects.length });
  }
  if (manifestSlides.length === 0) {
    const named = slides.reduce((sum, slide) => sum + slide.objectCount, 0);
    const customNames = [];
    for (const path of slidePaths) {
      const objects = slideObjects(await zip.file(path).async("string"));
      customNames.push(...objects.map((object) => object.name).filter((name) => name && !GENERIC_OBJECT_NAME.test(name)));
    }
    if (named > 0 && customNames.length === 0) {
      findings.push({
        slideId: auditSlides[0]?.id ?? "slide-001",
        elementId: "__deck__",
        kind: "pptx-object-lineage",
        severity: "critical",
        message: "PPTX contains only generic Office object names; manifest ID lineage cannot be proven and formal-pipeline provenance is missing."
      });
    }
  }
  const uniqueFindings = dedupeFindings(findings);
  const criticalCount = uniqueFindings.filter((finding) => finding.severity === "critical").length;
  return {
    version: PPTX_GEOMETRY_REPORT_VERSION,
    pptx: relative(options.baseDir ?? dirname(resolve(pptxPath)), resolve(pptxPath)).replaceAll("\\", "/") || "final.pptx",
    bindings: { manifestHash: await manifestBindingHash(manifest, options.manifestPath), pptxHash: await canonicalPptxHash(zip) },
    slides,
    findings: uniqueFindings,
    summary: { slideCount: auditSlides.length, criticalCount, warningCount: uniqueFindings.length - criticalCount, blocked: criticalCount > 0 }
  };
}

export async function writePptxGeometryReport(pptxPath, manifest, outputPath, options = {}) {
  const report = await auditPptxGeometry(pptxPath, manifest, { ...options, baseDir: options.baseDir ?? dirname(resolve(outputPath)) });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
