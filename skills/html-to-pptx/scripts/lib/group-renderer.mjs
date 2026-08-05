import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { isNativeChartElement } from "./chart-renderer.mjs";

export const EMU_PER_INCH = 914400;

function fail(message) {
  throw new Error(`invalid group manifest: ${message}`);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function emu(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail(`${label} must be a finite non-negative number`);
  return Math.round(number * EMU_PER_INCH);
}

function validGroupGeometry(group) {
  const values = [group.x, group.y, group.w, group.h].map(Number);
  return values.every(Number.isFinite) && values[2] > 0 && values[3] > 0 && values[0] >= 0 && values[1] >= 0;
}

function groupElements(slide) {
  return (slide?.elements ?? []).filter((element) => element?.type === "group");
}

export function validateGroupManifest(manifest) {
  const groups = [];
  const members = new Map();
  for (const slide of manifest?.slides ?? []) {
    const elements = Array.isArray(slide.elements) ? slide.elements : [];
    const byId = new Map();
    for (const element of elements) {
      if (typeof element?.id !== "string") continue;
      if (byId.has(element.id)) fail(`slide ${slide.id} contains duplicate element id ${element.id}`);
      byId.set(element.id, element);
    }
    const slideGroups = groupElements(slide);
    const groupIds = new Set(slideGroups.map((group) => group.id));
    if (groupIds.size !== slideGroups.length) fail(`slide ${slide.id} contains duplicate group ids`);
    const gridGroups = slideGroups.filter((group) => group.backgroundKind === "grid" && String(group.role ?? "").toLowerCase() === "background");
    if (gridGroups.length > 1) fail(`slide ${slide.id} declares more than one grid background group`);
    for (const group of slideGroups) {
      if (!group.id || typeof group.id !== "string") fail("group requires a stable id");
      if (!Array.isArray(group.children) || group.children.length === 0) fail(`${group.id} requires non-empty children`);
      if (new Set(group.children).size !== group.children.length) fail(`${group.id} contains duplicate children`);
      if (!validGroupGeometry(group)) fail(`${group.id} has illegal geometry`);
      if (group.backgroundKind !== undefined && group.backgroundKind !== "grid") fail(`${group.id} has unsupported backgroundKind`);
      if (group.backgroundKind === "grid" && String(group.role ?? "").toLowerCase() !== "background") fail(`${group.id} grid background must use role=background`);
      for (const childId of group.children) {
        if (!byId.has(childId)) fail(`${group.id} references missing child ${childId}`);
        if (groupIds.has(childId)) fail(`${group.id} cannot contain nested group ${childId}`);
        const child = byId.get(childId);
        if (child?.type === "group") fail(`${group.id} cannot contain nested group ${childId}`);
        if (child?.type === "chart" && !isNativeChartElement(child)) {
          fail(`${group.id} cannot contain non-native expanding chart ${childId}`);
        }
        const owner = members.get(`${slide.id}\u0000${childId}`);
        if (owner && owner !== group.id) fail(`child ${childId} belongs to overlapping groups ${owner} and ${group.id}`);
        members.set(`${slide.id}\u0000${childId}`, group.id);
      }
      groups.push({ slide, group });
    }
  }
  return groups;
}

function topLevelObjects(xml) {
  const treeStart = xml.indexOf("<p:spTree");
  const openEnd = treeStart >= 0 ? xml.indexOf(">", treeStart) + 1 : -1;
  const treeEnd = treeStart >= 0 ? xml.indexOf("</p:spTree>", openEnd) : -1;
  if (treeStart < 0 || openEnd <= 0 || treeEnd < 0) fail("slide XML has no p:spTree");
  const content = xml.slice(openEnd, treeEnd);
  if (/<p:grpSp\b/i.test(content)) fail("pre-existing nested groups are not supported");
  const objects = [];
  const pattern = /<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1>/g;
  for (const match of content.matchAll(pattern)) {
    const block = match[0];
    const name = block.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1] ?? "";
    objects.push({
      name: String(name).replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
      kind: match[1],
      start: match.index,
      end: match.index + block.length,
      block
    });
  }
  return { treeStart, openEnd, treeEnd, content, objects };
}

function nextObjectId(xml) {
  let max = 1;
  for (const match of String(xml).matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)) max = Math.max(max, Number(match[1]));
  return max + 1;
}

function groupXml(group, children, objectId) {
  const x = emu(group.x, `${group.id}.x`);
  const y = emu(group.y, `${group.id}.y`);
  const w = emu(group.w, `${group.id}.w`);
  const h = emu(group.h, `${group.id}.h`);
  const name = escapeXml(group.id);
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${objectId}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${w}" cy="${h}"/></a:xfrm></p:grpSpPr>${children.join("")}</p:grpSp>`;
}

function applyGroupsToSlideXml(xml, slide, objectId) {
  const groups = groupElements(slide);
  if (groups.length === 0) return xml;
  const parsed = topLevelObjects(xml);
  const byName = new Map();
  for (const object of parsed.objects) {
    if (!object.name) continue;
    if (byName.has(object.name)) fail(`slide ${slide.id} contains duplicate objectName ${object.name}`);
    byName.set(object.name, object);
  }
  const claims = new Map();
  const plans = groups.map((group) => {
    const members = group.children.map((id) => {
      const object = byName.get(id);
      if (!object) fail(`${group.id} references missing rendered object ${id}`);
      if (claims.has(id)) fail(`child ${id} belongs to overlapping groups ${claims.get(id)} and ${group.id}`);
      claims.set(id, group.id);
      return object;
    });
    const positions = members.map((object) => parsed.objects.indexOf(object));
    const sorted = [...positions].sort((a, b) => a - b);
    if (sorted.some((position, index) => position !== sorted[0] + index)) fail(`${group.id} members are non-contiguous in PPTX paint order`);
    if (positions.some((position, index) => position !== sorted[index])) fail(`${group.id} child order differs from PPTX paint order`);
    return { group, members, first: sorted[0], last: sorted.at(-1) };
  });
  for (let i = 0; i < plans.length; i += 1) {
    for (let j = i + 1; j < plans.length; j += 1) {
      if (plans[i].first <= plans[j].last && plans[j].first <= plans[i].last) fail(`groups ${plans[i].group.id} and ${plans[j].group.id} overlap`);
    }
  }
  const planAt = new Map(plans.map((plan) => [plan.first, plan]));
  const memberIndices = new Set(plans.flatMap((plan) => plan.members.map((object) => parsed.objects.indexOf(object))));
  let nextId = objectId;
  const replacements = [];
  for (const [index, object] of parsed.objects.entries()) {
    if (planAt.has(index)) {
      const plan = planAt.get(index);
      replacements.push({ start: object.start, end: object.end, value: groupXml(plan.group, plan.members.map((member) => member.block), nextId) });
      nextId += 1;
    } else if (memberIndices.has(index)) {
      replacements.push({ start: object.start, end: object.end, value: "" });
    }
  }
  let content = parsed.content;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    content = `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`;
  }
  return `${xml.slice(0, parsed.openEnd)}${content}${xml.slice(parsed.treeEnd)}`;
}

export async function applyPptxGroups(pptxPath, manifest) {
  const groups = validateGroupManifest(manifest);
  if (groups.length === 0) return { groups: 0 };
  const zip = await JSZip.loadAsync(await readFile(resolve(pptxPath)));
  for (const [slideIndex, slide] of (manifest.slides ?? []).entries()) {
    if (groupElements(slide).length === 0) continue;
    const path = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(path);
    if (!file) fail(`slide ${slide.id} is missing ${path}`);
    const xml = await file.async("string");
    // Object IDs are scoped to each slide tree. Allocate from the concrete
    // slide XML so a later slide with a higher existing ID cannot collide with
    // its own group cNvPr IDs.
    const objectId = nextObjectId(xml);
    const updated = applyGroupsToSlideXml(xml, slide, objectId);
    zip.file(path, updated);
  }
  await writeFile(resolve(pptxPath), await zip.generateAsync({ type: "nodebuffer" }));
  return { groups: groups.length };
}
