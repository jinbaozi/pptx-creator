import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMeasurementLookup,
  buildMeasurementsDocument,
  convertMeasurementPxToInches,
  getMeasurementBox,
  mergeMeasurementsIntoManifest,
  pxToInches
} from "../scripts/lib/html-measurement-core.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";
import { writeManifestFromHtml } from "../scripts/html-to-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const goldenMeasurementsPath = join(root, "examples/html-input/layout-measurements.json");
const cssHtmlPath = join(root, "examples/html-input/css-positioned-dashboard.html");

describe("html-measurement-core", () => {
  it("converts viewport pixels to slide inches", () => {
    const viewport = { width: 1280, height: 720 };
    const box = convertMeasurementPxToInches({ x: 90, y: 42, w: 1100, h: 58 }, viewport);
    expect(box.x).toBeCloseTo(0.938, 2);
    expect(box.y).toBeCloseTo(0.438, 2);
    expect(box.w).toBeCloseTo(11.458, 2);
    expect(box.h).toBeCloseTo(0.604, 2);
  });

  it("rounds inch values to three decimals", () => {
    expect(pxToInches(1, 3, 10)).toBe(3.333);
  });

  it("merges measurements into manifest elements by id", () => {
    const manifest = {
      slides: [
        {
          elements: [
            { id: "title", type: "text", x: 0, y: 0, w: 1, h: 1 },
            { id: "subtitle", type: "text", x: 0, y: 0, w: 1, h: 1 }
          ]
        }
      ]
    };
    const measurements = {
      elements: [
        { id: "title", x: 0.938, y: 0.438, w: 11.458, h: 0.604 },
        { id: "subtitle", x: 0.938, y: 1.125, w: 9.375, h: 0.375 }
      ]
    };

    mergeMeasurementsIntoManifest(manifest, measurements);
    expect(manifest.slides[0].elements[0]).toMatchObject({ x: 0.938, y: 0.438, w: 11.458, h: 0.604 });
    expect(manifest.slides[0].elements[1]).toMatchObject({ x: 0.938, y: 1.125, w: 9.375, h: 0.375 });
  });

  it("builds lookup and resolves measurement boxes", () => {
    const lookup = buildMeasurementLookup({
      elements: [{ id: "card-dau", x: 1, y: 2, w: 3, h: 4 }]
    });
    expect(getMeasurementBox(lookup, "card-dau")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(getMeasurementBox(lookup, "missing", { x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("normalizes raw measured elements", () => {
    const doc = buildMeasurementsDocument({
      source: "sample.html",
      elements: [{ id: "title", kind: "text", px: { x: 90, y: 42, w: 1100, h: 58 } }]
    });
    expect(doc.version).toBe("0.1.0");
    expect(doc.elements[0].x).toBeCloseTo(0.938, 2);
  });
});

describe("html-to-manifest with measurements", () => {
  it("applies golden measurements to CSS-positioned HTML", async () => {
    const html = await readFile(cssHtmlPath, "utf8");
    const measurements = JSON.parse(await readFile(goldenMeasurementsPath, "utf8"));
    const manifest = convertHtmlToManifest(html, { measurements });

    expect(manifest.slides).toHaveLength(1);
    expect(manifest.slides[0].title).toBe("CSS 布局看板");

    const title = manifest.slides[0].elements.find((el) => el.id === "title");
    expect(title?.x).toBeCloseTo(0.938, 2);
    expect(title?.y).toBeCloseTo(0.438, 2);

    const table = manifest.slides[0].elements.find((el) => el.id === "channel-table");
    expect(table?.type).toBe("table");
    expect(table?.y).toBeCloseTo(3.958, 2);
  });

  it("writes manifest via CLI helper with measurements path", async () => {
    const outputDir = join(root, "output");
    const manifestPath = join(outputDir, "css-dashboard.manifest.json");
    await writeManifestFromHtml(cssHtmlPath, manifestPath, {
      measurements: goldenMeasurementsPath
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.slides[0].elements.some((el) => el.id === "card-dau")).toBe(true);
  });
});

const playwrightEnabled = process.env.PLAYWRIGHT_RUN === "1";

describe.skipIf(!playwrightEnabled)("measure-html (Playwright)", () => {
  it("measures CSS-positioned dashboard in Chromium", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const measurements = await measureHtmlFile(cssHtmlPath);
    expect(measurements.elements.length).toBeGreaterThanOrEqual(5);

    const title = measurements.elements.find((el) => el.id === "title");
    expect(title?.x).toBeCloseTo(0.938, 1);
    expect(title?.y).toBeCloseTo(0.438, 1);
  }, 60000);
});
