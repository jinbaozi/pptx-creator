import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { analyzeAccessibility } from "../scripts/analyze-accessibility.mjs";
import { normalizeLineGeometry, primaryFontFamily } from "../scripts/render-pptx.mjs";
import { auditPptxGeometry } from "../scripts/lib/pptx-geometry-audit.mjs";

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));

async function slideXml(pptxPath) {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const files = Object.keys(zip.files).filter((name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"));
  const xml = await Promise.all(files.map((name) => zip.files[name].async("string")));
  return xml.join("\n");
}

describe("render-pptx", () => {
  it("normalizes all line quadrants to positive PPTX extents without moving logical endpoints", () => {
    expect(normalizeLineGeometry({ id: "q1", x: 3, y: 3, w: 2, h: 2 })).toEqual({ x: 3, y: 3, w: 2, h: 2, flipH: false, flipV: false });
    expect(normalizeLineGeometry({ id: "q2", x: 3, y: 3, w: -2, h: 2 })).toEqual({ x: 1, y: 3, w: 2, h: 2, flipH: true, flipV: false });
    expect(normalizeLineGeometry({ id: "q3", x: 3, y: 3, w: -2, h: -2 })).toEqual({ x: 1, y: 1, w: 2, h: 2, flipH: true, flipV: true });
    expect(normalizeLineGeometry({ id: "q4", x: 3, y: 3, w: 2, h: -2 })).toEqual({ x: 3, y: 1, w: 2, h: 2, flipH: false, flipV: true });
  });

  it("writes no negative cx/cy for left, up, and diagonal arrows and preserves target end markers", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-line-quadrants-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      { type: "line", role: "axis", axisDirection: "right", id: "q1", x: 1, y: 1, w: 2, h: 2, style: { endArrowType: "triangle" } },
      { type: "line", role: "axis", axisDirection: "left", id: "q2", x: 5, y: 1, w: -2, h: 2, style: { endArrowType: "triangle" } },
      { type: "line", role: "axis", axisDirection: "left", id: "q3", x: 5, y: 5, w: -2, h: -2, style: { endArrowType: "triangle" } },
      { type: "line", role: "axis", axisDirection: "up", id: "q4", x: 7, y: 5, w: 2, h: -2, style: { endArrowType: "triangle" } }
    ];
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifestPath, JSON.stringify(sample, null, 2), "utf8");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root });
    const xml = await slideXml(pptxPath);
    expect(xml).not.toMatch(/<a:ext[^>]*(?:cx|cy)="-/);
    expect(xml.match(/<a:tailEnd type="triangle"\/>/g)).toHaveLength(4);
    const report = await auditPptxGeometry(pptxPath, sample);
    expect(report.summary).toMatchObject({ criticalCount: 0, blocked: false });
  });

  it("blocks viewer-dependent autofit on a critical title in final PPTX XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-title-autofit-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "text", id: "slide-title", role: "title", maxLines: 1,
      x: 0.8, y: 0.6, w: 11.7, h: 0.6, text: "Measured title",
      style: { fontSize: 28, lineHeight: 1.2 }
    }];
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifestPath, JSON.stringify(sample, null, 2), "utf8");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root });
    expect(await slideXml(pptxPath)).not.toMatch(/<a:(?:normAutofit|spAutoFit)\b/);

    const zip = await JSZip.loadAsync(await readFile(pptxPath));
    const slidePath = "ppt/slides/slide1.xml";
    let xml = await zip.file(slidePath).async("string");
    if (/<a:bodyPr\b[^>]*\/>/.test(xml)) {
      xml = xml.replace(/<a:bodyPr\b([^>]*)\/>/, "<a:bodyPr$1><a:normAutofit/></a:bodyPr>");
    } else {
      xml = xml.replace(/<a:bodyPr\b([^>]*)>/, "<a:bodyPr$1><a:normAutofit/>");
    }
    zip.file(slidePath, xml);
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));

    const report = await auditPptxGeometry(pptxPath, sample);
    expect(report.findings).toContainEqual(expect.objectContaining({
      elementId: "slide-title",
      kind: "viewer-dependent-autofit",
      severity: "critical"
    }));
    expect(report.summary.blocked).toBe(true);
  });

  it("blocks generic Office object names that cannot prove manifest lineage", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-generic-lineage-"));
    const pptxPath = join(outputDir, "external.pptx");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text 1"/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld>
      </p:sld>`);
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
    const report = await auditPptxGeometry(pptxPath, { slides: [{ id: "slide-001", elements: [] }] });
    expect(report.findings).toContainEqual(expect.objectContaining({
      elementId: "Text 1",
      kind: "pptx-object-lineage",
      severity: "critical"
    }));
  });

  it("rechecks content occlusion against final PPTX object geometry", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-final-occlusion-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      { type: "shape", id: "core-content", x: 1, y: 1, w: 3, h: 2, shape: "rect", style: { fill: "#2563EB" } },
      { type: "text", id: "blocking-label", x: 3.5, y: 1.5, w: 2, h: 0.8, text: "Blocked", style: { fontSize: 18 } }
    ];
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifestPath, JSON.stringify(sample, null, 2), "utf8");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root });

    const report = await auditPptxGeometry(pptxPath, sample);
    expect(report.findings).toContainEqual(expect.objectContaining({
      slideId: sample.slides[0].id,
      elementId: "core-content",
      kind: "content-occlusion",
      severity: "critical"
    }));
    expect(report.summary.blocked).toBe(true);

    const compositionOnlyRelaxed = await auditPptxGeometry(pptxPath, sample, { allowCompositionViolation: true });
    expect(compositionOnlyRelaxed.findings).toContainEqual(expect.objectContaining({
      kind: "content-occlusion",
      severity: "critical"
    }));
    expect(compositionOnlyRelaxed.summary.blocked).toBe(true);

    sample.metadata.mode = "replica";
    sample.metadata.inputType = "image";
    const sourcePreservingReplica = await auditPptxGeometry(pptxPath, sample);
    expect(sourcePreservingReplica.findings.find((finding) => finding.kind === "content-occlusion")).toBeUndefined();
  });

  it("rechecks dominant empty bands against final PPTX object geometry", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-final-whitespace-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].type = "content";
    sample.slides[0].elements = [
      { type: "shape", id: "module-a", x: 0.8, y: 0.8, w: 2, h: 1.2, shape: "rect", style: { fill: "#EEF2FF" } },
      { type: "shape", id: "module-b", x: 3.1, y: 0.8, w: 2, h: 1.2, shape: "rect", style: { fill: "#E0E7FF" } }
    ];
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifestPath, JSON.stringify(sample, null, 2), "utf8");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root });

    const report = await auditPptxGeometry(pptxPath, sample);
    expect(report.findings).toContainEqual(expect.objectContaining({
      slideId: sample.slides[0].id,
      elementId: "__slide__",
      kind: "excessive-whitespace",
      severity: "critical"
    }));
    expect(report.summary.blocked).toBe(true);

    const explicitlyRelaxed = await auditPptxGeometry(pptxPath, sample, { allowCompositionViolation: true });
    expect(explicitlyRelaxed.findings.find((finding) => finding.kind === "excessive-whitespace")).toBeUndefined();
    expect(explicitlyRelaxed.summary.blocked).toBe(false);
  });

  it("reduces CSS font stacks to one valid PowerPoint font face", () => {
    expect(primaryFontFamily('Arial, "PingFang SC", sans-serif')).toBe("Arial");
    expect(primaryFontFamily('"PingFang SC", sans-serif')).toBe("PingFang SC");
    expect(primaryFontFamily('Arial, "PingFang SC", sans-serif', "Arial", "中文")).toBe("PingFang SC");
    expect(primaryFontFamily("system-ui, sans-serif", "Aptos")).toBe("Aptos");
  });

  it("renders lineHeight ratios as PowerPoint line-spacing multiples", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-line-height-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "text",
      id: "line-height-copy",
      x: 0.8,
      y: 1.0,
      w: 4.0,
      h: 1.4,
      text: "First line\nSecond line",
      style: { fontSize: 18, lineHeight: 1.5 }
    }];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('<a:spcPct val="150000"/>');
    expect(xml).not.toMatch(/<a:spcPts val="(?:150|1\.5)"\/>/);
  });

  it("lets explicit fitted font settings override typography tokens", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-fitted-token-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "text", id: "fitted-title", x: 1, y: 1, w: 5, h: 1,
      text: "Fitted title", style: { typography: "{typography.title}", fontSize: 17, fontFamily: "Arial" }
    }];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('sz="1700"');
    expect(xml).toContain('typeface="Arial"');
  });

  it("renders orthogonal semantic routes as editable bent connectors", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-orthogonal-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "line", role: "connector", id: "orthogonal", x: 2, y: 2, w: 4, h: 2,
      connector: { sourceId: "source", targetId: "target", sourceAnchor: "right", targetAnchor: "left", route: "orthogonal" },
      style: { color: "#2563EB", width: 2, endArrowType: "triangle" }
    }];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });
    expect(await slideXml(pptxPath)).toContain('prst="bentConnector3"');
  });

  it("renders tokenized manifest to pptx without owning pipeline reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-creator-"));
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    expect((await stat(pptxPath)).size).toBeGreaterThan(1000);
    for (const report of ["editable-report.md", "qa-report.md", "compatibility-report.md"]) {
      await expect(readFile(join(outputDir, report), "utf8")).rejects.toThrow();
    }

    expect(await slideXml(pptxPath)).toContain("AI");
  });

  it("renders bar chart elements as native shapes and text", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-chart-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements.push({
      type: "chart",
      kind: "bar",
      id: "chart-001",
      x: 0.8,
      y: 4.5,
      w: 5.2,
      h: 1.8,
      data: [
        { label: "Q1", value: 12 },
        { label: "Q2", value: 18 }
      ],
      style: { color: "{colors.primary}" }
    });
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Q1");
    expect(xml).toContain("Q2");
    expect(xml).toContain("18");
  });

  it("renders icon elements as native editable marks", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-icon-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements.push({
      type: "icon",
      name: "info",
      id: "info-icon",
      x: 6.0,
      y: 4.5,
      w: 0.5,
      h: 0.5,
      style: { color: "{colors.primary}" }
    });
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    expect(await slideXml(pptxPath)).toContain("i");
  });

  it("renders arrow-right icons without negative line extents", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-arrow-icon-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements.push({
      type: "icon",
      name: "arrow-right",
      id: "arrow-icon",
      x: 6.0,
      y: 4.5,
      w: 0.6,
      h: 0.35,
      style: { color: "{colors.primary}" }
    }, {
      type: "icon", name: "check", id: "check-icon", x: 7.0, y: 4.5, w: 0.6, h: 0.35,
      style: { color: "{colors.primary}" }
    }, {
      type: "icon", name: "x", id: "x-icon", x: 8.0, y: 4.5, w: 0.6, h: 0.35,
      style: { color: "{colors.primary}" }
    });
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).not.toMatch(/<a:ext[^>]*\s(?:cx|cy)="-/);
  });

  it("renders diagram elements as editable native shapes and text", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-diagram-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements.push({
      type: "diagram",
      kind: "layeredArchitecture",
      id: "diagram-001",
      x: 0.8,
      y: 1.2,
      w: 10.5,
      h: 4.5,
      layers: [
        { label: "Frontend", nodes: ["Lexer", "Parser"] },
        { label: "Middle End", nodes: ["IR", "Optimize"] },
        { label: "Backend", nodes: ["Codegen", "Assemble"] }
      ],
      style: { theme: "business-tech" }
    });
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Frontend");
    expect(xml).toContain("Optimize");
    expect(xml).toContain("tailEnd");
    expect(xml).toContain('type="triangle"');
  });

  it("renders native table fill, text, and border styling into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-table-style-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "table",
        id: "metrics",
        x: 0.8,
        y: 1.0,
        w: 4.5,
        h: 1.2,
        headers: ["Metric", "Value"],
        rows: [["ARR", "$12M"]],
        style: {
          fill: "#F8FAFC",
          headerFill: "#F8FAFC",
          borderColor: "#2563EB",
          color: "#0F172A",
          fontSize: 13
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Metric");
    expect(xml).toContain("ARR");
    expect(xml).toContain('val="F8FAFC"');
    expect(xml).toContain('val="2563EB"');
    expect(xml).toContain('val="0F172A"');
  });

  it("renders native shape shadow metadata into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-shadow-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "shape",
        id: "shadow-card",
        shape: "roundRect",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 1.4,
        style: {
          backgroundColor: "#FFFFFF",
          borderColor: "#DBEAFE",
          borderWidth: 1,
          shadow: { type: "outer", color: "2563EB", opacity: 0.08, blur: 18, offset: 6, angle: 90 }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("<a:outerShdw");
  });

  it("merges resolved component baselines before explicit semantic style overrides", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-component-precedence-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "shape",
      id: "semantic-hero",
      shape: "roundRect",
      x: 0.8,
      y: 1,
      w: 4,
      h: 1.4,
      style: {
        component: "{components.hero-card}",
        backgroundColor: "#123456",
        borderColor: "#ABCDEF",
        borderWidth: 3
      }
    }];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('val="123456"');
    expect(xml).toContain('val="ABCDEF"');
    expect(xml).toContain('w="38100"');
  });

  it("writes an editable roundRect adjustment from the resolved radius token", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-roundrect-adjustment-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "shape", id: "precise-card", shape: "roundRect", x: 0.8, y: 1, w: 4, h: 1.4,
      style: { component: "{components.hero-card}" }
    }];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toMatch(/name="precise-card"[\s\S]*?<a:gd name="adj" fmla="val 10417"/);
  });

  it("lets explicit fill and line aliases override component baseline colors", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-component-alias-precedence-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [{
      type: "shape",
      id: "alias-hero",
      shape: "roundRect",
      x: 0.8,
      y: 1,
      w: 4,
      h: 1.4,
      style: {
        component: "{components.hero-card}",
        fill: "#123456",
        line: "#ABCDEF",
        borderWidth: 3
      }
    }];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('val="123456"');
    expect(xml).toContain('val="ABCDEF"');
  });

  it("renders native radial gradient shape fills into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-radial-gradient-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "shape",
        id: "radial-halo",
        shape: "rect",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 2.4,
        style: {
          backgroundColor: "#020617",
          borderWidth: 0,
          gradient: {
            type: "radial",
            shape: "circle",
            position: "center",
            stops: [
              { color: "#F8FAFC", position: 0 },
              { color: "#2563EB", position: 62 },
              { color: "#020617", position: 100 }
            ]
          }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("radial-halo");
    expect(xml).toContain("<a:gradFill");
    expect(xml).toContain('<a:path path="circle">');
    expect(xml).toContain('pos="62000"');
  });

  it("renders text character spacing into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-char-spacing-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "tracking",
        text: "QUARTERLY REVIEW",
        x: 0.8,
        y: 1.0,
        w: 4.5,
        h: 0.5,
        style: {
          color: "#2563EB",
          fontSize: 12,
          charSpacing: 1.5
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("QUARTERLY REVIEW");
    expect(xml).toMatch(/\sspc="/);
  });

  it("renders underline and strike text decoration into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-decoration-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "link",
        text: "Read more",
        x: 0.8,
        y: 1.0,
        w: 2.0,
        h: 0.5,
        style: {
          color: "#2563EB",
          fontSize: 12,
          underline: { style: "sng" }
        }
      },
      {
        type: "text",
        id: "old-price",
        text: "$99",
        x: 0.8,
        y: 1.6,
        w: 1.0,
        h: 0.5,
        style: {
          color: "#64748B",
          fontSize: 12,
          strike: "sngStrike"
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Read more");
    expect(xml).toContain("$99");
    expect(xml).toMatch(/\su="sng"/);
    expect(xml).toMatch(/\sstrike="sngStrike"/);
  });

  it("renders native element rotation into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-rotate-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "shape",
        id: "rotated-badge",
        shape: "roundRect",
        x: 0.8,
        y: 1.0,
        w: 1.5,
        h: 0.5,
        rotate: -12,
        style: {
          backgroundColor: "#2563EB",
          borderColor: "#2563EB",
          borderWidth: 0
        }
      },
      {
        type: "text",
        id: "rotated-label",
        text: "Rotated label",
        x: 2.5,
        y: 1.0,
        w: 2.5,
        h: 0.5,
        rotate: 15,
        style: {
          color: "#111827",
          fontSize: 12
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Rotated label");
    expect(xml).toContain('rot="-720000"');
    expect(xml).toContain('rot="900000"');
  });

  it("renders image object-fit cover as native crop sizing XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-image-cover-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "image",
        id: "hero-image",
        src: join(root, "examples/image-input/business-slide.png"),
        x: 0.8,
        y: 1.0,
        w: 2.0,
        h: 2.0,
        sizing: {
          type: "cover",
          w: 2.0,
          h: 2.0
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("hero-image");
    expect(xml).toContain("<a:srcRect");
    expect(xml).not.toContain("<a:fillRect/>");
  });

  it("uses canonical image alt text in both accessibility analysis and the PPT object", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-image-alt-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "headline",
        text: "Evidence overview",
        x: 0.8,
        y: 0.3,
        w: 5,
        h: 0.6,
        style: { fontSize: 24 }
      },
      {
        type: "image",
        id: "hero-image",
        src: join(root, "examples/image-input/business-slide.png"),
        alt: "Business evidence overview",
        altText: "Legacy evidence description",
        x: 0.8,
        y: 1.1,
        w: 3,
        h: 2
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    const accessibility = await analyzeAccessibility(manifest);
    expect(accessibility.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "image-alt", elementId: "hero-image" })
    ]));
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('descr="Business evidence overview"');
    expect(xml).not.toContain('descr="Legacy evidence description"');
  });

  it("renders rounded native images into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-rounded-image-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "image",
        id: "avatar-image",
        src: join(root, "examples/image-input/business-slide.png"),
        x: 0.8,
        y: 1.0,
        w: 1.0,
        h: 1.0,
        rounding: true,
        sizing: {
          type: "cover",
          w: 1.0,
          h: 1.0
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("avatar-image");
    expect(xml).toContain('prst="ellipse"');
  });

  it("renders roundRect native image geometry into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-roundrect-image-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "image",
        id: "rounded-card-image",
        src: join(root, "examples/image-input/business-slide.png"),
        x: 0.8,
        y: 1.0,
        w: 2.0,
        h: 1.2,
        imageShape: "roundRect",
        sizing: {
          type: "cover",
          w: 2.0,
          h: 1.2
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("rounded-card-image");
    expect(xml).toContain('prst="roundRect"');
  });

  it("renders native image shadow metadata into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-image-shadow-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "image",
        id: "shadow-logo",
        src: join(root, "examples/image-input/business-slide.png"),
        x: 0.8,
        y: 1.0,
        w: 1.0,
        h: 1.0,
        style: {
          shadow: { type: "outer", color: "0F172A", opacity: 0.35, blur: 7.5, offset: 2.25, angle: 90 }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("shadow-logo");
    expect(xml).toContain("<a:outerShdw");
  });

  it("renders native image transparency into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-image-transparency-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "image",
        id: "watermark-image",
        src: join(root, "examples/image-input/business-slide.png"),
        x: 0.8,
        y: 1.0,
        w: 2.0,
        h: 1.0,
        transparency: 58
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("watermark-image");
    expect(xml).toContain('<a:alphaModFix amt="42000"/>');
  });

  it("renders native shape dash styles into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-dashed-border-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "shape",
        id: "dashed-callout",
        shape: "roundRect",
        x: 0.8,
        y: 1.0,
        w: 3.0,
        h: 1.0,
        style: {
          backgroundColor: "#FFFFFF",
          borderColor: "#2563EB",
          borderWidth: 2,
          dashType: "dash"
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('prstDash val="dash"');
  });

  it("renders native shape fill and border transparency into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-shape-transparency-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "shape",
        id: "glass-card",
        shape: "rect",
        x: 0.8,
        y: 1.0,
        w: 3.0,
        h: 1.0,
        style: {
          backgroundColor: "#2563EB",
          transparency: 82,
          borderColor: "#0F172A",
          borderTransparency: 55,
          borderWidth: 1
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('val="2563EB"><a:alpha val="18000"/></a:srgbClr');
    expect(xml).toContain('val="0F172A"><a:alpha val="45000"/></a:srgbClr');
  });

  it("renders native shape gradient fills into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-shape-gradient-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "shape",
        id: "gradient-card",
        shape: "rect",
        x: 0.8,
        y: 1.0,
        w: 3.0,
        h: 1.0,
        style: {
          backgroundColor: "#111827",
          borderWidth: 0,
          gradient: {
            type: "linear",
            angle: 90,
            stops: [
              { color: "#111827", position: 0 },
              { color: "#2563EB", position: 50 },
              { color: "#F97316", position: 100 }
            ]
          }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('name="gradient-card"');
    expect(xml).toContain("<a:gradFill");
    expect(xml).toContain('<a:gs pos="0"><a:srgbClr val="111827"/></a:gs>');
    expect(xml).toContain('<a:gs pos="50000"><a:srgbClr val="2563EB"/></a:gs>');
    expect(xml).toContain('<a:gs pos="100000"><a:srgbClr val="F97316"/></a:gs>');
  });

  it("renders native slide background gradient fills into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-bg-gradient-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].background = {
      type: "gradient",
      gradient: {
        type: "linear",
        angle: 90,
        stops: [
          { color: "#111827", position: 0 },
          { color: "#2563EB", position: 100 }
        ]
      }
    };
    sample.slides[0].elements = [
      {
        type: "text",
        id: "title",
        text: "Gradient background",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.6,
        style: { color: "#FFFFFF", fontSize: 20 }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("<p:bg><p:bgPr><a:gradFill");
    expect(xml).toContain('<a:gs pos="0"><a:srgbClr val="111827"/></a:gs>');
    expect(xml).toContain('<a:gs pos="100000"><a:srgbClr val="2563EB"/></a:gs>');
  });

  it("renders native line dash styles into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-dashed-line-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "line",
        id: "rule-line",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0,
        style: {
          color: "#2563EB",
          width: 1.5,
          dashType: "dash"
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('prstDash val="dash"');
  });

  it("renders native text transparency into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-transparency-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "muted-label",
        text: "Muted label",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.5,
        style: {
          color: "#0F172A",
          fontSize: 16,
          transparency: 58
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Muted label");
    expect(xml).toContain('<a:alpha val="42000"/>');
  });

  it("renders native small-caps text into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-small-caps-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "small-caps-label",
        text: "Quarterly Review",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.5,
        style: {
          color: "#2563EB",
          fontSize: 16,
          smallCaps: true
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("small-caps-label");
    expect(xml).toContain('cap="small"');
  });

  it("renders native first-line text indentation into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-indent-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "indented-lede",
        text: "Indented paragraph copy",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.8,
        style: {
          color: "#0F172A",
          fontSize: 14,
          firstLineIndent: 0.25
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("indented-lede");
    expect(xml).toContain('indent="228600"');
  });

  it("renders native text stroke into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-stroke-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "outlined-title",
        text: "Launch",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.8,
        style: {
          color: "#FFFFFF",
          fontSize: 44,
          textStroke: { color: "#2563EB", width: 1.5 }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("outlined-title");
    expect(xml).toContain('<a:ln w="19050">');
    expect(xml).toContain('<a:srgbClr val="2563EB"/>');
  });

  it("renders native text stroke transparency into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-stroke-alpha-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "outlined-title-alpha",
        text: "Outline",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.8,
        style: {
          color: "#FFFFFF",
          transparency: 100,
          fontSize: 44,
          textStroke: { color: "#2563EB", width: 1.5, transparency: 60 }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("outlined-title-alpha");
    expect(xml).toContain('<a:alpha val="40000"/>');
  });

  it("renders native line transparency into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-line-transparency-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "line",
        id: "muted-rule",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0,
        style: {
          color: "#64748B",
          width: 1,
          transparency: 65
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain('val="64748B"');
    expect(xml).toContain('<a:alpha val="35000"/>');
  });

  it("renders native text vertical alignment into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-valign-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "centered-cta",
        text: "Launch",
        x: 0.8,
        y: 1.0,
        w: 2.2,
        h: 0.7,
        style: {
          color: "#FFFFFF",
          fontSize: 12,
          align: "center",
          valign: "middle",
          margin: 0
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Launch");
    expect(xml).toContain('anchor="ctr"');
    expect(xml).toContain('algn="ctr"');
  });

  it("renders native vertical text direction into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-direction-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "vertical-label",
        text: "季度报告",
        x: 0.8,
        y: 1.0,
        w: 0.8,
        h: 2.6,
        style: {
          color: "#0F172A",
          fontSize: 18,
          textDirection: "vertical",
          margin: 0
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("vertical-label");
    expect(xml).toContain('vert="vert"');
  });

  it("renders native RTL paragraph direction into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-rtl-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "rtl-copy",
        text: "مرحبا بالعالم",
        x: 0.8,
        y: 1.0,
        w: 4.0,
        h: 0.8,
        style: {
          color: "#0F172A",
          fontSize: 18,
          align: "right",
          rtl: true,
          margin: 0
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("rtl-copy");
    expect(xml).toContain('rtl="1"');
    expect(xml).toContain('algn="r"');
  });

  it("renders native text shadow metadata into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-text-shadow-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "shadow-title",
        text: "Launch Ready",
        x: 0.8,
        y: 1.0,
        w: 4.2,
        h: 0.8,
        style: {
          color: "#FFFFFF",
          fontSize: 28,
          shadow: { type: "outer", color: "0F172A", opacity: 0.35, blur: 7.5, offset: 2.25, angle: 90 }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Launch Ready");
    expect(xml).toContain("<a:outerShdw");
    expect(xml).toContain('val="0F172A"');
  });

  it("renders native bullet text into slide XML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-bullet-text-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "text",
        id: "growth-bullet",
        text: "Revenue growth",
        x: 0.8,
        y: 1.0,
        w: 3.2,
        h: 0.5,
        style: {
          color: "#0F172A",
          fontSize: 16,
          bullet: {
            type: "bullet",
            characterCode: "2022"
          }
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("Revenue growth");
    expect(xml).toContain('<a:buChar char="&#x2022;"/>');
  });

  it("rejects remote image URLs with a clear localization error", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-remote-image-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements.push({
      type: "image",
      id: "remote-image",
      src: "https://example.com/image.png",
      x: 1,
      y: 1,
      w: 2,
      h: 1
    });
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await expect(execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root })).rejects.toThrow(
      /remote image URL must be downloaded before rendering/
    );
  });

  it("renders cropped-asset elements with direct src and optional crop", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-cropped-asset-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    // Use absolute src to avoid path resolution surprises from the temp manifest dir.
    const imageAbs = join(root, "examples/image-input/business-slide.png");
    // Remove default text elements to keep assertions focused on the cropped-asset.
    sample.slides[0].elements = [
      {
        type: "cropped-asset",
        id: "cropped-asset-001",
        src: imageAbs,
        x: 0.5,
        y: 0.5,
        w: 4.0,
        h: 3.0,
        crop: { x: 10, y: 10, w: 200, h: 150 }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    // Slide must be emitted and reference the image media part.
    const zip = await JSZip.loadAsync(await readFile(pptxPath));
    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/"));
    expect(mediaFiles.length).toBeGreaterThan(0);

    // The slide XML must contain the cropped-asset id (and a blip reference).
    const xml = await slideXml(pptxPath);
    expect(xml).toContain("cropped-asset-001");
  });

  it("renders image crop sizing with source dimensions for object-position crops", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-image-object-position-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "image",
        id: "positioned-hero",
        src: join(root, "examples/image-input/business-slide.png"),
        x: 0.5,
        y: 0.5,
        w: 3,
        h: 1.6,
        sizing: {
          type: "crop",
          x: 0.05,
          y: 0,
          w: 3,
          h: 1.6,
          sourceW: 3.2,
          sourceH: 1.6
        }
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    const xml = await slideXml(pptxPath);
    expect(xml).toContain("positioned-hero");
    expect(xml).toContain('<a:srcRect l="1563" r="4688" t="0" b="0"/><a:stretch/>');
  });

  it("renders cropped-asset elements that resolve src via manifest.assets[].id", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-cropped-asset-ref-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    const imageAbs = join(root, "examples/image-input/business-slide.png");
    sample.assets = [
      { id: "shared-asset", src: imageAbs }
    ];
    sample.slides[0].elements = [
      {
        type: "cropped-asset",
        id: "cropped-asset-002",
        assets: { id: "shared-asset" },
        x: 0.5,
        y: 0.5,
        w: 2.0,
        h: 2.0
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });
    const xml = await slideXml(pptxPath);
    expect(xml).toContain("cropped-asset-002");
  });

  it("validator accepts cropped-asset element with valid src", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-cropped-asset-validate-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    const imageAbs = join(root, "examples/image-input/business-slide.png");
    sample.slides[0].elements = [
      {
        type: "cropped-asset",
        id: "cropped-asset-003",
        src: imageAbs,
        x: 0.5,
        y: 0.5,
        w: 2.0,
        h: 2.0
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    const result = await execFileAsync(
      node,
      [join(root, "scripts/run-python.mjs"), join(root, "scripts/validate-manifest.py"), manifest],
      { cwd: root }
    );
    expect(result.stdout).toContain("manifest valid");
  });

  it("validator rejects cropped-asset without src and without assets.id", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-cropped-asset-no-src-"));
    const sample = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    sample.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    sample.slides[0].elements = [
      {
        type: "cropped-asset",
        id: "cropped-asset-orphan",
        x: 0.5,
        y: 0.5,
        w: 2.0,
        h: 2.0
      }
    ];
    const manifest = join(outputDir, "deck.manifest.json");
    await writeFile(manifest, JSON.stringify(sample, null, 2), "utf8");

    await expect(
      execFileAsync(
        node,
        [join(root, "scripts/run-python.mjs"), join(root, "scripts/validate-manifest.py"), manifest],
        { cwd: root }
      )
    ).rejects.toThrow(/cropped-asset requires src or assets.id/);
  });
});
