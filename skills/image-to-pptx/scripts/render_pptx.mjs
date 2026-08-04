#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function colorParts(value, fallback = "000000") {
  const source = String(value ?? fallback).trim();
  const rgb = source.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+)\s*)?\)$/i);
  if (rgb) {
    const red = clamp(Math.round(Number(rgb[1])), 0, 255);
    const green = clamp(Math.round(Number(rgb[2])), 0, 255);
    const blue = clamp(Math.round(Number(rgb[3])), 0, 255);
    const alpha = rgb[4] === undefined ? 1 : clamp(Number(rgb[4]) > 1 ? Number(rgb[4]) / 100 : Number(rgb[4]), 0, 1);
    return {
      hex: [red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase(),
      transparency: Math.round((1 - alpha) * 100)
    };
  }
  let normalized = source.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(normalized)) normalized = normalized.split("").map((part) => part + part).join("");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) normalized = String(fallback).replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) normalized = "000000";
  return { hex: normalized.toUpperCase(), transparency: 0 };
}

const hex = (value, fallback = "000000") => colorParts(value, fallback).hex;

function percentage(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(number, 0, 100);
}

function resolveFont(value, fallback = "Arial", text = "") {
  const candidates = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter((entry) => entry && !/^(?:serif|sans-serif|monospace|system-ui|cursive|fantasy)$/i.test(entry));
  if (/\p{Script=Han}/u.test(String(text))) {
    const cjk = candidates.find((entry) => /PingFang|Microsoft YaHei|Noto Sans CJK|Source Han|Hiragino|Heiti|Songti|SimHei|SimSun|WenQuanYi/i.test(entry));
    if (cjk) return cjk;
  }
  return candidates[0] ?? fallback;
}

const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`${label} must be finite`), { code: "E_CONTRACT" });
  return number;
};

function inchBox(box, slide) {
  const scaleX = slide.widthIn / slide.widthPx;
  const scaleY = slide.heightIn / slide.heightPx;
  const unit = String(box?.unit ?? "px").toLowerCase();
  if (unit === "in" || unit === "inch" || unit === "inches") {
    return {
      x: finite(box.x, "box.x"),
      y: finite(box.y, "box.y"),
      w: finite(box.w, "box.w"),
      h: finite(box.h, "box.h")
    };
  }
  if (unit === "pt" || unit === "points") {
    return {
      x: finite(box.x, "box.x") / 72,
      y: finite(box.y, "box.y") / 72,
      w: finite(box.w, "box.w") / 72,
      h: finite(box.h, "box.h") / 72
    };
  }
  return {
    x: finite(box.x, "box.x") * scaleX,
    y: finite(box.y, "box.y") * scaleY,
    w: finite(box.w, "box.w") * scaleX,
    h: finite(box.h, "box.h") * scaleY
  };
}

function assertInside(box, size, id, kind = "object") {
  const tolerance = 0.01;
  const invalidSize = kind === "connector"
    ? (box.w < 0 || box.h < 0 || (box.w === 0 && box.h === 0))
    : (box.w <= 0 || box.h <= 0);
  if (box.x < -tolerance || box.y < -tolerance || invalidSize
    || box.x + box.w > size.widthIn + tolerance || box.y + box.h > size.heightIn + tolerance) {
    throw Object.assign(new Error(`${id} is outside the slide`), { code: "E_CONTRACT" });
  }
}

function fullSlideRaster(box, size) {
  const areaShare = (box.w * box.h) / (size.widthIn * size.heightIn);
  return (box.x <= size.widthIn * 0.05
      && box.y <= size.heightIn * 0.05
      && box.w >= size.widthIn * 0.90
      && box.h >= size.heightIn * 0.90)
    || areaShare >= 0.80;
}

function objectBox(object, type = object.type) {
  const candidates = type === "text"
    ? [object.renderBox, object.pixelBox, object.box]
    : [object.pixelBox, object.renderBox, object.box];
  const box = candidates.find((item) => item && typeof item === "object");
  if (!box) throw Object.assign(new Error(`${object.id ?? "object"} has no geometry`), { code: "E_CONTRACT" });
  return box;
}

function normalizeAlign(value, fallback = "left") {
  const source = String(value ?? fallback).toLowerCase();
  if (["start", "left"].includes(source)) return "left";
  if (["end", "right"].includes(source)) return "right";
  if (["center", "centre", "middle"].includes(source)) return "center";
  if (["justify", "justified"].includes(source)) return "justify";
  return fallback;
}

function normalizeVAlign(value, fallback = "middle") {
  const source = String(value ?? fallback).toLowerCase();
  if (["top", "text-top"].includes(source)) return "top";
  if (["bottom", "text-bottom"].includes(source)) return "bottom";
  return "middle";
}

function objectRotation(object, style = object.style ?? {}) {
  const values = [
    object.rotate,
    object.rotation,
    object.rotationDeg,
    style.rotate,
    style.rotation,
    style.rotationDeg,
    style.transform?.rotate,
    style.transformData?.rotate
  ];
  const value = values.map(Number).find((item) => Number.isFinite(item));
  return value === undefined ? null : value;
}

function shadowOptions(value) {
  if (!value || typeof value !== "object") return null;
  const type = String(value.type ?? "outer").toLowerCase();
  if (!["outer", "inner", "none"].includes(type)) return null;
  return {
    type,
    color: hex(value.color, "000000"),
    opacity: clamp(Number(value.opacity ?? (value.transparency !== undefined ? (100 - percentage(value.transparency)) / 100 : 0.35)), 0, 1),
    blur: clamp(Number(value.blur ?? 0), 0, 100),
    offset: clamp(Number(value.offset ?? 0), 0, 200),
    angle: Number.isFinite(Number(value.angle)) ? Number(value.angle) : 0,
    ...(value.rotateWithShape !== undefined ? { rotateWithShape: Boolean(value.rotateWithShape) } : {})
  };
}

function textStyle(object, style = {}) {
  const source = style && typeof style === "object" ? style : {};
  const fontSize = Number(source.fontSizePt ?? source.fontSize ?? object.fontSizePt ?? 12);
  const colorValue = source.color ?? object.color ?? "172033";
  const color = colorParts(colorValue, "172033");
  const transparency = source.transparency ?? object.transparency ?? color.transparency;
  const options = {
    fontFace: resolveFont(source.fontFamily ?? source.fontFace ?? object.fontFamily, "Arial", object.text),
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12,
    color: color.hex,
    ...(transparency !== undefined ? { transparency: percentage(transparency) } : {}),
    bold: Boolean(source.bold ?? object.bold),
    italic: Boolean(source.italic ?? object.italic),
    ...(source.underline !== undefined ? { underline: source.underline } : {}),
    ...(source.strike !== undefined ? { strike: source.strike } : {}),
    ...(source.charSpacingPt !== undefined || source.charSpacing !== undefined ? { charSpacing: Number(source.charSpacingPt ?? source.charSpacing) || 0 } : {}),
    align: normalizeAlign(source.align ?? object.align, "left"),
    valign: normalizeVAlign(source.valign ?? object.valign, "middle"),
    margin: source.margin ?? object.margin ?? 0,
    wrap: source.wrap !== false && object.wrap !== false,
    ...(source.fit ? { fit: source.fit } : {}),
    ...(source.lineSpacingPt !== undefined ? { lineSpacing: Number(source.lineSpacingPt) } : {}),
    ...(source.lineSpacingMultiple !== undefined ? { lineSpacingMultiple: Number(source.lineSpacingMultiple) } : {}),
    ...(source.paraSpaceAfterPt !== undefined ? { paraSpaceAfter: Number(source.paraSpaceAfterPt) } : {}),
    ...(source.paraSpaceBeforePt !== undefined ? { paraSpaceBefore: Number(source.paraSpaceBeforePt) } : {}),
    ...(source.indentLevel !== undefined ? { indentLevel: Number(source.indentLevel) } : {}),
    ...(source.rtlMode !== undefined || source.rtl !== undefined ? { rtlMode: Boolean(source.rtlMode ?? source.rtl) } : {}),
    ...(source.vert ? { vert: source.vert } : {}),
    ...(source.shadow ? { shadow: shadowOptions(source.shadow) } : {}),
    ...(source.fill ? { fill: source.fill } : {}),
    ...(source.line ? { line: source.line } : {})
  };
  const rotate = objectRotation(object, source);
  if (rotate !== null) options.rotate = rotate;
  if (source.flipH || source.transform?.flipH) options.flipH = true;
  if (source.flipV || source.transform?.flipV) options.flipV = true;
  return options;
}

function runOptions(run, object, paragraph = {}) {
  const source = run && typeof run === "object" ? run : {};
  const nested = source.style && typeof source.style === "object" ? source.style : {};
  const merged = { ...textStyle(object, { ...paragraph, ...nested, ...source }) };
  if (source.hyperlink?.url) merged.hyperlink = { url: String(source.hyperlink.url), ...(source.hyperlink.tooltip ? { tooltip: source.hyperlink.tooltip } : {}) };
  else if (source.href) merged.hyperlink = { url: String(source.href) };
  if (source.breakLine !== undefined) merged.breakLine = Boolean(source.breakLine);
  if (source.softBreakBefore !== undefined) merged.softBreakBefore = Boolean(source.softBreakBefore);
  return merged;
}

function runText(run) {
  return typeof run === "string" || typeof run === "number" ? String(run) : String(run?.text ?? "");
}

function richTextPayload(object) {
  const style = object.style ?? {};
  const paragraphs = Array.isArray(object.paragraphs)
    ? object.paragraphs
    : Array.isArray(object.paragraph)
      ? object.paragraph
      : null;
  if (paragraphs && paragraphs.length > 0) {
    const payload = [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const paragraphRuns = Array.isArray(paragraph?.runs) && paragraph.runs.length > 0
        ? paragraph.runs
        : [{ text: paragraph?.text ?? "" }];
      paragraphRuns.forEach((run, runIndex) => {
        const text = runText(run);
        if (!text && paragraphRuns.length > 1) return;
        const options = runOptions(run, object, { ...style, ...(paragraph ?? {}) });
        if (paragraph?.align !== undefined) options.align = normalizeAlign(paragraph.align);
        if (paragraph?.valign !== undefined) options.valign = normalizeVAlign(paragraph.valign);
        if (runIndex === paragraphRuns.length - 1 && paragraphIndex < paragraphs.length - 1) options.breakLine = true;
        payload.push({ text, options });
      });
    });
    return payload;
  }
  if (Array.isArray(object.runs) && object.runs.length > 0) {
    return object.runs.map((run) => ({
      text: runText(run),
      options: runOptions(run, object, style)
    })).filter((run) => run.text);
  }
  return String(object.text ?? "");
}

const SHAPE_NAMES = new Set([
  "rect", "roundRect", "ellipse", "line", "bentConnector2", "bentConnector3", "bentConnector4", "bentConnector5",
  "curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5", "triangle", "diamond", "hexagon",
  "parallelogram", "trapezoid", "rightArrow", "leftArrow", "upArrow", "downArrow", "plus", "star5", "star6",
  "cloud", "heart", "arc", "blockArc", "pie", "pieWedge", "donut", "frame", "can", "cube", "chevron"
]);

function sourceColor(object, style = {}) {
  return style.color ?? style.fillColor ?? style.backgroundColor ?? object.color ?? object.fillColor ?? "FFFFFF";
}

function shapeFill(object) {
  const style = object.style && typeof object.style === "object" ? object.style : {};
  const explicit = object.fill;
  const fillObject = explicit && typeof explicit === "object" ? explicit : {};
  const enabled = explicit === true || (explicit && typeof explicit === "object" && explicit.type !== "none")
    || object.fillColor !== undefined || style.fill !== undefined || style.backgroundColor !== undefined || object.gradient || style.gradient;
  if (!enabled || explicit === false || fillObject.type === "none") return { color: "FFFFFF", transparency: 100, type: "none" };
  const colorValue = fillObject.color ?? sourceColor(object, style);
  const color = colorParts(colorValue, "FFFFFF");
  const transparency = fillObject.transparency ?? style.transparency ?? object.transparency ?? color.transparency;
  return {
    color: color.hex,
    transparency: percentage(transparency),
    ...(fillObject.type ? { type: fillObject.type } : {})
  };
}

function shapeLine(object) {
  const style = object.style && typeof object.style === "object" ? object.style : {};
  const explicit = object.line && typeof object.line === "object" ? object.line : {};
  const widthPx = Number(explicit.widthPx ?? style.borderWidthPx ?? object.borderWidthPx);
  const widthPt = Number(explicit.width ?? explicit.pt ?? style.borderWidth ?? object.borderWidthPt);
  const borderWidth = Number.isFinite(widthPt)
    ? widthPt
    : Number.isFinite(widthPx) ? widthPx * 0.75 : (object.fill ? 0 : 0.75);
  const color = colorParts(explicit.color ?? style.borderColor ?? object.borderColor ?? object.color ?? "64748B", "64748B");
  const transparency = explicit.transparency ?? style.borderTransparency ?? color.transparency;
  return {
    color: color.hex,
    transparency: percentage(transparency),
    width: borderWidth <= 0 ? 0 : Math.max(0.1, borderWidth),
    ...(explicit.dashType || style.dashType || object.dashType || style.dash ? { dashType: explicit.dashType ?? style.dashType ?? style.dash } : {}),
    ...(explicit.beginArrowType || object.beginArrowType ? { beginArrowType: explicit.beginArrowType ?? object.beginArrowType } : {}),
    ...(explicit.endArrowType || object.endArrowType ? { endArrowType: explicit.endArrowType ?? object.endArrowType } : {})
  };
}

function shapeName(object) {
  const requested = object.shape ?? object.shapeType ?? object.kind ?? "rect";
  if (requested === "rectangle") return "rect";
  if (requested === "roundedRectangle" || requested === "rounded-rect" || requested === "rounded_rect") return "roundRect";
  if (requested === "oval") return "ellipse";
  return SHAPE_NAMES.has(requested) ? requested : "rect";
}

function roundedRectRadius(object, target) {
  const style = object.style && typeof object.style === "object" ? object.style : {};
  const raw = object.rectRadius ?? style.rectRadius ?? object.radius ?? style.radius ?? style.borderRadius;
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value;
  const short = Math.max(0.001, Math.min(target.w, target.h));
  return clamp(value / (short * 100), 0, 1);
}

function applyTransform(options, object) {
  const rotate = objectRotation(object);
  if (rotate !== null) options.rotate = rotate;
  const transform = object.transform ?? object.style?.transform ?? object.style?.transformData;
  if (transform && typeof transform === "object") {
    if (transform.flipH) options.flipH = true;
    if (transform.flipV) options.flipV = true;
    if (Number.isFinite(Number(transform.rotate)) && rotate === null) options.rotate = Number(transform.rotate);
  }
  if (object.flipH) options.flipH = true;
  if (object.flipV) options.flipV = true;
  return options;
}

function normalizeLine(target) {
  const x = Number(target.x);
  const y = Number(target.y);
  const w = Number(target.w);
  const h = Number(target.h);
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
    ...(w < 0 ? { flipH: true } : {}),
    ...(h < 0 ? { flipV: true } : {})
  };
}

function safeAssetPath(packageRoot, asset) {
  const value = String(asset ?? "");
  if (!value || /^https?:\/\//i.test(value) || /^data:/i.test(value) || isAbsolute(value) || win32.isAbsolute(value)) {
    throw Object.assign(new Error(`image asset must be a local relative path: ${value}`), { code: "E_ASSET_PATH" });
  }
  const normalized = value.replaceAll("\\", "/");
  if (posix.normalize(normalized).split("/").includes("..")) {
    throw Object.assign(new Error(`image asset traversal is not allowed: ${value}`), { code: "E_ASSET_PATH" });
  }
  const root = resolve(packageRoot);
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw Object.assign(new Error(`image asset escapes package root: ${value}`), { code: "E_ASSET_PATH" });
  return target;
}

function imageSizing(object) {
  const source = object.sizing && typeof object.sizing === "object" ? object.sizing : object.crop && typeof object.crop === "object" ? object.crop : null;
  if (!source) return null;
  const type = String(source.type ?? (object.crop ? "crop" : "cover")).toLowerCase();
  if (!["crop", "cover", "contain"].includes(type)) return null;
  const options = { type };
  for (const key of ["x", "y", "w", "h"]) if (source[key] !== undefined) options[key] = Number.isFinite(Number(source[key])) ? Number(source[key]) : source[key];
  return options;
}

function traceableChartData(object, sourceById) {
  const recoverable = object.recoverability === true
    || object.sourceData === true
    || object.recoverability?.sourceData === true
    || object.chart?.recoverability === true
    || object.chart?.sourceData === true
    || object.chart?.recoverability?.sourceData === true;
  if (!recoverable) return null;
  const sourceRef = object.sourceRef ?? object.chart?.sourceRef;
  const sourceSha256 = String(object.sourceSha256 ?? object.chart?.sourceSha256 ?? "").toLowerCase();
  const sourceRecord = sourceById?.get(sourceRef);
  const sourceDigests = new Set([
    String(sourceRecord?.sha256 ?? "").toLowerCase(),
    String(sourceRecord?.normalizedSha256 ?? "").toLowerCase()
  ].filter(Boolean));
  if (!sourceRecord || !/^[0-9a-f]{64}$/.test(sourceSha256) || !sourceDigests.has(sourceSha256)) return null;
  const source = object.data ?? object.chartData ?? object.chart?.data;
  const raw = source && typeof source === "object" && !Array.isArray(source) && Array.isArray(source.series) ? source.series : source;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const data = raw.map((series, index) => {
    const labels = Array.isArray(series?.labels) ? series.labels.map(String) : null;
    const values = Array.isArray(series?.values) ? series.values.map(Number) : null;
    if (!labels || !values || labels.length !== values.length || values.some((value) => !Number.isFinite(value))) return null;
    return { name: String(series?.name ?? `Series ${index + 1}`), labels, values };
  });
  if (data.some((item) => item === null)) return null;
  return data;
}

function chartType(object) {
  const raw = object.chartType ?? object.kind ?? object.chart?.kind;
  if (raw === undefined || raw === null || raw === "") return "bar";
  const requested = String(raw).toLowerCase();
  if (["line", "pie", "doughnut", "area", "radar", "scatter", "bubble"].includes(requested)) return requested;
  if (["bar", "horizontalbar", "groupedbar", "stackedbar", "percentstackedbar"].includes(requested)) return "bar";
  throw Object.assign(new Error(`unsupported chart kind ${String(raw)}`), { code: "E_CHART_TYPE" });
}

function chartOptions(object, target) {
  const style = object.style && typeof object.style === "object" ? object.style : {};
  const source = object.options && typeof object.options === "object" ? object.options : {};
  const options = {
    ...source,
    ...target,
    ...(object.id ? { objectName: object.id, altText: object.id } : {}),
    ...(Array.isArray(style.palette) ? { chartColors: style.palette.map((value) => hex(value)) } : {}),
    ...(style.showLegend !== undefined ? { showLegend: Boolean(style.showLegend) } : {}),
    ...(style.showTitle !== undefined ? { showTitle: Boolean(style.showTitle) } : {}),
    ...(style.showValue !== undefined ? { showValue: Boolean(style.showValue) } : {}),
    ...(style.showLabel !== undefined ? { showLabel: Boolean(style.showLabel) } : {}),
    ...(style.legendPos ? { legendPos: style.legendPos } : {}),
    ...(style.catAxisLabelFontFace ? { catAxisLabelFontFace: resolveFont(style.catAxisLabelFontFace) } : {}),
    ...(style.catAxisLabelFontSize ? { catAxisLabelFontSize: Number(style.catAxisLabelFontSize) } : {}),
    ...(style.valAxisLabelFontSize ? { valAxisLabelFontSize: Number(style.valAxisLabelFontSize) } : {})
  };
  const kind = String(object.kind ?? object.chart?.kind ?? object.chartType ?? "").toLowerCase();
  if (kind.includes("horizontal")) options.barDir = "bar";
  if (kind.includes("stacked")) options.grouping = "stacked";
  if (kind.includes("percent")) options.grouping = "percentStacked";
  if (kind.includes("grouped")) options.grouping = "clustered";
  return options;
}

function tableRuns(cell, object, sectionStyle = {}) {
  if (!Array.isArray(cell?.runs) || cell.runs.length === 0) return String(cell?.text ?? cell ?? "");
  return cell.runs.map((run) => ({
    text: runText(run),
    options: runOptions(run, { ...object, text: cell.text }, sectionStyle)
  })).filter((run) => run.text);
}

function tableCell(cell, object, sectionStyle = {}) {
  const source = cell && typeof cell === "object" ? cell : { text: String(cell ?? "") };
  const style = { ...(sectionStyle && typeof sectionStyle === "object" ? sectionStyle : {}), ...(source.style ?? {}) };
  const color = colorParts(style.color ?? object.textColor ?? "172033", "172033");
  const fillValue = style.fill ?? style.backgroundColor;
  const options = {
    ...(source.options && typeof source.options === "object" ? source.options : {}),
    text: undefined,
    color: color.hex,
    ...(style.fontFamily || object.fontFamily ? { fontFace: resolveFont(style.fontFamily ?? object.fontFamily, "Arial", source.text) } : {}),
    ...(style.fontSizePt || style.fontSize ? { fontSize: Number(style.fontSizePt ?? style.fontSize) } : object.fontSizePt ? { fontSize: Number(object.fontSizePt) } : {}),
    ...(style.bold !== undefined ? { bold: Boolean(style.bold) } : {}),
    ...(style.fontWeight !== undefined ? { bold: Number(style.fontWeight) >= 700 } : {}),
    ...(style.italic !== undefined ? { italic: Boolean(style.italic) } : {}),
    ...(style.align !== undefined || style.textAlign !== undefined ? { align: normalizeAlign(style.align ?? style.textAlign) } : {}),
    ...(style.valign !== undefined || style.verticalAlign !== undefined ? { valign: normalizeVAlign(style.valign ?? style.verticalAlign) } : {}),
    ...(fillValue !== undefined ? { fill: { color: hex(fillValue), transparency: percentage(style.transparency ?? style.backgroundTransparency ?? 0) } } : {}),
    ...(source.colspan > 1 ? { colspan: Number(source.colspan) } : {}),
    ...(source.rowspan > 1 ? { rowspan: Number(source.rowspan) } : {}),
    ...(style.margin !== undefined || style.padding !== undefined ? { margin: style.margin ?? style.padding } : {})
  };
  const hyperlink = source.hyperlink ?? (source.href ? { url: source.href } : null);
  if (hyperlink?.url) options.hyperlink = { url: String(hyperlink.url), ...(hyperlink.tooltip ? { tooltip: hyperlink.tooltip } : {}) };
  return { text: tableRuns(source, object, style), options };
}

function tableRows(object) {
  const rows = [];
  if (Array.isArray(object.sections) && object.sections.length > 0) {
    for (const section of object.sections) {
      for (const row of section.rows ?? []) {
        const cells = Array.isArray(row) ? row : row?.cells;
        if (Array.isArray(cells)) rows.push(cells.map((cell) => tableCell(cell, object, section.style ?? section)));
      }
    }
  } else {
    if (Array.isArray(object.headers) && object.headers.length > 0) rows.push(object.headers.map((cell) => tableCell(cell, object, { bold: true, align: "center" })));
    for (const row of object.rows ?? []) {
      const cells = Array.isArray(row) ? row : row?.cells;
      if (Array.isArray(cells)) rows.push(cells.map((cell) => tableCell(cell, object)));
    }
  }
  return rows;
}

function addObject(slide, object, size, packageRoot, context = {}) {
  const target = inchBox(objectBox(object), size);
  const isConnector = object.type === "connector" || object.type === "line" || object.shape === "line";
  assertInside(target, size, object.id, isConnector ? "connector" : "object");
  if (object.type === "shape") {
    const shape = shapeName(object);
    const fill = shapeFill(object);
    const line = shapeLine(object);
    const options = applyTransform({
      ...target,
      objectName: object.id,
      fill,
      line,
      ...(object.shadow || object.style?.shadow ? { shadow: shadowOptions(object.shadow ?? object.style.shadow) } : {}),
      ...(shape === "roundRect" ? { rectRadius: roundedRectRadius(object, target) ?? 0.15 } : {})
    }, object);
    slide.addShape(shape, options);
    const gradient = object.gradient ?? object.style?.gradient ?? (object.fill && typeof object.fill === "object" ? object.fill.gradient : null);
    if (gradient && context.gradientPatches) context.gradientPatches.push({ id: object.id, gradient });
    return "shape";
  }
  if (object.type === "icon") {
    const requested = String(object.iconKind ?? "").toLowerCase();
    const iconShapes = {
      circle: "ellipse",
      diamond: "diamond",
      heart: "heart",
      plus: "plus",
      star: "star5",
      star5: "star5",
      star6: "star6",
      triangle: "triangle"
    };
    const shape = iconShapes[requested];
    if (!shape) {
      throw Object.assign(new Error(`${object.id ?? "icon"} has unsupported iconKind ${object.iconKind}`), { code: "E_ICON_KIND" });
    }
    slide.addShape(shape, applyTransform({
      ...target,
      objectName: object.id,
      fill: object.filled === false
        ? { color: "FFFFFF", transparency: 100, type: "none" }
        : { color: hex(object.color, "172033"), transparency: percentage(object.transparency ?? 0) },
      line: shapeLine({ ...object, fill: object.filled !== false })
    }, object));
    return "shape";
  }
  if (isConnector) {
    const source = objectBox(object);
    const normalized = normalizeLine(target);
    const shape = object.route === "orthogonal" || object.connector?.route === "orthogonal" ? "bentConnector3" : "line";
    slide.addShape(shape, applyTransform({
      ...normalized,
      objectName: object.id,
      line: shapeLine({ ...object, fill: false })
    }, object));
    // Keep the old pixel-box orientation behavior for tiny horizontal/vertical connectors.
    if (normalized.w === 0 && normalized.h === 0 && (Number(source.w) || Number(source.h))) {
      throw Object.assign(new Error(`${object.id} connector has zero length`), { code: "E_CONTRACT" });
    }
    return "connector";
  }
  if (object.type === "text") {
    const options = applyTransform({
      ...target,
      objectName: object.id,
      ...textStyle(object, object.style ?? {}),
      breakLine: false
    }, object);
    slide.addText(richTextPayload(object), options);
    return "text";
  }
  if (object.type === "image") {
    if (fullSlideRaster(target, size)) {
      throw Object.assign(new Error(`${object.id} is a prohibited whole-slide raster fallback`), {
        code: "E_WHOLE_SLIDE_FALLBACK"
      });
    }
    const source = object.asset ?? object.src ?? object.path;
    const imageOptions = applyTransform({
      path: safeAssetPath(packageRoot, source),
      ...target,
      objectName: object.id,
      altText: object.altText ?? object.alt ?? object.id,
      ...(object.transparency !== undefined || object.style?.transparency !== undefined
        ? { transparency: percentage(object.transparency ?? object.style.transparency) }
        : {}),
      ...(object.rounding !== undefined ? { rounding: Boolean(object.rounding) } : object.imageShape === "ellipse" ? { rounding: true } : {}),
      ...(object.shadow || object.style?.shadow ? { shadow: shadowOptions(object.shadow ?? object.style.shadow) } : {}),
      ...(imageSizing(object) ? { sizing: imageSizing(object) } : {})
    }, object);
    slide.addImage(imageOptions);
    return "image";
  }
  if (object.type === "table") {
    const rows = tableRows(object);
    if (rows.length < 1) throw Object.assign(new Error(`${object.id} has no rows`), { code: "E_CONTRACT" });
    const style = object.style && typeof object.style === "object" ? object.style : {};
    const borderColor = colorParts(style.borderColor ?? object.color ?? "64748B", "64748B");
    slide.addTable(rows, {
      ...target,
      objectName: object.id,
      border: { type: style.borderStyle === "none" ? "none" : "solid", color: borderColor.hex, pt: Number(style.borderWidthPt ?? style.borderWidth ?? 1) },
      fill: { color: hex(style.fill ?? object.fillColor ?? "FFFFFF"), transparency: percentage(style.transparency ?? 0) },
      color: hex(style.color ?? object.textColor ?? "172033"),
      fontFace: resolveFont(style.fontFamily ?? object.fontFamily, "Arial"),
      fontSize: Number(style.fontSizePt ?? object.fontSizePt ?? 12),
      margin: style.margin ?? object.margin ?? 0.04,
      ...(Array.isArray(object.colW) ? { colW: object.colW } : {}),
      ...(Array.isArray(object.rowH) ? { rowH: object.rowH } : {})
    });
    return "table";
  }
  if (object.type === "chart") {
    const data = traceableChartData(object, context.sourceById);
    if (!data) throw Object.assign(new Error(`${object.id ?? "chart"} requires source-bound recoverable data, a matching source digest, and finite numeric values`), { code: "E_CHART_TRACEABILITY" });
    const options = chartOptions(object, { ...target, objectName: object.id, altText: object.id });
    slide.addChart(chartType(object), data, options);
    return "chart";
  }
  if (object.type === "group") {
    // Group children are rendered by renderPlanObjects and wrapped in a native p:grpSp patch.
    return "group";
  }
  throw Object.assign(new Error(`unsupported object type ${object.type}`), { code: "E_CONTRACT" });
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const textKey = (value) => String(value ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();

function xmlTagEnd(xml, start) {
  let quote = null;
  for (let index = start + 1; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return xml.length - 1;
}

function xmlAttributes(raw) {
  const attributes = {};
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    const nameStart = index;
    while (index < raw.length && !/[\s=/>]/.test(raw[index])) index += 1;
    if (index === nameStart) break;
    const name = raw.slice(nameStart, index);
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (raw[index] !== "=") {
      while (index < raw.length && raw[index] !== " ") index += 1;
      continue;
    }
    index += 1;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    const quote = raw[index] === "\"" || raw[index] === "'" ? raw[index++] : null;
    const valueStart = index;
    if (quote) {
      while (index < raw.length && raw[index] !== quote) index += 1;
    } else {
      while (index < raw.length && !/[\s>]/.test(raw[index])) index += 1;
    }
    attributes[name] = decodeXml(raw.slice(valueStart, index));
    if (quote) index += 1;
  }
  return attributes;
}

function parseXml(xml) {
  const root = { type: "element", name: "#document", start: 0, openEnd: 0, end: xml.length, children: [] };
  const stack = [root];
  let cursor = 0;
  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart < 0) {
      if (cursor < xml.length) stack.at(-1).children.push({ type: "text", value: xml.slice(cursor), start: cursor, end: xml.length });
      break;
    }
    if (tagStart > cursor) stack.at(-1).children.push({ type: "text", value: xml.slice(cursor, tagStart), start: cursor, end: tagStart });
    if (xml.startsWith("<!--", tagStart)) {
      const commentEnd = xml.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? xml.length : commentEnd + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = xml.indexOf("]]>", tagStart + 9);
      const end = cdataEnd < 0 ? xml.length : cdataEnd;
      stack.at(-1).children.push({ type: "text", value: xml.slice(tagStart + 9, end), start: tagStart, end: Math.min(xml.length, end + 3) });
      cursor = Math.min(xml.length, end + 3);
      continue;
    }
    const tagEnd = xmlTagEnd(xml, tagStart);
    const raw = xml.slice(tagStart, tagEnd + 1);
    if (raw.startsWith("<?") || raw.startsWith("<!")) {
      cursor = tagEnd + 1;
      continue;
    }
    if (/^<\s*\//.test(raw)) {
      const name = raw.replace(/^<\s*\/\s*/, "").replace(/\s*>\s*$/, "").trim();
      const node = stack.pop();
      if (node && node.name === name) node.end = tagEnd + 1;
      cursor = tagEnd + 1;
      continue;
    }
    const nameMatch = raw.match(/^<\s*([^\s/>]+)/);
    if (!nameMatch) {
      cursor = tagEnd + 1;
      continue;
    }
    const name = nameMatch[1];
    const rawAttributes = raw.slice(nameMatch[0].length, raw.length - 1).replace(/\/\s*$/, "");
    const node = {
      type: "element",
      name,
      attrs: xmlAttributes(rawAttributes),
      start: tagStart,
      openEnd: tagEnd + 1,
      end: null,
      children: []
    };
    stack.at(-1).children.push(node);
    const selfClosing = /\/\s*>$/.test(raw);
    if (selfClosing) node.end = tagEnd + 1;
    else stack.push(node);
    cursor = tagEnd + 1;
  }
  return root;
}

function localName(name) {
  return String(name ?? "").split(":").at(-1);
}

function elementChildren(node) {
  return (node?.children ?? []).filter((child) => child.type === "element");
}

function descendants(node, predicate, output = []) {
  for (const child of elementChildren(node)) {
    if (predicate(child)) output.push(child);
    descendants(child, predicate, output);
  }
  return output;
}

function firstDescendant(node, predicate) {
  return descendants(node, predicate, []).at(0) ?? null;
}

function objectNameFromXml(node) {
  return firstDescendant(node, (item) => localName(item.name) === "cNvPr")?.attrs?.name ?? null;
}

function textFromXml(node) {
  return descendants(node, (item) => localName(item.name) === "t", []).map((item) => decodeXml((item.children ?? []).filter((child) => child.type === "text").map((child) => child.value).join(""))).join("");
}

function slideTree(xml) {
  const root = parseXml(xml);
  return firstDescendant(root, (node) => localName(node.name) === "spTree");
}

function replaceXmlRanges(xml, replacements) {
  return [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce((result, item) => `${result.slice(0, item.start)}${item.value}${result.slice(item.end)}`, xml);
}

function gradientFillXml(gradient) {
  if (!gradient || !Array.isArray(gradient.stops) || gradient.stops.length < 2) return null;
  const stops = gradient.stops.map((stop) => {
    const rawPosition = Number(stop?.position ?? 0);
    const position = clamp(rawPosition <= 1 ? rawPosition * 100 : rawPosition, 0, 100);
    const color = colorParts(stop?.color, "FFFFFF");
    const transparency = percentage(stop?.transparency ?? color.transparency);
    const alpha = Math.round((100 - transparency) * 1000);
    return `<a:gs pos="${Math.round(position * 1000)}"><a:srgbClr val="${color.hex}">${transparency > 0 ? `<a:alpha val="${alpha}"/>` : ""}</a:srgbClr></a:gs>`;
  }).join("");
  if (String(gradient.type ?? "linear").toLowerCase() === "radial") {
    const path = String(gradient.shape ?? "rect").toLowerCase() === "circle" ? "circle" : "rect";
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:path path="${path}"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
  }
  const angle = Math.round((Number(gradient.angle ?? 0) || 0) * 60000);
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${angle}" scaled="0"/></a:gradFill>`;
}

function patchShapeGradient(xml, id, gradient) {
  const gradientXml = gradientFillXml(gradient);
  if (!gradientXml || !id) return xml;
  const tree = slideTree(xml);
  if (!tree) return xml;
  const shape = elementChildren(tree).find((node) => ["sp", "grpSp"].includes(localName(node.name)) && objectNameFromXml(node) === id);
  if (!shape) return xml;
  const shapeProperties = firstDescendant(shape, (node) => localName(node.name) === "spPr");
  if (!shapeProperties) return xml;
  const fills = elementChildren(shapeProperties).filter((node) => ["solidFill", "noFill", "gradFill", "blipFill", "pattFill"].includes(localName(node.name)));
  if (fills.length > 0) return replaceXmlRanges(xml, [{ start: fills[0].start, end: fills[0].end, value: gradientXml }]);
  return replaceXmlRanges(xml, [{ start: shapeProperties.openEnd, end: shapeProperties.openEnd, value: gradientXml }]);
}

function patchBackgroundGradient(xml, gradient) {
  const gradientXml = gradientFillXml(gradient);
  if (!gradientXml) return xml;
  const root = parseXml(xml);
  const cSld = firstDescendant(root, (node) => localName(node.name) === "cSld");
  if (!cSld) return xml;
  const background = elementChildren(root).find((node) => localName(node.name) === "bg") ?? firstDescendant(root, (node) => localName(node.name) === "bg");
  const replacement = `<p:bg><p:bgPr>${gradientXml}</p:bgPr></p:bg>`;
  if (background) return replaceXmlRanges(xml, [{ start: background.start, end: background.end, value: replacement }]);
  return replaceXmlRanges(xml, [{ start: cSld.start, end: cSld.start, value: replacement }]);
}

async function patchSlideXml(pptxPath, patches) {
  if (!patches.some((item) => item?.length || item)) return;
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  for (const [slideIndex, patch] of patches.entries()) {
    if (!patch || (Array.isArray(patch) && patch.length === 0)) continue;
    const file = zip.file(`ppt/slides/slide${slideIndex + 1}.xml`);
    if (!file) continue;
    let xml = await file.async("string");
    if (patch.background) xml = patchBackgroundGradient(xml, patch.background);
    for (const item of patch.gradients ?? []) xml = patchShapeGradient(xml, item.id, item.gradient);
    if (patch.groups?.length) xml = patchGroupsXml(xml, patch.groups);
    zip.file(`ppt/slides/slide${slideIndex + 1}.xml`, xml);
  }
  await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function emu(value) {
  return Math.round(Number(value) * 914400);
}

function groupBounds(group) {
  if (group.box) {
    const x = Number(group.box.x);
    const y = Number(group.box.y);
    const w = Number(group.box.w);
    const h = Number(group.box.h);
    if ([x, y, w, h].every(Number.isFinite)) return { x, y, w: Math.max(0.01, w), h: Math.max(0.01, h) };
  }
  const boxes = (group.children ?? []).map((item) => item.inchBox).filter((item) => item && Number.isFinite(item.x));
  if (boxes.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const left = Math.min(...boxes.map((item) => item.x));
  const top = Math.min(...boxes.map((item) => item.y));
  const right = Math.max(...boxes.map((item) => item.x + item.w));
  const bottom = Math.max(...boxes.map((item) => item.y + item.h));
  return { x: left, y: top, w: Math.max(0.01, right - left), h: Math.max(0.01, bottom - top) };
}

function groupXml(id, children, bounds, nextId) {
  const offX = emu(bounds.x);
  const offY = emu(bounds.y);
  const extW = Math.max(1, emu(bounds.w));
  const extH = Math.max(1, emu(bounds.h));
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${nextId}" name="${xmlEscape(id)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${extW}" cy="${extH}"/><a:chOff x="${offX}" y="${offY}"/><a:chExt cx="${extW}" cy="${extH}"/></a:xfrm></p:grpSpPr>${children.join("")}</p:grpSp>`;
}

function patchGroupsXml(xml, groups) {
  let current = xml;
  const ordered = [...groups].sort((left, right) => Number(right.depth ?? 0) - Number(left.depth ?? 0));
  for (const group of ordered) {
    if (!Array.isArray(group.childIds) || group.childIds.length === 0) continue;
    const tree = slideTree(current);
    if (!tree) continue;
    const topChildren = elementChildren(tree).filter((node) => ["sp", "pic", "graphicFrame", "cxnSp", "grpSp"].includes(localName(node.name)));
    const childNodes = topChildren.filter((node) => group.childIds.includes(objectNameFromXml(node)));
    if (childNodes.length !== group.childIds.length) continue;
    const byId = new Map(childNodes.map((node) => [objectNameFromXml(node), node]));
    const orderedNodes = group.childIds.map((id) => byId.get(id)).filter(Boolean);
    const maxId = Math.max(0, ...descendants(parseXml(current), (node) => localName(node.name) === "cNvPr", []).map((node) => Number(node.attrs?.id)).filter(Number.isFinite));
    const groupValue = groupXml(group.id, orderedNodes.map((node) => current.slice(node.start, node.end)), groupBounds(group), maxId + 1);
    const first = Math.min(...orderedNodes.map((node) => node.start));
    const replacements = orderedNodes.map((node) => ({ start: node.start, end: node.end, value: node.start === first ? groupValue : "" }));
    current = replaceXmlRanges(current, replacements);
  }
  return current;
}

function collectPlanObjects(plan, size) {
  const direct = Array.isArray(plan.objects) ? plan.objects : [];
  const byId = new Map(direct.filter((item) => item?.id).map((item) => [item.id, item]));
  const flattened = [];
  const groups = [];
  const groupedIds = new Set();
  let generated = 0;
  const visitGroup = (group, depth = 0, parent = null) => {
    const children = Array.isArray(group.children) ? group.children : [];
    if (children.length === 0) throw Object.assign(new Error(`${group.id ?? "group"} has no children`), { code: "E_GROUP_EMPTY" });
    const childObjects = [];
    for (const value of children) {
      const child = typeof value === "string" ? byId.get(value) : value;
      if (!child || typeof child !== "object") throw Object.assign(new Error(`${group.id ?? "group"} references a missing child`), { code: "E_GROUP_CHILD" });
      if (!child.id) child.id = `${group.id ?? "group"}__child-${++generated}`;
      byId.set(child.id, child);
      groupedIds.add(child.id);
      if (child.type === "group") {
        const nested = visitGroup(child, depth + 1, group.id);
        childObjects.push({ id: nested.id, object: child, groupId: group.id, inchBox: nested.box });
      } else {
        const inch = inchBox(objectBox(child), size);
        childObjects.push({ id: child.id, object: child, groupId: group.id, inchBox: inch });
        flattened.push({ object: child, groupId: group.id, effectiveZ: Number(group.z ?? child.z ?? 0) + childObjects.length / 1000000 });
      }
    }
    const z = Number(group.z ?? childObjects.map((item) => Number(item.object?.z)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? 0);
    const box = (() => {
      const source = group.pixelBox ?? group.box;
      if (source) {
        try { return inchBox(source, size); } catch { /* derive from children */ }
      }
      const left = Math.min(...childObjects.map((item) => item.inchBox.x));
      const top = Math.min(...childObjects.map((item) => item.inchBox.y));
      const right = Math.max(...childObjects.map((item) => item.inchBox.x + item.inchBox.w));
      const bottom = Math.max(...childObjects.map((item) => item.inchBox.y + item.inchBox.h));
      return { x: left, y: top, w: Math.max(0.01, right - left), h: Math.max(0.01, bottom - top) };
    })();
    groups.push({ id: group.id, childIds: childObjects.map((item) => item.id), z, depth, parent, box, children: childObjects });
    return { id: group.id, box };
  };
  for (const object of direct.filter((item) => item?.type === "group")) visitGroup(object);
  for (const object of direct.filter((item) => item?.type !== "group")) {
    if (!object || groupedIds.has(object.id)) continue;
    flattened.push({ object, groupId: null, effectiveZ: Number.isFinite(Number(object.z)) ? Number(object.z) : flattened.length });
  }
  flattened.sort((left, right) => left.effectiveZ - right.effectiveZ);
  return { objects: flattened.map((item) => item.object), groups };
}

function expectedTextValue(object) {
  if (Array.isArray(object?.paragraphs)) return object.paragraphs.map((paragraph) => (paragraph?.runs ?? [{ text: paragraph?.text ?? "" }]).map(runText).join("")).join("\n");
  if (Array.isArray(object?.paragraph)) return object.paragraph.map((paragraph) => (paragraph?.runs ?? [{ text: paragraph?.text ?? "" }]).map(runText).join("")).join("\n");
  if (Array.isArray(object?.runs)) return object.runs.map(runText).join("");
  return String(object?.text ?? "");
}

function renderableNodes(node, output = []) {
  for (const child of elementChildren(node)) {
    if (["sp", "pic", "graphicFrame", "cxnSp", "grpSp"].includes(localName(child.name))) {
      output.push(child);
      renderableNodes(child, output);
    } else {
      renderableNodes(child, output);
    }
  }
  return output;
}

function xmlInventory(xml) {
  const tree = slideTree(xml);
  if (!tree) return { nodes: [], pictures: 0, groups: 0, charts: 0, tables: 0, shapes: 0, text: 0 };
  const nodes = renderableNodes(tree);
  const pictures = nodes.filter((node) => localName(node.name) === "pic");
  const groups = nodes.filter((node) => localName(node.name) === "grpSp");
  const graphics = nodes.filter((node) => localName(node.name) === "graphicFrame");
  const charts = graphics.filter((node) => firstDescendant(node, (item) => localName(item.name) === "chart"));
  const tables = graphics.filter((node) => firstDescendant(node, (item) => localName(item.name) === "tbl"));
  const text = nodes.filter((node) => ["sp", "grpSp"].includes(localName(node.name)) && textFromXml(node));
  const shapes = nodes.filter((node) => localName(node.name) === "sp" || localName(node.name) === "cxnSp");
  return {
    nodes,
    pictures: pictures.length,
    groups: groups.length,
    charts: charts.length,
    tables: tables.length,
    shapes: shapes.length,
    text: text.length
  };
}

async function inspectPptx(pptxPath, analysis, typeCounts, renderPlans = null, size = null) {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const slides = [];
  const findings = [];
  const deckSize = size ?? {
    widthPx: finite(analysis.deck?.size?.widthPx, "deck.size.widthPx"),
    heightPx: finite(analysis.deck?.size?.heightPx, "deck.size.heightPx"),
    widthIn: finite(analysis.deck?.size?.widthIn, "deck.size.widthIn"),
    heightIn: finite(analysis.deck?.size?.heightIn, "deck.size.heightIn")
  };
  const prepared = renderPlans ?? analysis.slides.map((plan) => collectPlanObjects(plan, deckSize));
  for (const [index, plan] of analysis.slides.entries()) {
    const xml = await zip.file(`ppt/slides/slide${index + 1}.xml`)?.async("string") ?? "";
    const inventory = xmlInventory(xml);
    const actualById = new Map(inventory.nodes.map((node) => [objectNameFromXml(node), node]).filter(([id]) => id));
    const expectedObjects = prepared[index]?.objects ?? plan.objects ?? [];
    const expected = expectedObjects.filter((item) => item.type === "text");
    const missingTextIds = expected
      .filter((item) => {
        const node = actualById.get(item.id);
        if (!node) return true;
        const expectedText = textKey(expectedTextValue(item));
        return expectedText !== "" && textKey(textFromXml(node)) !== expectedText;
      })
      .map((item) => item.id);
    if (missingTextIds.length) findings.push(`native-text-ooxml-mismatch: slide ${index + 1}: ${missingTextIds.join(",")}`);
    const expectedPictures = expectedObjects.filter((item) => item.type === "image").length;
    if (inventory.pictures !== expectedPictures) {
      findings.push(`pptx-raster-inventory-mismatch: slide ${index + 1}: ${inventory.pictures} != ${expectedPictures}`);
    }
    const expectedGroups = prepared[index]?.groups?.length ?? expectedObjects.filter((item) => item.type === "group").length;
    if (expectedGroups > 0 && inventory.groups < expectedGroups) findings.push(`pptx-group-inventory-mismatch: slide ${index + 1}: ${inventory.groups} < ${expectedGroups}`);
    slides.push({
      slideId: plan.id,
      nativeTextExpected: expected.length,
      nativeTextFound: expected.length - missingTextIds.length,
      nativeShapeCount: inventory.shapes,
      nativeTableCount: inventory.tables,
      nativeChartCount: inventory.charts,
      nativeGroupCount: inventory.groups,
      pictureCount: inventory.pictures,
      expectedPictureCount: expectedPictures,
      missingTextIds
    });
  }
  const totalArea = deckSize.widthIn * deckSize.heightIn * analysis.slides.length;
  const rasterObjects = prepared.flatMap((slide) => slide.objects).filter((item) => item.type === "image");
  const rasterArea = rasterObjects
    .filter((item) => item.type === "image")
    .reduce((sum, item) => {
      const box = inchBox(objectBox(item), deckSize);
      return sum + box.w * box.h;
    }, 0);
  const textExpected = slides.reduce((sum, slide) => sum + slide.nativeTextExpected, 0);
  const textFound = slides.reduce((sum, slide) => sum + slide.nativeTextFound, 0);
  const nativeTextRecall = textFound / Math.max(1, textExpected);
  const nativeObjectCount = slides.reduce((sum, slide) => sum + slide.nativeShapeCount + slide.nativeTableCount + slide.nativeChartCount + slide.nativeGroupCount, 0);
  const rasterAreaShare = rasterArea / Math.max(1, totalArea);
  if (rasterAreaShare > 0.65) {
    findings.push(`raster-area-share-too-high: ${rasterAreaShare.toFixed(6)} > 0.65`);
  }
  const wholeSlideRasterCount = rasterObjects.reduce((sum, item) => {
    const box = inchBox(objectBox(item), deckSize);
    return sum + (fullSlideRaster(box, deckSize) ? 1 : 0);
  }, 0);
  if (wholeSlideRasterCount > 0) findings.push(`whole-slide-raster-count: ${wholeSlideRasterCount}`);
  const nativeCoverage = nativeObjectCount / Math.max(1, nativeObjectCount + rasterObjects.length);
  const hasNativeText = textExpected > 0 && nativeTextRecall >= 0.9;
  const hasNativeVisual = nativeObjectCount > textFound;
  const level = hasNativeText && hasNativeVisual
    ? (rasterObjects.length === 0 ? 5 : 4)
    : hasNativeText ? (rasterObjects.length > 0 ? 3 : 5)
      : rasterObjects.length > 0 ? 1 : 2;
  return {
    version: "1.0.0",
    status: findings.length ? "failed" : "passed",
    level,
    nativeTextRecall: Number(nativeTextRecall.toFixed(6)),
    nativeObjectCount,
    nativeCoverage: Number(nativeCoverage.toFixed(6)),
    rasterObjectCount: rasterObjects.length,
    rasterAreaShare: Number(rasterAreaShare.toFixed(6)),
    wholeSlideRasterCount,
    slides,
    findings
  };
}

export async function renderPptx(analysisPath, outputPath, editabilityPath, packageRootOverride = null) {
  const analysis = JSON.parse(await readFile(resolve(analysisPath), "utf8"));
  if (analysis.version !== "1.0.0" || analysis.kind !== "image-reconstruction-analysis") {
    throw Object.assign(new Error("unsupported analysis contract"), { code: "E_CONTRACT" });
  }
  const packageRoot = packageRootOverride ? resolve(packageRootOverride) : dirname(resolve(analysisPath));
  const size = {
    widthPx: finite(analysis.deck?.size?.widthPx, "deck.size.widthPx"),
    heightPx: finite(analysis.deck?.size?.heightPx, "deck.size.heightPx"),
    widthIn: finite(analysis.deck?.size?.widthIn, "deck.size.widthIn"),
    heightIn: finite(analysis.deck?.size?.heightIn, "deck.size.heightIn")
  };
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "IMAGE_RECONSTRUCTION", width: size.widthIn, height: size.heightIn });
  pptx.layout = "IMAGE_RECONSTRUCTION";
  pptx.author = "image-to-pptx";
  pptx.subject = "Native-first reconstruction from user-provided slide images";
  pptx.title = analysis.deck.title;
  pptx.company = "";
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
    lang: "en-US"
  };
  const typeCounts = {};
  const sourceById = new Map((analysis.sources ?? []).map((source) => [source.id, source]));
  const renderPlans = [];
  const slidePatches = [];
  for (const plan of analysis.slides) {
    const slide = pptx.addSlide();
    const background = plan.background && typeof plan.background === "object" ? plan.background : null;
    const backgroundGradient = background?.gradient ?? (background?.type === "gradient" ? background : null);
    const backgroundColor = backgroundGradient?.stops?.[0]?.color ?? background?.color ?? plan.background;
    slide.background = { color: hex(backgroundColor, "FFFFFF") };
    const prepared = collectPlanObjects(plan, size);
    renderPlans.push(prepared);
    const gradients = [];
    for (const object of prepared.objects) {
      const rendered = addObject(slide, object, size, packageRoot, { gradientPatches: gradients, sourceById });
      typeCounts[rendered] = Number(typeCounts[rendered] ?? 0) + 1;
    }
    if (prepared.groups.length) typeCounts.group = Number(typeCounts.group ?? 0) + prepared.groups.length;
    slidePatches.push({ background: backgroundGradient, gradients, groups: prepared.groups });
    if (typeof slide.addNotes === "function") {
      slide.addNotes(`Source: ${plan.sourceRef}. OCR confidence is recorded in ocr-report.json.`);
    }
  }
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await pptx.writeFile({ fileName: resolve(outputPath) });
  await patchSlideXml(resolve(outputPath), slidePatches);
  const report = await inspectPptx(resolve(outputPath), analysis, typeCounts, renderPlans, size);
  if (editabilityPath) {
    await mkdir(dirname(resolve(editabilityPath)), { recursive: true });
    await writeFile(resolve(editabilityPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  return { pptx: resolve(outputPath), editability: report, typeCounts };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  renderPptx(process.argv[2], process.argv[3], process.argv[4], process.argv[5]).then(
    (result) => process.stdout.write(`${JSON.stringify({ status: "ok", ...result }, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "E_RENDER", message: error.message })}\n`);
      process.exitCode = 1;
    }
  );
}
