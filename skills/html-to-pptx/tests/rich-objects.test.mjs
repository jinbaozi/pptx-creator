import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { parse } from "node-html-parser";
import { convertHtmlToManifest, planReplicaElementBackgroundLayers, reconcileExplicitGroups } from "../scripts/lib/html-to-manifest-core.mjs";
import { auditStructureFidelity } from "../scripts/lib/structure-fidelity.mjs";
import { auditPptxGeometry } from "../scripts/lib/pptx-geometry-audit.mjs";
import { applyPptxGroups } from "../scripts/lib/group-renderer.mjs";
import { injectNativeCharts, suppressNativeChartDescendants } from "../scripts/convert.mjs";

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
  it("emits native pill geometry and preserves independent border lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-structure-geometry-"));
    try {
      const manifest = baseManifest([
        { type: "text", id: "heading", text: "Long heading text", renderedLines: ["Long heading", "text"], lineBreakOffsets: [12], x: 1, y: 0.3, w: 4, h: 0.4, style: { fontSize: 32, preserveWhitespace: false } },
        { type: "shape", id: "pill", shape: "pill", x: 1, y: 1, w: 3.333, h: 0.583, style: { backgroundColor: "#FFFFFF", borderWidth: 0, borderRadius: 28 } },
        { type: "shape", id: "card", shape: "roundRect", borderSides: [{ side: "top", width: 1.5, style: "solid", color: "#111111" }], x: 1, y: 2, w: 3, h: 1, style: { backgroundColor: "#FFFFFF", borderWidth: 0, borderRadius: 12 } },
        { type: "line", id: "card-top-border", x: 1, y: 2, w: 3, h: 0, style: { color: "#111111", width: 1.5 } }
      ]);
      const zip = await renderManifest(root, "structure-geometry", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      expect(slideXml).toContain('name="pill"');
      expect(slideXml).toContain('prst="roundRect"');
      expect(slideXml).toContain('name="adj" fmla="val 50000"');
      expect(slideXml).toContain('name="card-top-border"');
      expect(slideXml).not.toContain("<a:normAutofit");
      expect(slideXml).not.toContain("<a:spAutoFit");
      const report = await auditStructureFidelity({
        manifest,
        manifestPath: join(root, "structure-geometry.manifest.json"),
        pptxPath: join(root, "structure-geometry.pptx")
      });
      expect(report.bindings.manifestHash).toMatch(/^sha256:/);
      expect(report.bindings.pptxHash).toMatch(/^sha256:/);
      expect(report.summary.blocked).toBe(false);
      expect(report.headings[0]).toMatchObject({ elementId: "heading", passed: true });
      expect(report.shapes.find((entry) => entry.elementId === "pill")).toMatchObject({ expectedShape: "roundRect", actualShape: "roundRect", passed: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders planned multi-gradient element layers with alpha and radial glow OOXML", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-element-gradient-layers-"));
    try {
      const measurement = {
        id: "layered-card",
        kind: "shape",
        x: 1,
        y: 1,
        w: 4,
        h: 2,
        px: { x: 96, y: 96, w: 384, h: 192 },
        style: {
          backgroundColor: "#112233",
          backgroundImage: "radial-gradient(circle at 82% 18%, rgba(36, 87, 230, 0.55), transparent 90%), linear-gradient(135deg, #F6F7FB, rgba(232, 238, 255, 0.5)), linear-gradient(180deg, #FFFFFF, #DDEAFE)",
          borderColor: "#2457E6",
          borderWidth: 1,
          borderStyle: "solid",
          borderTopWidth: 2,
          borderRightWidth: 1,
          borderBottomWidth: 1,
          borderLeftWidth: 1,
          borderTopStyle: "solid",
          borderRightStyle: "solid",
          borderBottomStyle: "solid",
          borderLeftStyle: "solid",
          borderTopColor: "#2457E6",
          borderRightColor: "#2457E6",
          borderBottomColor: "#2457E6",
          borderLeftColor: "#2457E6",
          boxShadow: "rgba(0, 0, 0, 0.25) 2px 4px 6px",
          cornerRadii: [{ rx: 12, ry: 12 }, { rx: 12, ry: 12 }, { rx: 12, ry: 12 }, { rx: 12, ry: 12 }]
        },
        replica: { hasUnsupportedEffects: true }
      };
      const layers = planReplicaElementBackgroundLayers("layered-card", measurement);
      const manifest = baseManifest(layers);
      const zip = await renderManifest(root, "element-gradient-layers", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      const orderedNames = [
        "layered-card",
        "layered-card-background-gradient-001",
        "layered-card-background-gradient-002",
        "layered-card-radial-glow-001",
        "layered-card-top-border"
      ];
      for (let index = 0; index < orderedNames.length - 1; index += 1) {
        expect(slideXml.indexOf(`name="${orderedNames[index]}"`)).toBeLessThan(slideXml.indexOf(`name="${orderedNames[index + 1]}"`));
      }
      expect((slideXml.match(/<a:gradFill/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect(slideXml).toContain("<a:alpha val=\"55000\"/>");
      expect(slideXml).toContain('<a:path path="circle">');
      expect(slideXml).toContain("<a:outerShdw");
      expect(slideXml).not.toContain("<p:pic>");
      expect(manifest.slides[0].elements.every((element) => !["image", "cropped-asset"].includes(element.type))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("audits pre/code text, exact border side structure, and rich heading breaks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-structure-audit-"));
    try {
      const manifest = baseManifest([
        {
          type: "text",
          id: "code",
          text: "  alpha\t beta\n    gamma  ",
          x: 1,
          y: 0.3,
          w: 4,
          h: 0.8,
          style: { fontSize: 12, whiteSpace: "pre", preserveWhitespace: true }
        },
        {
          type: "text",
          id: "rich-heading",
          text: "Alpha beta gamma delta",
          renderedLines: ["Alpha beta", "gamma", "delta"],
          lineBreakOffsets: [10, 16],
          x: 1,
          y: 1.3,
          w: 4,
          h: 0.8,
          style: { fontSize: 32, whiteSpace: "normal", preserveWhitespace: false },
          runs: [
            { text: "Alpha ", fontFamily: "Arial", fontSize: 32, fontWeight: 700, fontStyle: "normal", color: "#111111" },
            { text: "beta gamma", fontFamily: "Arial", fontSize: 32, fontWeight: 700, fontStyle: "normal", color: "#CC0000" },
            { text: " delta", fontFamily: "Arial", fontSize: 32, fontWeight: 700, fontStyle: "normal", color: "#111111" }
          ]
        },
        {
          type: "shape",
          id: "full-outline-with-top",
          shape: "roundRect",
          borderSides: [{ side: "top", width: 1, style: "solid", color: "#111111" }],
          x: 1,
          y: 2.4,
          w: 2,
          h: 0.8,
          style: { backgroundColor: "#FFFFFF", borderWidth: 1, borderRadius: 12 }
        },
        { type: "line", id: "full-outline-with-top-top-border", x: 1, y: 2.4, w: 2, h: 0, style: { color: "#111111", width: 1 } },
        {
          type: "shape",
          id: "extra-side",
          shape: "rect",
          borderSides: [{ side: "top", width: 1, style: "solid", color: "#111111" }],
          x: 4,
          y: 2.4,
          w: 2,
          h: 0.8,
          style: { backgroundColor: "#FFFFFF", borderWidth: 0 }
        },
        { type: "line", id: "extra-side-top-border", x: 4, y: 2.4, w: 2, h: 0, style: { color: "#111111", width: 1 } },
        { type: "line", id: "extra-side-right-border", x: 6, y: 2.4, w: 0, h: 0.8, style: { color: "#111111", width: 1 } }
      ]);
      const manifestPath = join(root, "structure-audit.manifest.json");
      const pptxPath = join(root, "structure-audit.pptx");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await execFileAsync(process.execPath, ["scripts/render-pptx.mjs", manifestPath, pptxPath], { cwd: resolve("."), maxBuffer: 10 * 1024 * 1024 });
      const report = await auditStructureFidelity({ manifest, manifestPath, pptxPath });
      expect(report.text.find((entry) => entry.elementId === "code")).toMatchObject({ passed: true });
      expect(report.code.find((entry) => entry.elementId === "code")).toMatchObject({
        expectedLineCount: 2,
        actualLineCount: 2,
        expectedLeadingSpaces: [2, 4],
        actualLeadingSpaces: [2, 4],
        passed: true
      });
      expect(report.text.find((entry) => entry.elementId === "rich-heading")).toMatchObject({ passed: true });
      expect(report.headings.find((entry) => entry.elementId === "rich-heading")).toMatchObject({
        expectedLineBreakOffsets: [10, 16],
        actualLineBreakOffsets: [10, 16],
        passed: true
      });
      expect(report.borders.find((entry) => entry.elementId === "full-outline-with-top")).toMatchObject({
        actualBorderSides: ["top", "right", "bottom", "left"],
        baseShapeHasFullOutline: true,
        unexpectedFullOutline: true,
        passed: false
      });
      expect(report.borders.find((entry) => entry.elementId === "extra-side")).toMatchObject({
        actualBorderSides: ["top", "right"],
        unexpectedFullOutline: false,
        passed: false
      });
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "full-outline-with-top", kind: "border-sides" }),
        expect.objectContaining({ elementId: "extra-side", kind: "border-sides" })
      ]));
      expect(report.summary.blocked).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("renders native line, area, and lineArea charts with exact chart OOXML and relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-native-line-charts-"));
    try {
      const data = [
        { label: "A", value: 1 },
        { label: "B", value: 2 }
      ];
      const manifest = baseManifest([
        { type: "chart", id: "line-native", kind: "line", renderMode: "native", x: 1, y: 1, w: 3, h: 2, data },
        { type: "chart", id: "area-native", kind: "area", renderMode: "semantic", x: 4.5, y: 1, w: 3, h: 2, data },
        { type: "chart", id: "combo-native", kind: "lineArea", renderMode: "native", x: 8, y: 1, w: 4, h: 2, data }
      ]);
      const zip = await renderManifest(root, "native-line-charts", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      const chartXml = await Promise.all(["chart1.xml", "chart2.xml", "chart3.xml"].map((name) => zip.file(`ppt/charts/${name}`).async("string")));
      const relsXml = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");

      expect(slideXml).toContain('name="line-native"');
      expect(slideXml).toContain('name="area-native"');
      expect(slideXml).toContain('name="combo-native"');
      expect(chartXml[0]).toContain("<c:lineChart");
      expect(chartXml[0]).not.toContain("<c:areaChart");
      expect(chartXml[1]).toContain("<c:areaChart");
      expect(chartXml[1]).not.toContain("<c:lineChart");
      expect(chartXml[2]).toContain("<c:areaChart");
      expect(chartXml[2]).toContain("<c:lineChart");
      expect((relsXml.match(/Type=\"[^\"]*\/chart\"/g) ?? []).length).toBe(3);

      const report = await auditStructureFidelity({
        manifest,
        manifestPath: join(root, "native-line-charts.manifest.json"),
        pptxPath: join(root, "native-line-charts.pptx")
      });
      expect(report.charts).toHaveLength(3);
      expect(report.charts).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "line-native", expectedKind: "line", actualKind: "line", passed: true }),
        expect.objectContaining({ elementId: "area-native", expectedKind: "area", actualKind: "area", passed: true }),
        expect.objectContaining({ elementId: "combo-native", expectedKind: "lineArea", actualKind: "lineArea", passed: true })
      ]));
      expect(report.summary.blocked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes explicit flat groups as editable OOXML while preserving a child chart relationship", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-explicit-group-"));
    try {
      const data = [{ label: "A", value: 1 }, { label: "B", value: 2 }];
      const manifest = baseManifest([
        { type: "group", id: "group-001", children: ["shape-a", "chart-a"], x: 1, y: 1, w: 7, h: 3 },
        { type: "shape", id: "shape-a", shape: "roundRect", x: 1, y: 1, w: 2, h: 1, style: { backgroundColor: "#FFFFFF", borderWidth: 0 } },
        { type: "chart", id: "chart-a", kind: "line", renderMode: "native", x: 3.5, y: 1, w: 4, h: 2, data }
      ]);
      const zip = await renderManifest(root, "explicit-group", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      const relsXml = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
      expect((slideXml.match(/<p:grpSp>/g) ?? []).length).toBe(1);
      expect(slideXml.indexOf('name="group-001"')).toBeLessThan(slideXml.indexOf('name="shape-a"'));
      expect(slideXml.indexOf('name="shape-a"')).toBeLessThan(slideXml.indexOf('name="chart-a"'));
      expect(slideXml).toContain('<a:chOff x="914400" y="914400"/>');
      expect(slideXml).toContain('<a:chExt cx="6400800" cy="2743200"/>');
      expect((relsXml.match(/Type="[^"]*\/chart"/g) ?? []).length).toBe(1);
      const report = await auditStructureFidelity({
        manifest,
        manifestPath: join(root, "explicit-group.manifest.json"),
        pptxPath: join(root, "explicit-group.pptx")
      });
      expect(report.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "group-001", expectedChildren: ["shape-a", "chart-a"], passed: true })
      ]));
      expect(report.charts).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "chart-a", chartRelId: expect.any(String), passed: true })
      ]));
      expect(report.summary.blocked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles explicit groups across HTML conversion, native chart injection, suppression, and rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-explicit-group-chain-"));
    try {
      const html = `<section class="pptx-slide" data-slide-id="slide-001">
        <div data-pptx-kind="group" data-pptx-id="group-chain" data-x="1" data-y="1" data-w="8" data-h="3">
          <div data-pptx-kind="shape" data-pptx-id="shape-chain" data-x="1" data-y="1" data-w="2" data-h="1"></div>
          <div data-pptx-kind="text" data-pptx-id="text-chain" data-x="3.5" data-y="1" data-w="2" data-h="0.5">Chain</div>
          <div data-pptx-kind="chart" data-pptx-id="chart-chain" data-x="5.5" data-y="1" data-w="3.5" data-h="2" data-pptx-chart='{"kind":"line","renderMode":"native","data":[{"label":"A","value":1},{"label":"B","value":2}]}'><span data-pptx-kind="text" data-pptx-id="chart-chain-label" data-x="5.5" data-y="2.5" data-w="1" data-h="0.2">A</span></div>
        </div>
      </section>`;
      const baseStyle = { color: "#111111", fontSize: 16, backgroundColor: "#FFFFFF", borderWidth: 0 };
      const measurementDocument = {
        viewport: { width: 1280, height: 720 },
        slides: [{ slideId: "slide-001", slideIndex: 0 }],
        elements: [
          { id: "group-chain", slideId: "slide-001", slideIndex: 0, kind: "group", x: 1, y: 1, w: 8, h: 3, style: {} },
          { id: "shape-chain", slideId: "slide-001", slideIndex: 0, kind: "shape", x: 1, y: 1, w: 2, h: 1, style: { ...baseStyle, backgroundColor: "#FFFFFF" } },
          { id: "text-chain", slideId: "slide-001", slideIndex: 0, kind: "text", x: 3.5, y: 1, w: 2, h: 0.5, style: baseStyle, text: "Chain" },
          { id: "chart-chain", slideId: "slide-001", slideIndex: 0, kind: "chart", x: 5.5, y: 1, w: 3.5, h: 2, style: {} },
          { id: "chart-chain-label", slideId: "slide-001", slideIndex: 0, kind: "text", x: 5.5, y: 2.5, w: 1, h: 0.2, style: baseStyle, text: "A" }
        ]
      };
      const manifest = convertHtmlToManifest(html, {
        measurements: measurementDocument,
        designMode: "replica",
        designSystemSource: designSource
      });
      expect(manifest.slides[0].elements.find((element) => element.id === "group-chain").children).toEqual([
        "shape-chain",
        "text-chain-box",
        "text-chain",
        "chart-chain-label-box",
        "chart-chain-label"
      ]);

      injectNativeCharts(html, manifest, measurementDocument);
      suppressNativeChartDescendants(html, manifest, measurementDocument);
      reconcileExplicitGroups(parse(html), manifest, measurementDocument);
      const group = manifest.slides[0].elements.find((element) => element.id === "group-chain");
      expect(group.children).toEqual(["shape-chain", "text-chain-box", "text-chain", "chart-chain"]);
      expect(manifest.slides[0].elements.map((element) => element.id)).toEqual([
        "group-chain",
        "shape-chain",
        "text-chain-box",
        "text-chain",
        "chart-chain"
      ]);

      const zip = await renderManifest(root, "explicit-group-chain", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      expect((slideXml.match(/<p:grpSp>/g) ?? []).length).toBe(1);
      expect(slideXml.indexOf('name="shape-chain"')).toBeLessThan(slideXml.indexOf('name="text-chain"'));
      expect(slideXml.indexOf('name="text-chain"')).toBeLessThan(slideXml.indexOf('name="chart-chain"'));
      expect((slideXml.match(/name="chart-chain-label"/g) ?? []).length).toBe(0);
      expect((await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string")).match(/Type="[^"]*\/chart"/g)).toHaveLength(1);
      const structure = await auditStructureFidelity({
        manifest,
        manifestPath: join(root, "explicit-group-chain.manifest.json"),
        pptxPath: join(root, "explicit-group-chain.pptx")
      });
      const geometry = await auditPptxGeometry(join(root, "explicit-group-chain.pptx"), manifest);
      expect(structure.summary.blocked).toBe(false);
      expect(geometry.summary.blocked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit grid as one top-level editable group while unmarked lines remain auditable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-explicit-grid-group-"));
    try {
      const lines = [1, 2, 3, 4].map((y, index) => ({
        type: "line",
        id: `grid-${index + 1}`,
        x: 0,
        y,
        w: 13.333,
        h: 0,
        role: "decoration",
        style: { color: "#DDDDDD", width: 1 }
      }));
      const manifest = baseManifest([
        { type: "group", id: "grid-group", children: lines.map((line) => line.id), x: 0, y: 0, w: 13.333, h: 7.5, role: "background", backgroundKind: "grid" },
        ...lines
      ]);
      const zip = await renderManifest(root, "explicit-grid", manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      expect((slideXml.match(/<p:grpSp>/g) ?? []).length).toBe(1);
      const structure = await auditStructureFidelity({ manifest, pptxPath: join(root, "explicit-grid.pptx") });
      expect(structure.groupSlides[0]).toMatchObject({ expectedGridCount: 1, actualGridCount: 1, passed: true });
      const geometry = await auditPptxGeometry(join(root, "explicit-grid.pptx"), manifest);
      expect(geometry.slides[0]).toMatchObject({ backgroundGridTopLevelObjects: 1, actualGroupCount: 1 });
      expect(geometry.summary.blocked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allocates group cNvPr IDs independently for each slide", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-explicit-group-slide-ids-"));
    try {
      const slideElements = (prefix) => [
        { type: "shape", id: `${prefix}-a`, shape: "rect", x: 1, y: 1, w: 2, h: 1, style: { backgroundColor: "#FFFFFF", borderWidth: 0 } },
        { type: "shape", id: `${prefix}-b`, shape: "rect", x: 3.5, y: 1, w: 2, h: 1, style: { backgroundColor: "#FFFFFF", borderWidth: 0 } }
      ];
      const base = {
        ...baseManifest([]),
        slides: [
          { id: "slide-001", title: "", background: { type: "solid", color: "#FFFFFF" }, elements: slideElements("one") },
          { id: "slide-002", title: "", background: { type: "solid", color: "#FFFFFF" }, elements: slideElements("two") }
        ]
      };
      const grouped = {
        ...base,
        slides: base.slides.map((slide, index) => ({
          ...slide,
          elements: [{ type: "group", id: `group-${index + 1}`, children: slide.elements.map((element) => element.id), x: 1, y: 1, w: 7, h: 3 }, ...slide.elements]
        }))
      };
      await renderManifest(root, "two-slide-base", base);
      const pptxPath = join(root, "two-slide-base.pptx");
      const zip = await JSZip.loadAsync(await readFile(pptxPath));
      const slide2Xml = await zip.file("ppt/slides/slide2.xml").async("string");
      zip.file("ppt/slides/slide2.xml", slide2Xml.replace(/<p:cNvPr id="\d+"/, '<p:cNvPr id="9999"'));
      await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
      await applyPptxGroups(pptxPath, grouped);
      const groupedZip = await JSZip.loadAsync(await readFile(pptxPath));
      for (const slideNumber of [1, 2]) {
        const xml = await groupedZip.file(`ppt/slides/slide${slideNumber}.xml`).async("string");
        const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((match) => match[1]);
        expect(new Set(ids).size).toBe(ids.length);
        expect(xml).toContain(`name="group-${slideNumber}"`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks missing, leaked, reordered, and transformed group children", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-explicit-group-negative-"));
    try {
      const elements = [
        { type: "group", id: "group-001", children: ["shape-a", "shape-b"], x: 1, y: 1, w: 7, h: 3 },
        { type: "shape", id: "shape-a", shape: "rect", x: 1, y: 1, w: 2, h: 1, style: { backgroundColor: "#FFFFFF", borderWidth: 0 } },
        { type: "shape", id: "shape-b", shape: "rect", x: 3.5, y: 1, w: 2, h: 1, style: { backgroundColor: "#FFFFFF", borderWidth: 0 } }
      ];
      const manifest = baseManifest(elements);
      await renderManifest(root, "group-negative-base", manifest);
      const basePptx = join(root, "group-negative-base.pptx");

      const missingManifest = baseManifest([
        { ...elements[0], children: ["shape-a", "missing-child"] },
        elements[1],
        elements[2]
      ]);
      const missingStructure = await auditStructureFidelity({ manifest: missingManifest, pptxPath: basePptx });
      const missingGeometry = await auditPptxGeometry(basePptx, missingManifest);
      expect(missingStructure.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-ungrouped-child", severity: "critical" })
      ]));
      expect(missingGeometry.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-ungrouped-child", severity: "critical" })
      ]));

      const baseZip = await JSZip.loadAsync(await readFile(basePptx));
      const baseSlideXml = await baseZip.file("ppt/slides/slide1.xml").async("string");
      const childA = baseSlideXml.match(/<p:sp>[\s\S]*?name="shape-a"[\s\S]*?<\/p:sp>/)?.[0];
      expect(childA).toBeTruthy();
      const leakedZip = await JSZip.loadAsync(await readFile(basePptx));
      const leakedXml = baseSlideXml.replace("</p:spTree>", `${childA}</p:spTree>`);
      leakedZip.file("ppt/slides/slide1.xml", leakedXml);
      const leakedPptx = join(root, "group-leaked-child.pptx");
      await writeFile(leakedPptx, await leakedZip.generateAsync({ type: "nodebuffer" }));
      const leakedStructure = await auditStructureFidelity({ manifest, pptxPath: leakedPptx });
      const leakedGeometry = await auditPptxGeometry(leakedPptx, manifest);
      expect(leakedStructure.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-ungrouped-child", severity: "critical" })
      ]));
      expect(leakedGeometry.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-ungrouped-child", severity: "critical" })
      ]));

      const groupXml = baseSlideXml.match(/<p:grpSp>[\s\S]*?<\/p:grpSp>/)?.[0];
      const childBlocks = [...(groupXml ?? "").matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((match) => match[0]);
      expect(childBlocks).toHaveLength(2);
      const reorderedGroup = groupXml.replace(childBlocks[0], "__GROUP_CHILD_A__").replace(childBlocks[1], childBlocks[0]).replace("__GROUP_CHILD_A__", childBlocks[1]);
      const reorderedZip = await JSZip.loadAsync(await readFile(basePptx));
      reorderedZip.file("ppt/slides/slide1.xml", baseSlideXml.replace(groupXml, reorderedGroup));
      const reorderedPptx = join(root, "group-reordered-child.pptx");
      await writeFile(reorderedPptx, await reorderedZip.generateAsync({ type: "nodebuffer" }));
      const reorderedStructure = await auditStructureFidelity({ manifest, pptxPath: reorderedPptx });
      const reorderedGeometry = await auditPptxGeometry(reorderedPptx, manifest);
      expect(reorderedStructure.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-child-order", severity: "critical" })
      ]));
      expect(reorderedGeometry.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-child-order", severity: "critical" })
      ]));

      const transformedZip = await JSZip.loadAsync(await readFile(basePptx));
      const transformedXml = baseSlideXml.replace('<a:chExt cx="6400800" cy="2743200"/>', '<a:chExt cx="6400801" cy="2743200"/>');
      transformedZip.file("ppt/slides/slide1.xml", transformedXml);
      const transformedPptx = join(root, "group-wrong-transform.pptx");
      await writeFile(transformedPptx, await transformedZip.generateAsync({ type: "nodebuffer" }));
      const transformedStructure = await auditStructureFidelity({ manifest, pptxPath: transformedPptx });
      const transformedGeometry = await auditPptxGeometry(transformedPptx, manifest);
      expect(transformedStructure.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-transform", severity: "critical" })
      ]));
      expect(transformedGeometry.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-transform", severity: "critical" })
      ]));

      const childTransformedZip = await JSZip.loadAsync(await readFile(basePptx));
      const childShapeXml = baseSlideXml.match(/<p:sp>[\s\S]*?name="shape-a"[\s\S]*?<\/p:sp>/)?.[0];
      expect(childShapeXml).toBeTruthy();
      const childTransformedXml = baseSlideXml.replace(childShapeXml, childShapeXml.replace('<a:off x="914400" y="914400"/>', '<a:off x="914401" y="914400"/>'));
      childTransformedZip.file("ppt/slides/slide1.xml", childTransformedXml);
      const childTransformedPptx = join(root, "group-wrong-child-transform.pptx");
      await writeFile(childTransformedPptx, await childTransformedZip.generateAsync({ type: "nodebuffer" }));
      const childTransformedStructure = await auditStructureFidelity({ manifest, pptxPath: childTransformedPptx });
      const childTransformedGeometry = await auditPptxGeometry(childTransformedPptx, manifest);
      expect(childTransformedStructure.groups[0]).toMatchObject({ childTransformMismatches: [expect.objectContaining({ childId: "shape-a" })], passed: false });
      expect(childTransformedStructure.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-child-transform", severity: "critical" })
      ]));
      expect(childTransformedGeometry.slides[0].childTransformMismatches).toEqual([
        expect.objectContaining({ groupId: "group-001", mismatches: [expect.objectContaining({ childId: "shape-a" })] })
      ]);
      expect(childTransformedGeometry.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group-child-transform", severity: "critical" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks native chart type, count, and primitive-expansion mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-native-chart-negative-"));
    try {
      const data = [{ label: "A", value: 1 }, { label: "B", value: 2 }];
      const oneChart = baseManifest([
        { type: "chart", id: "line-native", kind: "line", renderMode: "native", x: 1, y: 1, w: 4, h: 2, data }
      ]);
      const oneChartPptx = join(root, "one-chart.pptx");
      await renderManifest(root, "one-chart", oneChart);

      const typeZip = await JSZip.loadAsync(await readFile(oneChartPptx));
      const originalChartXml = await typeZip.file("ppt/charts/chart1.xml").async("string");
      typeZip.file("ppt/charts/chart1.xml", originalChartXml
        .replaceAll("<c:lineChart", "<c:areaChart")
        .replaceAll("</c:lineChart>", "</c:areaChart>"));
      const typePptx = join(root, "type-mismatch.pptx");
      await writeFile(typePptx, await typeZip.generateAsync({ type: "nodebuffer" }));
      const typeReport = await auditStructureFidelity({
        manifest: oneChart,
        manifestPath: join(root, "one-chart.manifest.json"),
        pptxPath: typePptx
      });
      expect(typeReport.charts[0]).toMatchObject({ actualType: "area", actualKind: "area", passed: false });
      expect(typeReport.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "line-native", kind: "chart-type", severity: "critical" })
      ]));

      const twoCharts = baseManifest([
        ...oneChart.slides[0].elements,
        { type: "chart", id: "second-native", kind: "area", renderMode: "native", x: 6, y: 1, w: 4, h: 2, data }
      ]);
      const twoChartsManifestPath = join(root, "two-charts.manifest.json");
      await writeFile(twoChartsManifestPath, `${JSON.stringify(twoCharts, null, 2)}\n`, "utf8");
      const countReport = await auditStructureFidelity({ manifest: twoCharts, manifestPath: twoChartsManifestPath, pptxPath: oneChartPptx });
      expect(countReport.chartSlides[0]).toMatchObject({ expectedNativeCount: 2, actualChartCount: 1, passed: false });
      expect(countReport.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "chart-count", severity: "critical" })
      ]));

      const expansionZip = await JSZip.loadAsync(await readFile(oneChartPptx));
      const slideXml = await expansionZip.file("ppt/slides/slide1.xml").async("string");
      const primitive = `<p:sp><p:nvSpPr><p:cNvPr id="99" name="line-native__chart__primitive"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
      expansionZip.file("ppt/slides/slide1.xml", slideXml.replace("</p:spTree>", `${primitive}</p:spTree>`));
      const expansionPptx = join(root, "primitive-expansion.pptx");
      await writeFile(expansionPptx, await expansionZip.generateAsync({ type: "nodebuffer" }));
      const expansionReport = await auditStructureFidelity({ manifest: oneChart, manifestPath: join(root, "one-chart.manifest.json"), pptxPath: expansionPptx });
      expect(expansionReport.charts[0]).toMatchObject({ noPrimitiveExpansion: false, passed: false });
      expect(expansionReport.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "line-native", kind: "chart-expansion", severity: "critical" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
