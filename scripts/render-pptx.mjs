import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pptxgen from "pptxgenjs";
import { parseDesignFile } from "./parse-design-md.mjs";
import { expandChartElement } from "./lib/chart-renderer.mjs";
import { expandDiagramElement } from "./lib/diagram-compiler.mjs";

const SHAPES = { rect: "rect", roundRect: "roundRect", ellipse: "ellipse" };

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

function textOptions(element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  const typography = style.typography ?? {};
  return {
    fontFace: typography.fontFamily ?? style.fontFamily ?? design.tokens.typography.body.fontFamily,
    fontSize: typography.fontSize ?? style.fontSize ?? design.tokens.typography.body.fontSize,
    bold: Boolean((typography.fontWeight ?? style.fontWeight ?? 400) >= 700 || style.bold),
    color: hex(style.color, design.tokens.colors.text),
    align: style.align ?? "left",
    valign: style.valign ?? "top",
    margin: 0.05
  };
}

function componentStyle(element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  return resolveValue(style.component ?? style, design.tokens);
}

function addText(slide, element, design) {
  slide.addText(element.text ?? "", {
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    ...textOptions(element, design)
  });
}

function addShape(slide, element, design) {
  const style = componentStyle(element, design);
  slide.addShape(SHAPES[element.shape] ?? "rect", {
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    fill: { color: hex(style.backgroundColor ?? style.fill, design.tokens.colors.surface) },
    line: { color: hex(style.borderColor ?? style.line, design.tokens.colors.border), transparency: 0 }
  });
}

function addLine(slide, element, design) {
  const style = resolveValue(element.style ?? {}, design.tokens);
  slide.addShape("line", {
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    line: {
      color: hex(style.color, design.tokens.colors.primary),
      width: style.width ?? 1.5,
      ...(style.beginArrowType ? { beginArrowType: style.beginArrowType } : {}),
      ...(style.endArrowType ? { endArrowType: style.endArrowType } : {}),
      ...(style.dash ? { dash: style.dash } : {})
    }
  });
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
    border: { color: hex(style.borderColor, design.tokens.colors.border), pt: 1 },
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
    slide.addShape("line", {
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
    slide.addShape("line", { x: x + w * 0.15, y: y + h * 0.55, w: w * 0.25, h: h * 0.25, line });
    slide.addShape("line", { x: x + w * 0.38, y: y + h * 0.78, w: w * 0.48, h: -h * 0.58, line });
    return { shape: 2, text: 0 };
  }
  if (element.name === "x") {
    slide.addShape("line", { x: x + w * 0.15, y: y + h * 0.15, w: w * 0.7, h: h * 0.7, line });
    slide.addShape("line", { x: x + w * 0.85, y: y + h * 0.15, w: -w * 0.7, h: h * 0.7, line });
    return { shape: 2, text: 0 };
  }
  if (element.name === "arrow-right") {
    slide.addShape("line", {
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
  slide.addImage({
    path: localImagePath(baseDir, element.src),
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h
  });
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
  const imageOpts = {
    path: localImagePath(baseDir, src),
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h
  };
  if (element.id) {
    // Surface the manifest id in the slide XML so downstream tooling can correlate
    // generated objects back to their source blocks (cropped-asset provenance).
    imageOpts.objectName = element.id;
    imageOpts.altText = element.id;
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
  }
}

function expandRenderableElements(elements) {
  return elements.flatMap((element) => {
    if (element.type === "chart") return expandChartElement(element);
    if (element.type === "diagram") return expandDiagramElement(element);
    return [element];
  });
}

function renderElement(slide, element, design, baseDir, counters, manifestAssets) {
  if (element.type === "text") {
    counters.text += 1;
    addText(slide, element, design);
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

async function writeReports(outputDir, manifest, design, countersBySlide, options = {}) {
  const nativeText = countersBySlide.reduce((sum, item) => sum + item.text, 0);
  const rasterized = countersBySlide.reduce(
    (sum, item) => sum + item.image + (item.croppedAsset ?? 0),
    0
  );
  const overall = Math.min(...countersBySlide.map(editableLevel));
  const compatibilityIssues = [];
  const fontNames = new Set();
  const complexShapeCount = manifest.slides.reduce(
    (sum, slide) =>
      sum +
      slide.elements.filter((element) => element.type === "shape" && !["rect", "roundRect", "ellipse"].includes(element.shape))
        .length,
    0
  );
  const externalImageCount = manifest.slides.reduce(
    (sum, slide) =>
      sum +
      slide.elements.filter(
        (element) => element.type === "image" && typeof element.src === "string" && /^https?:\/\//i.test(element.src)
      ).length,
    0
  );

  for (const value of Object.values(design.tokens.typography ?? {})) {
    if (value && typeof value === "object" && value.fontFamily) {
      fontNames.add(value.fontFamily);
    }
  }
  const portableFonts = new Set(["Arial", "Calibri", "Aptos", "Microsoft YaHei", "SimSun", "Noto Sans SC"]);
  const nonPortableFonts = [...fontNames].filter((font) => !portableFonts.has(font));
  if (nonPortableFonts.length > 0) {
    compatibilityIssues.push(`Non-portable fonts: ${nonPortableFonts.join(", ")}`);
  }
  if (externalImageCount > 0) {
    compatibilityIssues.push(`Remote image URLs: ${externalImageCount}`);
  }
  if (complexShapeCount > 0) {
    compatibilityIssues.push(`Unsupported shape names: ${complexShapeCount}`);
  }
  if (rasterized > 0) {
    compatibilityIssues.push(`Rasterized objects may edit differently in WPS: ${rasterized}`);
  }
  const compatibilityRisk = compatibilityIssues.length === 0 ? "low" : compatibilityIssues.length <= 2 ? "medium" : "high";
  const layouts = [...new Set((manifest.slides ?? []).map((slide) => slide.layout).filter(Boolean))];
  await writeFile(
    resolve(outputDir, "editable-report.md"),
    `# Editable Report\n\n## Summary\n\n- Output: ${outputDir}/final.pptx\n- Slide count: ${manifest.slides.length}\n- Overall editability: Level ${overall}\n- Native text: ${nativeText}\n- Rasterized objects: ${rasterized}\n`,
    "utf8"
  );
  await writeFile(
    resolve(outputDir, "qa-report.md"),
    `# QA Report\n\n## Validation\n\n- Manifest schema: not validated in render step (run validate-manifest.py separately)\n- Design system: ${design.name}\n- Design source: ${manifest.designSystem.source}\n- Design mode: ${manifest.designSystem.mode}\n- Renderer backend: ${options.backend ?? "pptxgen"}\n- Layouts used: ${layouts.join(", ") || "none"}\n- PPTX render: passed\n- Preview render: skipped in M1.1\n\n## Risks\n\n- Visual preview rendering is deferred unless render-preview.py is available.\n`,
    "utf8"
  );
  await writeFile(
    resolve(outputDir, "compatibility-report.md"),
    `# WPS Compatibility Report\n\n## Summary\n\n- Overall risk: ${compatibilityRisk}\n- Slide count: ${manifest.slides.length}\n- Fonts checked: ${[...fontNames].join(", ") || "none"}\n- Rasterized objects: ${rasterized}\n\n## Issues\n\n${
      compatibilityIssues.length > 0 ? compatibilityIssues.map((issue) => `- ${issue}`).join("\n") : "- No obvious WPS compatibility risks detected."
    }\n\n## Notes\n\n- Open the PPTX in WPS and PowerPoint when exact compatibility matters.\n- Prefer system fonts and native PPT objects for best portability.\n`,
    "utf8"
  );
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
  for (const sourceSlide of manifest.slides) {
    const slide = pptx.addSlide();
    const counters = { text: 0, shape: 0, image: 0, table: 0 };
    addBackground(slide, sourceSlide.background, manifest, design, baseDir);
    for (const element of expandRenderableElements(sourceSlide.elements ?? [])) renderElement(slide, element, design, baseDir, counters, manifest.assets);
    countersBySlide.push(counters);
  }

  await pptx.writeFile({ fileName: outputPath });
  await writeReports(outputDir, manifest, design, countersBySlide, { backend });
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
    preview: { libreofficeAvailable: false, status: "deferred" },
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
