import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { materializeLineBreaks } from "../render-pptx.mjs";
import { isNativeChartElement } from "./chart-renderer.mjs";
import { parsePptxObjectTree } from "./pptx-object-tree.mjs";
import { EMU_PER_INCH } from "./group-renderer.mjs";

export const STRUCTURE_FIDELITY_REPORT_VERSION = "1.0.0";
const SIDES = ["top", "right", "bottom", "left"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value) {
  return `sha256:${sha256(value)}`;
}

export function canonicalText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function canonicalManifest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalManifest).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalManifest(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digestManifest(manifest, manifestPath) {
  if (manifestPath) return prefixedSha256(await readFile(resolve(manifestPath)));
  return prefixedSha256(Buffer.from(canonicalManifest(manifest)));
}

async function digestPptx(pptxPath) {
  return prefixedSha256(await readFile(resolve(pptxPath)));
}

function xmlAttribute(block, name) {
  return block.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function slideRelationships(xml) {
  const relationships = new Map();
  for (const match of String(xml ?? "").matchAll(/<Relationship\b[^>]*\/?>/gi)) {
    const block = match[0];
    const id = xmlAttribute(block, "Id");
    const target = xmlAttribute(block, "Target");
    if (!id || !target) continue;
    relationships.set(id, { id, target, type: xmlAttribute(block, "Type") });
  }
  return relationships;
}

function chartZipPath(target) {
  const value = String(target ?? "").replaceAll("\\", "/");
  if (value.startsWith("/")) return value.slice(1);
  if (value.startsWith("../")) return `ppt/${value.replace(/^(\.\.\/)+/, "")}`;
  if (value.startsWith("ppt/")) return value;
  return `ppt/slides/${value}`;
}

function chartXmlKind(xml) {
  const value = String(xml ?? "");
  const hasArea = /<c:areaChart\b/i.test(value);
  const hasLine = /<c:lineChart\b/i.test(value);
  const hasBar = /<c:barChart\b/i.test(value);
  if (hasArea && hasLine) return "lineArea";
  if (hasLine) return "line";
  if (hasArea) return "area";
  if (hasBar) {
    const direction = value.match(/<c:barDir\b[^>]*\bval="([^"]+)"/i)?.[1] ?? "col";
    const grouping = value.match(/<c:grouping\b[^>]*\bval="([^"]+)"/i)?.[1] ?? "clustered";
    if (direction === "bar") return "horizontalBar";
    if (grouping === "stacked") return "stackedBar";
    return "groupedBar";
  }
  return null;
}

function chartXmlType(xml) {
  const value = String(xml ?? "");
  const hasArea = /<c:areaChart\b/i.test(value);
  const hasLine = /<c:lineChart\b/i.test(value);
  if (hasArea && hasLine) return "lineArea";
  if (hasLine) return "line";
  if (hasArea) return "area";
  if (/<c:barChart\b/i.test(value)) return "bar";
  return null;
}

function expectedChartXmlType(kind) {
  return ["groupedBar", "stackedBar", "horizontalBar"].includes(kind) ? "bar" : kind;
}

function chartElements(manifest) {
  return (manifest?.slides ?? []).flatMap((slide) => (slide.elements ?? [])
    .filter((element) => element?.type === "chart" && typeof element.id === "string" && isNativeChartElement(element))
    .map((element) => ({ slideId: slide.id, element })));
}

function textElements(manifest) {
  return (manifest?.slides ?? []).flatMap((slide) => (slide.elements ?? [])
    .filter((element) => element?.type === "text" && typeof element.id === "string")
    .map((element) => ({ slideId: slide.id, element })));
}

function shapeElements(manifest) {
  return (manifest?.slides ?? []).flatMap((slide) => (slide.elements ?? [])
    .filter((element) => element?.type === "shape" && typeof element.id === "string")
    .map((element) => ({ slideId: slide.id, element })));
}

function keyHeading(element) {
  const role = String(element?.role ?? "").toLowerCase();
  const tag = String(element?.tagName ?? "").toLowerCase();
  const size = Number(element?.style?.fontSize ?? 0);
  return ["h1", "h2"].includes(tag)
    || role === "title"
    || Number.isInteger(element?.maxLines)
    || size >= 28
    || Array.isArray(element?.renderedLines);
}

function expectedText(element) {
  return canonicalText(materializeLineBreaks(element?.text ?? "", element));
}

function lineLeadingSpaces(lines) {
  return lines.map((line) => (String(line).match(/^[ \t]*/) ?? [""])[0].length);
}

function sourceCoordinateLineBreakOffsets(lines, sourceText) {
  const source = canonicalText(sourceText);
  const offsets = [];
  let sourceCursor = 0;
  for (let index = 0; index < Math.max(0, lines.length - 1); index += 1) {
    const line = String(lines[index] ?? "");
    const directStart = source.indexOf(line, sourceCursor);
    let sourceEnd = directStart >= 0 ? directStart + line.length : sourceCursor;
    if (directStart < 0) {
      let cursor = sourceCursor;
      for (const character of line) {
        if (/\s/.test(character)) {
          while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
          continue;
        }
        const match = source.indexOf(character, cursor);
        if (match < 0) break;
        cursor = match + 1;
      }
      sourceEnd = cursor;
    }
    offsets.push(sourceEnd);
    sourceCursor = sourceEnd;
    while (sourceCursor < source.length && /\s/.test(source[sourceCursor])) sourceCursor += 1;
  }
  return offsets;
}

function expectedBorderSides(element) {
  if (Array.isArray(element?.borderSides)) {
    return [...new Set(element.borderSides.map((side) => String(side?.side ?? side).toLowerCase()))]
      .filter((side) => SIDES.includes(side));
  }
  const style = element?.style ?? {};
  const hasExplicitSideProperties = SIDES.some((side) => {
    const cap = `${side[0].toUpperCase()}${side.slice(1)}`;
    return ["Width", "Style", "Color", "Transparency"].some((suffix) => Object.prototype.hasOwnProperty.call(style, `border${cap}${suffix}`));
  });
  const sides = [];
  for (const side of SIDES) {
    const cap = `${side[0].toUpperCase()}${side.slice(1)}`;
    const width = Number(style[`border${cap}Width`] ?? (hasExplicitSideProperties ? 0 : style.borderWidth));
    const borderStyle = String(style[`border${cap}Style`] ?? (hasExplicitSideProperties ? "solid" : (style.borderStyle ?? "solid"))).toLowerCase();
    if (width > 0 && !["none", "hidden"].includes(borderStyle)) sides.push(side);
  }
  return sides;
}

function actualBorderSides(element, byName, object) {
  const independent = SIDES.filter((side) => byName.has(`${element.id}-${side}-border`));
  if (object?.lineVisible) return [...SIDES];
  return independent;
}

function expectedShapeName(shape) {
  const value = String(shape ?? "rect");
  return value === "roundRect" || value === "pill" ? "roundRect" : value === "circle" ? "ellipse" : value;
}

function expectedAdjustment(element) {
  if (!["roundRect", "pill"].includes(element?.shape)) return null;
  const style = element?.style ?? {};
  const radiusPx = Number(style.borderRadius ?? style.borderRadiusY ?? style.radius ?? style.rounded);
  const shortSidePx = Math.min(Number(element.w), Number(element.h)) * 96;
  if (!(radiusPx >= 0 && shortSidePx > 0)) return null;
  return Math.round(Math.max(0, Math.min(50000, radiusPx / shortSidePx * 100000)));
}

function finding(slideId, elementId, kind, message, details = {}) {
  return { slideId, elementId, kind, severity: "critical", message, ...details };
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
  const offX = line && w < 0 ? x + w : x;
  const offY = line && h < 0 ? y + h : y;
  return {
    off: { x: Math.round(offX * EMU_PER_INCH), y: Math.round(offY * EMU_PER_INCH) },
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

function transformPassed(expected, actual) {
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

function auditGroups(slide, tree) {
  const expected = expectedGroups(slide);
  const actual = tree.topLevel.filter((object) => object.isGroup);
  const byName = new Map(tree.flat.filter((object) => object.name).map((object) => [object.name, object]));
  const actualByName = new Map(actual.filter((object) => object.name).map((object) => [object.name, object]));
  const expectedByName = new Map((slide?.elements ?? []).filter((element) => element?.id).map((element) => [element.id, element]));
  const audits = [];
  const groupFindings = [];
  const nameCounts = new Map();
  for (const object of tree.flat) {
    if (object.name) nameCounts.set(object.name, (nameCounts.get(object.name) ?? 0) + 1);
  }
  const duplicateObjectNames = [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicateObjectNames.length > 0) {
    groupFindings.push(finding(slide.id, duplicateObjectNames[0], "pptx-object-name-duplicate", `PPTX contains duplicate object names: ${duplicateObjectNames.join(", ")}.`, { duplicateObjectNames }));
  }
  const actualExpectedNames = new Set();
  for (const group of expected) {
    const object = actualByName.get(group.id) ?? byName.get(group.id);
    actualExpectedNames.add(group.id);
    const actualChildren = object?.children?.map((child) => child.name).filter(Boolean) ?? [];
    const expectedChildren = Array.isArray(group.children) ? [...group.children] : [];
    const childOrderPassed = Boolean(object?.isGroup)
      && object.parentGroupId === null
      && actualChildren.join("\u0000") === expectedChildren.join("\u0000");
    const expectedTransform = expectedGroupTransform(group);
    const actualTransform = object?.transform ?? null;
    const groupTransformPassed = Boolean(object?.isGroup) && transformPassed(expectedTransform, actualTransform);
    const ungroupedChildIds = expectedChildren.filter((childId) => {
      const child = byName.get(childId);
      return !child || child.parentGroupId !== group.id;
    });
    const unexpectedChildIds = actualChildren.filter((childId) => !expectedChildren.includes(childId));
    const childTransformMismatches = expectedChildren.flatMap((childId) => {
      const expectedElement = expectedByName.get(childId);
      const actualElement = byName.get(childId);
      if (!expectedElement || !actualElement) return [{ childId, expected: expectedElement ? expectedChildTransform(expectedElement) : null, actual: actualElement?.transform ?? null }];
      const expectedTransform = expectedChildTransform(expectedElement);
      const actualTransform = { ...actualElement.transform, flipH: actualElement.flipH, flipV: actualElement.flipV };
      return childTransformPassed(expectedTransform, actualTransform) ? [] : [{ childId, expected: expectedTransform, actual: actualTransform }];
    });
    const passed = childOrderPassed && groupTransformPassed && ungroupedChildIds.length === 0 && unexpectedChildIds.length === 0 && childTransformMismatches.length === 0;
    const audit = {
      slideId: slide.id,
      elementId: group.id,
      expectedChildren,
      actualChildren,
      expectedTransform,
      actualTransform,
      childOrderPassed,
      groupTransformPassed,
      ungroupedChildIds,
      unexpectedChildIds,
      childTransformMismatches,
      role: group.role ?? null,
      backgroundKind: group.backgroundKind ?? null,
      passed
    };
    audits.push(audit);
    if (!childOrderPassed || unexpectedChildIds.length > 0) {
      groupFindings.push(finding(slide.id, group.id, "group-child-order", `Group child order or membership mismatch for ${group.id}.`, audit));
    }
    if (!groupTransformPassed) {
      groupFindings.push(finding(slide.id, group.id, "group-transform", `Group transform mismatch for ${group.id}.`, audit));
    }
    if (ungroupedChildIds.length > 0) {
      groupFindings.push(finding(slide.id, group.id, "group-ungrouped-child", `Group children are missing from the declared top-level group for ${group.id}.`, audit));
    }
    if (childTransformMismatches.length > 0) {
      groupFindings.push(finding(slide.id, group.id, "group-child-transform", `Group child transform mismatch for ${group.id}.`, audit));
    }
  }
  const unexpectedGroups = actual.filter((object) => object.name && !actualExpectedNames.has(object.name)).map((object) => object.name);
  if (unexpectedGroups.length > 0) {
    groupFindings.push(finding(slide.id, unexpectedGroups[0], "group-unexpected", `PPTX contains undeclared top-level groups: ${unexpectedGroups.join(", ")}.`, { unexpectedGroups }));
  }
  if (actual.length !== expected.length) {
    groupFindings.push(finding(slide.id, expected[0]?.id ?? actual[0]?.name ?? "__slide__", "group-count", `Group count mismatch on ${slide.id}.`, {
      expectedGroupCount: expected.length,
      actualGroupCount: actual.length
    }));
  }
  const expectedGridCount = expected.filter((group) => group.backgroundKind === "grid" && String(group.role ?? "").toLowerCase() === "background").length;
  const actualGridCount = actual.filter((object) => expected.some((group) => group.id === object.name && group.backgroundKind === "grid" && String(group.role ?? "").toLowerCase() === "background")).length;
  if (expectedGridCount > 1 || actualGridCount > 1 || (expectedGridCount > 0 && actualGridCount !== expectedGridCount)) {
    groupFindings.push(finding(slide.id, expected.find((group) => group.backgroundKind === "grid")?.id ?? "__slide__", "group-background", `Explicit grid background must remain one top-level group on ${slide.id}.`, {
      expectedGridCount,
      actualGridCount
    }));
  }
  return {
    audits,
    findings: groupFindings,
    expectedGroupCount: expected.length,
    actualGroupCount: actual.length,
    expectedGridCount,
    actualGridCount
  };
}

export async function auditStructureFidelity({ manifest, manifestPath, pptxPath }) {
  const zip = await JSZip.loadAsync(await readFile(resolve(pptxPath)));
  const manifestHash = await digestManifest(manifest, manifestPath);
  const pptxHash = await digestPptx(pptxPath);
  const textAudits = [];
  const headingAudits = [];
  const codeAudits = [];
  const shapeAudits = [];
  const borderAudits = [];
  const chartAudits = [];
  const chartSlideAudits = [];
  const groupAudits = [];
  const groupSlideAudits = [];
  const findings = [];
  const objectsBySlide = new Map();
  const objectTreesBySlide = new Map();
  const relationshipsBySlide = new Map();
  for (const [slideIndex, slide] of (manifest?.slides ?? []).entries()) {
    const xml = await zip.file(`ppt/slides/slide${slideIndex + 1}.xml`)?.async("string") ?? "";
    const relsXml = await zip.file(`ppt/slides/_rels/slide${slideIndex + 1}.xml.rels`)?.async("string") ?? "";
    const tree = parsePptxObjectTree(xml);
    objectTreesBySlide.set(slide.id, tree);
    objectsBySlide.set(slide.id, new Map(tree.flat.filter((object) => object.name).map((object) => [object.name, object])));
    relationshipsBySlide.set(slide.id, slideRelationships(relsXml));
  }

  for (const slide of manifest?.slides ?? []) {
    const tree = objectTreesBySlide.get(slide.id) ?? { topLevel: [], flat: [] };
    const groupReport = auditGroups(slide, tree);
    groupAudits.push(...groupReport.audits);
    groupSlideAudits.push({ slideId: slide.id, ...groupReport, passed: groupReport.findings.length === 0 });
    findings.push(...groupReport.findings);
  }

  for (const { slideId, element } of textElements(manifest)) {
    const object = objectsBySlide.get(slideId)?.get(element.id);
    const expected = expectedText(element);
    const actual = canonicalText(object?.text ?? "");
    const expectedHash = prefixedSha256(Buffer.from(expected));
    const actualHash = prefixedSha256(Buffer.from(actual));
    const passed = Boolean(object) && expectedHash === actualHash;
    textAudits.push({ slideId, elementId: element.id, expectedSha256: expectedHash, actualSha256: actualHash, passed });
    if (!passed) findings.push(finding(slideId, element.id, "text-canonical-sha256", `Text canonical SHA-256 mismatch for ${element.id}.`, { expectedSha256: expectedHash, actualSha256: actualHash }));

    const expectedLines = Array.isArray(element.renderedLines) ? element.renderedLines.map(canonicalText) : expected.split("\n");
    const actualLines = actual.split("\n");
    if (element?.style?.preserveWhitespace || ["pre", "pre-wrap", "break-spaces"].includes(String(element?.style?.whiteSpace ?? "").toLowerCase())) {
      const expectedLeading = lineLeadingSpaces(expectedLines);
      const actualLeading = lineLeadingSpaces(actualLines);
      const codePassed = expectedLines.length === actualLines.length && expectedLeading.join(",") === actualLeading.join(",");
      const audit = { slideId, elementId: element.id, expectedLineCount: expectedLines.length, actualLineCount: actualLines.length, expectedLeadingSpaces: expectedLeading, actualLeadingSpaces: actualLeading, passed: codePassed };
      codeAudits.push(audit);
      if (!codePassed) findings.push(finding(slideId, element.id, "code-whitespace", `Code line count or leading spaces changed for ${element.id}.`, audit));
    }
    if (keyHeading(element)) {
      const expectedBreaks = Array.isArray(element.lineBreakOffsets) ? element.lineBreakOffsets : [];
      const actualBreaks = sourceCoordinateLineBreakOffsets(actualLines, element.text ?? "");
      const headingPassed = expectedLines.length === actualLines.length
        && (expectedBreaks.length === 0 || expectedBreaks.join(",") === actualBreaks.join(","));
      const audit = { slideId, elementId: element.id, expectedLines, actualLines, expectedLineBreakOffsets: expectedBreaks, actualLineBreakOffsets: actualBreaks, passed: headingPassed };
      headingAudits.push(audit);
      if (!headingPassed) findings.push(finding(slideId, element.id, "heading-lines", `Key heading line structure changed for ${element.id}.`, audit));
    }
  }

  for (const { slideId, element } of shapeElements(manifest)) {
    const objects = objectsBySlide.get(slideId) ?? new Map();
    const object = objects.get(element.id);
    const expected = expectedShapeName(element.shape);
    const actual = object?.shape ?? null;
    const expectedAdj = expectedAdjustment(element);
    const actualAdj = object?.adjustment ?? null;
    const shapePassed = Boolean(object) && expected === actual && (expectedAdj === null || expectedAdj === actualAdj);
    const shapeAudit = { slideId, elementId: element.id, expectedShape: expected, actualShape: actual, expectedRoundRectAdjustment: expectedAdj, actualRoundRectAdjustment: actualAdj, passed: shapePassed, shapeFidelity: element.shapeFidelity ?? null };
    shapeAudits.push(shapeAudit);
    if (!shapePassed) findings.push(finding(slideId, element.id, "shape-geometry", `Shape geometry mismatch for ${element.id}.`, shapeAudit));
    if (element.shapeFidelity?.status === "unsupported") {
      findings.push(finding(slideId, element.id, "shape-fidelity-unsupported", `Unsupported corner geometry for ${element.id}: ${element.shapeFidelity.reason}.`, { shapeFidelity: element.shapeFidelity }));
    }

    const expectedSides = expectedBorderSides(element);
    const independentSides = SIDES.filter((side) => objects.has(`${element.id}-${side}-border`));
    const baseShapeHasFullOutline = Boolean(object?.lineVisible);
    const actualSides = actualBorderSides(element, objects, object);
    const unexpectedFullOutline = expectedSides.length < SIDES.length && baseShapeHasFullOutline;
    const borderPassed = !unexpectedFullOutline
      && expectedSides.length === actualSides.length
      && expectedSides.every((side) => actualSides.includes(side));
    const borderAudit = {
      slideId,
      elementId: element.id,
      expectedBorderSides: expectedSides,
      actualBorderSides: actualSides,
      independentBorderSides: independentSides,
      baseShapeHasFullOutline,
      unexpectedFullOutline,
      passed: borderPassed
    };
    borderAudits.push(borderAudit);
    if (!borderPassed) findings.push(finding(slideId, element.id, "border-sides", `Border side structure mismatch for ${element.id}.`, borderAudit));
  }

  for (const [slideIndex, slide] of (manifest?.slides ?? []).entries()) {
    const expectedCharts = chartElements({ slides: [slide] });
    const objects = [...(objectsBySlide.get(slide.id)?.values() ?? [])];
    const actualChartObjects = objects.filter((object) => object.chartRelId);
    const expectedObjectNames = expectedCharts.map(({ element }) => element.id).sort();
    const actualObjectNames = actualChartObjects.map((object) => object.name).sort();
    const countPassed = expectedCharts.length === actualChartObjects.length;
    const slideAudit = {
      slideId: slide.id,
      slideIndex,
      expectedNativeCount: expectedCharts.length,
      actualChartCount: actualChartObjects.length,
      expectedObjectNames,
      actualObjectNames,
      passed: countPassed
    };
    chartSlideAudits.push(slideAudit);
    if (!countPassed) findings.push(finding(slide.id, null, "chart-count", `Native chart count mismatch on ${slide.id}.`, slideAudit));
  }

  for (const { slideId, element } of chartElements(manifest)) {
    const objects = objectsBySlide.get(slideId) ?? new Map();
    const object = objects.get(element.id);
    const objectList = [...objects.values()];
    const relationships = relationshipsBySlide.get(slideId) ?? new Map();
    const chartRelId = object?.chartRelId ?? null;
    const relationship = chartRelId ? relationships.get(chartRelId) : null;
    const chartTarget = relationship?.target ?? null;
    const chartPath = chartTarget ? chartZipPath(chartTarget) : null;
    const chartXml = chartPath ? await zip.file(chartPath)?.async("string") ?? null : null;
    const actualKind = chartXmlKind(chartXml);
    const actualType = chartXmlType(chartXml);
    const expectedType = expectedChartXmlType(element.kind);
    const primitiveDescendantIds = objectList
      .filter((candidate) => candidate.name?.startsWith(`${element.id}__chart__`))
      .map((candidate) => candidate.name)
      .sort();
    const relationshipTypePassed = Boolean(relationship?.type && /\/chart$/i.test(relationship.type));
    const relationshipPassed = Boolean(object?.kind === "graphicFrame" && chartRelId && relationship && relationshipTypePassed && chartXml);
    const semanticTypePassed = actualKind === element.kind;
    const typePassed = actualType === expectedType && semanticTypePassed;
    const noPrimitiveExpansion = primitiveDescendantIds.length === 0;
    const passed = relationshipPassed && typePassed && noPrimitiveExpansion;
    const chartAudit = {
      slideId,
      elementId: element.id,
      expectedNative: true,
      expectedKind: element.kind,
      expectedType,
      actualKind,
      actualType,
      objectName: object?.name ?? null,
      objectKind: object?.kind ?? null,
      chartRelId,
      chartTarget,
      chartXmlPath: chartPath,
      relationshipType: relationship?.type ?? null,
      relationshipTypePassed,
      relationshipPassed,
      semanticTypePassed,
      typePassed,
      primitiveDescendantIds,
      noPrimitiveExpansion,
      passed
    };
    chartAudits.push(chartAudit);
    if (!relationshipPassed) findings.push(finding(slideId, element.id, "chart-relationship", `Native chart relationship is missing or not a graphicFrame for ${element.id}.`, chartAudit));
    if (!typePassed) findings.push(finding(slideId, element.id, "chart-type", `Native chart semantic type mismatch for ${element.id}.`, chartAudit));
    if (!noPrimitiveExpansion) findings.push(finding(slideId, element.id, "chart-expansion", `Native chart expanded into primitive descendants for ${element.id}.`, chartAudit));
  }

  const criticalCount = findings.filter((item) => item.severity === "critical").length;
  return {
    version: STRUCTURE_FIDELITY_REPORT_VERSION,
    status: criticalCount === 0 ? "passed" : "failed",
    bindings: { manifestHash, pptxHash },
    text: textAudits,
    code: codeAudits,
    headings: headingAudits,
    shapes: shapeAudits,
    borders: borderAudits,
    charts: chartAudits,
    chartSlides: chartSlideAudits,
    groups: groupAudits,
    groupSlides: groupSlideAudits,
    findings,
    summary: {
      textCount: textAudits.length,
      codeCount: codeAudits.length,
      headingCount: headingAudits.length,
      shapeCount: shapeAudits.length,
      borderCount: borderAudits.length,
      chartCount: chartAudits.length,
      chartExpectedCount: chartSlideAudits.reduce((sum, item) => sum + item.expectedNativeCount, 0),
      chartActualCount: chartSlideAudits.reduce((sum, item) => sum + item.actualChartCount, 0),
      groupCount: groupAudits.length,
      groupExpectedCount: groupSlideAudits.reduce((sum, item) => sum + item.expectedGroupCount, 0),
      groupActualCount: groupSlideAudits.reduce((sum, item) => sum + item.actualGroupCount, 0),
      backgroundGridTopLevelObjects: groupSlideAudits.reduce((sum, item) => sum + item.actualGridCount, 0),
      criticalCount,
      warningCount: 0,
      blocked: criticalCount > 0
    }
  };
}

export async function writeStructureFidelityReport(options, outputPath) {
  const report = await auditStructureFidelity(options);
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
