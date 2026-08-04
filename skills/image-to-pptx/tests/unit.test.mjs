import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { renderPptx } from "../scripts/render_pptx.mjs";

const execFileAsync = promisify(execFile);

function analysis() {
  const sourceDigest = "a".repeat(64);
  return {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: {
      id: "unit-deck",
      title: "Unit deck",
      size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 }
    },
    ocr: { engine: "test", version: "1", langs: "eng", threshold: 0.7, policy: "test" },
    sources: [{
      id: "source-001",
      kind: "user-image",
      path: "source.png",
      sha256: sourceDigest,
      normalizedPath: "source.png",
      normalizedSha256: sourceDigest
    }],
    slides: [{
      id: "slide-001",
      order: 1,
      title: "UNIT TEST",
      sourceRef: "source-001",
      background: "#F5F7FB",
      sizePx: { width: 1280, height: 720 },
      objects: [
        {
          id: "shape-001",
          type: "shape",
          shape: "rect",
          fill: true,
          color: "#102A43",
          confidence: 1,
          pixelBox: { x: 0, y: 0, w: 1280, h: 120 },
          z: 0
        },
        {
          id: "text-001",
          type: "text",
          text: "UNIT TEST",
          confidence: 1,
          pixelBox: { x: 64, y: 42, w: 180, h: 28 },
          renderBox: { x: 62, y: 32, w: 320, h: 48 },
          style: {
            fontFamily: "Arial",
            fontSizePt: 28,
            color: "#FFFFFF",
            bold: true,
            charSpacingPt: 0
          },
          z: 1
        }
      ],
      componentInferences: [],
      annotation: "reports/low-confidence/slide-001.png",
      degradations: []
    }],
    designTokens: {},
    degradations: [],
    editabilityTarget: { minimumLevel: 3, wholeSlideRasterAllowed: false }
  };
}

test("renderer creates native editable text and shapes without a raster", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-unit-"));
  const source = join(directory, "analysis.json");
  const output = join(directory, "deck.pptx");
  const report = join(directory, "editability.json");
  await writeFile(source, `${JSON.stringify(analysis(), null, 2)}\n`);
  const result = await renderPptx(source, output, report, directory);
  assert.equal(result.editability.status, "passed");
  assert.equal(result.editability.level, 5);
  assert.equal(result.editability.rasterObjectCount, 0);
  assert.equal(result.editability.nativeTextRecall, 1);
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.match(xml, /UNIT TEST/);
  assert.doesNotMatch(xml, /<p:pic\b/);
});

test("renderer preserves rich runs, paragraph alignment, gradients, crop, rotation, and transparency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-rich-"));
  await copyFile(new URL("../examples/minimal/input.png", import.meta.url), join(directory, "asset.png"));
  const value = analysis();
  value.slides[0].objects = [
    {
      id: "gradient-card",
      type: "shape",
      shape: "roundRect",
      fill: { color: "#102A43" },
      color: "#102A43",
      pixelBox: { x: 24, y: 160, w: 520, h: 340 },
      style: {
        gradient: {
          type: "linear",
          angle: 135,
          stops: [{ position: 0, color: "#102A43" }, { position: 100, color: "#2F80ED", transparency: 20 }]
        },
        borderColor: "#2F80ED",
        borderWidth: 2,
        shadow: { type: "outer", color: "#000000", opacity: 0.25, blur: 4, offset: 2, angle: 45 }
      },
      rotationDeg: 4,
      z: 0
    },
    {
      id: "rich-text",
      type: "text",
      pixelBox: { x: 64, y: 210, w: 400, h: 96 },
      renderBox: { x: 64, y: 200, w: 440, h: 120 },
      paragraphs: [
        { align: "center", runs: [{ text: "Rich ", bold: true }, { text: "text", italic: true, color: "#F59E0B" }] },
        { align: "left", runs: [{ text: "wrap & <escape>" }] }
      ],
      style: { fontFamily: "Arial", fontSizePt: 22, color: "#FFFFFF", wrap: true, valign: "top" },
      z: 1
    },
    {
      id: "cropped-image",
      type: "image",
      asset: "asset.png",
      pixelBox: { x: 620, y: 180, w: 240, h: 180 },
      sizing: { type: "crop", x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
      transparency: 35,
      rotate: 12,
      z: 2
    },
    {
      id: "flat-icon",
      type: "icon",
      iconKind: "star",
      color: "#F59E0B",
      filled: true,
      rotationDeg: 15,
      pixelBox: { x: 920, y: 180, w: 100, h: 100 },
      z: 3
    }
  ];
  const source = join(directory, "analysis.json");
  const output = join(directory, "deck.pptx");
  const report = join(directory, "editability.json");
  await writeFile(source, `${JSON.stringify(value, null, 2)}\n`);
  const result = await renderPptx(source, output, report, directory);
  assert.equal(result.editability.status, "passed");
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.match(xml, /<a:gradFill\b/);
  assert.match(xml, /<a:pPr[^>]*algn="ctr"/);
  assert.match(xml, /Rich /);
  assert.match(xml, /<a:srcRect\b/);
  assert.match(xml, /<a:alpha val=/);
  assert.match(xml, /prst="star5"/);
  assert.match(xml, /name="flat-icon"/);
});

test("renderer creates native charts only from explicitly recoverable finite source data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-chart-"));
  const source = join(directory, "analysis.json");
  const output = join(directory, "deck.pptx");
  const rejected = analysis();
  rejected.slides[0].objects = [{ id: "chart", type: "chart", pixelBox: { x: 20, y: 120, w: 420, h: 260 }, data: [{ name: "A", labels: ["One"], values: [1] }], z: 0 }];
  await writeFile(source, JSON.stringify(rejected));
  await assert.rejects(renderPptx(source, output, null, directory), (error) => error.code === "E_CHART_TRACEABILITY");

  const unbound = analysis();
  unbound.slides[0].objects = [{
    id: "chart",
    type: "chart",
    sourceData: true,
    sourceRef: "source-001",
    sourceSha256: "b".repeat(64),
    data: [{ name: "A", labels: ["One"], values: [1] }],
    pixelBox: { x: 20, y: 120, w: 420, h: 260 },
    z: 0
  }];
  await writeFile(source, JSON.stringify(unbound));
  await assert.rejects(renderPptx(source, output, null, directory), (error) => error.code === "E_CHART_TRACEABILITY");

  unbound.slides[0].objects[0].sourceRef = "missing-source";
  unbound.slides[0].objects[0].sourceSha256 = "a".repeat(64);
  await writeFile(source, JSON.stringify(unbound));
  await assert.rejects(renderPptx(source, output, null, directory), (error) => error.code === "E_CHART_TRACEABILITY");

  const accepted = analysis();
  accepted.slides[0].objects = [{
    id: "chart",
    type: "chart",
    kind: "groupedBar",
    recoverability: true,
    sourceData: true,
    sourceRef: "source-001",
    sourceSha256: "a".repeat(64),
    data: [{ name: "A", labels: ["One", "Two"], values: [1, 2] }],
    pixelBox: { x: 20, y: 120, w: 420, h: 260 },
    z: 0
  }];
  await writeFile(source, JSON.stringify(accepted));
  const result = await renderPptx(source, output, null, directory);
  assert.equal(result.editability.status, "passed");
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.ok(Object.keys(zip.files).some((name) => /ppt\/charts\/chart\d+\.xml$/.test(name)));
});

test("renderer wraps declared group children into a native OOXML group and keeps z-order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-group-"));
  const source = join(directory, "analysis.json");
  const output = join(directory, "deck.pptx");
  const value = analysis();
  value.slides[0].objects = [
    {
      id: "group-001",
      type: "group",
      pixelBox: { x: 100, y: 160, w: 420, h: 220 },
      z: 1,
      children: [
        { id: "group-shape", type: "shape", shape: "ellipse", fill: true, color: "#2F80ED", pixelBox: { x: 120, y: 180, w: 180, h: 140 }, z: 0 },
        { id: "group-text", type: "text", text: "Grouped", pixelBox: { x: 160, y: 220, w: 180, h: 28 }, renderBox: { x: 160, y: 210, w: 240, h: 48 }, style: { fontFamily: "Arial", fontSizePt: 20, color: "#FFFFFF" }, z: 1 }
      ]
    },
    { id: "top-shape", type: "shape", shape: "rect", fill: true, color: "#102A43", pixelBox: { x: 40, y: 40, w: 80, h: 40 }, z: 0 }
  ];
  await writeFile(source, JSON.stringify(value));
  const result = await renderPptx(source, output, null, directory);
  assert.equal(result.editability.status, "passed");
  const zip = await JSZip.loadAsync(await readFile(output));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.match(xml, /<p:grpSp>/);
  assert.match(xml, /name="group-001"/);
  assert.match(xml, /name="group-shape"/);
  assert.match(xml, /name="group-text"/);
  if (process.env.IMAGE_TO_PPTX_LIBREOFFICE === "1") {
    try {
      await execFileAsync("soffice", [
        `-env:UserInstallation=file://${join(directory, "lo-profile")}`,
        "--headless", "--convert-to", "pdf", "--outdir", directory, output
      ], { timeout: 60_000 });
    } catch (error) {
      assert.fail(`LibreOffice could not open generated grouped PPTX: ${error.message}`);
    }
  }
});
