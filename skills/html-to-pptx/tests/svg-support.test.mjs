import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { measureHtmlFile } from "../scripts/measure-html.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";

const execFileAsync = promisify(execFile);
const browserIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;
const designSource = resolve("design-systems/business-neutral/DESIGN.md");

async function renderManifest(root, manifest) {
  const manifestPath = join(root, "deck.manifest.json");
  const outputPath = join(root, "deck.pptx");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await execFileAsync(process.execPath, [
    resolve("scripts/render-pptx.mjs"),
    manifestPath,
    outputPath
  ], { cwd: resolve(".") });
  return JSZip.loadAsync(await readFile(outputPath));
}

describe("SVG fidelity boundary", () => {
  browserIt("maps safe SVG primitives, group inheritance, and simple paths to native elements", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-native-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-native" data-pptx-id="svg-native" viewBox="0 0 400 240" style="position:absolute;left:80px;top:80px;width:400px;height:240px">
        <g id="group" fill="#2457E6" stroke="#111827" stroke-width="4" opacity=".5" transform="translate(12 8)">
          <g id="group-inner" opacity=".5"><rect id="rect-native" x="20" y="20" width="90" height="60" /></g>
          <circle id="circle-native" cx="170" cy="55" r="30" />
          <ellipse id="ellipse-native" cx="260" cy="55" rx="34" ry="22" />
          <line id="line-native" x1="20" y1="130" x2="100" y2="180" />
          <polyline id="polyline-native" fill="none" points="120,130 160,180 210,130" />
          <polygon id="polygon-native" fill="none" points="240,130 290,130 270,180" />
          <path id="path-native" fill="none" d="M 300 130 H 360 V 180" />
          <text id="text-native" x="24" y="220" font-size="20">Native SVG</text>
        </g>
      </svg>
    </section></body></html>`);
    try {
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const svg = measured.elements.find((element) => element.id === "svg-native");
      expect(svg?.svg).toMatchObject({ mode: "native", safe: true });
      const manifest = convertHtmlToManifest(await readFile(input, "utf8"), {
        measurements: measured,
        designMode: "replica",
        designSystemSource: designSource
      });
      const elements = manifest.slides[0].elements;
      expect(elements.filter((element) => ["rect-native", "circle-native", "ellipse-native"].includes(element.id))).toHaveLength(3);
      expect(elements.find((element) => element.id === "rect-native")?.style.transparency).toBe(75);
      expect(elements.some((element) => element.id === "line-native" && element.type === "line")).toBe(true);
      expect(elements.some((element) => element.id === "text-native" && element.type === "text")).toBe(true);
      expect(manifest.slides[0].replicaUnsupportedEffects).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "svg-native" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("keeps a safe complex SVG as SVG media and marks effects for localized raster fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-boundary-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-vector" data-pptx-id="svg-vector" viewBox="0 0 100 100" style="position:absolute;left:80px;top:80px;width:180px;height:180px">
        <defs><linearGradient id="g"><stop offset="0" stop-color="#2457E6"/><stop offset="1" stop-color="#F59E0B"/></linearGradient></defs>
        <path d="M10 10 C30 0 70 0 90 10 S100 70 90 90 C70 100 30 100 10 90 S0 30 10 10Z" fill="url(#g)"/>
      </svg>
      <svg id="svg-unsafe" data-pptx-id="svg-unsafe" viewBox="0 0 100 100" style="position:absolute;left:320px;top:80px;width:180px;height:180px">
        <filter id="blur"><feGaussianBlur stdDeviation="4"/></filter><rect width="100" height="100" filter="url(#blur)"/>
      </svg>
    </section></body></html>`);
    try {
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      expect(measured.elements.find((element) => element.id === "svg-vector")?.svg.mode).toBe("vector-preserved");
      expect(measured.elements.find((element) => element.id === "svg-unsafe")?.svg.mode).toBe("raster-fallback");
      const manifest = convertHtmlToManifest(await readFile(input, "utf8"), {
        measurements: measured,
        designMode: "replica",
        designSystemSource: designSource
      });
      const vector = manifest.slides[0].elements.find((element) => element.id === "svg-vector");
      expect(vector).toMatchObject({ type: "image", vectorPreserved: true, mediaKind: "svg" });
      expect(vector.src).toMatch(/^data:image\/svg\+xml;base64,/);
      const unsafe = manifest.slides[0].replicaUnsupportedEffects.find((effect) => effect.elementId === "svg-unsafe");
      expect(unsafe).toMatchObject({ unsupportedVisual: "svg-paint" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes editable SVG-native OOXML and preserves vector SVG media without PNG substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-ooxml-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "complex.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\"><path d=\"M0 0 L20 20\" stroke=\"#2457E6\" fill=\"none\"/></svg>");
    try {
      const zip = await renderManifest(root, {
        version: "0.2.0",
        designSystem: { source: designSource },
        deck: { title: "SVG", language: "en-US", size: { width: 13.333, height: 7.5 } },
        slides: [{ id: "slide-001", background: { type: "solid", color: "#FFFFFF" }, elements: [
          { type: "shape", id: "rect-native", shape: "rect", x: 1, y: 1, w: 1, h: 0.5, style: { fill: "#2457E6", borderWidth: 0 } },
          { type: "line", id: "line-native", x: 2, y: 1, w: 1, h: 0.5, style: { color: "#111827", width: 1 } },
          { type: "text", id: "text-native", text: "SVG", x: 3, y: 1, w: 1, h: 0.3, style: { fontSize: 16, color: "#111827" } },
          { type: "image", id: "svg-vector", src: "assets/complex.svg", vectorPreserved: true, mediaKind: "svg", x: 4, y: 1, w: 1, h: 1 }
        ] }]
      });
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      expect(slideXml).toContain("name=\"rect-native\"");
      expect(slideXml).toContain("name=\"line-native\"");
      expect(slideXml).toContain("name=\"text-native\"");
      const media = Object.keys(zip.files).filter((path) => path.startsWith("ppt/media/"));
      expect(media.some((path) => path.endsWith(".svg"))).toBe(true);
      expect(slideXml).toContain("asvg:svgBlip");
      await access(join(root, "deck.pptx"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
