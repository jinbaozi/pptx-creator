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

  it("preserves replica text, src, style, and slide indexes", () => {
    const doc = buildMeasurementsDocument({
      source: "replica.html",
      slides: [
        {
          slideIndex: 1,
          selector: "#slide-2",
          style: { backgroundColor: "#0F172A", backgroundImage: "linear-gradient(red, blue)" },
          replica: { hasUnsupportedEffects: true, backgroundImage: "linear-gradient(red, blue)" }
        }
      ],
      elements: [
        {
          id: "hero-title",
          kind: "text",
          slideIndex: 1,
          text: "Measured title",
          visibleText: "Measured…",
          style: { color: "#111111", fontSize: 30, fontWeight: 700, zIndex: 7 },
          replica: { hasUnsupportedEffects: true, filter: "blur(2px)" },
          px: { x: 96, y: 48, w: 600, h: 72 }
        }
      ]
    });

    expect(doc.elements[0]).toMatchObject({
      id: "hero-title",
      kind: "text",
      slideIndex: 1,
      text: "Measured title",
      visibleText: "Measured…",
      style: { color: "#111111", fontSize: 30, fontWeight: 700, zIndex: 7 },
      replica: { hasUnsupportedEffects: true, filter: "blur(2px)" }
    });
    expect(doc.slides[0]).toMatchObject({
      slideIndex: 1,
      selector: "#slide-2",
      style: { backgroundColor: "#0F172A", backgroundImage: "linear-gradient(red, blue)" },
      replica: { hasUnsupportedEffects: true, backgroundImage: "linear-gradient(red, blue)" }
    });
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

  it("builds replica manifests from measured DOM styles as editable native objects", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica">
        <section class="pptx-slide">
          <div id="panel"><h1 id="title">Replica Title</h1></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [
        {
          slideIndex: 0,
          style: { backgroundColor: "#EEF2FF" },
          replica: { hasUnsupportedEffects: false }
        }
      ],
      elements: [
        {
          id: "panel",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 2,
          style: { backgroundColor: "#F8FAFC", borderColor: "#CBD5E1", borderWidth: 1, borderRadius: 8 }
        },
        {
          id: "title",
          kind: "text",
          slideIndex: 0,
          text: "Replica Title",
          x: 0.8,
          y: 0.8,
          w: 3.2,
          h: 0.45,
          style: { color: "#0F172A", fontFamily: "Aptos", fontSize: 24, fontWeight: 700, textAlign: "left" }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(result.manifest.metadata.mode).toBe("replica");
    expect(slide.path).toBe("replica");
    expect(slide.background).toEqual({ type: "solid", color: "#EEF2FF" });
    expect(slide.elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "panel",
        shape: "roundRect",
        x: 0.5,
        y: 0.5,
        style: expect.objectContaining({ fill: "#F8FAFC", borderColor: "#CBD5E1" })
      })
    );
    expect(slide.elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "title",
        text: "Replica Title",
        style: expect.objectContaining({ color: "#0F172A", fontSize: 24, fontWeight: 700 })
      })
    );
  });

  it("reports unsupported slide background effects in replica mode", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Background">
        <section class="pptx-slide">
          <h1 id="title">Gradient</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [
        {
          slideIndex: 0,
          style: { backgroundColor: "#111827", backgroundImage: "linear-gradient(90deg, red, blue)" },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: "linear-gradient(90deg, red, blue)"
          }
        }
      ],
      elements: [
        {
          id: "title",
          kind: "text",
          slideIndex: 0,
          text: "Gradient",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 0.5,
          style: { color: "#FFFFFF", fontSize: 24 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const slide = result.manifest.slides[0];
    expect(slide.background.color).toBe("#111827");
    expect(slide.replicaUnsupportedEffects).toContainEqual(
      expect.objectContaining({
        elementId: "__slide-background",
        backgroundImage: "linear-gradient(90deg, red, blue)"
      })
    );
    expect(result.replicaCoverage.unsupportedEffects).toContainEqual(
      expect.objectContaining({
        elementId: "__slide-background",
        backgroundImage: "linear-gradient(90deg, red, blue)"
      })
    );
  });

  it("converts simple measured CSS slide background gradients into native PPT background gradients", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Background Gradient">
        <section class="pptx-slide">
          <h1 id="title">Gradient</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [
        {
          slideIndex: 0,
          style: { backgroundColor: "#111827", backgroundImage: "linear-gradient(90deg, #111827, #2563EB)" },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: "linear-gradient(90deg, #111827, #2563EB)"
          }
        }
      ],
      elements: [
        {
          id: "title",
          kind: "text",
          slideIndex: 0,
          text: "Gradient",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 0.5,
          style: { color: "#FFFFFF", fontSize: 24 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(slide.background).toEqual({
      type: "gradient",
      gradient: {
        type: "linear",
        angle: 90,
        stops: [
          { color: "#111827", position: 0 },
          { color: "#2563EB", position: 100 }
        ]
      }
    });
    expect(slide.replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "__slide-background" })
    );
  });

  it("converts multi-stop measured CSS slide background gradients into native PPT background gradients", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Multi Stop Background Gradient">
        <section class="pptx-slide">
          <h1 id="title">Gradient</h1>
        </section>
      </div>`;
    const backgroundImage = "linear-gradient(135deg, #020617 0%, #2563EB 45%, #F97316 100%)";
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [
        {
          slideIndex: 0,
          style: { backgroundColor: "#020617", backgroundImage },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage
          }
        }
      ],
      elements: [
        {
          id: "title",
          kind: "text",
          slideIndex: 0,
          text: "Gradient",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 0.5,
          style: { color: "#FFFFFF", fontSize: 24 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(slide.background).toEqual({
      type: "gradient",
      gradient: {
        type: "linear",
        angle: 135,
        stops: [
          { color: "#020617", position: 0 },
          { color: "#2563EB", position: 45 },
          { color: "#F97316", position: 100 }
        ]
      }
    });
    expect(slide.replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "__slide-background" })
    );
  });

  it("converts directional CSS slide background gradients into native PPT background gradients", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Directional Background Gradient">
        <section class="pptx-slide">
          <h1 id="title">Gradient</h1>
        </section>
      </div>`;
    const backgroundImage = "linear-gradient(to right, #111827 0%, #2563EB 100%)";
    const measurements = {
      viewport: { width: 1280, height: 720 },
      slides: [
        {
          slideIndex: 0,
          style: { backgroundColor: "#111827", backgroundImage },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage
          }
        }
      ],
      elements: [
        {
          id: "title",
          kind: "text",
          slideIndex: 0,
          text: "Gradient",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 0.5,
          style: { color: "#FFFFFF", fontSize: 24 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const slide = result.manifest.slides[0];

    expect(slide.background).toEqual({
      type: "gradient",
      gradient: {
        type: "linear",
        angle: 90,
        stops: [
          { color: "#111827", position: 0 },
          { color: "#2563EB", position: 100 }
        ]
      }
    });
    expect(slide.replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "__slide-background" })
    );
  });

  it("converts centered CSS radial gradients into native PPT radial gradients", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Radial Gradient">
        <section class="pptx-slide">
          <div id="halo-card"></div>
        </section>
      </div>`;
    const backgroundImage = "radial-gradient(circle at center, #F8FAFC 0%, #2563EB 62%, #020617 100%)";
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "halo-card",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 4,
          h: 2.5,
          style: {
            backgroundColor: "#020617",
            backgroundImage
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const card = result.manifest.slides[0].elements.find((element) => element.id === "halo-card");

    expect(card).toMatchObject({
      type: "shape",
      style: {
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
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "halo-card", reason: "unsupported-background-image" })
    );
  });

  it("reports unsupported element background images in replica mode", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Element Background">
        <section class="pptx-slide">
          <div id="photo-card">Photo card</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 1.2,
          style: { backgroundColor: "#111827", backgroundImage: 'url("card-bg.png")' },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: 'url("card-bg.png")'
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });

    expect(result.manifest.slides[0].replicaUnsupportedEffects).toContainEqual(
      expect.objectContaining({
        elementId: "photo-card",
        backgroundImage: 'url("card-bg.png")'
      })
    );
    expect(result.replicaCoverage.unsupportedEffects).toContainEqual(
      expect.objectContaining({
        elementId: "photo-card",
        backgroundImage: 'url("card-bg.png")'
      })
    );
  });

  it("converts supported CSS background image URLs into native PPT image layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Background Image">
        <section class="pptx-slide">
          <div id="photo-card"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 1.2,
          style: {
            backgroundImage: 'url("/tmp/card-bg.png")',
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: 'url("/tmp/card-bg.png")'
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "photo-card-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: "/tmp/card-bg.png",
      x: 0.5,
      y: 1,
      w: 4,
      h: 1.2,
      sizing: {
        type: "cover",
        w: 4,
        h: 1.2
      }
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "photo-card" })
    );
  });

  it("preserves CSS background-position for covered background image crops", () => {
    const imagePath = join(root, "examples/image-input/business-slide.png");
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Background Position">
        <section class="pptx-slide">
          <div id="photo-card"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 3.125,
          h: 1.667,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "cover",
            backgroundPosition: "50% 75%",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "photo-card-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: imagePath,
      x: 0.5,
      y: 1,
      w: 3.125,
      h: 1.667,
      sizing: {
        type: "crop",
        w: 3.125,
        h: 1.667,
        sourceW: 3.125,
        sourceH: 1.758,
        x: 0,
        y: 0.068
      }
    });
  });

  it("converts explicit CSS background-size and position into native image placement", () => {
    const imagePath = join(root, "examples/image-input/business-slide.png");
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Background Size">
        <section class="pptx-slide">
          <div id="photo-card"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 2,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% 50%",
            backgroundPosition: "right bottom",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "photo-card-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: imagePath,
      x: 2.5,
      y: 2,
      w: 2,
      h: 1
    });
    expect(image.sizing).toBeUndefined();
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "photo-card", reason: "unsupported-background-image" })
    );
  });

  it("converts auto CSS background-size into intrinsic native image placement when it fits", () => {
    const imagePath = join(root, "examples/image-input/calibration/mixed.png");
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Auto Background Size">
        <section class="pptx-slide">
          <div id="photo-card"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 3,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "auto",
            backgroundPosition: "right bottom",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "photo-card-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: imagePath,
      x: 2.417,
      y: 1.917,
      w: 2.083,
      h: 2.083
    });
    expect(image.sizing).toBeUndefined();
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "photo-card", reason: "unsupported-background-image" })
    );
  });

  it("converts single-axis auto CSS background-size into proportional native image placement", () => {
    const imagePath = join(root, "examples/image-input/calibration/mixed.png");
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 3,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% auto",
            backgroundPosition: "right bottom",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        },
        {
          id: "single-value-card",
          kind: "shape",
          slideIndex: 0,
          x: 6,
          y: 1,
          w: 4,
          h: 3,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50%",
            backgroundPosition: "right bottom",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const first = result.manifest.slides[0].elements.find((element) => element.id === "photo-card-background-image");
    const singleValue = result.manifest.slides[0].elements.find((element) => element.id === "single-value-card-background-image");

    expect(first).toMatchObject({
      type: "image",
      src: imagePath,
      x: 2.5,
      y: 2,
      w: 2,
      h: 2
    });
    expect(first.sizing).toBeUndefined();
    expect(singleValue).toMatchObject({
      type: "image",
      src: imagePath,
      x: 8,
      y: 2,
      w: 2,
      h: 2
    });
    expect(singleValue.sizing).toBeUndefined();
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ reason: "unsupported-background-image" })
    );
  });

  it("converts px CSS background-position into native image placement", () => {
    const imagePath = join(root, "examples/image-input/calibration/mixed.png");
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "offset-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 3,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% 50%",
            backgroundPosition: "24px 36px",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        },
        {
          id: "edge-offset-card",
          kind: "shape",
          slideIndex: 0,
          x: 6,
          y: 1,
          w: 4,
          h: 3,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% 50%",
            backgroundPosition: "right 24px bottom 36px",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        },
        {
          id: "computed-edge-offset-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 5,
          w: 4,
          h: 2,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% 50%",
            backgroundPosition: "calc(100% - 24px) calc(100% - 36px)",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const offset = result.manifest.slides[0].elements.find((element) => element.id === "offset-card-background-image");
    const edgeOffset = result.manifest.slides[0].elements.find((element) => element.id === "edge-offset-card-background-image");
    const computedEdgeOffset = result.manifest.slides[0].elements.find((element) => element.id === "computed-edge-offset-card-background-image");

    expect(offset).toMatchObject({
      type: "image",
      src: imagePath,
      x: 0.75,
      y: 1.375,
      w: 2,
      h: 1.5
    });
    expect(edgeOffset).toMatchObject({
      type: "image",
      src: imagePath,
      x: 7.75,
      y: 2.125,
      w: 2,
      h: 1.5
    });
    expect(computedEdgeOffset).toMatchObject({
      type: "image",
      src: imagePath,
      x: 2.25,
      y: 5.625,
      w: 2,
      h: 1
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ reason: "unsupported-background-image" })
    );
  });

  it("converts exact repeat-x CSS background images into native image tiles", () => {
    const imagePath = join(root, "examples/image-input/calibration/mixed.png");
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "tile-strip",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 2,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% 100%",
            backgroundPosition: "left top",
            backgroundRepeat: "repeat-x"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const tiles = result.manifest.slides[0].elements.filter((element) => element.id.startsWith("tile-strip-background-image"));

    expect(tiles).toEqual([
      expect.objectContaining({
        type: "image",
        src: imagePath,
        id: "tile-strip-background-image-1",
        x: 0.5,
        y: 1,
        w: 2,
        h: 2
      }),
      expect.objectContaining({
        type: "image",
        src: imagePath,
        id: "tile-strip-background-image-2",
        x: 2.5,
        y: 1,
        w: 2,
        h: 2
      })
    ]);
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "tile-strip", reason: "unsupported-background-image" })
    );
  });

  it("converts exact repeat-y CSS background images into native image tiles", () => {
    const imagePath = join(root, "examples/image-input/calibration/mixed.png");
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "tile-column",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 2,
          h: 4,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "100% 50%",
            backgroundPosition: "left top",
            backgroundRepeat: "repeat-y"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const tiles = result.manifest.slides[0].elements.filter((element) => element.id.startsWith("tile-column-background-image"));

    expect(tiles).toEqual([
      expect.objectContaining({
        id: "tile-column-background-image-1",
        x: 0.5,
        y: 1,
        w: 2,
        h: 2
      }),
      expect.objectContaining({
        id: "tile-column-background-image-2",
        x: 0.5,
        y: 3,
        w: 2,
        h: 2
      })
    ]);
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "tile-column", reason: "unsupported-background-image" })
    );
  });

  it("converts exact full-repeat CSS background images into native image tile grids", () => {
    const imagePath = join(root, "examples/image-input/calibration/mixed.png");
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "tile-grid",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 4,
          style: {
            backgroundImage: `url("${imagePath}")`,
            backgroundSize: "50% 50%",
            backgroundPosition: "left top",
            backgroundRepeat: "repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: `url("${imagePath}")`
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const tiles = result.manifest.slides[0].elements.filter((element) => element.id.startsWith("tile-grid-background-image"));

    expect(tiles).toHaveLength(4);
    expect(tiles).toEqual([
      expect.objectContaining({ id: "tile-grid-background-image-1", x: 0.5, y: 1, w: 2, h: 2 }),
      expect.objectContaining({ id: "tile-grid-background-image-2", x: 2.5, y: 1, w: 2, h: 2 }),
      expect.objectContaining({ id: "tile-grid-background-image-3", x: 0.5, y: 3, w: 2, h: 2 }),
      expect.objectContaining({ id: "tile-grid-background-image-4", x: 2.5, y: 3, w: 2, h: 2 })
    ]);
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "tile-grid", reason: "unsupported-background-image" })
    );
  });

  it("converts stretched CSS background images into native PPT image layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Stretched Background Image">
        <section class="pptx-slide">
          <div id="texture-card"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "texture-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.75,
          y: 1.25,
          w: 3.5,
          h: 1.5,
          style: {
            backgroundImage: 'url("/tmp/texture.png")',
            backgroundSize: "100% 100%",
            backgroundRepeat: "no-repeat"
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: 'url("/tmp/texture.png")'
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "texture-card-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: "/tmp/texture.png",
      x: 0.75,
      y: 1.25,
      w: 3.5,
      h: 1.5
    });
    expect(image.sizing).toBeUndefined();
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "texture-card" })
    );
  });

  it("converts fully rounded CSS background images into native rounded PPT image layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Rounded Background Image">
        <section class="pptx-slide">
          <div id="avatar"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "avatar",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 1,
          h: 1,
          px: { x: 96, y: 96, w: 96, h: 96 },
          style: {
            backgroundImage: 'url("/tmp/avatar.png")',
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
            borderRadius: 48,
            borderTopLeftRadius: 48,
            borderTopRightRadius: 48,
            borderBottomRightRadius: 48,
            borderBottomLeftRadius: 48
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: 'url("/tmp/avatar.png")'
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "avatar-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: "/tmp/avatar.png",
      x: 1,
      y: 1,
      w: 1,
      h: 1,
      rounding: true
    });
  });

  it("converts uniform rounded CSS background images into native roundRect PPT image layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Rounded Card Background Image">
        <section class="pptx-slide">
          <div id="photo-card"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "photo-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.75,
          y: 1.25,
          w: 3.5,
          h: 1.5,
          px: { x: 72, y: 120, w: 336, h: 144 },
          style: {
            backgroundImage: 'url("/tmp/card.png")',
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
            borderRadius: 16,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            borderBottomRightRadius: 16,
            borderBottomLeftRadius: 16
          },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: 'url("/tmp/card.png")'
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const image = result.manifest.slides[0].elements.find((element) => element.id === "photo-card-background-image");

    expect(image).toMatchObject({
      type: "image",
      src: "/tmp/card.png",
      x: 0.75,
      y: 1.25,
      w: 3.5,
      h: 1.5,
      imageShape: "roundRect"
    });
    expect(image.rounding).toBeUndefined();
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "photo-card" })
    );
  });

  it("converts simple measured CSS linear gradients into native PPT gradient fills", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Gradient">
        <section class="pptx-slide">
          <div id="gradient-card">Gradient card</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "gradient-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 1.2,
          style: { backgroundColor: "#111827", backgroundImage: "linear-gradient(90deg, #111827, #2563EB)" },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage: "linear-gradient(90deg, #111827, #2563EB)"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const card = result.manifest.slides[0].elements.find((element) => element.id === "gradient-card");

    expect(card).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        gradient: {
          type: "linear",
          angle: 90,
          stops: [
            { color: "#111827", position: 0 },
            { color: "#2563EB", position: 100 }
          ]
        }
      })
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "gradient-card" })
    );
  });

  it("converts multi-stop measured CSS linear gradients into native PPT gradient fills", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Multi Stop Gradient">
        <section class="pptx-slide">
          <div id="gradient-card">Gradient card</div>
        </section>
      </div>`;
    const backgroundImage = "linear-gradient(135deg, #020617 0%, #2563EB 45%, #F97316 100%)";
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "gradient-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 1.2,
          style: { backgroundColor: "#020617", backgroundImage },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const card = result.manifest.slides[0].elements.find((element) => element.id === "gradient-card");

    expect(card).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { color: "#020617", position: 0 },
            { color: "#2563EB", position: 45 },
            { color: "#F97316", position: 100 }
          ]
        }
      })
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "gradient-card" })
    );
  });

  it("converts directional CSS linear gradients into native PPT gradient fills", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Directional Gradient">
        <section class="pptx-slide">
          <div id="gradient-card">Gradient card</div>
        </section>
      </div>`;
    const backgroundImage = "linear-gradient(to bottom right, #020617 0%, #2563EB 60%, #F97316 100%)";
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "gradient-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.5,
          y: 1,
          w: 4,
          h: 1.2,
          style: { backgroundColor: "#020617", backgroundImage },
          replica: {
            hasUnsupportedEffects: true,
            backgroundImage
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const card = result.manifest.slides[0].elements.find((element) => element.id === "gradient-card");

    expect(card).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { color: "#020617", position: 0 },
            { color: "#2563EB", position: 60 },
            { color: "#F97316", position: 100 }
          ]
        }
      })
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "gradient-card" })
    );
  });

  it("converts fully rounded CSS boxes into native PPT ellipses", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Avatar">
        <section class="pptx-slide">
          <div id="avatar"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "avatar",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 0.8,
          h: 0.8,
          style: {
            backgroundColor: "#2563EB",
            borderColor: "#1D4ED8",
            borderWidth: 2,
            borderRadius: 38.4,
            borderTopLeftRadius: 38.4,
            borderTopRightRadius: 38.4,
            borderBottomRightRadius: 38.4,
            borderBottomLeftRadius: 38.4
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const avatar = result.manifest.slides[0].elements.find((element) => element.id === "avatar");

    expect(avatar).toMatchObject({
      type: "shape",
      shape: "ellipse",
      w: 0.8,
      h: 0.8,
      style: expect.objectContaining({
        fill: "#2563EB",
        borderColor: "#1D4ED8"
      })
    });
  });

  it("preserves measured card groups as editable native card layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Cards">
        <section class="pptx-slide">
          <div id="metric-card"><h3>DAU</h3><p class="metric">128K</p><p>Up 12%</p></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "metric-card",
          kind: "card",
          slideIndex: 0,
          x: 0.7,
          y: 1,
          w: 4,
          h: 1.8,
          style: { backgroundColor: "#FFFFFF", borderColor: "#DBEAFE", borderWidth: 1, borderRadius: 12 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "metric-card",
        style: expect.objectContaining({ fill: "#FFFFFF", borderColor: "#DBEAFE" })
      })
    );
    expect(elements.some((element) => element.type === "text" && element.text === "DAU")).toBe(true);
    expect(elements.some((element) => element.type === "text" && element.text === "128K")).toBe(true);
  });

  it("converts uniform per-corner CSS border radii into native rounded rectangles", () => {
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "rounded-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.7,
          y: 1,
          w: 4,
          h: 1.8,
          style: {
            backgroundColor: "#FFFFFF",
            borderColor: "#DBEAFE",
            borderWidth: 1,
            borderRadius: 0,
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            borderBottomRightRadius: 12,
            borderBottomLeftRadius: 12
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const rounded = result.manifest.slides[0].elements.find((element) => element.id === "rounded-card");

    expect(rounded).toMatchObject({
      type: "shape",
      shape: "roundRect",
      style: expect.objectContaining({
        fill: "#FFFFFF",
        borderColor: "#DBEAFE"
      })
    });
  });

  it("converts simple CSS box shadows into native replica shape shadows", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Shadow">
        <section class="pptx-slide">
          <div id="metric-card">DAU</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "metric-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.7,
          y: 1,
          w: 4,
          h: 1.8,
          style: {
            backgroundColor: "#FFFFFF",
            borderColor: "#DBEAFE",
            borderWidth: 1,
            boxShadow: "rgba(37, 99, 235, 0.08) 0px 8px 24px 0px"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const shadowed = result.manifest.slides[0].elements.find((element) => element.id === "metric-card");

    expect(shadowed).toMatchObject({
      type: "shape",
      style: {
        shadow: {
          type: "outer",
          color: "2563EB",
          opacity: 0.08,
          blur: 18,
          offset: 6,
          angle: 90
        }
      }
    });
  });

  it("converts simple CSS drop-shadow filters into native replica shadows", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Drop Shadow">
        <section class="pptx-slide">
          <div id="metric-card">DAU</div>
          <img id="logo" src="./logo.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "metric-card",
          kind: "shape",
          slideIndex: 0,
          x: 0.7,
          y: 1,
          w: 4,
          h: 1.8,
          style: {
            backgroundColor: "#FFFFFF",
            filter: "drop-shadow(rgba(37, 99, 235, 0.08) 0px 8px 24px)"
          },
          replica: {
            hasUnsupportedEffects: true,
            filter: "drop-shadow(rgba(37, 99, 235, 0.08) 0px 8px 24px)"
          }
        },
        {
          id: "logo",
          kind: "image",
          slideIndex: 0,
          src: "./logo.png",
          x: 5,
          y: 1,
          w: 1.2,
          h: 1.2,
          style: {
            filter: "drop-shadow(rgba(15, 23, 42, 0.35) 0px 3px 10px)"
          },
          replica: {
            hasUnsupportedEffects: true,
            filter: "drop-shadow(rgba(15, 23, 42, 0.35) 0px 3px 10px)"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const card = result.manifest.slides[0].elements.find((element) => element.id === "metric-card");
    const logo = result.manifest.slides[0].elements.find((element) => element.id === "logo");

    expect(card).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        shadow: {
          type: "outer",
          color: "2563EB",
          opacity: 0.08,
          blur: 18,
          offset: 6,
          angle: 90
        }
      })
    });
    expect(logo).toMatchObject({
      type: "image",
      style: {
        shadow: {
          type: "outer",
          color: "0F172A",
          opacity: 0.35,
          blur: 7.5,
          offset: 2.25,
          angle: 90
        }
      }
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "metric-card", filter: expect.stringContaining("drop-shadow") })
    );
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "logo", filter: expect.stringContaining("drop-shadow") })
    );
  });

  it("converts simple CSS text shadows into native replica text shadows", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Shadow">
        <section class="pptx-slide">
          <h1 id="hero-title">Launch Ready</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "hero-title",
          kind: "text",
          slideIndex: 0,
          text: "Launch Ready",
          x: 1,
          y: 1,
          w: 4,
          h: 0.7,
          style: {
            color: "#FFFFFF",
            fontSize: 28,
            textShadow: "rgba(15, 23, 42, 0.35) 0px 3px 10px"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const title = result.manifest.slides[0].elements.find((element) => element.id === "hero-title");

    expect(title).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        shadow: {
          type: "outer",
          color: "0F172A",
          opacity: 0.35,
          blur: 7.5,
          offset: 2.25,
          angle: 90
        }
      })
    });
  });

  it("orders replica layers by measured CSS z-index while preserving DOM order for ties", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Layers">
        <section class="pptx-slide">
          <div id="top">Top</div>
          <div id="bottom">Bottom</div>
          <div id="middle">Middle</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "top",
          kind: "shape",
          slideIndex: 0,
          x: 0.8,
          y: 0.8,
          w: 3,
          h: 1,
          style: { backgroundColor: "#2563EB", zIndex: 20 }
        },
        {
          id: "bottom",
          kind: "shape",
          slideIndex: 0,
          x: 0.7,
          y: 0.7,
          w: 3,
          h: 1,
          style: { backgroundColor: "#FFFFFF", zIndex: 1 }
        },
        {
          id: "middle",
          kind: "shape",
          slideIndex: 0,
          x: 0.75,
          y: 0.75,
          w: 3,
          h: 1,
          style: { backgroundColor: "#DBEAFE", zIndex: 10 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    expect(result.manifest.slides[0].elements.map((element) => element.id)).toEqual(["bottom", "middle", "top"]);
  });

  it("converts measured CSS padding into native PPT text margins", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Padding">
        <section class="pptx-slide">
          <button id="cta">Launch</button>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "cta",
          kind: "text",
          slideIndex: 0,
          text: "Launch",
          x: 1,
          y: 1,
          w: 2.4,
          h: 0.6,
          style: {
            color: "#FFFFFF",
            fontSize: 14,
            paddingTop: 6,
            paddingRight: 18,
            paddingBottom: 6,
            paddingLeft: 18
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const cta = result.manifest.slides[0].elements.find((element) => element.id === "cta");
    expect(cta).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        margin: [6, 18, 6, 18]
      })
    });
  });

  it("converts measured CSS letter spacing into native PPT character spacing", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Tracking">
        <section class="pptx-slide">
          <p id="eyebrow">QUARTERLY REVIEW</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "eyebrow",
          kind: "text",
          slideIndex: 0,
          text: "QUARTERLY REVIEW",
          x: 1,
          y: 1,
          w: 3.2,
          h: 0.35,
          style: {
            color: "#2563EB",
            fontSize: 11,
            letterSpacing: 1.5
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const eyebrow = result.manifest.slides[0].elements.find((element) => element.id === "eyebrow");
    expect(eyebrow).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        charSpacing: 1.5
      })
    });
  });

  it("applies measured CSS text-transform to editable replica text", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Transform">
        <section class="pptx-slide">
          <p id="eyebrow">quarterly review</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "eyebrow",
          kind: "text",
          slideIndex: 0,
          text: "quarterly review",
          x: 1,
          y: 1,
          w: 3.2,
          h: 0.35,
          style: {
            color: "#2563EB",
            fontSize: 11,
            textTransform: "uppercase"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const eyebrow = result.manifest.slides[0].elements.find((element) => element.id === "eyebrow");
    expect(eyebrow).toMatchObject({
      type: "text",
      text: "QUARTERLY REVIEW"
    });
  });

  it("uses measured single-line ellipsis text for editable replica text", () => {
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "headline",
          kind: "text",
          slideIndex: 0,
          text: "Revenue forecast expanded across all regions",
          visibleText: "Revenue forecast…",
          x: 0.8,
          y: 0.8,
          w: 2.4,
          h: 0.4,
          style: {
            color: "#0F172A",
            fontSize: 16,
            whiteSpace: "nowrap",
            overflowX: "hidden",
            textOverflow: "ellipsis"
          }
        }
      ]
    };

    const result = convertHtmlToManifest("", { measurements, designMode: "replica", returnMetadata: true });
    const headline = result.manifest.slides[0].elements.find((element) => element.id === "headline");

    expect(headline).toMatchObject({
      type: "text",
      text: "Revenue forecast…",
      style: expect.objectContaining({
        textOverflow: "ellipsis"
      })
    });
  });

  it("converts logical CSS text alignment using measured direction", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Logical Align">
        <section class="pptx-slide">
          <p id="ltr-end">LTR end</p>
          <p id="rtl-start">RTL start</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "ltr-end",
          kind: "text",
          slideIndex: 0,
          text: "LTR end",
          x: 1,
          y: 1,
          w: 3.2,
          h: 0.35,
          style: {
            color: "#0F172A",
            fontSize: 12,
            textAlign: "end",
            direction: "ltr"
          }
        },
        {
          id: "rtl-start",
          kind: "text",
          slideIndex: 0,
          text: "RTL start",
          x: 1,
          y: 1.5,
          w: 3.2,
          h: 0.35,
          style: {
            color: "#0F172A",
            fontSize: 12,
            textAlign: "start",
            direction: "rtl"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const ltrEnd = result.manifest.slides[0].elements.find((element) => element.id === "ltr-end");
    const rtlStart = result.manifest.slides[0].elements.find((element) => element.id === "rtl-start");

    expect(ltrEnd).toMatchObject({
      type: "text",
      style: expect.objectContaining({ align: "right" })
    });
    expect(rtlStart).toMatchObject({
      type: "text",
      style: expect.objectContaining({ align: "right" })
    });
  });

  it("converts CSS rtl direction into native editable RTL text", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica RTL Text">
        <section class="pptx-slide">
          <p id="rtl-copy">مرحبا بالعالم</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "rtl-copy",
          kind: "text",
          slideIndex: 0,
          text: "مرحبا بالعالم",
          x: 1,
          y: 1,
          w: 4.5,
          h: 0.6,
          style: {
            color: "#0F172A",
            fontSize: 18,
            direction: "rtl",
            textAlign: "start"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const copy = result.manifest.slides[0].elements.find((element) => element.id === "rtl-copy");

    expect(copy).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        rtl: true,
        align: "right"
      })
    });
  });

  it("converts CSS text-indent into native editable text indentation", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Indent">
        <section class="pptx-slide">
          <p id="lede">Indented paragraph copy</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "lede",
          kind: "text",
          slideIndex: 0,
          text: "Indented paragraph copy",
          x: 1,
          y: 1,
          w: 4.5,
          h: 0.7,
          style: {
            color: "#0F172A",
            fontSize: 14,
            textIndent: 24
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const lede = result.manifest.slides[0].elements.find((element) => element.id === "lede");

    expect(lede).toMatchObject({
      type: "text",
      style: expect.objectContaining({ firstLineIndent: 0.25 })
    });
  });

  it("converts CSS text stroke into native editable text outline", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Stroke">
        <section class="pptx-slide">
          <h1 id="hero-title">Launch</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "hero-title",
          kind: "text",
          slideIndex: 0,
          text: "Launch",
          x: 1,
          y: 1,
          w: 4.5,
          h: 0.8,
          style: {
            color: "#FFFFFF",
            fontSize: 44,
            webkitTextStrokeColor: "#2563EB",
            webkitTextStrokeWidth: 2
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const title = result.manifest.slides[0].elements.find((element) => element.id === "hero-title");

    expect(title).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        textStroke: { color: "#2563EB", width: 1.5 }
      })
    });
  });

  it("uses CSS text fill color as editable PPT text fill color", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Fill">
        <section class="pptx-slide">
          <h1 id="hero-title">Launch</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "hero-title",
          kind: "text",
          slideIndex: 0,
          text: "Launch",
          x: 1,
          y: 1,
          w: 4.5,
          h: 0.8,
          style: {
            color: "#111827",
            webkitTextFillColor: "#F97316",
            webkitTextStrokeColor: "#2563EB",
            webkitTextStrokeWidth: 2,
            fontSize: 44
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const title = result.manifest.slides[0].elements.find((element) => element.id === "hero-title");

    expect(title).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        color: "#F97316",
        textStroke: { color: "#2563EB", width: 1.5 }
      })
    });
  });

  it("preserves transparent CSS text fill with editable text stroke", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Outline Text">
        <section class="pptx-slide">
          <h1 id="outline-title">Outline</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "outline-title",
          kind: "text",
          slideIndex: 0,
          text: "Outline",
          x: 1,
          y: 1,
          w: 4.5,
          h: 0.8,
          style: {
            color: "#111827",
            webkitTextFillColor: "#FFFFFF",
            webkitTextFillTransparency: 100,
            webkitTextStrokeColor: "#2563EB",
            webkitTextStrokeWidth: 2,
            fontSize: 44
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const title = result.manifest.slides[0].elements.find((element) => element.id === "outline-title");

    expect(title).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        color: "#FFFFFF",
        transparency: 100,
        textStroke: { color: "#2563EB", width: 1.5 }
      })
    });
  });

  it("converts CSS vertical writing mode into native editable vertical text", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Vertical Text">
        <section class="pptx-slide">
          <p id="side-label">季度报告</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "side-label",
          kind: "text",
          slideIndex: 0,
          text: "季度报告",
          x: 1,
          y: 1,
          w: 0.8,
          h: 2.8,
          style: {
            color: "#0F172A",
            fontSize: 18,
            writingMode: "vertical-rl"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const label = result.manifest.slides[0].elements.find((element) => element.id === "side-label");

    expect(label).toMatchObject({
      type: "text",
      style: expect.objectContaining({ textDirection: "vertical" })
    });
  });

  it("converts measured CSS small-caps into native PPT text style", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Small Caps">
        <section class="pptx-slide">
          <p id="label">Quarterly Review</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "label",
          kind: "text",
          slideIndex: 0,
          text: "Quarterly Review",
          x: 1,
          y: 1,
          w: 3.2,
          h: 0.35,
          style: {
            color: "#2563EB",
            fontSize: 12,
            fontVariantCaps: "small-caps"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const label = result.manifest.slides[0].elements.find((element) => element.id === "label");
    expect(label).toMatchObject({
      type: "text",
      text: "Quarterly Review",
      style: expect.objectContaining({
        smallCaps: true
      })
    });
  });

  it("converts measured CSS text decoration into native PPT text options", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Decoration">
        <section class="pptx-slide">
          <a id="link">Read more</a>
          <span id="old-price">$99</span>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "link",
          kind: "text",
          slideIndex: 0,
          text: "Read more",
          x: 1,
          y: 1,
          w: 2,
          h: 0.35,
          style: {
            color: "#2563EB",
            fontSize: 12,
            textDecorationLine: "underline"
          }
        },
        {
          id: "old-price",
          kind: "text",
          slideIndex: 0,
          text: "$99",
          x: 1,
          y: 1.5,
          w: 1,
          h: 0.35,
          style: {
            color: "#64748B",
            fontSize: 12,
            textDecorationLine: "line-through"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const link = result.manifest.slides[0].elements.find((element) => element.id === "link");
    const oldPrice = result.manifest.slides[0].elements.find((element) => element.id === "old-price");

    expect(link).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        underline: { style: "sng" }
      })
    });
    expect(oldPrice).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        strike: "sngStrike"
      })
    });
  });

  it("converts measured CSS rotation into native editable element rotation", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Rotation">
        <section class="pptx-slide">
          <div id="badge">Live</div>
          <p id="label">Rotated label</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "badge",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 1.4,
          h: 0.5,
          style: {
            backgroundColor: "#2563EB",
            rotate: -12
          }
        },
        {
          id: "label",
          kind: "text",
          slideIndex: 0,
          text: "Rotated label",
          x: 2,
          y: 1,
          w: 2.4,
          h: 0.4,
          style: {
            color: "#111827",
            fontSize: 12,
            rotate: 15
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const badge = result.manifest.slides[0].elements.find((element) => element.id === "badge");
    const label = result.manifest.slides[0].elements.find((element) => element.id === "label");

    expect(badge).toMatchObject({
      type: "shape",
      rotate: -12
    });
    expect(label).toMatchObject({
      type: "text",
      rotate: 15
    });
  });

  it("converts measured CSS object-fit into native editable image sizing", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Image Fit">
        <section class="pptx-slide">
          <img id="hero" src="./hero.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "hero",
          kind: "image",
          slideIndex: 0,
          src: "./hero.png",
          x: 1,
          y: 1,
          w: 3,
          h: 1.6,
          style: {
            objectFit: "cover",
            objectPosition: "50% 50%"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const hero = result.manifest.slides[0].elements.find((element) => element.id === "hero");

    expect(hero).toMatchObject({
      type: "image",
      src: "./hero.png",
      sizing: {
        type: "cover",
        w: 3,
        h: 1.6
      }
    });
  });

  it("preserves measured CSS object-position for covered image crops", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Image Position">
        <section class="pptx-slide">
          <img id="hero" src="./hero.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "hero",
          kind: "image",
          slideIndex: 0,
          src: "./hero.png",
          x: 1,
          y: 1,
          w: 3,
          h: 1.6,
          naturalWidth: 400,
          naturalHeight: 200,
          style: {
            objectFit: "cover",
            objectPosition: "25% 75%"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const hero = result.manifest.slides[0].elements.find((element) => element.id === "hero");

    expect(hero).toMatchObject({
      type: "image",
      src: "./hero.png",
      sizing: {
        type: "crop",
        x: 0.05,
        y: 0,
        w: 3,
        h: 1.6,
        sourceW: 3.2,
        sourceH: 1.6
      }
    });
  });

  it("preserves measured CSS image opacity as native PPT image transparency", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Image Opacity">
        <section class="pptx-slide">
          <img id="watermark" src="./watermark.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "watermark",
          kind: "image",
          slideIndex: 0,
          src: "./watermark.png",
          x: 1,
          y: 1,
          w: 3,
          h: 1.6,
          style: {
            opacity: 0.42,
            objectFit: "contain"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const watermark = result.manifest.slides[0].elements.find((element) => element.id === "watermark");

    expect(watermark).toMatchObject({
      type: "image",
      src: "./watermark.png",
      transparency: 58,
      sizing: {
        type: "contain",
        w: 3,
        h: 1.6
      }
    });
  });

  it("converts measured CSS image box shadows into native image shadows", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Image Shadow">
        <section class="pptx-slide">
          <img id="logo" src="./logo.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "logo",
          kind: "image",
          slideIndex: 0,
          src: "./logo.png",
          x: 1,
          y: 1,
          w: 1.4,
          h: 1.4,
          style: {
            boxShadow: "rgba(15, 23, 42, 0.35) 0px 3px 10px"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const logo = result.manifest.slides[0].elements.find((element) => element.id === "logo");

    expect(logo).toMatchObject({
      type: "image",
      style: {
        shadow: {
          type: "outer",
          color: "0F172A",
          opacity: 0.35,
          blur: 7.5,
          offset: 2.25,
          angle: 90
        }
      }
    });
    expect(result.manifest.slides[0].replicaUnsupportedEffects ?? []).not.toContainEqual(
      expect.objectContaining({ elementId: "logo", reason: "unsupported-box-shadow" })
    );
  });

  it("converts measured CSS image borders into native editable border overlays", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Image Border">
        <section class="pptx-slide">
          <img id="avatar" src="./avatar.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "avatar",
          kind: "image",
          slideIndex: 0,
          src: "./avatar.png",
          x: 1,
          y: 1,
          w: 1,
          h: 1,
          px: { x: 96, y: 96, w: 96, h: 96 },
          style: {
            objectFit: "cover",
            borderColor: "#FFFFFF",
            borderWidth: 3,
            borderStyle: "solid",
            borderRadius: 48,
            borderTopLeftRadius: 48,
            borderTopRightRadius: 48,
            borderBottomRightRadius: 48,
            borderBottomLeftRadius: 48
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;
    const avatar = elements.find((element) => element.id === "avatar");
    const border = elements.find((element) => element.id === "avatar-border");

    expect(avatar).toMatchObject({
      type: "image",
      rounding: true,
      sizing: {
        type: "cover",
        w: 1,
        h: 1
      }
    });
    expect(border).toMatchObject({
      type: "shape",
      shape: "ellipse",
      x: 1,
      y: 1,
      w: 1,
      h: 1,
      style: expect.objectContaining({
        fill: "#FFFFFF",
        transparency: 100,
        borderColor: "#FFFFFF",
        borderWidth: 2.25
      })
    });
    expect(elements.findIndex((element) => element.id === "avatar-border")).toBeGreaterThan(elements.findIndex((element) => element.id === "avatar"));
  });

  it("converts fully rounded CSS img elements into native rounded PPT image layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Rounded Image">
        <section class="pptx-slide">
          <img id="avatar" src="./avatar.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "avatar",
          kind: "image",
          slideIndex: 0,
          src: "./avatar.png",
          x: 1,
          y: 1,
          w: 1,
          h: 1,
          px: { x: 96, y: 96, w: 96, h: 96 },
          style: {
            objectFit: "cover",
            borderRadius: 48,
            borderTopLeftRadius: 48,
            borderTopRightRadius: 48,
            borderBottomRightRadius: 48,
            borderBottomLeftRadius: 48
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const avatar = result.manifest.slides[0].elements.find((element) => element.id === "avatar");

    expect(avatar).toMatchObject({
      type: "image",
      src: "./avatar.png",
      x: 1,
      y: 1,
      w: 1,
      h: 1,
      rounding: true,
      sizing: {
        type: "cover",
        w: 1,
        h: 1
      }
    });
  });

  it("converts uniform rounded CSS img elements into native roundRect PPT image layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Rounded Rect Image">
        <section class="pptx-slide">
          <img id="card-photo" src="./card.png" alt="" />
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "card-photo",
          kind: "image",
          slideIndex: 0,
          src: "./card.png",
          x: 1,
          y: 1,
          w: 3,
          h: 1.5,
          px: { x: 96, y: 96, w: 288, h: 144 },
          style: {
            objectFit: "cover",
            borderRadius: 16,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            borderBottomRightRadius: 16,
            borderBottomLeftRadius: 16
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const photo = result.manifest.slides[0].elements.find((element) => element.id === "card-photo");

    expect(photo).toMatchObject({
      type: "image",
      src: "./card.png",
      x: 1,
      y: 1,
      w: 3,
      h: 1.5,
      imageShape: "roundRect",
      sizing: {
        type: "cover",
        w: 3,
        h: 1.5
      }
    });
    expect(photo.rounding).toBeUndefined();
  });

  it("converts measured dashed CSS borders into native PPT line dash styles", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Border Style">
        <section class="pptx-slide">
          <div id="callout">Callout</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "callout",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 3,
          h: 1,
          style: {
            backgroundColor: "#FFFFFF",
            borderColor: "#2563EB",
            borderWidth: 2,
            borderStyle: "dashed"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const callout = result.manifest.slides[0].elements.find((element) => element.id === "callout");

    expect(callout).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        borderColor: "#2563EB",
        dashType: "dash"
      })
    });
  });

  it("converts measured single-side CSS borders into native PPT lines", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Border Line">
        <section class="pptx-slide">
          <div id="section-rule"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "section-rule",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 4,
          h: 0.45,
          style: {
            backgroundColor: null,
            borderTopWidth: 0,
            borderRightWidth: 0,
            borderBottomWidth: 2,
            borderLeftWidth: 0,
            borderBottomColor: "#2563EB",
            borderBottomStyle: "solid"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const line = result.manifest.slides[0].elements.find((element) => element.id === "section-rule-bottom-border");

    expect(line).toMatchObject({
      type: "line",
      id: "section-rule-bottom-border",
      x: 1,
      y: 1.45,
      w: 4,
      h: 0,
      style: {
        color: "#2563EB",
        width: 1.5
      }
    });
    expect(result.manifest.slides[0].elements.some((element) => element.id === "section-rule" && element.type === "shape")).toBe(false);
  });

  it("preserves measured CSS opacity on native border line replicas", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Border Opacity">
        <section class="pptx-slide">
          <div id="hairline"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "hairline",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 4,
          h: 0.2,
          style: {
            opacity: 0.35,
            borderTopWidth: 1,
            borderRightWidth: 0,
            borderBottomWidth: 0,
            borderLeftWidth: 0,
            borderTopColor: "#64748B",
            borderTopStyle: "solid"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const line = result.manifest.slides[0].elements.find((element) => element.id === "hairline-top-border");

    expect(line).toMatchObject({
      type: "line",
      style: expect.objectContaining({
        color: "#64748B",
        transparency: 65
      })
    });
  });

  it("converts measured CSS outlines into native editable outline shapes", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Outline">
        <section class="pptx-slide">
          <div id="focus-ring"></div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "focus-ring",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 3,
          h: 1,
          style: {
            outlineColor: "#2563EB",
            outlineWidth: 4,
            outlineStyle: "solid",
            outlineOffset: 2
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const outline = result.manifest.slides[0].elements.find((element) => element.id === "focus-ring-outline");

    expect(outline).toMatchObject({
      type: "shape",
      id: "focus-ring-outline",
      shape: "rect",
      x: 0.958,
      y: 0.958,
      w: 3.083,
      h: 1.083,
      style: expect.objectContaining({
        fill: "#FFFFFF",
        transparency: 100,
        borderColor: "#2563EB",
        borderWidth: 3
      })
    });
    expect(result.replicaCoverage).toMatchObject({
      measuredElements: 1,
      coveredElements: 1,
      coverage: 1
    });
  });

  it("preserves CSS outlines on measured text as native editable outline overlays", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Outline">
        <section class="pptx-slide">
          <button id="cta">Launch</button>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "cta",
          kind: "text",
          slideIndex: 0,
          text: "Launch",
          x: 1,
          y: 1,
          w: 2,
          h: 0.6,
          style: {
            color: "#111827",
            fontSize: 18,
            outlineColor: "#F97316",
            outlineWidth: 3,
            outlineStyle: "solid",
            outlineOffset: 1
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;
    const outline = elements.find((element) => element.id === "cta-box-outline");
    const text = elements.find((element) => element.id === "cta");

    expect(outline).toMatchObject({
      type: "shape",
      shape: "rect",
      x: 0.974,
      y: 0.974,
      w: 2.052,
      h: 0.652,
      style: expect.objectContaining({
        fill: "#FFFFFF",
        transparency: 100,
        borderColor: "#F97316",
        borderWidth: 2.25
      })
    });
    expect(text).toMatchObject({
      type: "text",
      text: "Launch"
    });
    expect(elements.findIndex((element) => element.id === "cta-box-outline")).toBeLessThan(elements.findIndex((element) => element.id === "cta"));
  });

  it("preserves asymmetric CSS borders on filled boxes as native PPT line overlays", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Asymmetric Border">
        <section class="pptx-slide">
          <div id="callout-card">Callout</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "callout-card",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 4,
          h: 1.2,
          style: {
            backgroundColor: "#FFFFFF",
            borderColor: "#CBD5E1",
            borderWidth: 0,
            borderTopWidth: 4,
            borderRightWidth: 0,
            borderBottomWidth: 1,
            borderLeftWidth: 0,
            borderTopColor: "#2563EB",
            borderBottomColor: "#CBD5E1",
            borderTopStyle: "solid",
            borderBottomStyle: "dashed"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;
    const fill = elements.find((element) => element.id === "callout-card");
    const top = elements.find((element) => element.id === "callout-card-top-border");
    const bottom = elements.find((element) => element.id === "callout-card-bottom-border");

    expect(fill).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        fill: "#FFFFFF",
        borderWidth: 0
      })
    });
    expect(top).toMatchObject({
      type: "line",
      x: 1,
      y: 1,
      w: 4,
      h: 0,
      style: { color: "#2563EB", width: 3 }
    });
    expect(bottom).toMatchObject({
      type: "line",
      x: 1,
      y: 2.2,
      w: 4,
      h: 0,
      style: expect.objectContaining({ color: "#CBD5E1", width: 0.75, dashType: "dash" })
    });
  });

  it("preserves measured RGBA backgrounds and borders as native PPT transparency", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica RGBA Paint">
        <section class="pptx-slide">
          <div id="glass-card">Glass card</div>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "glass-card",
          kind: "shape",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 3,
          h: 1,
          style: {
            backgroundColor: "#2563EB",
            backgroundTransparency: 82,
            borderColor: "#0F172A",
            borderTransparency: 55,
            borderWidth: 1,
            borderStyle: "solid"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const card = result.manifest.slides[0].elements.find((element) => element.id === "glass-card");

    expect(card).toMatchObject({
      type: "shape",
      style: expect.objectContaining({
        fill: "#2563EB",
        transparency: 82,
        borderColor: "#0F172A",
        borderTransparency: 55
      })
    });
  });

  it("preserves measured RGBA text color as native PPT text transparency", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica RGBA Text">
        <section class="pptx-slide">
          <p id="caption">Caption</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "caption",
          kind: "text",
          slideIndex: 0,
          text: "Caption",
          x: 1,
          y: 1,
          w: 3,
          h: 0.4,
          style: {
            color: "#0F172A",
            colorTransparency: 36,
            fontSize: 12
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const caption = result.manifest.slides[0].elements.find((element) => element.id === "caption");

    expect(caption).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        color: "#0F172A",
        transparency: 36
      })
    });
  });

  it("converts measured flex centering into native PPT text alignment", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Flex Button">
        <section class="pptx-slide">
          <button id="cta">Launch</button>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "cta",
          kind: "text",
          slideIndex: 0,
          text: "Launch",
          x: 1,
          y: 1,
          w: 2.2,
          h: 0.6,
          style: {
            color: "#FFFFFF",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const cta = result.manifest.slides[0].elements.find((element) => element.id === "cta");

    expect(cta).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        align: "center",
        valign: "middle"
      })
    });
  });

  it("preserves measured CSS text opacity as native PPT text transparency", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Text Opacity">
        <section class="pptx-slide">
          <p id="muted-label">Muted label</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "muted-label",
          kind: "text",
          slideIndex: 0,
          text: "Muted label",
          x: 1,
          y: 1,
          w: 3,
          h: 0.4,
          style: {
            color: "#0F172A",
            fontSize: 14,
            opacity: 0.42
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const label = result.manifest.slides[0].elements.find((element) => element.id === "muted-label");

    expect(label).toMatchObject({
      type: "text",
      style: expect.objectContaining({
        color: "#0F172A",
        transparency: 58
      })
    });
  });

  it("uses measured table CSS for native editable table styling", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Table Style">
        <section class="pptx-slide">
          <table id="metrics">
            <thead><tr><th>Metric</th><th>Value</th></tr></thead>
            <tbody><tr><td>ARR</td><td>$12M</td></tr></tbody>
          </table>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "metrics",
          kind: "table",
          slideIndex: 0,
          x: 1,
          y: 1,
          w: 4.5,
          h: 1.2,
          style: {
            backgroundColor: "#F8FAFC",
            borderColor: "#2563EB",
            borderWidth: 2,
            color: "#0F172A",
            fontSize: 13
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const table = result.manifest.slides[0].elements.find((element) => element.id === "metrics");

    expect(table).toMatchObject({
      type: "table",
      headers: ["Metric", "Value"],
      rows: [["ARR", "$12M"]],
      style: expect.objectContaining({
        fill: "#F8FAFC",
        headerFill: "#F8FAFC",
        borderColor: "#2563EB",
        borderWidth: 1.5,
        color: "#0F172A",
        fontSize: 13
      })
    });
  });

  it("converts measured inline text fragments into native editable text layers", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Inline Text">
        <section class="pptx-slide">
          <p id="headline">Metrics <strong id="headline-strong">up</strong> today</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "headline-text-1",
          kind: "text",
          slideIndex: 0,
          text: "Metrics",
          x: 1,
          y: 1,
          w: 1.1,
          h: 0.3,
          style: { color: "#0F172A", fontSize: 18 }
        },
        {
          id: "headline-strong",
          kind: "text",
          slideIndex: 0,
          text: "up",
          x: 2.15,
          y: 1,
          w: 0.35,
          h: 0.3,
          style: { color: "#2563EB", fontSize: 18, fontWeight: 700 }
        },
        {
          id: "headline-text-2",
          kind: "text",
          slideIndex: 0,
          text: "today",
          x: 2.55,
          y: 1,
          w: 0.8,
          h: 0.3,
          style: { color: "#0F172A", fontSize: 18 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const texts = result.manifest.slides[0].elements.filter((element) => element.type === "text");

    expect(texts.map((element) => element.text)).toEqual(["Metrics", "up", "today"]);
    expect(texts).toContainEqual(
      expect.objectContaining({
        id: "headline-strong",
        style: expect.objectContaining({ color: "#2563EB", fontWeight: 700 })
      })
    );
  });

  it("preserves measured explicit text line breaks as native editable text content", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Line Break Text">
        <section class="pptx-slide">
          <p id="region-label">North<br>America</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "region-label",
          kind: "text",
          slideIndex: 0,
          text: "North\nAmerica",
          x: 1,
          y: 1,
          w: 1.5,
          h: 0.7,
          style: { color: "#0F172A", fontSize: 18, lineHeight: 21 }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const label = result.manifest.slides[0].elements.find((element) => element.id === "region-label");

    expect(label).toMatchObject({
      type: "text",
      text: "North\nAmerica",
      style: expect.objectContaining({
        color: "#0F172A",
        lineHeight: 21
      })
    });
  });

  it("preserves measured CSS white-space text newlines as native editable text content", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica White Space Text">
        <section class="pptx-slide">
          <p id="note">First line
Second line</p>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "note",
          kind: "text",
          slideIndex: 0,
          text: "First line\nSecond line",
          x: 1,
          y: 1,
          w: 2.2,
          h: 0.7,
          style: { color: "#0F172A", fontSize: 15, lineHeight: 19.5, whiteSpace: "pre-line" }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const note = result.manifest.slides[0].elements.find((element) => element.id === "note");

    expect(note).toMatchObject({
      type: "text",
      text: "First line\nSecond line",
      style: expect.objectContaining({
        color: "#0F172A",
        lineHeight: 19.5
      })
    });
  });

  it("converts simple SVG circle, ellipse, and rect primitives into native editable shapes", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Primitives">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <circle id="status-dot" cx="50" cy="50" r="30" fill="#22C55E" stroke="#14532D" stroke-width="4" />
            <ellipse id="focus-oval" cx="100" cy="50" rx="35" ry="20" fill="#FDE68A" stroke="#92400E" stroke-width="3" />
            <rect id="legend-bar" x="110" y="25" width="70" height="50" fill="#2563EB" stroke="#1E3A8A" stroke-width="2" />
            <rect id="rounded-badge" x="20" y="10" width="40" height="20" rx="8" ry="8" fill="#DBEAFE" stroke="#1D4ED8" stroke-width="2" />
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "status-dot",
        shape: "ellipse",
        x: 1.2,
        y: 1.2,
        w: 0.6,
        h: 0.6,
        style: expect.objectContaining({
          fill: "#22C55E",
          borderColor: "#14532D",
          borderWidth: 2.88
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "focus-oval",
        shape: "ellipse",
        x: 1.65,
        y: 1.3,
        w: 0.7,
        h: 0.4,
        style: expect.objectContaining({
          fill: "#FDE68A",
          borderColor: "#92400E",
          borderWidth: 2.16
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "legend-bar",
        shape: "rect",
        x: 2.1,
        y: 1.25,
        w: 0.7,
        h: 0.5,
        style: expect.objectContaining({
          fill: "#2563EB",
          borderColor: "#1E3A8A",
          borderWidth: 1.44
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "rounded-badge",
        shape: "roundRect",
        x: 1.2,
        y: 1.1,
        w: 0.4,
        h: 0.2,
        style: expect.objectContaining({
          fill: "#DBEAFE",
          borderColor: "#1D4ED8",
          borderWidth: 1.44
        })
      })
    );
  });

  it("converts simple SVG text primitives into native editable text", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Text">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <text id="axis-label" x="40" y="60" fill="#0F172A" font-size="20" font-family="Aptos">Revenue</text>
            <text id="emphasis-label" x="40" y="90" fill="#7C3AED" font-size="18" font-weight="700" font-style="italic">Target</text>
            <text id="decorated-label" x="120" y="90" fill="#2563EB" font-size="18" text-decoration="underline line-through">Decorated</text>
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "axis-label",
        text: "Revenue",
        x: 1.4,
        y: 1.4,
        w: 1.6,
        h: 0.24,
        style: expect.objectContaining({
          color: "#0F172A",
          fontSize: 14.4,
          fontFamily: "Aptos"
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "emphasis-label",
        text: "Target",
        x: 1.4,
        y: 1.72,
        w: 1.6,
        h: 0.216,
        style: expect.objectContaining({
          color: "#7C3AED",
          fontSize: 12.96,
          fontWeight: 700,
          italic: true
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "decorated-label",
        text: "Decorated",
        x: 2.2,
        y: 1.72,
        w: 0.8,
        h: 0.216,
        style: expect.objectContaining({
          color: "#2563EB",
          fontSize: 12.96,
          underline: { style: "sng" },
          strike: "sngStrike"
        })
      })
    );
  });

  it("preserves simple SVG text-anchor as native text alignment", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Text Anchor">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <text id="center-label" x="100" y="40" text-anchor="middle" fill="#2563EB" font-size="20">Center</text>
            <text id="end-label" x="180" y="80" text-anchor="end" fill="#0F172A" font-size="20">End</text>
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "center-label",
        x: 1,
        y: 1.2,
        w: 2,
        h: 0.24,
        style: expect.objectContaining({
          align: "center",
          color: "#2563EB"
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "end-label",
        x: 1,
        y: 1.6,
        w: 1.8,
        h: 0.24,
        style: expect.objectContaining({
          align: "right",
          color: "#0F172A"
        })
      })
    );
  });

  it("preserves simple SVG opacity attributes as native PPT transparency", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Opacity">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <rect id="ghost-card" x="20" y="20" width="80" height="40" fill="#2563EB" fill-opacity="0.42" stroke="#0F172A" stroke-opacity="0.35" stroke-width="2" />
            <line id="ghost-line" x1="20" y1="80" x2="180" y2="80" stroke="#F97316" stroke-opacity="0.35" stroke-width="2" />
            <text id="ghost-label" x="40" y="60" fill="#0F172A" opacity="0.42" font-size="20">Muted</text>
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "shape",
        id: "ghost-card",
        style: expect.objectContaining({
          transparency: 58,
          borderTransparency: 65
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "ghost-line",
        style: expect.objectContaining({
          transparency: 65
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "text",
        id: "ghost-label",
        style: expect.objectContaining({
          transparency: 58
        })
      })
    );
  });

  it("converts simple SVG M/L paths into native editable lines with true geometry", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Path Line">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <path id="trend-line" d="M 20 30 L 180 70" stroke="#F97316" stroke-width="3" />
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "trend-line",
        x: 1.2,
        y: 1.3,
        w: 1.6,
        h: 0.4,
        style: expect.objectContaining({
          color: "#F97316",
          width: 2.16
        })
      })
    );
  });

  it("converts simple SVG line primitives into native editable lines", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Line">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <line id="axis-line" x1="25" y1="80" x2="175" y2="20" stroke="#0EA5E9" stroke-width="2" />
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "axis-line",
        x: 1.25,
        y: 1.8,
        w: 1.5,
        h: -0.6,
        style: expect.objectContaining({
          color: "#0EA5E9",
          width: 1.44
        })
      })
    );
  });

  it("converts simple SVG polyline primitives into native editable line segments", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Polyline">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <polyline id="sparkline" points="20,80 100,30 180,70" stroke="#8B5CF6" stroke-width="2" fill="none" />
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "sparkline-segment-1",
        x: 1.2,
        y: 1.8,
        w: 0.8,
        h: -0.5,
        style: expect.objectContaining({
          color: "#8B5CF6",
          width: 1.44
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "sparkline-segment-2",
        x: 2,
        y: 1.3,
        w: 0.8,
        h: 0.4,
        style: expect.objectContaining({
          color: "#8B5CF6",
          width: 1.44
        })
      })
    );
  });

  it("converts stroke-only SVG polygon primitives into closed native editable line segments", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica SVG Polygon">
        <section class="pptx-slide">
          <svg data-x="1" data-y="1" data-w="2" data-h="1" viewBox="0 0 200 100">
            <polygon id="warning-triangle" points="100,20 180,80 20,80" stroke="#F97316" stroke-width="3" fill="none" />
          </svg>
        </section>
      </div>`;

    const result = convertHtmlToManifest(html, { designMode: "replica", returnMetadata: true });
    const elements = result.manifest.slides[0].elements;

    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "warning-triangle-segment-1",
        x: 2,
        y: 1.2,
        w: 0.8,
        h: 0.6,
        style: expect.objectContaining({
          color: "#F97316",
          width: 2.16
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "warning-triangle-segment-2",
        x: 2.8,
        y: 1.8,
        w: -1.6,
        h: 0,
        style: expect.objectContaining({
          color: "#F97316",
          width: 2.16
        })
      })
    );
    expect(elements).toContainEqual(
      expect.objectContaining({
        type: "line",
        id: "warning-triangle-segment-3",
        x: 1.2,
        y: 1.8,
        w: 0.8,
        h: -0.6,
        style: expect.objectContaining({
          color: "#F97316",
          width: 2.16
        })
      })
    );
  });

  it("converts measured CSS list markers into native editable bullet text", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Replica Bullet List">
        <section class="pptx-slide">
          <ul><li id="growth">Revenue growth</li></ul>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "growth",
          kind: "text",
          slideIndex: 0,
          text: "Revenue growth",
          x: 1,
          y: 1,
          w: 2.2,
          h: 0.3,
          style: {
            color: "#0F172A",
            fontSize: 15,
            display: "list-item",
            listStyleType: "disc",
            listStylePosition: "outside"
          }
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    const growth = result.manifest.slides[0].elements.find((element) => element.id === "growth");

    expect(growth).toMatchObject({
      type: "text",
      text: "Revenue growth",
      style: expect.objectContaining({
        color: "#0F172A",
        bullet: {
          type: "bullet",
          characterCode: "2022"
        }
      })
    });
  });

  it("reports replica coverage for dropped measured nodes", () => {
    const html = `
      <div class="pptx-deck" data-deck-title="Coverage">
        <section class="pptx-slide">
          <h1 id="title">Coverage</h1>
        </section>
      </div>`;
    const measurements = {
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          id: "title",
          kind: "text",
          slideIndex: 0,
          text: "Coverage",
          x: 0.5,
          y: 0.5,
          w: 4,
          h: 0.5,
          style: { color: "#111111", fontSize: 24 }
        },
        {
          id: "fancy",
          kind: "css-gradient",
          slideIndex: 0,
          x: 0.5,
          y: 1.2,
          w: 4,
          h: 1,
          style: {}
        }
      ]
    };

    const result = convertHtmlToManifest(html, { measurements, designMode: "replica", returnMetadata: true });
    expect(result.replicaCoverage).toMatchObject({
      measuredElements: 2,
      coveredElements: 1,
      coverage: 0.5
    });
    expect(result.replicaCoverage.droppedElements).toContainEqual(
      expect.objectContaining({ elementId: "fancy", kind: "css-gradient", reason: "unsupported-kind" })
    );
    expect(result.replicaCoverage.coverage).toBe(0.5);
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

  it("captures computed CSS padding for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "padding-")));
    const input = join(dir, "padding.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <button id="cta" style="position:absolute;left:96px;top:96px;padding:8px 24px;color:#fff;background:#2563eb;">Launch</button>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const cta = measurements.elements.find((element) => element.id === "cta");

    expect(cta?.style).toMatchObject({
      paddingTop: 6,
      paddingRight: 18,
      paddingBottom: 6,
      paddingLeft: 18
    });
  }, 60000);

  it("captures computed CSS letter-spacing for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "tracking-")));
    const input = join(dir, "tracking.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="eyebrow" style="position:absolute;left:96px;top:96px;letter-spacing:2px;color:#2563eb;">QUARTERLY REVIEW</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const eyebrow = measurements.elements.find((element) => element.id === "eyebrow");

    expect(eyebrow?.style?.letterSpacing).toBe(1.5);
  }, 60000);

  it("captures computed CSS text-transform for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-transform-")));
    const input = join(dir, "text-transform.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="eyebrow" style="position:absolute;left:96px;top:96px;text-transform:uppercase;color:#2563eb;">quarterly review</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const eyebrow = measurements.elements.find((element) => element.id === "eyebrow");

    expect(eyebrow?.text).toBe("quarterly review");
    expect(eyebrow?.style?.textTransform).toBe("uppercase");
  }, 60000);

  it("captures single-line CSS text-overflow ellipsis as visible replica text", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-ellipsis-")));
    const input = join(dir, "text-ellipsis.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="headline" style="position:absolute;left:96px;top:96px;width:128px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:600 18px Arial;color:#0f172a;">Revenue forecast expanded across all regions</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const headline = measurements.elements.find((element) => element.id === "headline");

    expect(headline?.text).toBe("Revenue forecast expanded across all regions");
    expect(headline?.visibleText).toContain("…");
    expect(headline?.visibleText.length).toBeLessThan(headline?.text.length ?? 0);
    expect(headline?.style).toMatchObject({
      whiteSpace: "nowrap",
      overflowX: "hidden",
      textOverflow: "ellipsis"
    });
  }, 60000);

  it("captures computed CSS direction for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "direction-")));
    const input = join(dir, "direction.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="label" dir="rtl" style="position:absolute;left:96px;top:96px;text-align:start;color:#0f172a;">RTL label</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const label = measurements.elements.find((element) => element.id === "label");

    expect(label?.style?.textAlign).toBe("start");
    expect(label?.style?.direction).toBe("rtl");
  }, 60000);

  it("captures computed CSS text-indent for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-indent-")));
    const input = join(dir, "text-indent.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="lede" style="position:absolute;left:96px;top:96px;width:360px;text-indent:24px;color:#0f172a;">Indented paragraph copy wraps to a second line for paragraph measurement.</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const lede = measurements.elements.find((element) => element.id === "lede");

    expect(lede?.style?.textIndent).toBe(24);
  }, 60000);

  it("captures computed CSS text stroke for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-stroke-")));
    const input = join(dir, "text-stroke.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <h1 id="hero-title" style="position:absolute;left:96px;top:96px;color:#fff;-webkit-text-stroke:2px #2563eb;">Launch</h1>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const title = measurements.elements.find((element) => element.id === "hero-title");

    expect(title?.style?.webkitTextStrokeColor).toBe("#2563EB");
    expect(title?.style?.webkitTextStrokeWidth).toBe(2);
  }, 60000);

  it("captures computed CSS text fill color for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-fill-")));
    const input = join(dir, "text-fill.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <h1 id="hero-title" style="position:absolute;left:96px;top:96px;color:#111827;-webkit-text-fill-color:#f97316;-webkit-text-stroke:2px #2563eb;">Launch</h1>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const title = measurements.elements.find((element) => element.id === "hero-title");

    expect(title?.style?.color).toBe("#111827");
    expect(title?.style?.webkitTextFillColor).toBe("#F97316");
  }, 60000);

  it("captures CSS text fill and stroke alpha for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-alpha-")));
    const input = join(dir, "text-alpha.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <h1 id="outline-title" style="position:absolute;left:96px;top:96px;color:#111827;-webkit-text-fill-color:rgba(255,255,255,0);-webkit-text-stroke:2px rgba(37,99,235,.4);">Outline</h1>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const title = measurements.elements.find((element) => element.id === "outline-title");

    expect(title?.style?.webkitTextFillColor).toBe("#FFFFFF");
    expect(title?.style?.webkitTextFillTransparency).toBe(100);
    expect(title?.style?.webkitTextStrokeColor).toBe("#2563EB");
    expect(title?.style?.webkitTextStrokeTransparency).toBe(60);
  }, 60000);

  it("captures computed CSS writing-mode for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "writing-mode-")));
    const input = join(dir, "writing-mode.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="side-label" style="position:absolute;left:96px;top:96px;writing-mode:vertical-rl;color:#0f172a;">季度报告</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const label = measurements.elements.find((element) => element.id === "side-label");

    expect(label?.style?.writingMode).toBe("vertical-rl");
  }, 60000);

  it("captures computed CSS font-variant-caps for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "small-caps-")));
    const input = join(dir, "small-caps.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="label" style="position:absolute;left:96px;top:96px;font-variant-caps:small-caps;color:#2563eb;">Quarterly Review</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const label = measurements.elements.find((element) => element.id === "label");

    expect(label?.text).toBe("Quarterly Review");
    expect(label?.style?.fontVariantCaps).toBe("small-caps");
  }, 60000);

  it("captures explicit HTML line breaks in replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "line-break-")));
    const input = join(dir, "line-break.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="region-label" style="position:absolute;left:96px;top:96px;font-size:24px;line-height:28px;color:#0f172a;">North<br>America</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const label = measurements.elements.find((element) => element.id === "region-label");

    expect(label?.text).toBe("North\nAmerica");
    expect(label?.style?.lineHeight).toBe(21);
  }, 60000);

  it("captures CSS white-space pre-line text newlines in replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "pre-line-")));
    const input = join(dir, "pre-line.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="note" style="position:absolute;left:96px;top:96px;font-size:20px;line-height:26px;white-space:pre-line;color:#0f172a;">First line
Second line</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const note = measurements.elements.find((element) => element.id === "note");

    expect(note?.text).toBe("First line\nSecond line");
    expect(note?.style).toMatchObject({
      lineHeight: 19.5,
      whiteSpace: "pre-line"
    });
  }, 60000);

  it("captures computed CSS text-decoration for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-decoration-")));
    const input = join(dir, "text-decoration.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <a id="link" style="position:absolute;left:96px;top:96px;text-decoration:underline;color:#2563eb;">Read more</a>
              <span id="old-price" style="position:absolute;left:96px;top:140px;text-decoration:line-through;color:#64748b;">$99</span>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const link = measurements.elements.find((element) => element.id === "link");
    const oldPrice = measurements.elements.find((element) => element.id === "old-price");

    expect(link?.style?.textDecorationLine).toContain("underline");
    expect(oldPrice?.style?.textDecorationLine).toContain("line-through");
  }, 60000);

  it("captures computed CSS list marker styles for replica list items", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "list-marker-")));
    const input = join(dir, "list-marker.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <ul style="position:absolute;left:96px;top:96px;margin:0;padding-left:28px;color:#0f172a;">
                <li id="growth" style="font-size:20px;line-height:26px;list-style-type:disc;list-style-position:outside;">Revenue growth</li>
              </ul>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const growth = measurements.elements.find((element) => element.id === "growth");

    expect(growth).toMatchObject({
      kind: "text",
      text: "Revenue growth",
      style: expect.objectContaining({
        display: "list-item",
        listStyleType: "disc",
        listStylePosition: "outside"
      })
    });
  }, 60000);

  it("captures direct text-node fragments inside mixed inline replica text", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "inline-text-")));
    const input = join(dir, "inline-text.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="headline" style="position:absolute;left:96px;top:96px;font-size:24px;color:#0f172a;">
                Metrics <strong id="headline-strong" style="color:#2563eb;">up</strong> today
              </p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const fragments = measurements.elements.filter((element) => element.id.startsWith("headline-text-"));
    const strong = measurements.elements.find((element) => element.id === "headline-strong");

    expect(fragments.map((element) => element.text)).toEqual(["Metrics", "today"]);
    expect(fragments.every((element) => element.kind === "text" && element.w > 0 && element.h > 0)).toBe(true);
    expect(strong).toMatchObject({
      kind: "text",
      text: "up",
      style: expect.objectContaining({ color: "#2563EB" })
    });
  }, 60000);

  it("captures computed CSS transform rotation for replica nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "rotation-")));
    const input = join(dir, "rotation.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <p id="label" style="position:absolute;left:160px;top:120px;transform:rotate(15deg);color:#111827;">Rotated label</p>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const label = measurements.elements.find((element) => element.id === "label");

    expect(label?.style?.transform).toContain("matrix");
    expect(label?.style?.rotate).toBeCloseTo(15, 1);
  }, 60000);

  it("captures computed CSS object-fit for replica image nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "object-fit-")));
    const input = join(dir, "object-fit.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <img id="hero" src="${join(root, "examples/image-input/business-slide.png")}" style="position:absolute;left:96px;top:96px;width:320px;height:160px;object-fit:cover;object-position:50% 50%;" />
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const hero = measurements.elements.find((element) => element.id === "hero");

    expect(hero?.style).toMatchObject({
      objectFit: "cover",
      objectPosition: "50% 50%"
    });
    expect(hero).toMatchObject({
      naturalWidth: 1920,
      naturalHeight: 1080
    });
  }, 60000);

  it("captures fully rounded CSS border-radius for replica image nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "rounded-img-")));
    const input = join(dir, "rounded-img.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <img id="avatar" src="${join(root, "examples/image-input/business-slide.png")}" style="position:absolute;left:96px;top:96px;width:96px;height:96px;border-radius:50%;object-fit:cover;" />
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const avatar = measurements.elements.find((element) => element.id === "avatar");

    expect(avatar).toMatchObject({
      kind: "image",
      style: expect.objectContaining({
        objectFit: "cover",
        borderRadius: 48,
        borderTopLeftRadius: 48,
        borderTopRightRadius: 48,
        borderBottomRightRadius: 48,
        borderBottomLeftRadius: 48
      })
    });
  }, 60000);

  it("captures computed CSS border and box-shadow for replica image nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "image-border-shadow-")));
    const input = join(dir, "image-border-shadow.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <img id="avatar" src="${join(root, "examples/image-input/business-slide.png")}" style="position:absolute;left:96px;top:96px;width:96px;height:96px;border:3px solid #fff;border-radius:50%;box-shadow:0px 3px 10px rgba(15,23,42,.35);object-fit:cover;" />
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const avatar = measurements.elements.find((element) => element.id === "avatar");

    expect(avatar?.style).toMatchObject({
      objectFit: "cover",
      borderColor: "#FFFFFF",
      borderWidth: 3,
      borderStyle: "solid",
      borderRadius: 51
    });
    expect(avatar?.style?.boxShadow).toContain("rgba");
    expect(avatar?.style?.boxShadow).toContain("10px");
  }, 60000);

  it("captures computed CSS border style for replica shape nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "border-style-")));
    const input = join(dir, "border-style.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="callout" style="position:absolute;left:96px;top:96px;width:240px;height:80px;background:#fff;border:2px dashed #2563eb;"></div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const callout = measurements.elements.find((element) => element.id === "callout");

    expect(callout?.style).toMatchObject({
      borderStyle: "dashed"
    });
  }, 60000);

  it("captures computed CSS outline for replica shape nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "outline-")));
    const input = join(dir, "outline.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="focus-ring" style="position:absolute;left:96px;top:96px;width:240px;height:80px;outline:4px solid #2563eb;outline-offset:2px;"></div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const focusRing = measurements.elements.find((element) => element.id === "focus-ring");

    expect(focusRing).toMatchObject({
      kind: "shape",
      style: expect.objectContaining({
        outlineColor: "#2563EB",
        outlineWidth: 4,
        outlineStyle: "solid",
        outlineOffset: 2
      })
    });
  }, 60000);

  it("captures computed CSS outline for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-outline-")));
    const input = join(dir, "text-outline.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <button id="cta" style="position:absolute;left:96px;top:96px;width:180px;height:56px;outline:3px solid #f97316;outline-offset:1px;color:#111827;background:transparent;border:0;">Launch</button>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const cta = measurements.elements.find((element) => element.id === "cta");

    expect(cta).toMatchObject({
      kind: "text",
      text: "Launch",
      style: expect.objectContaining({
        outlineColor: "#F97316",
        outlineWidth: 3,
        outlineStyle: "solid",
        outlineOffset: 1
      })
    });
  }, 60000);

  it("captures per-side CSS border measurements for replica nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "border-side-")));
    const input = join(dir, "border-side.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="section-rule" style="position:absolute;left:96px;top:96px;width:320px;height:48px;border-bottom:2px solid #2563eb;"></div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const rule = measurements.elements.find((element) => element.id === "section-rule");

    expect(rule?.style).toMatchObject({
      borderTopWidth: 0,
      borderRightWidth: 0,
      borderBottomWidth: 2,
      borderLeftWidth: 0,
      borderBottomColor: "#2563EB",
      borderBottomStyle: "solid"
    });
  }, 60000);

  it("captures per-corner CSS border-radius measurements for replica nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "border-radius-")));
    const input = join(dir, "border-radius.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="avatar" style="position:absolute;left:96px;top:96px;width:96px;height:96px;border-radius:50%;background:#2563eb;"></div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const avatar = measurements.elements.find((element) => element.id === "avatar");

    expect(avatar?.style).toMatchObject({
      borderTopLeftRadius: 48,
      borderTopRightRadius: 48,
      borderBottomRightRadius: 48,
      borderBottomLeftRadius: 48
    });
  }, 60000);

  it("captures computed RGBA alpha as transparency fields for replica nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "rgba-alpha-")));
    const input = join(dir, "rgba-alpha.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="glass-card" style="position:absolute;left:96px;top:96px;width:320px;height:80px;color:rgba(15,23,42,.64);background:rgba(37,99,235,.18);border:1px solid rgba(15,23,42,.45);">Glass card</div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const card = measurements.elements.find((element) => element.id === "glass-card");

    expect(card?.style).toMatchObject({
      color: "#0F172A",
      colorTransparency: 36,
      backgroundColor: "#2563EB",
      backgroundTransparency: 82,
      borderColor: "#0F172A",
      borderTransparency: 55,
      borderTopTransparency: 55,
      borderRightTransparency: 55,
      borderBottomTransparency: 55,
      borderLeftTransparency: 55
    });
  }, 60000);

  it("captures computed flex alignment for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "flex-align-")));
    const input = join(dir, "flex-align.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <button id="cta" style="position:absolute;left:96px;top:96px;width:220px;height:64px;display:flex;align-items:center;justify-content:center;background:#2563eb;color:#fff;">Launch</button>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const cta = measurements.elements.find((element) => element.id === "cta");

    expect(cta?.style).toMatchObject({
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    });
  }, 60000);

  it("captures computed CSS text-shadow for replica text nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "text-shadow-")));
    const input = join(dir, "text-shadow.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <h1 id="hero-title" style="position:absolute;left:96px;top:96px;color:#fff;text-shadow:0px 3px 10px rgba(15,23,42,.35);">Launch Ready</h1>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const title = measurements.elements.find((element) => element.id === "hero-title");

    expect(title?.style?.textShadow).toContain("rgba");
    expect(title?.style?.textShadow).toContain("10px");
  }, 60000);

  it("captures computed CSS drop-shadow filters for replica nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "drop-shadow-filter-")));
    const input = join(dir, "drop-shadow-filter.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <img id="logo" src="${join(root, "examples/image-input/business-slide.png")}" style="position:absolute;left:96px;top:96px;width:96px;height:96px;filter:drop-shadow(0px 8px 18px rgba(15,23,42,.35));" />
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const logo = measurements.elements.find((element) => element.id === "logo");

    expect(logo?.replica?.filter).toContain("drop-shadow");
    expect(logo?.replica?.filter).toContain("18px");
  }, 60000);

  it("captures gradient-only painted boxes as replica shape nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "gradient-only-shape-")));
    const input = join(dir, "gradient-only-shape.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="gradient-card" style="position:absolute;left:96px;top:96px;width:360px;height:120px;background:linear-gradient(to right, #111827 0%, #2563eb 100%);border-radius:12px;"></div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const card = measurements.elements.find((element) => element.id === "gradient-card");

    expect(card).toMatchObject({
      kind: "shape",
      style: expect.objectContaining({
        backgroundImage: expect.stringContaining("linear-gradient")
      })
    });
  }, 60000);

  it("captures supported CSS background image sizing for replica shape nodes", async () => {
    let measureHtmlFile;
    try {
      ({ measureHtmlFile } = await import("../scripts/measure-html.mjs"));
    } catch {
      return;
    }

    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(root, "output", "background-image-shape-")));
    const input = join(dir, "background-image-shape.html");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        input,
        `<!doctype html>
        <html>
          <body>
            <section class="pptx-slide">
              <div id="photo-card" style="position:absolute;left:96px;top:96px;width:360px;height:120px;background-image:url('${join(root, "examples/image-input/business-slide.png")}');background-size:cover;background-position:50% 75%;background-repeat:no-repeat;"></div>
            </section>
          </body>
        </html>`,
        "utf8"
      )
    );

    const measurements = await measureHtmlFile(input, { replica: true });
    const card = measurements.elements.find((element) => element.id === "photo-card");

    expect(card).toMatchObject({
      kind: "shape",
      style: expect.objectContaining({
        backgroundImage: expect.stringContaining("business-slide.png"),
        backgroundSize: "cover",
        backgroundPosition: "50% 75%",
        backgroundRepeat: "no-repeat"
      })
    });
  }, 60000);
});
