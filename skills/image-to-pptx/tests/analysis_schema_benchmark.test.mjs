import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const schemaPath = new URL("../schemas/analysis.schema.json", import.meta.url);
const fixtureManifestPath = new URL("./fixtures/object-level-benchmark/manifest.json", import.meta.url);
const fixtureTruthPath = new URL("./fixtures/object-level-benchmark/ground-truth.json", import.meta.url);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

function box(x, y, w, h) {
  return { x, y, w, h };
}

function base(id, type, pixelBox, z = 0) {
  return { id, type, pixelBox, confidence: 1, z, factStatus: "observed" };
}

function analysisFixture() {
  const shape = {
    ...base("shape-001", "shape", box(0, 0, 1280, 720)),
    shape: "rect",
    fill: true,
    color: "#12263A",
    borderWidthPx: 0,
    rotationDeg: 12,
    opacity: 0.62,
    transparency: 38,
    gradient: {
      type: "linear",
      angle: 135,
      stops: [{ position: 0, color: "#12263A" }, { position: 100, color: "#2F80ED", transparency: 20 }]
    },
    relations: { contains: [], overlaps: ["text-001"], occludes: ["text-001"], anchors: [] },
    recoverability: {
      status: "native",
      confidence: 0.93,
      renderedAs: "native-shape",
      reason: "bounded vector geometry"
    }
  };
  const text = {
    ...base("text-001", "text", box(64, 40, 420, 70), 1),
    text: "Two lines\nremain editable",
    runs: [
      { text: "Two lines", bold: true },
      { text: "\nremain editable", italic: true }
    ],
    renderBox: box(64, 36, 500, 90),
    style: {
      fontFamily: "Arial",
      fontSizePt: 24,
      color: "#FFFFFF",
      bold: true,
      charSpacingPt: 0,
      lineCount: 2,
      lineHeightPt: 30,
      align: "left",
      valign: "top",
      wrap: true
    }
  };
  const connector = {
    ...base("connector-001", "connector", box(580, 120, 220, 4), 2),
    color: "#829AB1",
    widthPx: 2,
    direction: "horizontal",
    sourceId: "shape-001",
    targetId: "table-001"
  };
  const table = {
    ...base("table-001", "table", box(64, 200, 420, 180), 3),
    rows: [["Region", "Share"], ["North", "42%"]],
    headerRows: 1,
    columns: 2,
    color: "#64748B",
    fillColor: "#FFFFFF",
    textColor: "#172033",
    fontFamily: "Arial",
    fontSizePt: 12
  };
  const chart = {
    ...base("chart-001", "chart", box(600, 180, 560, 280), 4),
    chartType: "bar",
    series: [{ id: "series-001", label: "Visible bars", factStatus: "inferred" }],
    dataPolicy: "source-provided",
    sourceData: true,
    sourceRef: "source-001",
    sourceSha256: "1".repeat(64),
    data: [{ name: "Visible bars", labels: ["Q1", "Q2"], values: [12, 18] }],
    categories: ["Q1", "Q2"],
    legend: false
  };
  const icon = {
    ...base("icon-001", "icon", box(500, 40, 48, 48), 5),
    iconKind: "star",
    color: "#F6C85F",
    filled: true
  };
  const image = {
    ...base("image-001", "image", box(900, 40, 180, 100), 6),
    asset: "assets/local.png",
    reason: "bounded-complex-region",
    crop: { type: "crop", x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    transparency: 15
  };
  const group = {
    ...base("group-001", "group", box(40, 20, 520, 120), 7),
    children: ["shape-001", "text-001"]
  };
  return {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: {
      id: "deck-001",
      title: "Strict scene IR",
      size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 }
    },
    ocr: { engine: "test", version: "1", langs: "eng", threshold: 0.7, policy: "visible text only" },
    sources: [{
      id: "source-001",
      kind: "user-image",
      path: "sources/source.png",
      sha256: "0".repeat(64),
      normalizedPath: "evidence/reference/source.png",
      normalizedSha256: "1".repeat(64)
    }],
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Strict scene IR",
      sourceRef: "source-001",
      background: "#F7F9FC",
      sizePx: { width: 1280, height: 720 },
      objects: [shape, text, connector, table, chart, icon, image, group],
      degradations: []
    }],
    designTokens: {
      version: "1.0.0",
      source: "test",
      colors: { background: "#F7F9FC", primary: "#12263A", palette: ["#F7F9FC", "#12263A"] },
      typography: { primary: "Arial", fallbacks: ["Noto Sans"] },
      page: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 }
    },
    degradations: [],
    editabilityTarget: { minimumLevel: 3, wholeSlideRasterAllowed: false }
  };
}

test("object benchmark manifest and truth are stable and source-bound", async () => {
  const manifest = await readJson(fixtureManifestPath);
  const truth = await readJson(fixtureTruthPath);
  assert.equal(manifest.kind, "image-to-pptx-object-benchmark");
  assert.equal(manifest.id, truth.id);
  assert.equal(manifest.fixture.image, "reference.png");
  assert.equal(manifest.fixture.groundTruth, "ground-truth.json");
  assert.equal(manifest.deterministic.network, false);
  assert.equal(manifest.deterministic.model, null);
  assert.ok(truth.objects.length >= 15);
  const ids = truth.objects.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of truth.objects) {
    assert.match(item.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(["shape", "text", "chart", "table", "icon"].includes(item.type));
    assert.deepEqual(Object.keys(item.box).sort(), ["h", "unit", "w", "x", "y"]);
    assert.equal(item.box.unit, "px");
    assert.ok(item.box.w > 0 && item.box.h > 0);
    assert.ok(Number.isInteger(item.z) && item.z >= 0);
    assert.equal(typeof item.style, "object");
    assert.equal(typeof item.relations, "object");
    assert.equal(typeof item.recoverability, "object");
  }
});

test("analysis schema accepts current objects and rich scene attributes", async () => {
  const schema = await readJson(schemaPath);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  const value = analysisFixture();
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));

  const unknown = structuredClone(value);
  unknown.slides[0].objects[0].unexpected = true;
  assert.equal(validate(unknown), false);

  const invalidRotation = structuredClone(value);
  invalidRotation.slides[0].objects[0].rotationDeg = 361;
  assert.equal(validate(invalidRotation), false);

  const unboundChart = structuredClone(value);
  delete unboundChart.slides[0].objects.find((item) => item.type === "chart").sourceSha256;
  assert.equal(validate(unboundChart), false);
});
