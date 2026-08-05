import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { measureHtmlFile } from "../scripts/measure-html.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";

const browserIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;

describe("real Chromium rich text and table measurements", () => {
  browserIt("covers explicit structural groups without adding replica paint or dropped entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-group-measurement-"));
    const input = join(root, "index.html");
    const html = `<!doctype html>
      <html><head><style>
        *, *::before, *::after { box-sizing: border-box; }
        html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
        .pptx-slide { position: relative; overflow: hidden; background: #FFFFFF; }
        #group { position: absolute; left: 80px; top: 60px; width: 600px; height: 220px; }
        #shape { position: absolute; left: 0; top: 0; width: 240px; height: 100px; background: #DDEAFE; }
        #text { position: absolute; left: 280px; top: 20px; width: 280px; font: 24px/1.25 Arial, sans-serif; }
      </style></head><body>
        <section class="pptx-slide" data-slide-id="slide-001">
          <div id="group" data-pptx-id="group-001" data-pptx-kind="group">
            <div id="shape" data-pptx-id="shape-001" data-pptx-kind="shape"></div>
            <p id="text" data-pptx-id="text-001" data-pptx-kind="text">Grouped text</p>
          </div>
        </section>
      </body></html>`;
    await writeFile(input, html, "utf8");
    try {
      const measurements = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      expect(measurements.elements.find((element) => element.id === "group-001")).toMatchObject({ kind: "group" });
      const manifest = convertHtmlToManifest(html, {
        measurements,
        designMode: "replica",
        designSystemSource: resolve("design-systems/business-neutral/DESIGN.md")
      });
      expect(manifest.slides[0].elements[0]).toMatchObject({ type: "group", id: "group-001", children: ["shape-001", "text-001"] });
      expect(manifest.metadata.replicaSource.coverage).toMatchObject({
        coverage: 1,
        droppedElements: expect.not.arrayContaining([expect.objectContaining({ elementId: "group-001" })])
      });
      expect(manifest.metadata.replicaSource.coverage.slides[0].droppedElements).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "group-001", kind: "group" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("materializes simple pseudo text/dots and keeps unsupported fallback ownership on pseudo bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-pseudo-measurement-"));
    const input = join(root, "index.html");
    const html = `<!doctype html>
      <html><head><style>
        *, *::before, *::after { box-sizing: border-box; }
        html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
        .pptx-slide { position: relative; overflow: hidden; background: #FFFFFF; }
        #card, #unsupported { position: absolute; width: 280px; height: 140px; background: #F8FAFC; }
        #card { left: 80px; top: 70px; }
        #card-child { position: absolute; left: 90px; top: 54px; font: 14px/18px Arial, sans-serif; color: #0F172A; }
        #card::before { content: "PRE"; position: absolute; left: 12px; top: 10px; width: 56px; height: 22px; color: #2457E6; font: 16px/22px Arial, sans-serif; }
        #card::after { content: ""; position: absolute; right: 14px; top: 14px; width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, #2457E6, #F59E0B); box-shadow: 0 2px 4px rgba(0, 0, 0, .25); }
        #unsupported { left: 420px; top: 70px; }
        #unsupported::before { content: "BLUR"; position: absolute; left: 12px; top: 14px; background: #EF4444; font: 16px/20px Arial, sans-serif; filter: blur(3px); }
      </style></head><body>
        <section class="pptx-slide" data-slide-id="slide-001">
          <div id="card" data-pptx-id="card" data-pptx-kind="shape"><span id="card-child" data-pptx-id="card-child" data-pptx-kind="text">child</span></div>
          <div id="unsupported" data-pptx-id="unsupported" data-pptx-kind="shape"></div>
        </section>
      </body></html>`;
    await writeFile(input, html, "utf8");
    try {
      const measurements = await measureHtmlFile(input, { replica: true, totalTimeoutMs: 90_000 });
      const byId = new Map(measurements.elements.map((element) => [element.id, element]));
      expect(byId.get("card-before")).toMatchObject({
        generated: true,
        dataPptxGenerated: true,
        generatedBy: "card",
        pseudo: "before",
        kind: "text",
        text: "PRE",
        semantics: { semanticParentId: "card" }
      });
      expect(byId.get("card-before").px.w).toBeGreaterThan(0);
      expect(byId.get("card-after")).toMatchObject({
        generated: true,
        pseudo: "after",
        kind: "shape",
        style: { backgroundImage: expect.stringContaining("linear-gradient") }
      });
      expect(byId.get("unsupported-before")).toMatchObject({
        generated: true,
        pseudo: "before",
        replica: { unsupportedVisual: "pseudo-unsupported-filter", hasUnsupportedEffects: true }
      });
      expect(byId.get("unsupported").replica.unsupportedVisual).toBeNull();
      expect(byId.get("unsupported-before").px).toMatchObject({ x: 432, y: 84 });
      expect(byId.get("unsupported-before").px.w).toBeLessThan(byId.get("unsupported").px.w);
      expect(byId.get("unsupported-before").px.h).toBeLessThan(byId.get("unsupported").px.h);
      const manifest = convertHtmlToManifest(html, {
        measurements,
        designMode: "replica",
        designSystemSource: resolve("design-systems/business-neutral/DESIGN.md")
      });
      const ids = manifest.slides[0].elements.map((element) => element.id);
      expect(ids.indexOf("card")).toBeLessThan(ids.indexOf("card-before"));
      expect(ids.indexOf("card-before")).toBeLessThan(ids.indexOf("card-child"));
      expect(ids.indexOf("card-child")).toBeLessThan(ids.indexOf("card-after-background-gradient-001"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  browserIt("persists nested rich runs and table structure into the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pptx-rich-measurement-"));
    const input = join(root, "index.html");
    const html = `<!doctype html>
      <html><head><style>
        *, *::before, *::after { box-sizing: border-box; }
        html, body, .pptx-slide { margin: 0; width: 1280px; height: 720px; }
        .pptx-slide { position: relative; overflow: hidden; background: #FFFFFF; }
        #rich { position: absolute; left: 80px; top: 52px; width: 680px; font: 24px/1.25 Arial, sans-serif; }
        #table { position: absolute; left: 80px; top: 180px; width: 640px; border-collapse: collapse; font: 14px/1.2 Arial, sans-serif; }
        #table caption { padding: 4px; color: #334155; text-align: left; }
        #table th, #table td { border: 2px solid #334155; padding: 8px 12px; text-align: left; vertical-align: middle; }
        #table thead th { background: #DDEAFE; color: #0F172A; font-weight: 700; }
        #table tbody td { background: #FFFFFF; }
        #table tfoot td { background: #E2E8F0; font-style: italic; }
      </style></head><body>
        <section class="pptx-slide" data-slide-id="slide-001">
          <p id="rich" data-pptx-kind="text">Alpha <strong>bold </strong><em>italic </em><a href="https://example.com/rich">link</a></p>
          <table id="table" data-pptx-kind="table">
            <caption>Table caption</caption>
            <thead>
              <tr><th rowspan="2">Header A</th><th>Header B</th></tr>
              <tr><th>Header C</th></tr>
            </thead>
            <tbody>
              <tr><td colspan="2">Body <strong>cell</strong></td></tr>
            </tbody>
            <tfoot>
              <tr><td colspan="2">Footer <em>note</em></td></tr>
            </tfoot>
          </table>
        </section>
      </body></html>`;

    await writeFile(input, html, "utf8");
    try {
      const measurements = await measureHtmlFile(input, {
        replica: true,
        totalTimeoutMs: 90_000
      });
      const richMeasurement = measurements.elements.find((element) => element.id === "rich");
      expect(richMeasurement).toMatchObject({
        kind: "text",
        text: "Alpha bold italic link",
        runs: [
          { text: "Alpha " },
          { text: "bold ", fontWeight: 700 },
          { text: "italic ", fontStyle: "italic" },
          { text: "link", hyperlink: { url: "https://example.com/rich" } }
        ]
      });
      expect(richMeasurement.runs.map((run) => run.text).join("")).toBe(richMeasurement.text);
      expect(richMeasurement.runs.every((run) => run.fontFamily && Number(run.fontSize) > 0 && run.color)).toBe(true);

      const tableMeasurement = measurements.elements.find((element) => element.id === "table");
      expect(tableMeasurement?.table).toBeDefined();
      expect(tableMeasurement.table.sections.map((section) => section.type)).toEqual(["thead", "tbody", "tfoot"]);
      expect(tableMeasurement.table.caption).toMatchObject({ text: "Table caption" });
      expect(tableMeasurement.table.columnsPx.length).toBeGreaterThanOrEqual(2);
      expect(tableMeasurement.table.columnsPx.every((width) => width > 0)).toBe(true);
      expect(tableMeasurement.table.rowHeightsPx.length).toBeGreaterThanOrEqual(4);
      expect(tableMeasurement.table.rowHeightsPx.every((height) => height > 0)).toBe(true);

      const headerA = tableMeasurement.table.sections[0].rows[0].cells[0];
      expect(headerA).toMatchObject({
        rowspan: 2,
        runs: [{ text: "Header A" }],
        style: {
          backgroundColor: "#DDEAFE",
          fontWeight: 700,
          borderTopWidth: expect.any(Number),
          paddingLeft: expect.any(Number),
          verticalAlign: "middle"
        }
      });
      const bodyCell = tableMeasurement.table.sections[1].rows[0].cells[0];
      expect(bodyCell).toMatchObject({
        colspan: 2,
        runs: [
          { text: "Body " },
          { text: "cell", fontWeight: 700 }
        ]
      });

      const manifest = convertHtmlToManifest(html, {
        measurements,
        designMode: "replica",
        designSystemSource: resolve("design-systems/business-neutral/DESIGN.md")
      });
      const rich = manifest.slides[0].elements.find((element) => element.id === "rich");
      expect(rich).toMatchObject({ text: "Alpha bold italic link" });
      expect(rich.runs.map((run) => run.text)).toEqual(["Alpha ", "bold ", "italic ", "link"]);
      expect(rich.runs[1]).toMatchObject({ fontWeight: 700, fontFamily: richMeasurement.runs[1].fontFamily });
      expect(rich.runs[2]).toMatchObject({ fontStyle: "italic", fontFamily: richMeasurement.runs[2].fontFamily });
      expect(rich.runs[3]).toMatchObject({ hyperlink: { url: "https://example.com/rich" } });
      const table = manifest.slides[0].elements.find((element) => element.id === "table");
      expect(table.sections.map((section) => section.type)).toEqual(["thead", "tbody", "tfoot"]);
      expect(table).toMatchObject({ colW: expect.arrayContaining([expect.any(Number)]), rowH: expect.arrayContaining([expect.any(Number)]), caption: "Table caption" });
      expect(table.sections[0].rows[0].cells[0]).toMatchObject({ rowspan: 2, runs: [{ text: "Header A" }] });
      expect(table.sections[1].rows[0].cells[0]).toMatchObject({ colspan: 2, runs: [{ text: "Body " }, { text: "cell", fontWeight: 700 }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
