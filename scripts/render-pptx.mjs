import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { parseDesignFile } from "./parse-design-md.mjs";
import { expandChartElement } from "./lib/chart-renderer.mjs";
import { expandDiagramElement } from "./lib/diagram-compiler.mjs";

const SHAPES = { rect: "rect", roundRect: "roundRect", ellipse: "ellipse" };
const IMAGE_SHAPES = new Set(["rect", "roundRect", "ellipse"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function getToken(tokens, ref) {
  if (typeof ref !== "string") return ref;
  const match = ref.match(/^\{([^}]+)\}$/);
  if (!match) return ref;
  let cursor = tokens;
  for (const part of match[1].split(".")) cursor = cursor?.[part];
  if (cursor === undefined) throw new Error(`unresolved token reference ${ref}`);
  return cursor;
}

function resolveValue(value, tokens) {
  if (typeof value === "string") return getToken(tokens, value);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, tokens));
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, tokens)]));
  }
  return value;
}

function hex(value, fallback = "#111827") {
  const resolved = value ?? fallback;
  return String(resolved).startsWith("#") ? String(resolved).slice(1) : String(resolved);
}

function localImagePath(baseDir, src) {
  if (typeof src === "string" && /^https?:\/\//i.test(src)) {
    throw new Error(`remote image URL must be downloaded before rendering: ${src}`);
  }
  return resolve(baseDir, src);
}

export function primaryFontFamily(value, fallback = "Arial", text = "") {
  const candidates = String(value ?? "")
    .match(/(?:"[^"]+"|'[^']+'|[^,])+/g)
    ?.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean) ?? [];
  const concrete = candidates.filter((entry) => !/^(?:serif|sans-serif|monospace|system-ui|cursive|fantasy)$/i.test(entry));
  if (/\p{Script=Han}/u.test(String(text))) {
    const cjk = concrete.find((entry) => /PingFang|Microsoft YaHei|Noto Sans CJK|Source Han|Hiragino|Heiti|Songti|SimHei|SimSun|WenQuanYi/i.test(entry));
    if (cjk) return cjk;
  }
  return concrete[0] ?? fallback;
}

function textOptions(element, design, language) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const typography = style.typography ?? {};
  const fontWeight = style.fontWeight ?? typography.fontWeight ?? 400;
  const options = {
    fontFace: primaryFontFamily(style.fontFamily ?? typography.fontFamily ?? design.tokens.typography.body.fontFamily, "Arial", element.text),
    fontSize: style.fontSize ?? typography.fontSize ?? design.tokens.typography.body.fontSize,
    lang: language,
    bold: Boolean(fontWeight >= 700 || style.bold),
    italic: Boolean(style.italic),
    underline: style.underline,
    strike: style.strike,
    color: hex(style.color, design.tokens.colors.text),
    align: style.align ?? "left",
    valign: style.valign ?? "top",
    charSpacing: style.charSpacing,
    lineSpacingMultiple: style.lineHeight ?? typography.lineHeight,
    transparency: style.transparency,
    shadow: shadowOptions(style.shadow),
    margin: style.margin ?? 0.05
  };
  const bullet = bulletOptions(style.bullet);
  if (bullet) options.bullet = bullet;
  return options;
}

function bulletOptions(bullet) {
  if (!bullet) return null;
  if (bullet === true) return true;
  if (typeof bullet !== "object") return null;
  if (String(bullet.type ?? "").toLowerCase() === "number") {
    return {
      type: "number",
      style: bullet.style,
      startAt: bullet.startAt,
      numberStartAt: bullet.numberStartAt,
      indent: bullet.indent
    };
  }
  const options = {};
  if (bullet.characterCode) options.characterCode = bullet.characterCode;
  if (bullet.code) options.code = bullet.code;
  if (bullet.indent) options.indent = bullet.indent;
  return Object.keys(options).length > 0 ? options : true;
}

function componentStyle(element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  if (!style || typeof style !== "object" || Array.isArray(style)) return {};
  const component = style.component && typeof style.component === "object" && !Array.isArray(style.component)
    ? resolveValue(style.component, design.tokens)
    : {};
  const { component: _component, ...overrides } = style;
  const merged = { ...component, ...overrides };
  const explicitBackgroundColor = overrides.backgroundColor ?? overrides.fill;
  const explicitBorderColor = overrides.borderColor ?? overrides.line;
  if (explicitBackgroundColor !== undefined) merged.backgroundColor = explicitBackgroundColor;
  if (explicitBorderColor !== undefined) merged.borderColor = explicitBorderColor;
  return merged;
}

function shadowOptions(shadow) {
  if (!shadow || typeof shadow !== "object") return null;
  if (!["outer", "inner", "none"].includes(shadow.type)) return null;
  const options = {
    type: shadow.type,
    color: hex(shadow.color, "000000"),
    opacity: Number(shadow.opacity ?? 0.35),
    blur: Number(shadow.blur ?? 0),
    offset: Number(shadow.offset ?? 0),
    angle: Number(shadow.angle ?? 0)
  };
  if (shadow.rotateWithShape !== undefined) options.rotateWithShape = Boolean(shadow.rotateWithShape);
  return options;
}

function applyElementRotation(options, element) {
  const rotate = Number(element.rotate);
  if (Number.isFinite(rotate) && Math.abs(rotate) > 0.01) options.rotate = rotate;
  return options;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function inchesToEmu(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 914400) : null;
}

function pointsToEmu(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 12700) : null;
}

function imageSizingOptions(element) {
  const sizing = element.sizing;
  if (!sizing || typeof sizing !== "object" || !["cover", "contain", "crop"].includes(sizing.type)) return null;
  const options = { type: sizing.type };
  for (const key of ["x", "y", "w", "h"]) {
    if (sizing[key] !== undefined) options[key] = sizing[key];
  }
  return options;
}

function imageSourceSizing(element) {
  const sizing = element.sizing;
  if (!sizing || typeof sizing !== "object") return null;
  const sourceW = Number(sizing.sourceW);
  const sourceH = Number(sizing.sourceH);
  if (!(sourceW > 0 && sourceH > 0)) return null;
  return { w: sourceW, h: sourceH };
}

function addText(slide, element, design, language) {
  const opts = applyElementRotation({
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    ...textOptions(element, design, language)
  }, element);
  if (element.id) opts.objectName = element.id;
  slide.addText(element.text ?? "", opts);
}

function addShape(slide, element, design) {
  const style = componentStyle(element, design);
  const borderWidth = Number(style.borderWidth ?? 1);
  const opts = applyElementRotation({
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    objectName: element.id,
    fill: {
      color: hex(style.backgroundColor ?? style.fill, design.tokens.colors.surface),
      transparency: Number(style.transparency ?? 0)
    },
    line: {
      color: hex(style.borderColor ?? style.line, style.backgroundColor ?? design.tokens.colors.border),
      transparency: borderWidth <= 0 ? 100 : Number(style.borderTransparency ?? 0),
      width: borderWidth <= 0 ? 0 : borderWidth,
      dashType: style.dashType
    }
  }, element);
  const shadow = shadowOptions(style.shadow);
  if (shadow) opts.shadow = shadow;
  slide.addShape(SHAPES[element.shape] ?? "rect", opts);
}

function gradientFillXml(gradient) {
  if (!gradient || !Array.isArray(gradient.stops) || gradient.stops.length < 2) return null;
  const stops = gradient.stops
    .map((stop) => {
      const color = hex(stop.color, "FFFFFF").toUpperCase();
      const position = Math.round(Math.max(0, Math.min(100, Number(stop.position ?? 0))) * 1000);
      return `<a:gs pos="${position}"><a:srgbClr val="${color}"/></a:gs>`;
    })
    .join("");
  if (gradient.type === "radial") {
    const path = gradient.shape === "circle" ? "circle" : "rect";
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:path path="${path}"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
  }
  if (gradient.type !== "linear") return null;
  const angle = Math.round((Number(gradient.angle ?? 0) || 0) * 60000);
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${angle}" scaled="0"/></a:gradFill>`;
}

async function patchGradientFills(pptxPath, gradientPatches) {
  if (!gradientPatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of gradientPatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      const gradientXml = gradientFillXml(patch.gradient);
      if (!gradientXml) continue;
      const name = xmlEscape(patch.id);
      const shapePattern = new RegExp(`(<p:sp><p:nvSpPr><p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:spPr>[\\s\\S]*?)(<a:solidFill>[\\s\\S]*?</a:solidFill>|<a:noFill/>)([\\s\\S]*?</p:spPr>)`);
      xml = xml.replace(shapePattern, `$1${gradientXml}$3`);
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function patchBackgroundGradientFills(pptxPath, backgroundPatches) {
  if (!backgroundPatches.some(Boolean)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, gradient] of backgroundPatches.entries()) {
    if (!gradient) continue;
    const gradientXml = gradientFillXml(gradient);
    if (!gradientXml) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    const backgroundXml = `<p:bg><p:bgPr>${gradientXml}</p:bgPr></p:bg>`;
    if (/<p:bg>[\s\S]*?<\/p:bg>/.test(xml)) {
      xml = xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, backgroundXml);
    } else {
      xml = xml.replace("<p:cSld", "<p:cSld").replace(/(<p:cSld[^>]*>)/, `$1${backgroundXml}`);
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function patchImageShapes(pptxPath, imageShapePatches) {
  if (!imageShapePatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of imageShapePatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      if (!IMAGE_SHAPES.has(patch.imageShape)) continue;
      const name = xmlEscape(patch.id);
      const picturePattern = new RegExp(
        `(<p:pic>[\\s\\S]*?<p:nvPicPr>[\\s\\S]*?<p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:spPr>[\\s\\S]*?<a:prstGeom prst=")(rect|roundRect|ellipse)("[\\s\\S]*?</a:prstGeom>)`
      );
      xml = xml.replace(picturePattern, `$1${patch.imageShape}$3`);
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function patchTextCaps(pptxPath, textCapPatches) {
  if (!textCapPatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of textCapPatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      if (patch.cap !== "small") continue;
      const name = xmlEscape(patch.id);
      const textShapePattern = new RegExp(
        `(<p:sp><p:nvSpPr><p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:txBody>)([\\s\\S]*?)(</p:txBody>)`
      );
      xml = xml.replace(textShapePattern, (_match, before, body, after) => {
        const patchedBody = body.replace(/<(a:(?:rPr|endParaRPr))\b(?![^>]*\bcap=)([^>]*)>/g, '<$1 cap="small"$2>');
        return `${before}${patchedBody}${after}`;
      });
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function patchTextIndents(pptxPath, textIndentPatches) {
  if (!textIndentPatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of textIndentPatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      const indent = inchesToEmu(patch.firstLineIndent);
      if (indent === null) continue;
      const name = xmlEscape(patch.id);
      const textShapePattern = new RegExp(
        `(<p:sp><p:nvSpPr><p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:txBody>)([\\s\\S]*?)(</p:txBody>)`
      );
      xml = xml.replace(textShapePattern, (_match, before, body, after) => {
        const patchedBody = body.replace(/<a:pPr\b([^>]*)>/g, (_pPr, attrs) => {
          const withoutIndent = attrs.replace(/\sindent="[^"]*"/g, "");
          return `<a:pPr${withoutIndent} indent="${indent}">`;
        });
        return `${before}${patchedBody}${after}`;
      });
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function patchTextDirections(pptxPath, textDirectionPatches) {
  if (!textDirectionPatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of textDirectionPatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      if (patch.textDirection !== "vertical") continue;
      const name = xmlEscape(patch.id);
      const textShapePattern = new RegExp(
        `(<p:sp><p:nvSpPr><p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:txBody>)([\\s\\S]*?)(</p:txBody>)`
      );
      xml = xml.replace(textShapePattern, (_match, before, body, after) => {
        const patchedBody = body.replace(/<a:bodyPr\b([^>]*)>/, (_bodyPr, attrs) => {
          const withoutVert = attrs.replace(/\svert="[^"]*"/g, "");
          return `<a:bodyPr${withoutVert} vert="vert">`;
        });
        return `${before}${patchedBody}${after}`;
      });
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function patchTextRtl(pptxPath, textRtlPatches) {
  if (!textRtlPatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of textRtlPatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      if (!patch.rtl) continue;
      const name = xmlEscape(patch.id);
      const textShapePattern = new RegExp(
        `(<p:sp><p:nvSpPr><p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:txBody>)([\\s\\S]*?)(</p:txBody>)`
      );
      xml = xml.replace(textShapePattern, (_match, before, body, after) => {
        const patchedBody = body.replace(/<a:pPr\b([^>]*)>/g, (_pPr, attrs) => {
          const withoutRtl = attrs.replace(/\srtl="[^"]*"/g, "");
          return `<a:pPr${withoutRtl} rtl="1">`;
        });
        return `${before}${patchedBody}${after}`;
      });
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

function textStrokeXml(stroke) {
  if (!stroke || typeof stroke !== "object") return null;
  const width = pointsToEmu(stroke.width);
  if (!(width > 0)) return null;
  const color = hex(stroke.color, "000000").toUpperCase();
  const transparency = Number(stroke.transparency);
  const alpha =
    Number.isFinite(transparency) && transparency > 0
      ? `<a:alpha val="${Math.round(Math.max(0, Math.min(100, 100 - transparency)) * 1000)}"/>`
      : "";
  const colorXml = alpha ? `<a:srgbClr val="${color}">${alpha}</a:srgbClr>` : `<a:srgbClr val="${color}"/>`;
  return `<a:ln w="${width}"><a:solidFill>${colorXml}</a:solidFill></a:ln>`;
}

async function patchTextStrokes(pptxPath, textStrokePatches) {
  if (!textStrokePatches.some((slide) => slide.length > 0)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patches] of textStrokePatches.entries()) {
    if (patches.length === 0) continue;
    const slidePath = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(slidePath);
    if (!file) continue;
    let xml = await file.async("string");
    for (const patch of patches) {
      const lineXml = textStrokeXml(patch.textStroke);
      if (!lineXml) continue;
      const name = xmlEscape(patch.id);
      const textShapePattern = new RegExp(
        `(<p:sp><p:nvSpPr><p:cNvPr[^>]*name="${name}"[\\s\\S]*?<p:txBody>)([\\s\\S]*?)(</p:txBody>)`
      );
      xml = xml.replace(textShapePattern, (_match, before, body, after) => {
        const patchedBody = body.replace(/<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>/g, (_rPr, attrs, inner) => {
          const cleanedInner = inner.replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, "");
          return `<a:rPr${attrs}>${lineXml}${cleanedInner}</a:rPr>`;
        });
        return `${before}${patchedBody}${after}`;
      });
    }
    zip.file(slidePath, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

export function normalizeLineGeometry(element) {
  const logicalX = Number(element.x);
  const logicalY = Number(element.y);
  const logicalW = Number(element.w);
  const logicalH = Number(element.h);
  if (![logicalX, logicalY, logicalW, logicalH].every(Number.isFinite)) {
    throw new Error(`line ${element.id ?? "unknown"} requires finite x/y/w/h geometry`);
  }
  return {
    x: logicalW < 0 ? logicalX + logicalW : logicalX,
    y: logicalH < 0 ? logicalY + logicalH : logicalY,
    w: Math.abs(logicalW),
    h: Math.abs(logicalH),
    flipH: logicalW < 0,
    flipV: logicalH < 0
  };
}

function addNormalizedLineShape(slide, options, shapeType = "line") {
  const { x, y, w, h, ...rest } = options;
  slide.addShape(shapeType, { ...rest, ...normalizeLineGeometry({ id: options.objectName, x, y, w, h }) });
}

function addLine(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const shapeType = element.connector?.route === "orthogonal" ? "bentConnector3" : "line";
  addNormalizedLineShape(slide, {
    ...(element.id ? { objectName: element.id } : {}),
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    line: {
      color: hex(style.color, design.tokens.colors.primary),
      width: style.width ?? 1.5,
      ...(style.beginArrowType ? { beginArrowType: style.beginArrowType } : {}),
      ...(style.endArrowType ? { endArrowType: style.endArrowType } : {}),
      ...(style.dash ? { dash: style.dash } : {}),
      dashType: style.dashType,
      transparency: style.transparency
    }
  }, shapeType);
}

function addTable(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const headerStyle = resolveValue(design.tokens.components?.["table-header"] ?? {}, design.tokens);
  const headerTypography = resolveValue(headerStyle.typography ?? {}, design.tokens);
  const tableRows = [];
  if (Array.isArray(element.headers) && element.headers.length > 0) {
    tableRows.push(
      element.headers.map((cell) => ({
        text: String(cell),
        options: {
          fill: { color: hex(headerStyle.backgroundColor, design.tokens.colors.surfaceAlt) },
          color: hex(headerStyle.textColor ?? headerStyle.color, design.tokens.colors.primary),
          fontFace: headerTypography.fontFamily ?? design.tokens.typography.body.fontFamily,
          fontSize: headerTypography.fontSize ?? style.fontSize ?? design.tokens.typography.body.fontSize,
          bold: Boolean((headerTypography.fontWeight ?? 400) >= 700),
          align: "center",
          valign: "middle"
        }
      }))
    );
  }
  tableRows.push(...(element.rows ?? []));
  slide.addTable(tableRows, {
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    border: { color: hex(style.borderColor, design.tokens.colors.border), pt: Number(style.borderWidth ?? 1) },
    color: hex(style.color, design.tokens.colors.text),
    fontFace: design.tokens.typography.body.fontFamily,
    fontSize: style.fontSize ?? design.tokens.typography.body.fontSize,
    fill: { color: hex(style.fill, design.tokens.colors.background) }
  });
}

function addBarChart(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const data = Array.isArray(element.data) ? element.data : [];
  if (data.length === 0) return { text: 0, shape: 0 };

  const maxValue = Math.max(...data.map((point) => Number(point.value) || 0), 1);
  const gap = Math.min(0.12, element.w / Math.max(data.length * 4, 1));
  const labelHeight = Math.min(0.32, element.h * 0.18);
  const valueHeight = Math.min(0.26, element.h * 0.14);
  const chartHeight = Math.max(0.2, element.h - labelHeight - valueHeight - 0.1);
  const barWidth = Math.max(0.08, (element.w - gap * (data.length - 1)) / data.length);
  let textCount = 0;
  let shapeCount = 0;

  data.forEach((point, index) => {
    const value = Number(point.value) || 0;
    const barHeight = Math.max(0.05, (value / maxValue) * chartHeight);
    const x = element.x + index * (barWidth + gap);
    const y = element.y + chartHeight - barHeight + valueHeight;
    const fill = hex(point.color ?? style.color, design.tokens.colors.primary);

    slide.addText(String(value), {
      x,
      y: element.y,
      w: barWidth,
      h: valueHeight,
      fontFace: design.tokens.typography.body.fontFamily,
      fontSize: Math.min(10, design.tokens.typography.caption?.fontSize ?? 10),
      color: hex(style.labelColor, design.tokens.colors.text),
      align: "center",
      margin: 0
    });
    textCount += 1;

    slide.addShape("rect", {
      x,
      y,
      w: barWidth,
      h: barHeight,
      fill: { color: fill },
      line: { color: fill, transparency: 0 }
    });
    shapeCount += 1;

    slide.addText(String(point.label), {
      x,
      y: element.y + valueHeight + chartHeight + 0.05,
      w: barWidth,
      h: labelHeight,
      fontFace: design.tokens.typography.body.fontFamily,
      fontSize: Math.min(10, design.tokens.typography.caption?.fontSize ?? 10),
      color: hex(style.labelColor, design.tokens.colors.textMuted),
      align: "center",
      margin: 0
    });
    textCount += 1;
  });

  return { text: textCount, shape: shapeCount };
}

function addLineChart(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const data = Array.isArray(element.data) ? element.data : [];
  if (data.length === 0) return { text: 0, shape: 0 };
  const maxValue = Math.max(...data.map((point) => Number(point.value) || 0), 1);
  const minValue = Math.min(...data.map((point) => Number(point.value) || 0), 0);
  const range = Math.max(1, maxValue - minValue);
  const plotHeight = Math.max(0.2, element.h - 0.36);
  const color = hex(style.color, design.tokens.colors.primary);
  const points = data.map((point, index) => ({
    ...point,
    x: element.x + (data.length === 1 ? element.w / 2 : (index / (data.length - 1)) * element.w),
    y: element.y + plotHeight - (((Number(point.value) || 0) - minValue) / range) * plotHeight
  }));
  let textCount = 0;
  let shapeCount = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    addNormalizedLineShape(slide, {
      x: current.x,
      y: current.y,
      w: next.x - current.x,
      h: next.y - current.y,
      line: { color, width: style.width ?? 2 }
    });
    shapeCount += 1;
  }
  for (const point of points) {
    slide.addShape("ellipse", {
      x: point.x - 0.06,
      y: point.y - 0.06,
      w: 0.12,
      h: 0.12,
      fill: { color },
      line: { color, transparency: 0 }
    });
    shapeCount += 1;
    slide.addText(String(point.label), {
      x: point.x - 0.35,
      y: element.y + plotHeight + 0.06,
      w: 0.7,
      h: 0.3,
      fontFace: design.tokens.typography.body.fontFamily,
      fontSize: Math.min(10, design.tokens.typography.caption?.fontSize ?? 10),
      color: hex(style.labelColor, design.tokens.colors.textMuted),
      align: "center",
      margin: 0
    });
    textCount += 1;
  }
  return { text: textCount, shape: shapeCount };
}

function addPieChart(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const data = Array.isArray(element.data) ? element.data : [];
  if (data.length === 0) return { text: 0, shape: 0 };
  const total = data.reduce((sum, point) => sum + (Number(point.value) || 0), 0) || 1;
  const palette = [
    hex(style.color, design.tokens.colors.primary),
    hex(style.secondaryColor, design.tokens.colors.accent),
    hex(style.tertiaryColor, design.tokens.colors.success),
    hex(style.quaternaryColor, design.tokens.colors.warning)
  ];
  const rowHeight = Math.max(0.16, Math.min(0.3, element.h / Math.max(data.length * 1.5, 1)));
  let textCount = 0;
  let shapeCount = 0;
  data.forEach((point, index) => {
    const share = (Number(point.value) || 0) / total;
    const y = element.y + index * (rowHeight + 0.14);
    const color = hex(point.color, palette[index % palette.length]);
    const segmentWidth = Math.max(0.06, element.w * share * 0.62);
    slide.addShape("rect", {
      x: element.x,
      y,
      w: segmentWidth,
      h: rowHeight,
      fill: { color },
      line: { color, transparency: 0 }
    });
    shapeCount += 1;
    slide.addText(`${point.label} ${Math.round(share * 100)}%`, {
      x: element.x + segmentWidth + 0.08,
      y: y - 0.02,
      w: Math.max(0.5, element.w - segmentWidth - 0.08),
      h: rowHeight + 0.08,
      fontFace: design.tokens.typography.body.fontFamily,
      fontSize: Math.min(10, design.tokens.typography.caption?.fontSize ?? 10),
      color: hex(style.labelColor, design.tokens.colors.text),
      margin: 0
    });
    textCount += 1;
  });
  return { text: textCount, shape: shapeCount };
}

function addChart(slide, element, design) {
  if (element.kind === "line") return addLineChart(slide, element, design);
  if (element.kind === "pie") return addPieChart(slide, element, design);
  return addBarChart(slide, element, design);
}

function addIcon(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const color = hex(style.color, design.tokens.colors.primary);
  const line = { color, width: style.width ?? 2 };
  const x = element.x;
  const y = element.y;
  const w = element.w;
  const h = element.h;

  if (element.name === "check") {
    addNormalizedLineShape(slide, { x: x + w * 0.15, y: y + h * 0.55, w: w * 0.25, h: h * 0.25, line });
    addNormalizedLineShape(slide, { x: x + w * 0.38, y: y + h * 0.78, w: w * 0.48, h: -h * 0.58, line });
    return { shape: 2, text: 0 };
  }
  if (element.name === "x") {
    addNormalizedLineShape(slide, { x: x + w * 0.15, y: y + h * 0.15, w: w * 0.7, h: h * 0.7, line });
    addNormalizedLineShape(slide, { x: x + w * 0.85, y: y + h * 0.15, w: -w * 0.7, h: h * 0.7, line });
    return { shape: 2, text: 0 };
  }
  if (element.name === "arrow-right") {
    addNormalizedLineShape(slide, {
      x: x + w * 0.1,
      y: y + h * 0.5,
      w: w * 0.8,
      h: 0,
      line: { ...line, endArrowType: "triangle" }
    });
    return { shape: 1, text: 0 };
  }

  slide.addShape("ellipse", {
    x,
    y,
    w,
    h,
    fill: { color: hex(style.backgroundColor, design.tokens.colors.background), transparency: 100 },
    line
  });
  slide.addText("i", {
    x,
    y: y + h * 0.05,
    w,
    h: h * 0.9,
    fontFace: design.tokens.typography.body.fontFamily,
    fontSize: Math.max(8, h * 30),
    bold: true,
    color,
    align: "center",
    valign: "mid",
    margin: 0
  });
  return { shape: 1, text: 1 };
}

function addImage(slide, element, baseDir) {
  const style = element.style ?? {};
  const sourceSizing = imageSourceSizing(element);
  const imageOpts = applyElementRotation({
    path: localImagePath(baseDir, element.src),
    x: element.x,
    y: element.y,
    w: sourceSizing?.w ?? element.w,
    h: sourceSizing?.h ?? element.h
  }, element);
  if (element.id) {
    imageOpts.objectName = element.id;
    imageOpts.altText = element.alt ?? element.altText ?? element.id;
  }
  if (element.rounding !== undefined) imageOpts.rounding = Boolean(element.rounding);
  else if (element.imageShape === "ellipse") imageOpts.rounding = true;
  if (element.transparency !== undefined) imageOpts.transparency = Number(element.transparency);
  const sizing = imageSizingOptions(element);
  if (sizing) imageOpts.sizing = sizing;
  const shadow = shadowOptions(style.shadow);
  if (shadow) imageOpts.shadow = shadow;
  slide.addImage(imageOpts);
}

function addCroppedAsset(slide, element, baseDir, manifestAssets) {
  // Resolve src: direct src wins, otherwise look up via manifest.assets[].id.
  let src = element.src;
  if (!src && element.assets && typeof element.assets === "object" && element.assets.id) {
    const resolved = resolveAssetSrc(element.assets.id, manifestAssets);
    if (resolved) src = resolved;
    else throw new Error(`cropped-asset references unknown manifest.assets id: ${element.assets.id}`);
  }
  if (!src) throw new Error("cropped-asset requires src or assets.id");
  const crop = element.crop;
  const imageOpts = applyElementRotation({
    path: localImagePath(baseDir, src),
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h
  }, element);
  if (element.id) {
    // Surface the manifest id in the slide XML so downstream tooling can correlate
    // generated objects back to their source blocks (cropped-asset provenance).
    imageOpts.objectName = element.id;
    imageOpts.altText = element.alt ?? element.altText ?? element.id;
  }
  if (crop && typeof crop === "object") {
    // pptxgenjs uses sizing with `type: "crop"` and a `w`/`h` describing the source crop box.
    imageOpts.sizing = {
      type: "crop",
      x: Number(crop.x) || 0,
      y: Number(crop.y) || 0,
      w: Number(crop.w) || 0,
      h: Number(crop.h) || 0
    };
  }
  slide.addImage(imageOpts);
}

function resolveAssetSrc(assetId, manifestAssets) {
  if (!Array.isArray(manifestAssets)) return null;
  const hit = manifestAssets.find((a) => a && a.id === assetId);
  return hit && typeof hit.src === "string" ? hit.src : null;
}

function addBackground(slide, background, manifest, design, baseDir) {
  if (background.type === "solid") {
    slide.background = { color: hex(resolveValue(background.color, design.tokens), design.tokens.colors.background) };
  } else if (background.type === "image") {
    slide.addImage({
      path: localImagePath(baseDir, background.src),
      x: 0,
      y: 0,
      w: manifest.deck.size.width,
      h: manifest.deck.size.height
    });
  } else if (background.type === "gradient") {
    const firstStop = background.gradient?.stops?.[0]?.color;
    slide.background = { color: hex(resolveValue(firstStop, design.tokens), design.tokens.colors.background) };
  }
}

function expandRenderableElements(elements) {
  return elements.flatMap((element) => {
    if (element.type === "chart") return expandChartElement(element);
    if (element.type === "diagram") return expandDiagramElement(element);
    return [element];
  });
}

function renderElement(slide, element, design, baseDir, counters, manifestAssets, language) {
  if (element.type === "text") {
    counters.text += 1;
    addText(slide, element, design, language);
  } else if (element.type === "shape") {
    counters.shape += 1;
    addShape(slide, element, design);
  } else if (element.type === "line") {
    counters.shape += 1;
    addLine(slide, element, design);
  } else if (element.type === "image") {
    counters.image += 1;
    addImage(slide, element, baseDir);
  } else if (element.type === "cropped-asset") {
    counters.croppedAsset = (counters.croppedAsset ?? 0) + 1;
    counters.image += 1;
    addCroppedAsset(slide, element, baseDir, manifestAssets);
  } else if (element.type === "table") {
    counters.table += 1;
    addTable(slide, element, design);
  } else if (element.type === "chart") {
    const added = addChart(slide, element, design);
    counters.text += added.text;
    counters.shape += added.shape;
  } else if (element.type === "icon") {
    const added = addIcon(slide, element, design);
    counters.text += added.text;
    counters.shape += added.shape;
  }
}

export function editableLevel(counters) {
  const { text, shape, image, table } = counters;
  const croppedAsset = counters.croppedAsset ?? 0;
  const effectiveImage = image + croppedAsset;
  const nativeShapes = shape + table;

  // Level 1: raster fallback — images present but no editable text
  if (effectiveImage > 0 && text === 0) return 1;

  // Level 5: fully native — no raster images, with editable text
  if (effectiveImage === 0 && text > 0) return 5;

  // Level 4: native text + shapes/tables, plus some raster assets
  if (text > 0 && effectiveImage > 0 && nativeShapes > 0) return 4;

  // Level 3: text editable, but visuals are mostly rasterized
  if (text > 0 && effectiveImage > 0) return 3;

  // Level 2: shape/table-only slides or other sparse native content without text
  return 2;
}

function aggregateCounters(countersBySlide) {
  return countersBySlide.reduce(
    (acc, item) => {
      acc.text += item.text ?? 0;
      acc.shape += item.shape ?? 0;
      acc.image += item.image ?? 0;
      acc.table += item.table ?? 0;
      acc.croppedAsset += item.croppedAsset ?? 0;
      return acc;
    },
    { text: 0, shape: 0, image: 0, table: 0, croppedAsset: 0 }
  );
}

function collectFontNames(manifest, design) {
  const fonts = new Set();
  const typography = design.tokens?.typography ?? {};
  for (const value of Object.values(typography)) {
    if (value && typeof value === "object" && value.fontFamily) {
      fonts.add(value.fontFamily);
    }
  }
  for (const slide of manifest.slides ?? []) {
    const style = slide.style ?? {};
    if (typeof style.fontFamily === "string") fonts.add(style.fontFamily);
    for (const element of slide.elements ?? []) {
      const elementStyle = element.style ?? {};
      if (typeof elementStyle.fontFamily === "string") fonts.add(elementStyle.fontFamily);
    }
  }
  return [...fonts];
}

async function main() {
  const [, , manifestArg, outputArg] = process.argv;
  if (!manifestArg || !outputArg) fail("usage: render-pptx.mjs <deck.manifest.json> <output.pptx>");
  const backendIndex = process.argv.indexOf("--backend");
  const backend = backendIndex >= 0 ? process.argv[backendIndex + 1] : "pptxgen";
  if (!["pptxgen"].includes(backend)) fail(`unsupported renderer backend: ${backend}`);
  const manifestPath = resolve(manifestArg);
  const outputPath = resolve(outputArg);
  const outputDir = dirname(outputPath);
  const baseDir = dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const design = await parseDesignFile(resolve(baseDir, manifest.designSystem.source));
  await mkdir(outputDir, { recursive: true });

  const pptx = new pptxgen();
  pptx.author = "pptx-creator";
  pptx.subject = manifest.deck.title;
  pptx.title = manifest.deck.title;
  pptx.defineLayout({ name: "CUSTOM_WIDE", width: manifest.deck.size.width, height: manifest.deck.size.height });
  pptx.layout = "CUSTOM_WIDE";

  const countersBySlide = [];
  const gradientPatches = [];
  const backgroundGradientPatches = [];
  const imageShapePatches = [];
  const textCapPatches = [];
  const textIndentPatches = [];
  const textDirectionPatches = [];
  const textRtlPatches = [];
  const textStrokePatches = [];
  for (const sourceSlide of manifest.slides) {
    const slide = pptx.addSlide();
    const counters = { text: 0, shape: 0, image: 0, table: 0 };
    addBackground(slide, sourceSlide.background, manifest, design, baseDir);
    backgroundGradientPatches.push(sourceSlide.background?.type === "gradient" ? sourceSlide.background.gradient : null);
    const renderableElements = expandRenderableElements(sourceSlide.elements ?? []);
    gradientPatches.push(
      renderableElements
        .filter((element) => element.type === "shape" && element.style?.gradient)
        .map((element) => ({ id: element.id, gradient: element.style.gradient }))
    );
    imageShapePatches.push(
      renderableElements
        .filter((element) => element.type === "image" && element.id && IMAGE_SHAPES.has(element.imageShape))
        .map((element) => ({ id: element.id, imageShape: element.imageShape }))
    );
    textCapPatches.push(
      renderableElements
        .filter((element) => element.type === "text" && element.id && element.style?.smallCaps)
        .map((element) => ({ id: element.id, cap: "small" }))
    );
    textIndentPatches.push(
      renderableElements
        .filter((element) => element.type === "text" && element.id && Number.isFinite(Number(element.style?.firstLineIndent)))
        .map((element) => ({ id: element.id, firstLineIndent: Number(element.style.firstLineIndent) }))
    );
    textDirectionPatches.push(
      renderableElements
        .filter((element) => element.type === "text" && element.id && element.style?.textDirection)
        .map((element) => ({ id: element.id, textDirection: element.style.textDirection }))
    );
    textRtlPatches.push(
      renderableElements
        .filter((element) => element.type === "text" && element.id && element.style?.rtl)
        .map((element) => ({ id: element.id, rtl: true }))
    );
    textStrokePatches.push(
      renderableElements
        .filter((element) => element.type === "text" && element.id && element.style?.textStroke)
        .map((element) => ({ id: element.id, textStroke: element.style.textStroke }))
    );
    for (const element of renderableElements) renderElement(slide, element, design, baseDir, counters, manifest.assets, manifest.deck.language);
    countersBySlide.push(counters);
  }

  await pptx.writeFile({ fileName: outputPath });
  await patchGradientFills(outputPath, gradientPatches);
  await patchBackgroundGradientFills(outputPath, backgroundGradientPatches);
  await patchImageShapes(outputPath, imageShapePatches);
  await patchTextCaps(outputPath, textCapPatches);
  await patchTextIndents(outputPath, textIndentPatches);
  await patchTextDirections(outputPath, textDirectionPatches);
  await patchTextRtl(outputPath, textRtlPatches);
  await patchTextStrokes(outputPath, textStrokePatches);
  const editabilityCounter = aggregateCounters(countersBySlide);
  const fontNames = collectFontNames(manifest, design).map((requested) => ({
    element: "design-tokens",
    requested,
    fallback: requested
  }));
  const intermediate = {
    sourceCoordinates: [],
    fontNames,
    paletteMatches: [],
    paletteUnmapped: [],
    inlineColors: [],
    editabilityCounter,
    countersBySlide,
    preview: { status: "unavailable", reason: "renderer-does-not-own-route-proof" },
    layoutPaths: {},
    inputHints: {}
  };
  console.log(
    JSON.stringify(
      { pptxPath: outputPath, slides: manifest.slides.length, design: design.name, backend, intermediate },
      null,
      2
    )
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
