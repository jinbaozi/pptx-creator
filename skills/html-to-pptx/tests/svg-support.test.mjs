import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { measureHtmlFile } from "../scripts/measure-html.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";
import { validateGroupManifest } from "../scripts/lib/group-renderer.mjs";
import { auditStructureFidelity } from "../scripts/lib/structure-fidelity.mjs";
import { calculateEditabilityCoverage } from "../scripts/lib/editability-coverage.mjs";

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
  browserIt("keeps a simple ungrouped SVG in tier A editable primitives", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-tier-a-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-simple" data-pptx-id="svg-simple" viewBox="0 0 100 60" style="position:absolute;left:80px;top:80px;width:300px;height:180px">
        <rect x="4" y="4" width="28" height="18" fill="#2457E6" />
        <circle cx="54" cy="14" r="10" fill="#F59E0B" />
        <line x1="10" y1="40" x2="90" y2="40" stroke="#111827" stroke-width="2" />
        <text x="8" y="56" fill="#111827" font-size="10">Tier A</text>
      </svg>
    </section></body></html>`);
    try {
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const svg = measured.elements.find((element) => element.id === "svg-simple");
      expect(svg?.svg).toMatchObject({ mode: "native", tier: "A", safe: true });
      const manifest = convertHtmlToManifest(await readFile(input, "utf8"), {
        measurements: measured,
        designMode: "replica",
        designSystemSource: designSource
      });
      const children = manifest.slides[0].elements.filter((element) => element.id.startsWith("svg-simple-svg-"));
      expect(children.some((element) => element.type === "shape")).toBe(true);
      expect(children.some((element) => element.type === "line")).toBe(true);
      expect(children.some((element) => element.type === "text")).toBe(true);
      expect(manifest.slides[0].elements.some((element) => element.id === "svg-simple" && element.type === "image")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("preserves Tier-C SVG semantic markers without routing them to unsupported kinds", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-semantic-markers-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
      svg { position: absolute; width: 180px; height: 180px; top: 80px; }
      #svg-chart { left: 80px; }
      #svg-architecture { left: 340px; }
      #svg-text-bearing { left: 600px; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-chart" data-pptx-id="svg-chart" data-pptx-kind="chart" viewBox="0 0 100 100">
        <path d="M5 90 C20 10 80 10 95 90 Z" fill="#2457E6" />
      </svg>
      <svg id="svg-architecture" data-pptx-id="svg-architecture" data-pptx-kind="architecture" viewBox="0 0 100 100">
        <path d="M5 95 C30 5 70 5 95 95 Z" fill="#14B8A6" />
      </svg>
      <svg id="svg-text-bearing" data-pptx-id="svg-text-bearing" data-pptx-text-bearing="true" viewBox="0 0 100 100">
        <path d="M5 90 C20 20 80 20 95 90 Z" fill="#F59E0B" />
      </svg>
    </section></body></html>`);
    try {
      const html = await readFile(input, "utf8");
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      for (const id of ["svg-chart", "svg-architecture", "svg-text-bearing"]) {
        expect(measured.elements.find((element) => element.id === id)?.svg).toMatchObject({ mode: "vector-preserved", tier: "C", safe: true });
      }
      expect(measured.elements.find((element) => element.id === "svg-chart")?.svg.semantic).toMatchObject({ classification: "chart", source: "dom-marker" });
      expect(measured.elements.find((element) => element.id === "svg-architecture")?.svg.semantic).toMatchObject({ classification: "architecture", source: "dom-marker" });
      expect(measured.elements.find((element) => element.id === "svg-text-bearing")?.svg.semantic).toMatchObject({ classification: "text-bearing", source: "dom-marker" });
      const manifest = convertHtmlToManifest(html, {
        measurements: measured,
        designMode: "replica",
        designSystemSource: designSource
      });
      const elements = manifest.slides[0].elements;
      const vectors = ["svg-chart", "svg-architecture", "svg-text-bearing"].map((id) => elements.find((element) => element.id === id));
      expect(vectors).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "svg-chart", type: "image", mediaKind: "svg", vectorPreserved: true, svgSemantic: expect.objectContaining({ classification: "chart", source: "dom-marker" }) }),
        expect.objectContaining({ id: "svg-architecture", type: "image", mediaKind: "svg", vectorPreserved: true, svgSemantic: expect.objectContaining({ classification: "architecture", source: "dom-marker" }) }),
        expect.objectContaining({ id: "svg-text-bearing", type: "image", mediaKind: "svg", vectorPreserved: true, svgSemantic: expect.objectContaining({ classification: "text-bearing", source: "dom-marker" }) })
      ]));
      expect(manifest.slides[0].droppedElements ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "svg-chart" }),
        expect.objectContaining({ elementId: "svg-architecture" }),
        expect.objectContaining({ elementId: "svg-text-bearing" })
      ]));
      expect(manifest.slides[0].replicaUnsupportedEffects ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "svg-chart" }),
        expect.objectContaining({ elementId: "svg-architecture" }),
        expect.objectContaining({ elementId: "svg-text-bearing" })
      ]));
      const coverage = calculateEditabilityCoverage({ manifest });
      const evidence = new Map(coverage.perSlide[0].semanticEvidence.map((entry) => [entry.id, entry]));
      expect(evidence.get("svg-chart")).toMatchObject({ classification: "chart-svg", weight: 0.2 });
      expect(evidence.get("svg-architecture")).toMatchObject({ classification: "architecture-svg", weight: 0.2 });
      expect(evidence.get("svg-text-bearing")).toMatchObject({ classification: "text-bearing-whole-svg", weight: 0.4 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("maps safe SVG primitives, group inheritance, and simple paths to native elements", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-native-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-native" data-pptx-id="svg-native" viewBox="0 0 400 240" style="position:absolute;left:80px;top:80px;width:400px;height:240px">
          <g id="group" data-pptx-group="true" fill="#2457E6" stroke="#111827" stroke-width="4" opacity=".5" transform="translate(12 8)">
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
      expect(svg?.svg).toMatchObject({ mode: "native", tier: "B", safe: true });
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

  browserIt("downgrades an explicitly marked SVG group without its own stable ID to tier C", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-missing-group-id-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-missing-group-id" data-pptx-id="svg-missing-group-id" viewBox="0 0 100 60" style="position:absolute;left:80px;top:80px;width:300px;height:180px">
        <g data-pptx-kind="group"><rect data-pptx-id="orphan-box" x="10" y="10" width="24" height="18" fill="#2457E6" /></g>
      </svg>
    </section></body></html>`);
    try {
      const html = await readFile(input, "utf8");
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      expect(measured.elements.find((element) => element.id === "svg-missing-group-id")?.svg).toMatchObject({
        mode: "vector-preserved",
        tier: "C",
        safe: true,
        reasons: expect.arrayContaining(["missing-group-id"])
      });
      const manifest = convertHtmlToManifest(html, {
        measurements: measured,
        designMode: "replica",
        designSystemSource: designSource
      });
      expect(manifest.slides[0].elements).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "svg-missing-group-id", type: "image", vectorPreserved: true })
      ]));
      expect(manifest.slides[0].elements.some((element) => element.id === "orphan-box")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("unions reversed polyline/path segments when a tier-B group has no direct measurement box", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-segment-group-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-segment-group" data-pptx-id="svg-segment-group" viewBox="0 0 200 120" style="position:absolute;left:80px;top:80px;width:400px;height:240px">
        <g data-pptx-id="segment-group" data-pptx-kind="group">
          <polyline data-pptx-id="route-polyline" points="160,20 100,20 40,60" fill="none" stroke="#2457E6" stroke-width="2" />
          <path data-pptx-id="route-path" d="M 170 100 L 20 30" fill="none" stroke="#64748B" stroke-width="2" />
        </g>
      </svg>
    </section></body></html>`);
    try {
      const html = await readFile(input, "utf8");
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      expect(measured.elements.find((element) => element.id === "svg-segment-group")?.svg).toMatchObject({ mode: "native", tier: "B" });
      const withoutGroupBox = {
        ...measured,
        elements: measured.elements.filter((element) => element.id !== "segment-group")
      };
      const manifest = convertHtmlToManifest(html, {
        measurements: withoutGroupBox,
        designMode: "replica",
        designSystemSource: designSource
      });
      const elements = manifest.slides[0].elements;
      const group = elements.find((element) => element.id === "segment-group");
      const children = elements.filter((element) => [
        "route-polyline-segment-1",
        "route-polyline-segment-2",
        "route-path-segment-1"
      ].includes(element.id));
      expect(group).toMatchObject({
        type: "group",
        children: ["route-polyline-segment-1", "route-polyline-segment-2", "route-path-segment-1"]
      });
      expect(children).toHaveLength(3);
      const left = Math.min(...children.map((element) => Math.min(element.x, element.x + element.w)));
      const top = Math.min(...children.map((element) => Math.min(element.y, element.y + element.h)));
      const right = Math.max(...children.map((element) => Math.max(element.x, element.x + element.w)));
      const bottom = Math.max(...children.map((element) => Math.max(element.y, element.y + element.h)));
      expect(group).toMatchObject({
        x: left,
        y: top,
        w: right - left,
        h: bottom - top
      });
      expect(children.some((element) => element.w < 0 || element.h < 0)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("reconciles an explicitly grouped structured SVG into one editable OOXML group", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-svg-tier-b-group-"));
    const input = join(root, "index.html");
    await writeFile(input, `<!doctype html><html><head><style>
      html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
      .pptx-slide { position: relative; background: #fff; }
    </style></head><body><section class="pptx-slide" data-slide-id="slide-001">
      <svg id="svg-router" data-pptx-id="svg-router" viewBox="0 0 200 120" style="position:absolute;left:80px;top:80px;width:400px;height:240px">
        <g data-pptx-id="router-group" data-pptx-kind="group">
          <rect data-pptx-id="router-box" x="12" y="18" width="64" height="34" fill="#DDEAFE" stroke="#2457E6" />
          <line data-pptx-id="router-connector" data-connector="true" data-source-id="router-box" data-target-id="router-label" x1="76" y1="35" x2="142" y2="35" stroke="#2457E6" stroke-width="3" />
          <text data-pptx-id="router-label" x="18" y="42" fill="#0F172A" font-size="12">Router</text>
          <polyline data-pptx-id="router-route" data-connector="true" data-source-id="router-box" data-target-id="router-label" points="142,35 158,20 182,20" fill="none" stroke="#64748B" stroke-width="2" />
          <path data-pptx-id="router-edge" data-connector="true" data-source-id="router-box" data-target-id="router-label" d="M 142 48 L 168 64" fill="none" stroke="#94A3B8" stroke-width="2" />
        </g>
      </svg>
    </section></body></html>`);
    try {
      const html = await readFile(input, "utf8");
      const measured = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      expect(measured.elements.find((element) => element.id === "svg-router")?.svg).toMatchObject({ mode: "native", tier: "B" });
      const manifest = convertHtmlToManifest(html, {
        measurements: measured,
        designMode: "replica",
        designSystemSource: designSource
      });
      const group = manifest.slides[0].elements.find((element) => element.id === "router-group");
      expect(group).toMatchObject({ type: "group" });
      expect(group.children).toEqual([
        "router-box",
        "router-connector",
        "router-label",
        "router-route-segment-1",
        "router-route-segment-2",
        "router-edge-segment-1"
      ]);
      expect(group.w).toBeGreaterThan(0);
      expect(manifest.slides[0].elements.find((element) => element.id === "router-connector")).toMatchObject({ type: "line", role: "connector", connector: { sourceId: "router-box", targetId: "router-label" } });
      expect(manifest.slides[0].elements.find((element) => element.id === "router-route-segment-1")).toMatchObject({ type: "line", semanticParentId: "router-route" });
      expect(manifest.slides[0].elements.some((element) => element.id === "svg-router" && element.type === "image")).toBe(false);
      expect(validateGroupManifest(manifest)).toHaveLength(1);
      const zip = await renderManifest(root, manifest);
      const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
      expect(slideXml).toContain("<p:grpSp>");
      expect(slideXml).toContain('name="router-group"');
      expect(slideXml).toContain('name="router-box"');
      expect(slideXml).toContain('name="router-connector"');
      expect(slideXml).toContain('name="router-label"');
      expect(slideXml).toContain("<p:cxnSp>");
      const structure = await auditStructureFidelity({
        manifest,
        manifestPath: join(root, "deck.manifest.json"),
        pptxPath: join(root, "deck.pptx")
      });
      expect(structure.summary.blocked).toBe(false);
      expect(structure.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "router-group", expectedChildren: group.children, passed: true })
      ]));
      expect(Object.keys(zip.files).filter((path) => path.startsWith("ppt/media/")).filter((path) => path.endsWith(".svg")).length).toBe(0);
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
      expect(measured.elements.find((element) => element.id === "svg-vector")?.svg).toMatchObject({ mode: "vector-preserved", tier: "C" });
      expect(measured.elements.find((element) => element.id === "svg-unsafe")?.svg).toMatchObject({ mode: "raster-fallback", tier: "C" });
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
