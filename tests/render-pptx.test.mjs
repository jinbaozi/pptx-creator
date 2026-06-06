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
});
