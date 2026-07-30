import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { renderPptx } from "../scripts/render_pptx.mjs";

function analysis() {
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
    sources: [],
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
