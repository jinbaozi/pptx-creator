function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&#(\d+);/g, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attribute(block, name) {
  return block.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function xfrm(block, group = false) {
  const source = group
    ? block.match(/<p:grpSpPr\b[\s\S]*?<a:xfrm\b[\s\S]*?<\/a:xfrm>/i)?.[0] ?? ""
    : block;
  const read = (tag, key) => {
    const value = source.match(new RegExp(`<a:${tag}\\b[^>]*\\b${key}="(-?\\d+)"`, "i"))?.[1];
    return value === undefined ? null : Number(value);
  };
  const result = {
    off: { x: read("off", "x"), y: read("off", "y") },
    ext: { cx: read("ext", "cx"), cy: read("ext", "cy") }
  };
  if (group) {
    result.chOff = { x: read("chOff", "x"), y: read("chOff", "y") };
    result.chExt = { cx: read("chExt", "cx"), cy: read("chExt", "cy") };
  }
  return result;
}

function matchingEnd(xml, start, tag) {
  const pattern = new RegExp(`<p:${tag}\\b[^>]*>|<\\/p:${tag}>`, "gi");
  pattern.lastIndex = start;
  let depth = 0;
  for (const match of xml.matchAll(pattern)) {
    if (match[0][1] === "/") depth -= 1;
    else depth += 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

function directBlocks(xml) {
  const blocks = [];
  const pattern = /<p:(grpSp|sp|pic|graphicFrame|cxnSp)\b[^>]*>/gi;
  for (const match of String(xml).matchAll(pattern)) {
    const tag = match[1];
    const start = match.index;
    if (blocks.some((block) => start >= block.start && start < block.end)) continue;
    const end = matchingEnd(xml, start, tag);
    if (end < 0) continue;
    blocks.push({ tag, start, end, block: xml.slice(start, end) });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function childContent(block) {
  if (block.tag !== "grpSp") return "";
  const start = block.block.match(/<p:grpSpPr\b[\s\S]*?<\/p:grpSpPr>/i)?.[0];
  if (!start) return "";
  const offset = block.block.indexOf(start) + start.length;
  return block.block.slice(offset, block.block.lastIndexOf("</p:grpSp>"));
}

function parseNode(node, parentGroupId, depth, order, topLevelOrder) {
  const block = node.block;
  const isGroup = node.tag === "grpSp";
  const name = decodeXml(attribute(block, "name") ?? "");
  const object = {
    name,
    kind: isGroup ? "grpSp" : node.tag,
    block,
    order,
    topLevelOrder,
    parentGroupId: parentGroupId ?? null,
    depth,
    isGroup,
    transform: xfrm(block, isGroup),
    shape: block.match(/<a:prstGeom\b[^>]*\bprst="([^"]+)"/i)?.[1] ?? null,
    adjustment: (() => {
      const value = block.match(/<a:gd\b[^>]*\bname="adj"[^>]*\bfmla="val\s+(-?\d+)"/i)?.[1];
      return value === undefined ? null : Number(value);
    })(),
    lineWidthEmu: Number(block.match(/<a:ln\b[^>]*\bw="(\d+)"/i)?.[1] ?? 0),
    lineVisible: (() => {
      const line = block.match(/<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/i)?.[0] ?? "";
      return Boolean(line) && !line.includes("<a:noFill") && !/<a:alpha\b[^>]*\bval="0"/i.test(line);
    })(),
    text: (() => {
      const tokens = [];
      const pattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:tab\b[^>]*\s*\/>|<a:br\b[^>]*\s*\/>|<\/a:p>\s*<a:p\b[^>]*>/g;
      for (const match of block.matchAll(pattern)) tokens.push(match[1] !== undefined ? decodeXml(match[1]) : match[0].startsWith("<a:tab") ? "\t" : "\n");
      return tokens.join("");
    })(),
    chartRelId: isGroup ? null : (block.match(/<c:chart\b[^>]*\br:id="([^"]+)"/i)?.[1] ?? null),
    flipH: /<a:xfrm\b[^>]*\bflipH="1"/i.test(block),
    flipV: /<a:xfrm\b[^>]*\bflipV="1"/i.test(block),
    beginArrow: /<a:headEnd\b[^>]*\btype="(?!none)[^"]+"/i.test(block),
    endArrow: /<a:tailEnd\b[^>]*\btype="(?!none)[^"]+"/i.test(block),
    viewerAutofit: /<a:(?:normAutofit|spAutoFit)\b/i.test(block),
    children: []
  };
  if (isGroup) {
    const childNodes = directBlocks(childContent(node));
    let childOrder = order + 1;
    object.children = childNodes.map((child, index) => {
      const parsed = parseNode(child, name || null, depth + 1, childOrder + index, topLevelOrder);
      return parsed;
    });
  }
  return object;
}

export function parsePptxObjectTree(xml) {
  const slideTree = String(xml).match(/<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>/i)?.[1] ?? "";
  const nodes = directBlocks(slideTree);
  let order = 0;
  const topLevel = nodes.map((node, index) => {
    const parsed = parseNode(node, null, 0, order, index);
    order += 1 + parsed.children.length;
    return parsed;
  });
  const flat = [];
  const walk = (node) => {
    flat.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  topLevel.forEach(walk);
  return { topLevel, flat };
}
