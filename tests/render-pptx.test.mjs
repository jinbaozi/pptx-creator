import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

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
  it("renders tokenized manifest to pptx with editable text and reports design source", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-creator-"));
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifest, pptxPath], { cwd: root });

    expect((await stat(pptxPath)).size).toBeGreaterThan(1000);
    expect(await readFile(join(outputDir, "editable-report.md"), "utf8")).toContain("Overall editability");

    const qa = await readFile(join(outputDir, "qa-report.md"), "utf8");
    expect(qa).toContain("PPTX render: passed");
    expect(qa).toContain("Manifest schema: not validated in render step");
    expect(qa).toContain("Design system: Business Neutral");

    const compatibility = await readFile(join(outputDir, "compatibility-report.md"), "utf8");
    expect(compatibility).toContain("WPS Compatibility Report");
    expect(compatibility).toContain("Overall risk");

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
