import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { measureHtmlFile } from "../scripts/measure-html.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";

const browserIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;

describe("real Chromium rich text and table measurements", () => {
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
