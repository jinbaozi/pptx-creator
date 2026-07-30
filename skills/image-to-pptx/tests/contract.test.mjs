import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHtmlPackage } from "../scripts/build_html_package.mjs";
import { validatePresentationPackage, validatePresentationPackageFile } from "../scripts/validate-presentation-package.mjs";

function fixture() {
  return {
    protocol: "pptx-creator.presentation-package",
    version: "1.0.0",
    kind: "image-reconstruction",
    producer: { skill: "image-to-pptx", version: "2.0.0" },
    entrypoint: "index.html",
    deck: {
      id: "deck-001",
      title: "Reconstruction",
      size: { width: 1280, height: 720, unit: "px" },
      slides: [{
        id: "slide-001",
        order: 1,
        title: "Visible title",
        notes: "Source-bound",
        sourceRefs: ["source-001"],
        components: [{
          id: "title-001",
          type: "text",
          box: { x: 64, y: 40, w: 500, h: 50, unit: "px" },
          z: 1,
          editableIntent: true,
          sourceRefs: ["source-001"],
          confidence: 0.96
        }]
      }]
    },
    designTokens: "design-tokens.json",
    assets: [],
    sources: [{
      id: "source-001",
      kind: "image",
      label: "Reference",
      locator: "sources/source-001.png",
      factStatus: "provided"
    }],
    validation: { status: "passed", reports: ["qa-report.json"] },
    degradations: [],
    compatibility: { minReaderVersion: "1.0.0", features: ["component-confidence"] }
  };
}

test("presentation-package 1.0.0 accepts the shared image reconstruction contract", () => {
  const result = validatePresentationPackage(fixture());
  assert.equal(result.slideCount, 1);
  assert.equal(result.producer, "image-to-pptx");
});

test("presentation-package fails closed on an unknown version", () => {
  const value = fixture();
  value.version = "2.0.0";
  assert.throws(() => validatePresentationPackage(value), (error) => error.code === "E_PROTOCOL_VERSION");
});

test("HTML package is self-contained and validates against the vendored protocol", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-html-contract-"));
  const normalized = join(directory, "evidence", "reference", "slide-001.png");
  await mkdir(join(directory, "evidence", "reference"), { recursive: true });
  await writeFile(normalized, Buffer.from("source-evidence"));
  const sourcePath = join(directory, "sources", "slide-001.png");
  await mkdir(join(directory, "sources"), { recursive: true });
  await writeFile(sourcePath, Buffer.from("source-original"));
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "assets", "crop.png"), Buffer.from("bounded-local-crop"));
  const analysis = {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: { id: "deck-001", title: "Contract", size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 } },
    sources: [{
      id: "source-001",
      label: "Reference",
      path: "sources/slide-001.png",
      sha256: "0".repeat(64),
      normalizedPath: "evidence/reference/slide-001.png"
    }],
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Contract",
      sourceRef: "source-001",
      background: "#FFFFFF",
      objects: [{
        id: "text-001",
        type: "text",
        text: "Contract",
        confidence: 1,
        pixelBox: { x: 64, y: 40, w: 200, h: 30 },
        renderBox: { x: 60, y: 30, w: 350, h: 50 },
        style: { fontFamily: "Arial", fontSizePt: 28, color: "#111111", bold: true },
        z: 1
      }, {
        id: "shape-001",
        type: "shape",
        shape: "rect",
        fill: true,
        color: "#336699",
        confidence: 1,
        pixelBox: { x: 40, y: 20, w: 400, h: 80 },
        z: 0
      }, {
        id: "connector-001",
        type: "connector",
        color: "#112233",
        widthPx: 2,
        confidence: 0.99,
        pixelBox: { x: 64, y: 200, w: 320, h: 2 },
        z: 3
      }, {
        id: "image-001",
        type: "image",
        asset: "assets/crop.png",
        reason: "low-confidence-ocr",
        confidence: 0.62,
        pixelBox: { x: 400, y: 100, w: 120, h: 80 },
        z: 4
      }, {
        id: "table-001",
        type: "table",
        confidence: 0.9,
        pixelBox: { x: 64, y: 240, w: 500, h: 180 },
        z: 5
      }, {
        id: "connector-anchored-001",
        type: "connector",
        sourceId: "shape-001",
        targetId: "table-001",
        color: "#334455",
        widthPx: 2,
        confidence: 0.95,
        pixelBox: { x: 264, y: 180, w: 160, h: 60 },
        z: 6
      }]
    }],
    designTokens: { version: "1.0.0" },
    degradations: []
  };
  const analysisPath = join(directory, "analysis.json");
  const qaPath = join(directory, "qa-report.json");
  await writeFile(analysisPath, JSON.stringify(analysis));
  await writeFile(qaPath, JSON.stringify({ status: "passed" }));
  const result = await buildHtmlPackage(analysisPath, qaPath, join(directory, "html-package"));
  const validated = await validatePresentationPackageFile(result.protocol);
  assert.equal(validated.validationStatus, "passed");
  assert.equal(validated.componentCount, 6);

  const html = await readFile(join(directory, "html-package", "index.html"), "utf8");
  assert.match(
    html,
    /class="slide pptx-slide active"[^>]*data-slide="true"[^>]*data-slide-id="slide-001"/
  );
  const expectedKinds = new Map([
    ["text-001", "text"],
    ["shape-001", "shape"],
    ["connector-001", "shape"],
    ["connector-anchored-001", "line"],
    ["image-001", "image"],
    ["table-001", "table"]
  ]);
  for (const [id, kind] of expectedKinds) {
    assert.match(
      html,
      new RegExp(`data-component-id="${id}"[^>]*data-pptx-id="${id}"[^>]*data-pptx-kind="${kind}"`)
    );
  }
  assert.match(
    html,
    /data-pptx-id="shape-001"[^>]*data-layout-role="background"[^>]*data-allow-overlap-with="text-001"/
  );
  assert.match(html, /class="object divider"[^>]*data-pptx-id="connector-001"[^>]*data-pptx-kind="shape"/);
  assert.doesNotMatch(
    html.match(/<div class="object divider"[^>]*>/)?.[0] ?? "",
    /data-connector=/
  );
  assert.match(
    html,
    /<line[^>]*data-pptx-id="connector-anchored-001"[^>]*data-pptx-kind="line"[^>]*data-connector="true"[^>]*data-source-id="shape-001"[^>]*data-target-id="table-001"/
  );

  const emittedIds = [...html.matchAll(/data-pptx-id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(emittedIds).size, emittedIds.length);
  assert.deepEqual([...emittedIds].sort(), [...expectedKinds.keys()].sort());

  const protocol = JSON.parse(await readFile(result.protocol, "utf8"));
  const protocolIds = protocol.deck.slides.flatMap((slide) => slide.components.map((component) => component.id));
  assert.deepEqual([...protocolIds].sort(), [...emittedIds].sort());
  const protocolTypes = new Map(
    protocol.deck.slides.flatMap((slide) => slide.components.map((component) => [component.id, component.type]))
  );
  assert.equal(protocolTypes.get("connector-001"), "shape");
  assert.equal(protocolTypes.get("connector-anchored-001"), "connector");
});
