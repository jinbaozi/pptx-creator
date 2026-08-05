import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import JSZip from "jszip";
import { preflightLayout } from "./check-layout-safety.mjs";
import { parsePptxObjectTree } from "./pptx-object-tree.mjs";
import { EMU_PER_INCH } from "./group-renderer.mjs";

export const PPTX_GEOMETRY_REPORT_VERSION = "0.4.0";

const LINEAGE_TYPES = new Set(["text", "shape", "image", "cropped-asset", "line", "group"]);
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

function expectedLineage(slide) {
  return (slide.elements ?? [])
    .filter((element) => LINEAGE_TYPES.has(element?.type) && typeof element.id === "string" && element.id.length > 0)
    .map((element) => element.id);
}

function expectedGroups(slide) {
  return (slide?.elements ?? []).filter((element) => element?.type === "group" && typeof element.id === "string");
}

function expectedGroupTransform(group) {
  const toEmu = (value) => Math.round(Number(value) * EMU_PER_INCH);
  return {
    off: { x: toEmu(group.x), y: toEmu(group.y) },
    ext: { cx: toEmu(group.w), cy: toEmu(group.h) },
    chOff: { x: toEmu(group.x), y: toEmu(group.y) },
    chExt: { cx: toEmu(group.w), cy: toEmu(group.h) }
  };
}

function expectedChildTransform(element) {
  const x = Number(element?.x);
  const y = Number(element?.y);
  const w = Number(element?.w);
  const h = Number(element?.h);
  const line = element?.type === "line";
  return {
    off: {
      x: Math.round((line && w < 0 ? x + w : x) * EMU_PER_INCH),
      y: Math.round((line && h < 0 ? y + h : y) * EMU_PER_INCH)
    },
    ext: { cx: Math.round(Math.abs(w) * EMU_PER_INCH), cy: Math.round(Math.abs(h) * EMU_PER_INCH) },
    flipH: line && w < 0,
    flipV: line && h < 0
  };
}

function childTransformPassed(expected, actual) {
  return Boolean(actual)
    && expected.off.x === actual.off?.x
    && expected.off.y === actual.off?.y
    && expected.ext.cx === actual.ext?.cx
    && expected.ext.cy === actual.ext?.cy
    && expected.flipH === Boolean(actual.flipH)
    && expected.flipV === Boolean(actual.flipV);
}

function groupTransformPassed(expected, actual) {
  if (!actual) return false;
  return [
    [expected.off?.x, actual.off?.x],
    [expected.off?.y, actual.off?.y],
    [expected.ext?.cx, actual.ext?.cx],
    [expected.ext?.cy, actual.ext?.cy],
    [expected.chOff?.x, actual.chOff?.x],
    [expected.chOff?.y, actual.chOff?.y],
    [expected.chExt?.cx, actual.chExt?.cx],
    [expected.chExt?.cy, actual.chExt?.cy]
  ].every(([left, right]) => Number.isFinite(left) && left === right);
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
  // Group wrappers are structural and their children are already represented
  // by the measured objects above. Omit the wrapper from the reconstructed
  // safety manifest so the preflight cannot treat chart/table descendants as
  // missing group members or double-count the wrapper.
  const safetyElements = elements.filter((element) => element?.type !== "group");
  const actualManifest = {
    ...manifest,
    slides: [{ ...slide, elements: safetyElements }]
  };
  const sourcePreservingReplica = ["image", "pdf"].includes(String(manifest?.metadata?.inputType ?? "").toLowerCase())
    || String(manifest?.metadata?.mode ?? "").toLowerCase() === "replica";
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
    const tree = parsePptxObjectTree(await file.async("string"));
    const objects = tree.flat.map((object) => ({
      ...object,
      x: Number(object.transform?.off?.x ?? 0),
      y: Number(object.transform?.off?.y ?? 0),
      cx: Number(object.transform?.ext?.cx ?? 0),
      cy: Number(object.transform?.ext?.cy ?? 0)
    }));
    const topLevelObjects = tree.topLevel.map((object) => ({
      ...object,
      x: Number(object.transform?.off?.x ?? 0),
      y: Number(object.transform?.off?.y ?? 0),
      cx: Number(object.transform?.ext?.cx ?? 0),
      cy: Number(object.transform?.ext?.cy ?? 0)
    }));
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
    const expectedGroupElements = expectedGroups(slide);
    const actualGroups = topLevelObjects.filter((object) => object.isGroup);
    const actualGroupsByName = new Map(actualGroups.filter((object) => object.name).map((object) => [object.name, object]));
    const actualByName = new Map(objects.filter((object) => object.name).map((object) => [object.name, object]));
    const expectedByName = new Map((slide?.elements ?? []).filter((element) => element?.id).map((element) => [element.id, element]));
    const slideChildTransformMismatches = [];
    const nameCounts = new Map();
    for (const object of objects) {
      if (object.name) nameCounts.set(object.name, (nameCounts.get(object.name) ?? 0) + 1);
    }
    const duplicateObjectNames = [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    if (duplicateObjectNames.length > 0) {
      findings.push({
        slideId: slide.id,
        elementId: duplicateObjectNames[0],
        kind: "pptx-object-name-duplicate",
        severity: "critical",
        message: `PPTX contains duplicate object names: ${duplicateObjectNames.join(", ")}.`,
        duplicateObjectNames
      });
    }
    const expectedGroupNames = new Set(expectedGroupElements.map((group) => group.id));
    for (const group of expectedGroupElements) {
      const object = actualGroupsByName.get(group.id) ?? actualByName.get(group.id);
      const expectedChildren = Array.isArray(group.children) ? [...group.children] : [];
      const actualChildren = object?.children?.map((child) => child.name).filter(Boolean) ?? [];
      const childOrderPassed = Boolean(object?.isGroup)
        && object.parentGroupId === null
        && actualChildren.join("\u0000") === expectedChildren.join("\u0000");
      const expectedTransform = expectedGroupTransform(group);
      const actualTransform = object?.transform ?? null;
      const transformPassed = Boolean(object?.isGroup) && groupTransformPassed(expectedTransform, actualTransform);
      const ungroupedChildIds = expectedChildren.filter((childId) => {
        const child = actualByName.get(childId);
        return !child || child.parentGroupId !== group.id;
      });
      const unexpectedChildIds = actualChildren.filter((childId) => !expectedChildren.includes(childId));
      const childTransformMismatches = expectedChildren.flatMap((childId) => {
        const expectedElement = expectedByName.get(childId);
        const actualElement = actualByName.get(childId);
        if (!expectedElement || !actualElement) return [{ childId, expected: expectedElement ? expectedChildTransform(expectedElement) : null, actual: actualElement?.transform ?? null }];
        const expectedTransform = expectedChildTransform(expectedElement);
        const actualTransform = { ...actualElement.transform, flipH: actualElement.flipH, flipV: actualElement.flipV };
        return childTransformPassed(expectedTransform, actualTransform) ? [] : [{ childId, expected: expectedTransform, actual: actualTransform }];
      });
      if (!childOrderPassed || unexpectedChildIds.length > 0) {
        findings.push({
          slideId: slide.id,
          elementId: group.id,
          kind: "group-child-order",
          severity: "critical",
          message: `PPTX group child order or membership mismatch for ${group.id}.`,
          expectedChildren,
          actualChildren,
          unexpectedChildIds
        });
      }
      if (!transformPassed) {
        findings.push({
          slideId: slide.id,
          elementId: group.id,
          kind: "group-transform",
          severity: "critical",
          message: `PPTX group transform mismatch for ${group.id}.`,
          expectedTransform,
          actualTransform
        });
      }
      if (ungroupedChildIds.length > 0) {
        findings.push({
          slideId: slide.id,
          elementId: group.id,
          kind: "group-ungrouped-child",
          severity: "critical",
          message: `PPTX group children are not direct children of ${group.id}.`,
          ungroupedChildIds
        });
      }
      if (childTransformMismatches.length > 0) {
        slideChildTransformMismatches.push({ groupId: group.id, mismatches: childTransformMismatches });
        findings.push({
          slideId: slide.id,
          elementId: group.id,
          kind: "group-child-transform",
          severity: "critical",
          message: `PPTX group child transform mismatch for ${group.id}.`,
          childTransformMismatches
        });
      }
    }
    const unexpectedGroups = actualGroups.filter((object) => object.name && !expectedGroupNames.has(object.name)).map((object) => object.name);
    if (unexpectedGroups.length > 0) {
      findings.push({
        slideId: slide.id,
        elementId: unexpectedGroups[0],
        kind: "group-unexpected",
        severity: "critical",
        message: `PPTX contains undeclared top-level groups: ${unexpectedGroups.join(", ")}.`,
        unexpectedGroups
      });
    }
    const expectedGridCount = expectedGroupElements.filter((group) => group.backgroundKind === "grid" && String(group.role ?? "").toLowerCase() === "background").length;
    const actualGridCount = actualGroups.filter((object) => expectedGroupElements.some((group) => group.id === object.name && group.backgroundKind === "grid" && String(group.role ?? "").toLowerCase() === "background")).length;
    if (expectedGridCount > 1 || actualGridCount > 1 || (expectedGridCount > 0 && actualGridCount !== expectedGridCount)) {
      findings.push({
        slideId: slide.id,
        elementId: expectedGroupElements.find((group) => group.backgroundKind === "grid")?.id ?? "__slide__",
        kind: "group-background",
        severity: "critical",
        message: `Explicit grid background count mismatch on ${slide.id}.`,
        expectedGridCount,
        actualGridCount
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
    slides.push({
      slideId: slide.id,
      expectedObjectCount: expected.length,
      matchedObjectCount: expected.length - missing.length,
      objectCount: objects.length,
      expectedGroupCount: expectedGroupElements.length,
      actualGroupCount: actualGroups.length,
      backgroundGridTopLevelObjects: actualGridCount,
      childTransformMismatches: slideChildTransformMismatches
    });
  }
  if (manifestSlides.length === 0) {
    const named = slides.reduce((sum, slide) => sum + slide.objectCount, 0);
    const customNames = [];
    for (const path of slidePaths) {
      const objects = parsePptxObjectTree(await zip.file(path).async("string")).flat;
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
    summary: {
      slideCount: auditSlides.length,
      criticalCount,
      warningCount: uniqueFindings.length - criticalCount,
      groupExpectedCount: slides.reduce((sum, slide) => sum + Number(slide.expectedGroupCount ?? 0), 0),
      groupActualCount: slides.reduce((sum, slide) => sum + Number(slide.actualGroupCount ?? 0), 0),
      backgroundGridTopLevelObjects: slides.reduce((sum, slide) => sum + Number(slide.backgroundGridTopLevelObjects ?? 0), 0),
      blocked: criticalCount > 0
    }
  };
}

export async function writePptxGeometryReport(pptxPath, manifest, outputPath, options = {}) {
  const report = await auditPptxGeometry(pptxPath, manifest, { ...options, baseDir: options.baseDir ?? dirname(resolve(outputPath)) });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
