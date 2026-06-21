import { access, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  connectorDirectionDot,
  hasBoxOverflow,
  pointTouchesRectBoundary,
  rectOverlapRatio
} from "../scripts/lib/html-layout-geometry.mjs";
import { buildMeasurementsDocument } from "../scripts/lib/html-measurement-core.mjs";
import { convertHtmlToManifest } from "../scripts/lib/html-to-manifest-core.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("HTML layout geometry", () => {
  it("detects meaningful sibling overlap but not edge contact", () => {
    expect(rectOverlapRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: 80, y: 0, w: 100, h: 100 })).toBeCloseTo(0.2);
    expect(rectOverlapRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(0);
  });

  it("detects horizontal and vertical text overflow with tolerance", () => {
    expect(hasBoxOverflow({ scrollWidth: 101, scrollHeight: 50, clientWidth: 100, clientHeight: 50 })).toBe(false);
    expect(hasBoxOverflow({ scrollWidth: 120, scrollHeight: 50, clientWidth: 100, clientHeight: 50 })).toBe(true);
    expect(hasBoxOverflow({ scrollWidth: 100, scrollHeight: 75, clientWidth: 100, clientHeight: 50 })).toBe(true);
  });

  it("validates connector boundary contact and direction", () => {
    const target = { x: 100, y: 50, w: 40, h: 40 };
    expect(pointTouchesRectBoundary({ x: 100, y: 70 }, target)).toBe(true);
    expect(pointTouchesRectBoundary({ x: 70, y: 70 }, target)).toBe(false);
    expect(connectorDirectionDot({ x: 0, y: 70 }, { x: 100, y: 70 }, { x: 120, y: 70 })).toBeGreaterThan(0);
    expect(connectorDirectionDot({ x: 100, y: 70 }, { x: 0, y: 70 }, { x: 120, y: 70 })).toBeLessThan(0);
  });
});

describe("HTML layout contracts", () => {
  it("keeps slide identity in multi-slide measurements", () => {
    const document = buildMeasurementsDocument({
      source: "deck.html",
      elements: [{ id: "second-title", slideId: "slide-002", kind: "text", px: { x: 100, y: 100, w: 500, h: 50 } }]
    });
    expect(document.elements[0]).toMatchObject({ id: "second-title", slideId: "slide-002" });
  });

  it("preserves HTML connector semantics in the manifest", () => {
    const html = `
      <section class="pptx-slide">
        <div data-pptx-kind="shape" data-pptx-id="source" data-x="1" data-y="1" data-w="2" data-h="1"></div>
        <div data-pptx-kind="shape" data-pptx-id="target" data-x="5" data-y="1" data-w="2" data-h="1"></div>
        <svg data-x="3" data-y="1.5" data-w="2" data-h="0.01">
          <path data-connector data-pptx-kind="line" data-pptx-id="flow" data-source-id="source" data-target-id="target" data-x="3" data-y="1.5" data-w="2" data-h="0.01" id="flow" d="M 0 0 L 100 0" stroke="#123456" stroke-width="2" marker-end="url(#arrow)"></path>
        </svg>
      </section>`;
    const manifest = convertHtmlToManifest(html);
    const line = manifest.slides[0].elements.find((element) => element.id === "flow");
    expect(line).toMatchObject({
      type: "line",
      style: { sourceId: "source", targetId: "target", endArrowType: "triangle", color: "#123456", width: 2 }
    });
  });

  it("ships schemas and public package commands", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts).toMatchObject({
      "html:check": "node scripts/run-html-layout-check.mjs",
      "html:repair": "node scripts/run-html-repair.mjs",
      "pipeline:html": "node scripts/run-html-pipeline.mjs"
    });
    for (const schema of ["html-layout-report.schema.json", "html-repair-report.schema.json"]) {
      expect(JSON.parse(await readFile(join(root, "schemas", schema), "utf8"))).toHaveProperty("$schema");
    }
  });
});

const playwrightEnabled = process.env.PLAYWRIGHT_RUN === "1";

describe.skipIf(!playwrightEnabled)("HTML layout browser integration", () => {
  it("measures each slide relative to its own canvas", async () => {
    const { measureHtmlFile } = await import("../scripts/measure-html.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-multi-"));
    const input = join(dir, "deck.html");
    await writeFile(input, `<!doctype html><style>
      body{margin:0}.pptx-slide{position:relative;width:1280px;height:720px}
      [data-pptx-kind]{position:absolute;left:100px;top:100px;width:500px;height:50px;margin:0}
    </style><section class="pptx-slide"><h1 data-pptx-kind="text" data-pptx-id="one">One</h1></section>
    <section class="pptx-slide"><h1 data-pptx-kind="text" data-pptx-id="two">Two</h1></section>`, "utf8");
    const measurements = await measureHtmlFile(input);
    expect(measurements.elements.find((entry) => entry.id === "one")?.y).toBeCloseTo(1.042, 2);
    expect(measurements.elements.find((entry) => entry.id === "two")?.y).toBeCloseTo(1.042, 2);
    expect(measurements.elements.find((entry) => entry.id === "two")?.slideId).toBe("slide-002");
  });

  it("reports clipping, overlap, bounds, and malformed connectors", async () => {
    const { auditHtmlFile } = await import("../scripts/lib/html-layout-audit.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-audit-"));
    const input = join(dir, "deck.html");
    await writeFile(input, `<!doctype html><style>
      body{margin:0}.pptx-slide{position:relative;width:1280px;height:720px}
      .card{position:absolute;width:300px;height:100px;overflow:hidden}.a{left:100px;top:100px}.b{left:250px;top:100px}
    </style><section class="pptx-slide">
      <div class="card a" data-pptx-id="a"><p style="height:18px;overflow:hidden">中文内容中文内容中文内容中文内容中文内容中文内容中文内容</p></div>
      <div class="card b" data-pptx-id="b">B</div>
      <svg style="position:absolute;left:0;top:0;width:1280px;height:720px"><line data-connector data-pptx-id="bad-arrow" data-source-id="a" data-target-id="b" x1="0" y1="0" x2="10" y2="10"/></svg>
    </section>`, "utf8");
    const report = await auditHtmlFile(input, { screenshots: false });
    const kinds = new Set(report.checks.map((check) => check.kind));
    expect(kinds.has("overlap")).toBe(true);
    expect(kinds.has("content-clipped")).toBe(true);
    expect(kinds.has("connector-detached")).toBe(true);
    expect(kinds.has("connector-marker-missing")).toBe(true);
  });

  it("writes a repaired copy, preserves the source, and is idempotent", async () => {
    const { repairHtmlLayout } = await import("../scripts/lib/html-layout-repair.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-repair-"));
    const input = join(dir, "source.html");
    const original = `<!doctype html><style>
      body{margin:0}.pptx-slide{position:relative;width:1000px;height:500px}
      h1{position:absolute;left:40px;top:40px;width:800px;height:20px;overflow:hidden;margin:0;font-size:32px;line-height:1.2}
    </style><section class="pptx-slide"><h1 data-pptx-id="title">A title that must remain fully visible</h1></section>`;
    await writeFile(input, original, "utf8");
    const first = await repairHtmlLayout(input, join(dir, "first"), { maxAttempts: 3, screenshots: false });
    expect(await readFile(input, "utf8")).toBe(original);
    expect(first.report.summary).toMatchObject({ status: "passed", sourcePreserved: true });
    expect(first.report.attempts.flatMap((attempt) => attempt.operations).map((operation) => operation.kind)).toEqual(
      expect.arrayContaining(["normalize-slide-canvas", "fit-text"])
    );

    const second = await repairHtmlLayout(first.repairedPath, join(dir, "second"), { maxAttempts: 3, screenshots: false });
    expect(second.report.summary).toMatchObject({ status: "passed", attemptCount: 0, criticalRemaining: 0 });
  });

  it("paginates complete cards instead of splitting or truncating text", async () => {
    const { repairHtmlLayout } = await import("../scripts/lib/html-layout-repair.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-paginate-"));
    const input = join(dir, "source.html");
    const cards = Array.from({ length: 6 }, (_, index) => `<article class="card" data-pptx-id="card-${index + 1}">Card ${index + 1}</article>`).join("");
    await writeFile(input, `<!doctype html><style>
      body{margin:0}.pptx-slide{position:relative;width:1280px;height:720px;padding:40px;box-sizing:border-box}
      .cards{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{height:280px;padding:20px;box-sizing:border-box}
    </style><section class="pptx-slide"><div class="cards" data-cols="2">${cards}</div></section>`, "utf8");
    const result = await repairHtmlLayout(input, join(dir, "output"), { maxAttempts: 3, screenshots: false });
    expect(result.report.summary).toMatchObject({ status: "passed", criticalRemaining: 0 });
    expect(result.report.attempts.flatMap((attempt) => attempt.operations).some((operation) => operation.kind === "paginate-cards")).toBe(true);
    const repaired = await readFile(result.repairedPath, "utf8");
    for (let index = 1; index <= 6; index += 1) {
      expect(repaired.match(new RegExp(`Card ${index}`, "g"))).toHaveLength(1);
    }
    expect((repaired.match(/class="pptx-slide"/g) ?? []).length).toBeGreaterThan(1);
  });

  it("reanchors an SVG connector and adds editable connector metadata", async () => {
    const { repairHtmlLayout } = await import("../scripts/lib/html-layout-repair.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-connectors-"));
    const input = join(dir, "source.html");
    await writeFile(input, `<!doctype html><style>
      body{margin:0}.pptx-slide{position:relative;width:1280px;height:720px}.node{position:absolute;top:200px;width:200px;height:100px}.a{left:100px}.b{left:700px}
      svg{position:absolute;inset:0;width:1280px;height:720px}
    </style><section class="pptx-slide">
      <div class="node a" data-pptx-kind="shape" data-pptx-id="a">A</div><div class="node b" data-pptx-kind="shape" data-pptx-id="b">B</div>
      <svg><line data-connector data-source-id="a" data-target-id="b" id="flow" x1="0" y1="0" x2="10" y2="10" stroke="#123456"/></svg>
    </section>`, "utf8");
    const result = await repairHtmlLayout(input, join(dir, "output"), { maxAttempts: 3, screenshots: false });
    expect(result.report.summary).toMatchObject({ status: "passed", criticalRemaining: 0 });
    const repaired = await readFile(result.repairedPath, "utf8");
    expect(repaired).toContain('data-pptx-kind="line"');
    expect(repaired).toContain('data-pptx-id="flow"');
    expect(repaired).toContain("marker-end=\"url(#pptx-auto-arrowhead-flow)\"");
  });

  it("runs the guarded HTML-to-PPTX pipeline end to end", async () => {
    const { runHtmlPipeline } = await import("../scripts/run-html-pipeline.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-html-pipeline-"));
    const summary = await runHtmlPipeline(join(root, "examples/html-input/css-positioned-dashboard.html"), dir);
    expect(summary).toMatchObject({
      status: "passed",
      htmlLayout: { criticalCount: 0, blocked: false },
      contentCoverage: { ratio: 1 }
    });
    for (const file of [
      "deck.repaired.html",
      "html-layout-report.json",
      "html-repair-report.json",
      "layout-measurements.json",
      "deck.manifest.json",
      "final.pptx"
    ]) {
      await expect(access(join(dir, file))).resolves.toBeUndefined();
    }
    const layoutSchema = JSON.parse(await readFile(join(root, "schemas/html-layout-report.schema.json"), "utf8"));
    const repairSchema = JSON.parse(await readFile(join(root, "schemas/html-repair-report.schema.json"), "utf8"));
    const layoutReport = JSON.parse(await readFile(join(dir, "html-layout-report.json"), "utf8"));
    const repairReport = JSON.parse(await readFile(join(dir, "html-repair-report.json"), "utf8"));
    expect(validateJsonSchema(layoutReport, layoutSchema)).toMatchObject({ valid: true, errors: [] });
    expect(validateJsonSchema(repairReport, repairSchema)).toMatchObject({ valid: true, errors: [] });
  }, 60000);
});
