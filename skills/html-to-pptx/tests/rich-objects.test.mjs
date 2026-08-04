import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";

const execFileAsync = promisify(execFile);
const designSource = resolve("design-systems/business-neutral/DESIGN.md");

async function renderManifest(root, name, manifest) {
  const manifestPath = join(root, `${name}.manifest.json`);
  const outputPath = join(root, `${name}.pptx`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, ["scripts/render-pptx.mjs", manifestPath, outputPath], {
    cwd: resolve("."),
    maxBuffer: 10 * 1024 * 1024
  });
  return JSZip.loadAsync(await readFile(outputPath));
}

function sourceHtml() {
  return `<section class="pptx-slide" data-slide-id="slide-001">
    <p id="rich" data-pptx-kind="text">Alpha <strong>bold</strong> <a href="https://example.com">link</a></p>
    <table id="table" data-pptx-kind="table">
      <caption>Caption</caption>
      <thead><tr><th rowspan="2">A</th><th>B</th></tr><tr><th>C</th></tr></thead>
      <tbody><tr><td colspan="2">Body <a href="https://example.com/cell">cell</a></td></tr></tbody>
      <tfoot><tr><td colspan="2">Foot</td></tr></tfoot>
    </table>
  </section>`;
}

function measurements() {
  const baseStyle = {
    color: "#111111",
    fontFamily: "Arial",
    fontSize: 18,
    fontWeight: 400,
    fontStyle: "normal",
    lineHeight: 22,
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "normal",
    backgroundColor: "#FFFFFF",
    backgroundTransparency: 0,
    borderWidth: 1,
    borderColor: "#111111",
    borderStyle: "solid",
    paddingTop: 6,
    paddingRight: 6,
    paddingBottom: 6,
    paddingLeft: 6
  };
  const runs = [
    { text: "Alpha ", fontFamily: "Arial", fontSize: 18, fontWeight: 400, fontStyle: "normal", color: "#111111", decoration: null },
    { text: "bold", fontFamily: "Arial", fontSize: 18, fontWeight: 700, fontStyle: "normal", color: "#CC0000", decoration: null },
    { text: "link", fontFamily: "Arial", fontSize: 18, fontWeight: 400, fontStyle: "normal", color: "#0000EE", decoration: { underline: { style: "sng" } }, hyperlink: { url: "https://example.com" } }
  ];
  const cell = (text, options = {}) => ({
    text,
    runs: options.runs ?? [{ text, fontFamily: "Arial", fontSize: 12, fontWeight: 400, fontStyle: "normal", color: "#111111" }],
    style: { ...baseStyle, fontSize: 12, ...options.style },
    ...(options.rowspan ? { rowspan: options.rowspan } : {}),
    ...(options.colspan ? { colspan: options.colspan } : {}),
    ...(options.href ? { href: options.href } : {}),
    inches: options.inches ?? { x: 1, y: 2, w: 2, h: 0.4 }
  });
  return {
    viewport: { width: 1280, height: 720 },
    slides: [{ slideId: "slide-001", slideIndex: 0 }],
    elements: [
      {
        id: "rich", slideId: "slide-001", slideIndex: 0, kind: "text", tagName: "p",
        x: 1, y: 0.5, w: 5, h: 0.5, px: { x: 96, y: 48, w: 480, h: 48 },
        text: "Alpha bold link", visibleText: null, href: "https://example.com", style: baseStyle, replica: {}, runs
      },
      {
        id: "table", slideId: "slide-001", slideIndex: 0, kind: "table", tagName: "table",
        x: 1, y: 1.5, w: 6, h: 2.1, px: { x: 96, y: 144, w: 576, h: 202 },
        text: "", visibleText: null, style: { ...baseStyle, fontSize: 12 }, replica: {},
        table: {
          columns: [2, 4],
          rowHeights: [0.5, 0.5, 0.5, 0.5],
          caption: { text: "Caption", runs: [{ text: "Caption", fontFamily: "Arial", fontSize: 12, fontWeight: 400, color: "#111111" }], inches: { x: 1, y: 1.2, w: 6, h: 0.2 } },
          sections: [
            { type: "thead", rows: [
              { cells: [cell("A", { rowspan: 2 }), cell("B")] },
              { cells: [cell("C")] }
            ] },
            { type: "tbody", rows: [
              { cells: [cell("Body cell", { colspan: 2, href: "https://example.com/cell", runs: [{ text: "Body ", fontFamily: "Arial", fontSize: 12, fontWeight: 400, color: "#111111" }, { text: "cell", fontFamily: "Arial", fontSize: 12, fontWeight: 400, color: "#0000EE", hyperlink: { url: "https://example.com/cell" } }] })] }
            ] },
            { type: "tfoot", rows: [{ cells: [cell("Foot", { colspan: 2 })] }] }
          ]
        }
      }
    ]
  };
}

function baseManifest(elements) {
  return {
    version: "0.2.0",
    designSystem: { source: designSource },
    deck: { title: "rich objects", language: "en-US", size: { width: 13.333, height: 7.5 } },
    slides: [{ id: "slide-001", title: "", background: { type: "solid", color: "#FFFFFF" }, elements }]
  };
}

describe("rich text, table fidelity, and native chart modes", () => {
  it("renders rich runs and table sections/spans/styles into editable OOXML", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-rich-objects-"));
    try {
      const manifest = convertHtmlToManifest(sourceHtml(), { measurements: measurements(), designMode: "replica", designSystemSource: designSource });
      const rich = manifest.slides[0].elements.find((element) => element.id === "rich");
      const table = manifest.slides[0].elements.find((element) => element.id === "table");
      expect(rich).toMatchObject({ text: "Alpha bold link", runs: [{ text: "Alpha " }, { text: "bold", fontWeight: 700 }, { text: "link", hyperlink: { url: "https://example.com" } }] });
      expect(table).toMatchObject({ caption: "Caption", colW: [2, 4], rowH: [0.5, 0.5, 0.5, 0.5] });
      expect(table.sections.map((section) => section.type)).toEqual(["thead", "tbody", "tfoot"]);
      expect(table.sections[0].rows[0].cells[0]).toMatchObject({ rowspan: 2 });
      expect(table.sections[1].rows[0].cells[0]).toMatchObject({ colspan: 2, runs: [{ text: "Body " }, { text: "cell", hyperlink: { url: "https://example.com/cell" } }] });

      const zip = await renderManifest(root, "rich-table", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      const relsXml = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
      expect((slideXml.match(/<a:r>/g) ?? []).length).toBeGreaterThanOrEqual(4);
      expect(slideXml).toContain('b="1"');
      expect(slideXml).toContain("CC0000");
      expect(slideXml).toContain("gridSpan");
      expect(slideXml).toContain("vMerge");
      expect(slideXml).toContain("table__caption");
      expect(relsXml).toContain("https://example.com");
      expect(relsXml).toContain("https://example.com/cell");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps fidelity-first primitives separate from semantic-first native chart OOXML", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-chart-modes-"));
    try {
      const data = [
        { label: "A", series: { first: 2, second: 3 } },
        { label: "B", series: { first: 4, second: 1 } }
      ];
      const primitive = baseManifest([{ type: "chart", id: "primitive", kind: "groupedBar", x: 1, y: 1, w: 5, h: 3, data, style: { showLegend: false } }]);
      const native = baseManifest([{ type: "chart", id: "native", kind: "stackedBar", renderMode: "native", x: 1, y: 1, w: 5, h: 3, data, style: { showLegend: false } }]);
      const primitiveZip = await renderManifest(root, "primitive", primitive);
      const nativeZip = await renderManifest(root, "native", native);
      expect(Object.keys(primitiveZip.files).some((name) => /ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(false);
      expect(Object.keys(nativeZip.files).some((name) => /ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(true);
      const chartXml = await nativeZip.file("ppt/charts/chart1.xml").async("string");
      expect(chartXml).toContain("<c:chart");
      expect(chartXml).toContain('<c:barDir val="col"');
      expect(chartXml).toContain('<c:grouping val="stacked"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
