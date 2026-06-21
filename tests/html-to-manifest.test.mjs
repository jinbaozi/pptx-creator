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

  it("resolves inline CSS hex colors against DESIGN.md tokens (U9)", () => {
    const html = `
      <div class="pptx-deck" data-design-system="business-neutral" data-deck-title="Tokens">
        <section class="pptx-slide">
          <div data-pptx-kind="text" data-color="#2563EB" data-x="1" data-y="1" data-w="4" data-h="0.5">Branded</div>
        </section>
      </div>`;
    const designTokens = {
      colors: {
        primary: "#2563EB",
        secondary: "#475569"
      }
    };
    const result = convertHtmlToManifest(html, {
      designTokens,
      returnMetadata: true
    });
    const text = result.manifest.slides[0].elements.find((el) => el.type === "text");
    expect(text.style.color).toBe("{colors.primary}");
    expect(result.paletteResolution.paletteMatch).toBeGreaterThan(0);
    expect(result.paletteResolution.skipped).toBe(false);
  });

  it("leaves unmatched inline hex colors untouched and tracks them in paletteResolution (U9)", () => {
    const html = `
      <div class="pptx-deck" data-design-system="business-neutral" data-deck-title="Unmapped">
        <section class="pptx-slide">
          <div data-pptx-kind="text" data-color="#ABCDEF" data-x="1" data-y="1" data-w="4" data-h="0.5">Brand</div>
        </section>
      </div>`;
    const designTokens = { colors: { primary: "#2563EB" } };
    const result = convertHtmlToManifest(html, {
      designTokens,
      returnMetadata: true
    });
    const text = result.manifest.slides[0].elements[0];
    expect(text.style.color).toBe("#ABCDEF"); // unmatched, kept verbatim
    expect(result.paletteResolution.unmapped.length).toBe(1);
    expect(result.paletteResolution.unmapped[0].extractedHex).toBe("#ABCDEF");
    expect(result.paletteResolution.matches.length).toBe(0);
  });

  it("skips color resolution in strict replica mode (U9)", () => {
    const html = `
      <div class="pptx-deck" data-design-system="business-neutral" data-deck-title="Replica">
        <section class="pptx-slide">
          <div data-pptx-kind="text" data-color="#2563EB" data-x="1" data-y="1" data-w="4" data-h="0.5">Keep</div>
        </section>
      </div>`;
    const designTokens = { colors: { primary: "#2563EB" } };
    const result = convertHtmlToManifest(html, {
      designTokens,
      designMode: "replica",
      returnMetadata: true
    });
    const text = result.manifest.slides[0].elements[0];
    // The data-color attribute (#2563EB) must remain untouched under
    // replica mode — the design system is owned by the source.
    expect(text.style.color).toBe("#2563EB");
    expect(result.paletteResolution.skipped).toBe(true);
    expect(result.paletteResolution.paletteMatch).toBe(0);
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

    const { manifest } = await writeManifestFromHtml(inputPath, manifestPath, {
      fetchRemoteAsset: async () => Buffer.from("fake-image")
    });
    const image = manifest.slides[0].elements.find((element) => element.type === "image");

    expect(image.src).toMatch(/^assets\/remote-image-/);
    expect(await readFile(join(outputDir, image.src), "utf8")).toBe("fake-image");
  });

  it("detects measured path for marker-only HTML", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Markers">
        <section class="pptx-slide">
          <h1 data-pptx-kind="text" data-pptx-id="t" data-x="0.5" data-y="0.5" data-w="12" data-h="1">Title</h1>
          <div data-pptx-type="text" data-id="b" data-x="0.5" data-y="2" data-w="12" data-h="0.5">Body</div>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, { returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(slide.path).toBe("measured");
    expect(slide.markers).toBe(2);
    expect(slide.autoLayoutContainers).toBe(0);
    expect(result.layoutPaths).toEqual([
      { slideId: slide.id, path: "measured", markers: 2, autoLayoutContainers: 0 }
    ]);
  });

  it("detects auto-layout path for card-grid-only HTML", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Auto">
        <section class="pptx-slide">
          <h1>Auto Layout</h1>
          <div class="cards" data-cols="2">
            <div class="card"><h3>A</h3><p>a</p></div>
            <div class="card"><h3>B</h3><p>b</p></div>
          </div>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, { returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(slide.path).toBe("auto-layout");
    expect(slide.markers).toBe(0);
    expect(slide.autoLayoutContainers).toBe(1);
  });

  it("detects hybrid path for mixed HTML", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Hybrid">
        <section class="pptx-slide">
          <h1 data-pptx-kind="text" data-pptx-id="t" data-x="0.5" data-y="0.5" data-w="12" data-h="1">Hybrid</h1>
          <div class="cards" data-cols="2">
            <div class="card"><h3>A</h3><p>a</p></div>
            <div class="card"><h3>B</h3><p>b</p></div>
          </div>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, { returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(slide.path).toBe("hybrid");
    expect(slide.markers).toBeGreaterThan(0);
    expect(slide.autoLayoutContainers).toBe(1);
    // Both kinds of children must be rendered: the measured marker and the
    // auto-layout card shapes.
    const hasMeasuredTitle = slide.elements.some(
      (el) => el.id === "t" && el.type === "text" && el.x === 0.5
    );
    const hasCardShape = slide.elements.some((el) => el.type === "shape");
    expect(hasMeasuredTitle).toBe(true);
    expect(hasCardShape).toBe(true);
  });

  it("force-hybrid flag overrides detection", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Forced">
        <section class="pptx-slide">
          <h1 data-pptx-kind="text" data-pptx-id="t" data-x="0.5" data-y="0.5" data-w="12" data-h="1">Only markers here</h1>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, { returnMetadata: true, forceHybrid: true });
    expect(result.manifest.slides[0].path).toBe("hybrid");
  });

  it("short-circuits to measured when data-archetype resolves via slide-archetypes (U8)", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Stat">
        <section class="pptx-slide" data-archetype="stat-callout">
          <p data-pptx-kind="text" data-pptx-id="metric" data-x="0.7" data-y="1.7" data-w="12" data-h="2.5">99.97%</p>
          <p data-pptx-kind="text" data-pptx-id="supportingText" data-x="0.7" data-y="4.6" data-w="12" data-h="1.2">Uptime</p>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, {
      returnMetadata: true,
      preferArchetypeFromArchetypeMd: true
    });
    const slide = result.manifest.slides[0];
    // The data-archetype attribute short-circuits the markers-vs-cards
    // heuristic to "measured", and the resolver stamps the resolved
    // archetype name + catalog root onto the slide so downstream
    // validators can confirm the archetype's slot schema was honored.
    expect(slide.path).toBe("measured");
    expect(slide.archetype).toBe("stat-callout");
    expect(slide.archetypeRoot).toBe("slide-archetypes");
    expect(result.layoutPaths[0]).toMatchObject({
      path: "measured",
      archetype: "stat-callout",
      archetypeRoot: "slide-archetypes"
    });
  });

  it("honors --no-prefer-archetype-from-archetype-md by falling back to heuristic detection (U8)", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Stat">
        <section class="pptx-slide" data-archetype="stat-callout">
          <div class="cards" data-cols="1">
            <div class="card"><h3>Only card</h3><p>No markers</p></div>
          </div>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, {
      returnMetadata: true,
      preferArchetypeFromArchetypeMd: false
    });
    // Without the flag, the data-archetype attribute is ignored and the
    // markers-vs-cards heuristic decides the path.
    expect(result.manifest.slides[0].path).toBe("auto-layout");
    expect(result.manifest.slides[0].archetype).toBeUndefined();
  });

  it("force-auto-layout and force-measured flags override detection", () => {
    const autoHtml = `
      <div class="pptx-deck" data-deck-title="Auto">
        <section class="pptx-slide">
          <h1>Auto</h1>
          <div class="cards" data-cols="1">
            <div class="card"><h3>A</h3><p>a</p></div>
          </div>
        </section>
      </div>`;
    const autoResult = convertHtmlToManifest(autoHtml, { returnMetadata: true, forceAutoLayout: true });
    expect(autoResult.manifest.slides[0].path).toBe("auto-layout");

    const measuredHtml = `
      <div class="pptx-deck" data-deck-title="Measured">
        <section class="pptx-slide">
          <div data-pptx-type="text" data-id="x" data-x="1" data-y="1" data-w="4" data-h="0.5">Hello</div>
        </section>
      </div>`;
    const measuredResult = convertHtmlToManifest(measuredHtml, { returnMetadata: true, forceMeasured: true });
    expect(measuredResult.manifest.slides[0].path).toBe("measured");
  });

  it("attaches sourceCoordinates selectively (image + one per region)", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Selective">
        <section class="pptx-slide">
          <h1>Title</h1>
          <p class="subtitle">Sub</p>
          <div class="cards" data-cols="2">
            <div class="card"><h3>Card 1</h3><p>x</p></div>
            <div class="card"><h3>Card 2</h3><p>y</p></div>
            <div class="card"><h3>Card 3</h3><p>z</p></div>
            <div class="card"><h3>Card 4</h3><p>w</p></div>
          </div>
          <img data-x="10" data-y="5" data-w="2" data-h="1" src="hero.png">
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, { returnMetadata: true });
    const coords = result.sourceCoordinates;
    // The image is always recorded.
    const imageCoord = coords.find((c) => c.dx === 10 && c.dy === 5);
    expect(imageCoord).toBeTruthy();
    // Non-image elements are recorded at most once per region (tl/tr/bl/br).
    // Mirror the same 2x2 region logic the implementation uses.
    const halfW = (13.333 - 0.7 * 2) / 2;
    const halfH = 7.5 / 2;
    function bucket(box) {
      const colHalf = box.dx < halfW ? "l" : "r";
      const rowHalf = box.dy < halfH ? "t" : "b";
      return `${rowHalf}${colHalf}`;
    }
    const nonImageByRegion = new Map();
    for (const c of coords) {
      if (c.dx === 10 && c.dy === 5) continue; // skip the image
      const key = bucket(c);
      nonImageByRegion.set(key, (nonImageByRegion.get(key) ?? 0) + 1);
    }
    for (const [key, count] of nonImageByRegion) {
      expect(count, `region ${key} should hold at most one sample`).toBeLessThanOrEqual(1);
    }
    // The first element per region wins. The title is the first "tl"
    // sample; the first top-right card is the "tr" sample.
    expect(nonImageByRegion.get("tl")).toBe(1);
    expect(nonImageByRegion.get("tr")).toBe(1);
    expect(nonImageByRegion.get("bl")).toBe(1);
    expect(nonImageByRegion.get("br")).toBe(1);
  });

  it("writes inputHints.json alongside the manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-html-hints-"));
    const manifestPath = join(outputDir, "deck.manifest.json");
    await writeManifestFromHtml(sampleHtml, manifestPath);
    const hintsPath = join(outputDir, "inputHints.json");
    const hints = JSON.parse(await readFile(hintsPath, "utf8"));
    expect(hints.viewportSize).toEqual({ w: 1280, h: 720 });
    expect(Array.isArray(hints.imageDimensions)).toBe(true);
    expect(Array.isArray(hints.detectedPalette)).toBe(true);
    expect(["absent", "present", "deferred"]).toContain(hints.ocrAvailability);
  });

  it("exposes per-slide path info for consistency report consumption", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Multi">
        <section class="pptx-slide">
          <h1 data-pptx-kind="text" data-pptx-id="t" data-x="0.5" data-y="0.5" data-w="12" data-h="1">M</h1>
        </section>
        <section class="pptx-slide">
          <h1>Auto</h1>
          <div class="cards" data-cols="1">
            <div class="card"><h3>A</h3><p>a</p></div>
          </div>
        </section>
      </div>`;
    const result = convertHtmlToManifest(html, { returnMetadata: true });
    expect(result.layoutPaths).toHaveLength(2);
    expect(result.layoutPaths[0].path).toBe("measured");
    expect(result.layoutPaths[1].path).toBe("auto-layout");
  });
});
