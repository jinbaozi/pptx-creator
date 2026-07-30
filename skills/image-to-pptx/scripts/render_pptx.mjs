#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";

const hex = (value, fallback = "000000") =>
  String(value ?? fallback).replace(/^#/, "").toUpperCase();

const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`${label} must be finite`), { code: "E_CONTRACT" });
  return number;
};

function inchBox(box, slide) {
  const scaleX = slide.widthIn / slide.widthPx;
  const scaleY = slide.heightIn / slide.heightPx;
  return {
    x: finite(box.x, "box.x") * scaleX,
    y: finite(box.y, "box.y") * scaleY,
    w: finite(box.w, "box.w") * scaleX,
    h: finite(box.h, "box.h") * scaleY
  };
}

function assertInside(box, size, id) {
  const tolerance = 0.01;
  if (box.x < -tolerance || box.y < -tolerance || box.w <= 0 || box.h <= 0
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

function addObject(slide, object, size, packageRoot) {
  const target = inchBox(object.type === "text" ? object.renderBox : object.pixelBox, size);
  assertInside(target, size, object.id);
  if (object.type === "shape") {
    slide.addShape(object.shape === "ellipse" ? "ellipse" : "rect", {
      ...target,
      objectName: object.id,
      fill: object.fill
        ? { color: hex(object.color), transparency: 0 }
        : { color: "FFFFFF", transparency: 100 },
      line: object.fill
        ? { color: hex(object.color), transparency: 100, width: 0 }
        : { color: hex(object.color), transparency: 0, width: Math.max(0.75, Number(object.borderWidthPx ?? 1) * 0.75) }
    });
    return "shape";
  }
  if (object.type === "connector") {
    const source = object.pixelBox;
    const horizontal = source.w >= source.h;
    const lineBox = horizontal
      ? { x: target.x, y: target.y + target.h / 2, w: target.w, h: 0 }
      : { x: target.x + target.w / 2, y: target.y, w: 0, h: target.h };
    slide.addShape("line", {
      ...lineBox,
      objectName: object.id,
      line: {
        color: hex(object.color),
        width: Math.max(0.75, Number(object.widthPx ?? 1) * 0.75),
        ...(object.beginArrowType ? { beginArrowType: object.beginArrowType } : {}),
        ...(object.endArrowType ? { endArrowType: object.endArrowType } : {})
      }
    });
    return "connector";
  }
  if (object.type === "text") {
    const style = object.style ?? {};
    slide.addText(String(object.text ?? ""), {
      ...target,
      objectName: object.id,
      fontFace: style.fontFamily || "Arial",
      fontSize: finite(style.fontSizePt, `${object.id}.style.fontSizePt`),
      color: hex(style.color, "172033"),
      bold: Boolean(style.bold),
      italic: Boolean(style.italic),
      charSpacing: Number(style.charSpacingPt ?? 0),
      margin: 0,
      align: "left",
      valign: "mid",
      breakLine: false,
      paraSpaceAfterPt: 0,
      lineSpacingMultiple: 1
    });
    return "text";
  }
  if (object.type === "image") {
    if (fullSlideRaster(target, size)) {
      throw Object.assign(new Error(`${object.id} is a prohibited whole-slide raster fallback`), {
        code: "E_WHOLE_SLIDE_FALLBACK"
      });
    }
    slide.addImage({
      path: resolve(packageRoot, object.asset),
      ...target,
      objectName: object.id
    });
    return "image";
  }
  if (object.type === "table") {
    const rows = Array.isArray(object.rows) ? object.rows : [];
    if (rows.length < 1) throw Object.assign(new Error(`${object.id} has no rows`), { code: "E_CONTRACT" });
    slide.addTable(rows, {
      ...target,
      objectName: object.id,
      border: { type: "solid", color: hex(object.color, "64748B"), pt: 1 },
      fill: hex(object.fillColor, "FFFFFF"),
      color: hex(object.textColor, "172033"),
      fontFace: object.fontFamily ?? "Arial",
      fontSize: Number(object.fontSizePt ?? 12),
      margin: 0.04
    });
    return "table";
  }
  throw Object.assign(new Error(`unsupported object type ${object.type}`), { code: "E_CONTRACT" });
}

function decodeXml(value = "") {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const textKey = (value) => String(value ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();

async function inspectPptx(pptxPath, analysis, typeCounts) {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const slides = [];
  const findings = [];
  for (const [index, plan] of analysis.slides.entries()) {
    const xml = await zip.file(`ppt/slides/slide${index + 1}.xml`)?.async("string") ?? "";
    const nativeTexts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]));
    const expected = plan.objects.filter((item) => item.type === "text");
    const missingTextIds = expected
      .filter((item) => !nativeTexts.some((value) => textKey(value) === textKey(item.text)))
      .map((item) => item.id);
    if (missingTextIds.length) findings.push(`native-text-ooxml-mismatch: slide ${index + 1}: ${missingTextIds.join(",")}`);
    const pictures = (xml.match(/<p:pic\b/g) ?? []).length;
    const expectedPictures = plan.objects.filter((item) => item.type === "image").length;
    if (pictures !== expectedPictures) {
      findings.push(`pptx-raster-inventory-mismatch: slide ${index + 1}: ${pictures} != ${expectedPictures}`);
    }
    slides.push({
      slideId: plan.id,
      nativeTextExpected: expected.length,
      nativeTextFound: expected.length - missingTextIds.length,
      nativeShapeCount: (xml.match(/<p:sp\b/g) ?? []).length,
      pictureCount: pictures,
      expectedPictureCount: expectedPictures,
      missingTextIds
    });
  }
  const totalArea = analysis.deck.size.widthIn * analysis.deck.size.heightIn * analysis.slides.length;
  const rasterArea = analysis.slides.flatMap((slide) => slide.objects)
    .filter((item) => item.type === "image")
    .reduce((sum, item) => {
      const box = inchBox(item.pixelBox, {
        widthPx: analysis.deck.size.widthPx,
        heightPx: analysis.deck.size.heightPx,
        widthIn: analysis.deck.size.widthIn,
        heightIn: analysis.deck.size.heightIn
      });
      return sum + box.w * box.h;
    }, 0);
  const textExpected = slides.reduce((sum, slide) => sum + slide.nativeTextExpected, 0);
  const textFound = slides.reduce((sum, slide) => sum + slide.nativeTextFound, 0);
  const nativeTextRecall = textFound / Math.max(1, textExpected);
  const nativeObjectCount = Number(typeCounts.text ?? 0) + Number(typeCounts.shape ?? 0)
    + Number(typeCounts.connector ?? 0) + Number(typeCounts.table ?? 0);
  const rasterAreaShare = rasterArea / Math.max(1, totalArea);
  if (rasterAreaShare > 0.65) {
    findings.push(`raster-area-share-too-high: ${rasterAreaShare.toFixed(6)} > 0.65`);
  }
  const level = nativeTextRecall >= 0.9 && nativeObjectCount > 0
    ? (rasterArea === 0 ? 5 : 4)
    : nativeTextRecall >= 0.9 ? 3 : 2;
  return {
    version: "1.0.0",
    status: findings.length ? "failed" : "passed",
    level,
    nativeTextRecall: Number(nativeTextRecall.toFixed(6)),
    nativeObjectCount,
    rasterObjectCount: Number(typeCounts.image ?? 0),
    rasterAreaShare: Number(rasterAreaShare.toFixed(6)),
    wholeSlideRasterCount: 0,
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
  for (const plan of analysis.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: hex(plan.background, "FFFFFF") };
    for (const object of [...plan.objects].sort((left, right) => left.z - right.z)) {
      const rendered = addObject(slide, object, size, packageRoot);
      typeCounts[rendered] = Number(typeCounts[rendered] ?? 0) + 1;
    }
    if (typeof slide.addNotes === "function") {
      slide.addNotes(`Source: ${plan.sourceRef}. OCR confidence is recorded in ocr-report.json.`);
    }
  }
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await pptx.writeFile({ fileName: resolve(outputPath) });
  const report = await inspectPptx(resolve(outputPath), analysis, typeCounts);
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
