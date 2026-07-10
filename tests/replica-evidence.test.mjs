import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { evaluateReplicaEvidence } from "../scripts/lib/replica-evidence.mjs";
import { buildReplicaEvidence } from "../scripts/run-deck-pipeline.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const metric = (value) => ({ status: "available", value });
const unavailable = (reason = "capability-not-installed") => ({ status: "unavailable", value: null, reason });

function validEvidence(route = "html") {
  const fidelity = route === "html" ? {
    ssim: metric(0.98), normalizedMae: metric(5 / 255), bboxP95Drift: metric(1.5),
    fontMapping: metric(1), colorMapping: metric(1)
  } : {
    ssim: metric(0.95), ocrCer: metric(0.015), bboxIou: metric(0.92),
    paletteDeltaE2000P95: metric(2.5), nativeHighConfidenceTextRecall: metric(0.92)
  };
  return {
    version: "0.1.0", mode: "replica", route,
    paths: { source: `/tmp/source.${route === "html" ? "html" : "png"}`, render: "/tmp/render" },
    capabilities: { sourceRenderComparison: true, nativeObjectInspection: true },
    thresholds: {}, retryCount: 0, accepted: true,
    source: { pageCount: 1, size: { width: 1600, height: 900 } },
    render: { pageCount: 1, size: { width: 1600, height: 900 } },
    perSlide: [{ slideIndex: 0, fidelity, nativeCoverage: metric(route === "html" ? 0.96 : 0.91), editability: { level: route === "html" ? 4 : 3 }, fallbacks: [] }],
    aggregate: { fidelity, nativeCoverage: metric(route === "html" ? 0.96 : 0.91), editability: { level: route === "html" ? 4 : 3 }, fallbacks: [] },
    blockingFindings: []
  };
}

describe("strict replica evidence evaluator", () => {
  it("publishes a schema with explicit unavailable metrics and separate fidelity/native coverage", async () => {
    const schema = JSON.parse(await readFile(join(root, "schemas/replica-evidence.schema.json"), "utf8"));
    expect(schema.required).toEqual(expect.arrayContaining(["perSlide", "aggregate", "accepted", "blockingFindings", "capabilities", "thresholds"]));
    expect(schema.$defs.metric.oneOf[1].properties.value.type).toBe("null");
    expect(schema.$defs.metric.oneOf[1].required).toContain("reason");
    expect(schema.$defs.slideEvidence.required).toEqual(expect.arrayContaining(["fidelity", "nativeCoverage", "editability", "fallbacks"]));
    const evaluated = evaluateReplicaEvidence(validEvidence("html"));
    expect(validateJsonSchema(evaluated, schema)).toEqual({ valid: true, errors: [] });
    evaluated.aggregate.fidelity.ssim = { status: "unavailable", value: 1 };
    expect(validateJsonSchema(evaluated, schema).valid).toBe(false);
  });
  it.each(["html", "image"])("accepts a complete %s proof and derives acceptance", (route) => {
    const input = validEvidence(route);
    input.accepted = false;
    const result = evaluateReplicaEvidence(input);
    expect(result.accepted).toBe(true);
    expect(result.blockingFindings).toEqual([]);
    expect(result.thresholds).toBeTruthy();
  });

  it("keeps creative mode outside the replica policy", () => {
    expect(evaluateReplicaEvidence({ mode: "creative", accepted: true })).toEqual({ applicable: false, accepted: true, blockingFindings: [] });
  });

  it.each([
    ["missing capability", (x) => { x.capabilities.sourceRenderComparison = false; }],
    ["unavailable required metric", (x) => { x.aggregate.fidelity.ssim = unavailable(); x.perSlide[0].fidelity.ssim = unavailable(); }],
    ["size mismatch", (x) => { x.render.size.width = 1599; }],
    ["page count mismatch", (x) => { x.render.pageCount = 2; }],
    ["aggregate mismatch", (x) => { x.aggregate.nativeCoverage = metric(0.99); }],
    ["low editability", (x) => { x.aggregate.editability.level = 3; x.perSlide[0].editability.level = 3; }],
    ["full slide fallback", (x) => { x.aggregate.fallbacks.push({ kind: "raster", fullSlide: true, reason: "unsupported", bbox: { x: 0, y: 0, width: 1600, height: 900 }, zOrder: 0, nativeAlternativesAttempted: [] }); }],
    ["too many retries", (x) => { x.retryCount = 4; }]
  ])("blocks %s", (_name, mutate) => {
    const input = validEvidence("html");
    mutate(input);
    const result = evaluateReplicaEvidence(input);
    expect(result.accepted).toBe(false);
    expect(result.blockingFindings.length).toBeGreaterThan(0);
  });

  it.each([
    ["html ssim", "html", (x) => { x.aggregate.fidelity.ssim = metric(0.969); x.perSlide[0].fidelity.ssim = metric(0.969); }],
    ["html mae", "html", (x) => { x.aggregate.fidelity.normalizedMae = metric(6.1 / 255); x.perSlide[0].fidelity.normalizedMae = metric(6.1 / 255); }],
    ["image ocr", "image", (x) => { x.aggregate.fidelity.ocrCer = metric(0.021); x.perSlide[0].fidelity.ocrCer = metric(0.021); }],
    ["image palette", "image", (x) => { x.aggregate.fidelity.paletteDeltaE2000P95 = metric(3.1); x.perSlide[0].fidelity.paletteDeltaE2000P95 = metric(3.1); }]
  ])("enforces %s threshold", (_name, route, mutate) => {
    const input = validEvidence(route); mutate(input);
    expect(evaluateReplicaEvidence(input).accepted).toBe(false);
  });

  it("requires unavailable metrics to carry null and a reason", () => {
    const input = validEvidence("html");
    input.aggregate.fidelity.ssim = { status: "unavailable", value: 1 };
    input.perSlide[0].fidelity.ssim = { status: "unavailable", value: 1 };
    const result = evaluateReplicaEvidence(input);
    expect(result.accepted).toBe(false);
    expect(result.blockingFindings.join(" ")).toMatch(/unavailable.*null.*reason/i);
  });

  it("adapts legacy structural facts without fabricating visual fidelity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replica-evidence-"));
    const pptxPath = join(dir, "final.pptx");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"p\"><p:cSld><p:spTree><p:sp/></p:spTree></p:cSld></p:sld>");
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await buildReplicaEvidence({
      pptxPath,
      manifest: { deck: { size: { width: 13.333, height: 7.5 } }, slides: [{}] },
      coverage: { coverage: 1, coveredElements: 1, droppedElements: [], unsupportedEffects: [] },
      intermediate: { editabilityCounter: { shape: 1 }, countersBySlide: [{ shape: 1 }] },
      route: "html", sourcePath: "/tmp/source.html", renderPath: "/tmp/preview"
    });
    expect(result.aggregate.fidelity.ssim).toEqual({ status: "unavailable", value: null, reason: "source-render-comparison-not-implemented" });
    expect(result.capabilities.sourceRenderComparison).toBe(false);
    expect(result.accepted).toBe(false);
    expect(result.blockingFindings.join(" ")).toMatch(/capability-unavailable|required-metric-unavailable/);
  });
});
