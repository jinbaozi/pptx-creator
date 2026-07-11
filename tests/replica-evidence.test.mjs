import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { evaluateMeasuredReplicaEvidence, evaluateReplicaEvidence, verifyReplicaEvidence } from "../scripts/lib/replica-evidence.mjs";
import { buildReplicaEvidence, proveReplicaFidelity } from "../scripts/run-deck-pipeline.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const metric = (value) => ({ status: "available", value });
const unavailable = (reason = "capability-not-installed") => ({ status: "unavailable", value: null, reason });

it("does not expose a caller-controlled measurement receipt mint", async () => {
  const module = await import("../scripts/lib/replica-evidence.mjs");
  expect(module.bindReplicaMeasurementReceipt).toBeUndefined();
});

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
    paths: { source: { status: "available", path: "/tmp/source" }, render: { status: "available", path: "/tmp/render" } },
    capabilities: { sourceRenderComparison: true, nativeObjectInspection: true, fallbackInventory: true },
    thresholds: {}, retry: { status: "available", attempts: [] }, accepted: true,
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
    const dir = await mkdtemp(join(tmpdir(), "replica-schema-"));
    const source = join(dir, "source.html"); const render = join(dir, "render.png");
    await writeFile(source, "source"); await writeFile(render, "render");
    const input = validEvidence("html"); input.paths = { source: { status: "available", path: source }, render: { status: "available", path: render } };
    const evaluated = await verifyReplicaEvidence(input);
    expect(validateJsonSchema(evaluated, schema)).toEqual({ valid: true, errors: [] });
    evaluated.aggregate.fidelity.ssim = { status: "unavailable", value: 1 };
    expect(validateJsonSchema(evaluated, schema).valid).toBe(false);
    const routeDrift = structuredClone(evaluated); routeDrift.route = "image";
    expect(validateJsonSchema(routeDrift, schema).valid).toBe(false);
  });
  it.each(["html", "image"])("blocks complete-looking %s metrics without a trusted measurement receipt", async (route) => {
    const dir = await mkdtemp(join(tmpdir(), "replica-authority-"));
    const source = join(dir, "source"); const render = join(dir, "render");
    await writeFile(source, "source"); await writeFile(render, "render");
    const input = validEvidence(route);
    input.paths = { source: { status: "available", path: source }, render: { status: "available", path: render } };
    input.accepted = false;
    const result = await verifyReplicaEvidence(input);
    expect(result.accepted).toBe(false);
    expect(result.blockingFindings.join(" ")).toMatch(/trusted-measurement-unavailable/);
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
    ["too many retries", (x) => { x.retry.attempts = [{}, {}, {}, {}]; }]
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

  it("never accepts unverified self-reported paths and capabilities", () => {
    expect(evaluateReplicaEvidence(validEvidence("html")).blockingFindings.join(" ")).toMatch(/artifact-verification-required/);
  });

  it("cannot forge a trusted measurement bundle with JSON or a public Symbol", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replica-forged-measurement-"));
    const source = join(dir, "source"); const render = join(dir, "render"); await writeFile(source, "source"); await writeFile(render, "render");
    const input = validEvidence("html"); input.paths = { source: { status: "available", path: source }, render: { status: "available", path: render } };
    const forged = { sourceSha256: "x", renderSha256: "y", perSlide: input.perSlide, aggregate: input.aggregate, [Symbol("replica-measurement-receipt")]: true };
    expect((await evaluateMeasuredReplicaEvidence(input, forged)).blockingFindings.join(" ")).toMatch(/trusted-measurement-unavailable/);
  });

  it("blocks missing artifacts and digest mismatches", async () => {
    const missing = validEvidence("html");
    expect((await verifyReplicaEvidence(missing)).blockingFindings.join(" ")).toMatch(/artifact-unavailable/);
    const dir = await mkdtemp(join(tmpdir(), "replica-digest-")); const source = join(dir, "source"); const render = join(dir, "render");
    await writeFile(source, "source"); await writeFile(render, "render");
    const mismatch = validEvidence("html");
    mismatch.paths = { source: { status: "available", path: source, sha256: "0".repeat(64) }, render: { status: "available", path: render } };
    expect((await verifyReplicaEvidence(mismatch)).blockingFindings.join(" ")).toMatch(/artifact-digest-mismatch/);
  });

  it("blocks duplicate slide indexes and aggregate fallback drift", () => {
    const input = validEvidence("html");
    input.source.pageCount = 2; input.render.pageCount = 2;
    input.perSlide.push(structuredClone(input.perSlide[0]));
    expect(evaluateReplicaEvidence(input).blockingFindings.join(" ")).toMatch(/slide-index-invalid/);
    input.perSlide[1].slideIndex = 1;
    input.perSlide[0].fallbacks.push({ kind: "raster", fullSlide: false, reason: "blur", bbox: { x: 1, y: 1, width: 2, height: 2 }, zOrder: 1, nativeAlternativesAttempted: ["shape"] });
    expect(evaluateReplicaEvidence(input).blockingFindings.join(" ")).toMatch(/aggregate-inconsistent: fallbacks/);
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
      route: "html", sourcePath: pptxPath, renderPath: null
    });
    expect(result.aggregate.fidelity.ssim).toEqual({ status: "unavailable", value: null, reason: "source-render-comparison-not-implemented" });
    expect(result.capabilities.sourceRenderComparison).toBe(false);
    expect(result.paths.render).toMatchObject({ status: "unavailable", path: null });
    expect(result.retry).toMatchObject({ status: "unavailable", attempts: [] });
    expect(result.accepted).toBe(false);
    expect(result.blockingFindings.join(" ")).toMatch(/capability-unavailable|required-metric-unavailable/);
    const schema = JSON.parse(await readFile(join(root, "schemas/replica-evidence.schema.json"), "utf8"));
    expect(validateJsonSchema(result, schema)).toEqual({ valid: true, errors: [] });
  });

  it("derives per-slide editability and explicit fallback inventory instead of copying globals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replica-multipage-")); const pptxPath = join(dir, "final.pptx");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"p\"><p:sp/><p:sp/></p:sld>");
    zip.file("ppt/slides/slide2.xml", "<p:sld xmlns:p=\"p\"><p:pic/></p:sld>");
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
    const fallback = { kind: "raster", fullSlide: true, reason: "complex-source", bbox: { x: 0, y: 0, width: 1600, height: 900 }, zOrder: 0, nativeAlternativesAttempted: ["shape"] };
    const result = await buildReplicaEvidence({
      pptxPath, sourcePath: pptxPath, renderPath: null, route: "html",
      manifest: { deck: { size: { width: 13.333, height: 7.5 } }, slides: [{ replicaFallbacks: [] }, { replicaFallbacks: [fallback] }] },
      coverage: { coverage: 1, coveredElements: 3, droppedElements: [], unsupportedEffects: [], slides: [{ coverage: 1 }, { coverage: 1 }] },
      intermediate: { editabilityCounter: { text: 1, shape: 1, image: 1 }, countersBySlide: [{ text: 1, shape: 1 }, { image: 1 }] }
    });
    expect(result.perSlide.map((slide) => slide.editability.level)).toEqual([5, 1]);
    expect(result.aggregate.fallbacks).toEqual([fallback]);
    expect(result.blockingFindings.join(" ")).toMatch(/full-slide-fallback|editability-failed/);
  });

  it("inventories ordinary, cropped, and background raster layers and blocks slide-sized imagery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replica-raster-inventory-")); const pptxPath = join(dir, "final.pptx");
    const zip = new JSZip(); zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"p\"><p:pic/><p:pic/></p:sld>");
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await buildReplicaEvidence({
      pptxPath, sourcePath: pptxPath, renderPath: null, route: "html",
      manifest: { deck: { size: { width: 10, height: 5 } }, slides: [{ background: { type: "image", src: "bg.png" }, elements: [
        { type: "image", x: 0, y: 0, w: 10, h: 5 },
        { type: "cropped-asset", x: 1, y: 1, w: 2, h: 2, replicaFallback: { reason: "blur", nativeAlternativesAttempted: ["shape"] } }
      ] }] },
      coverage: { coverage: 1, coveredElements: 2, droppedElements: [], unsupportedEffects: [] },
      intermediate: { editabilityCounter: { image: 2 }, countersBySlide: [{ image: 2 }] }
    });
    expect(result.perSlide[0].fallbacks).toHaveLength(3);
    expect(result.perSlide[0].fallbacks.filter((item) => item.fullSlide)).toHaveLength(2);
    expect(result.perSlide[0].fallbacks[2]).toMatchObject({ reason: "blur", bbox: { x: 1, y: 1, width: 2, height: 2 }, zOrder: 1 });
    expect(result.blockingFindings.join(" ")).toMatch(/full-slide-fallback/);
  });

  it("rejects aggregate object counts that hide a deficient slide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replica-slide-proof-")); const pptxPath = join(dir, "final.pptx");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="p">${"<p:sp/>".repeat(4)}</p:sld>`);
    zip.file("ppt/slides/slide2.xml", "<p:sld xmlns:p=\"p\"></p:sld>");
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));
    const proof = await proveReplicaFidelity(
      pptxPath, { slides: [{}, {}] },
      { coverage: 1, coveredElements: 4, droppedElements: [], unsupportedEffects: [], slides: [{ coverage: 1, coveredElements: 2 }, { coverage: 1, coveredElements: 2 }] },
      { countersBySlide: [{ shape: 4 }, { shape: 0 }] }, "html"
    );
    expect(proof).toMatchObject({ status: "failed", archiveObjectCount: 4, renderedNativeObjects: 4 });
    expect(proof.perSlide[1]).toMatchObject({ coveredElements: 2, archiveObjectCount: 0, renderedNativeObjects: 0, ok: false });
  });
});
