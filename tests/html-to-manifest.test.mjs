import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { convertHtmlToManifest, layoutCards } from "../scripts/lib/html-to-manifest-core.mjs";
import { writeManifestFromHtml } from "../scripts/html-to-manifest.mjs";

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));
const sampleHtml = join(root, "examples/html-input/one-page-dashboard.html");

async function slideXml(pptxPath) {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const files = Object.keys(zip.files).filter((name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"));
  const xml = await Promise.all(files.map((name) => zip.files[name].async("string")));
  return xml.join("\n");
}

describe("html-to-manifest", () => {
  it("maps semantic dashboard HTML to a tokenized manifest", async () => {
    const html = await readFile(sampleHtml, "utf8");
    const manifest = convertHtmlToManifest(html);

    expect(manifest.version).toBe("0.1.1");
    expect(manifest.designSystem.source).toContain("dashboard-data/DESIGN.md");
    expect(manifest.designSystem.name).toBe("Dashboard Data");
    expect(manifest.slides).toHaveLength(1);
    expect(manifest.slides[0].title).toBe("运营数据看板");

    const types = manifest.slides[0].elements.map((el) => el.type);
    expect(types.filter((t) => t === "text").length).toBeGreaterThanOrEqual(5);
    expect(types.filter((t) => t === "shape").length).toBe(4);
    expect(types.filter((t) => t === "table").length).toBe(1);

    const title = manifest.slides[0].elements.find((el) => el.text === "运营数据看板");
    expect(title?.style.typography).toBe("{typography.title}");
  });

  it("keeps Chinese sample content readable", async () => {
    const html = await readFile(sampleHtml, "utf8");

    expect(html).toContain("运营数据看板");
    expect(html).toContain("核心指标概览");
    expect(html).not.toContain("杩");
    expect(html).not.toContain("鈥");
  });

  it("layouts card grids deterministically", () => {
    const cards = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const { items, bottomY } = layoutCards(cards, 2, 2.0, 7.5);
    expect(items).toHaveLength(4);
    expect(items[0].box.x).toBeCloseTo(0.7, 1);
    expect(items[1].box.x).toBeGreaterThan(items[0].box.x);
    expect(bottomY).toBeGreaterThan(4);
  });

  it("writes manifest that passes Python validation", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-html-"));
    const manifestPath = join(outputDir, "deck.manifest.json");
    await writeManifestFromHtml(sampleHtml, manifestPath);

    const { stdout } = await execFileAsync("python", [join(root, "scripts/validate-manifest.py"), manifestPath], {
      cwd: root
    });
    expect(stdout).toContain("manifest valid");
  });

  it("end-to-end renders dashboard PPTX from HTML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-html-render-"));
    const manifestPath = join(outputDir, "deck.manifest.json");
    const pptxPath = join(outputDir, "final.pptx");

    await execFileAsync(node, [join(root, "scripts/html-to-manifest.mjs"), sampleHtml, manifestPath], { cwd: root });
    await execFileAsync(node, [join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root });

    expect((await stat(pptxPath)).size).toBeGreaterThan(1000);
    expect(await slideXml(pptxPath)).toContain("运营数据看板");
    expect(await readFile(join(outputDir, "editable-report.md"), "utf8")).toContain("Overall editability");
  });

  it("supports explicit data-pptx-type elements", async () => {
    const html = `
      <div class="pptx-deck" data-design-system="business-neutral" data-deck-title="Explicit">
        <section class="pptx-slide">
          <div data-pptx-type="text" data-x="1" data-y="1" data-w="4" data-h="0.5">Hello</div>
        </section>
      </div>`;
    const manifest = convertHtmlToManifest(html);
    expect(manifest.slides[0].elements).toHaveLength(1);
    expect(manifest.slides[0].elements[0]).toMatchObject({ type: "text", text: "Hello", x: 1, y: 1, w: 4, h: 0.5 });
  });

  it("auto-paginates oversized semantic card grids", () => {
    const cards = Array.from(
      { length: 7 },
      (_, index) => `<article class="card"><h3>Card ${index + 1}</h3><p>Detail ${index + 1}</p></article>`
    ).join("");
    const html = `
      <main class="pptx-deck" data-deck-title="Auto pages">
        <section class="pptx-slide">
          <h1>Quarterly Review</h1>
          <div class="cards" data-cols="2">${cards}</div>
        </section>
      </main>`;

    const manifest = convertHtmlToManifest(html);

    expect(manifest.slides).toHaveLength(2);
    expect(manifest.slides[0].elements.some((element) => element.text === "Card 1")).toBe(true);
    expect(manifest.slides[1].elements.some((element) => element.text === "Card 7")).toBe(true);
    for (const slide of manifest.slides) {
      for (const element of slide.elements) {
        expect(element.y + element.h).toBeLessThanOrEqual(7.5);
      }
    }
  });

  it("converts simple SVG line paths into native line elements", () => {
    const html = `
      <section class="pptx-slide" data-title="SVG line">
        <svg data-x="1" data-y="1.5" data-w="3" data-h="1.2">
          <path id="trend" d="M 0 0 L 100 100"></path>
        </svg>
      </section>`;

    const manifest = convertHtmlToManifest(html);

    expect(manifest.slides[0].elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "trend",
        x: 1,
        y: 1.5,
        w: 3,
        h: 1.2
      })
    );
  });

  it("keeps list text readable with bullet prefixes", () => {
    const html = `
      <section class="pptx-slide" data-title="List">
        <ul>
          <li>第一项</li>
          <li>Second item</li>
        </ul>
      </section>`;
    const manifest = convertHtmlToManifest(html);
    const list = manifest.slides[0].elements.find((element) => element.id.startsWith("list-"));

    expect(list.text).toBe("• 第一项\n• Second item");
    expect(list.text).not.toContain("鈥");
  });

  it("downloads remote HTML image assets next to the manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-html-assets-"));
    const inputPath = join(outputDir, "input.html");
    const manifestPath = join(outputDir, "deck.manifest.json");
    await writeFile(
      inputPath,
      `<section class="pptx-slide"><img data-x="1" data-y="1" data-w="2" data-h="1" src="https://example.com/hero.png"></section>`,
      "utf8"
    );

    const manifest = await writeManifestFromHtml(inputPath, manifestPath, {
      fetchRemoteAsset: async () => Buffer.from("fake-image")
    });
    const image = manifest.slides[0].elements.find((element) => element.type === "image");

    expect(image.src).toMatch(/^assets\/remote-image-/);
    expect(await readFile(join(outputDir, image.src), "utf8")).toBe("fake-image");
  });
});
