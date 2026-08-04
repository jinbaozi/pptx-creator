#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import JSZip from "jszip";
import { validatePresentationPackageFile } from "./validate-presentation-package.mjs";

const analysisSchemaPath = fileURLToPath(new URL("../schemas/analysis.schema.json", import.meta.url));
const qaSchemaPath = fileURLToPath(new URL("../schemas/qa-report.schema.json", import.meta.url));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(schemaValidator);
const validateAnalysisSchema = schemaValidator.compile(JSON.parse(readFileSync(analysisSchemaPath, "utf8")));
const validateQaSchema = schemaValidator.compile(JSON.parse(readFileSync(qaSchemaPath, "utf8")));

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readable(path, label) {
  try {
    await access(path);
  } catch {
    fail("E_CONTRACT", `${label} is missing: ${path}`);
  }
}

async function present(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function schemaCheck(validate, value, label) {
  if (validate(value)) return;
  const details = (validate.errors ?? []).map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ");
  fail("E_SCHEMA", `${label} schema validation failed${details ? `: ${details}` : ""}`);
}

function local(root, path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path)) fail("E_CONTRACT", `${label} must be relative`);
  if (path.includes("\0") || path.split(/[\\/]+/u).includes("..")) fail("E_CONTRACT", `${label} contains traversal`);
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) fail("E_CONTRACT", `${label} escapes output`);
  return resolved;
}

export async function validateOutput(outputDir) {
  const root = resolve(outputDir);
  const analysisPath = join(root, "analysis.json");
  const qaPath = join(root, "qa-report.json");
  const runPath = join(root, "run.json");
  await Promise.all([
    readable(analysisPath, "analysis"),
    readable(qaPath, "qa report"),
    readable(runPath, "run index")
  ]);
  let analysis;
  let qa;
  let run;
  try {
    analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    qa = JSON.parse(await readFile(qaPath, "utf8"));
    run = JSON.parse(await readFile(runPath, "utf8"));
  } catch (error) {
    fail("E_SCHEMA", `output JSON is invalid: ${error.message}`);
  }
  schemaCheck(validateAnalysisSchema, analysis, "analysis");
  schemaCheck(validateQaSchema, qa, "qa report");
  if (analysis.version !== "1.0.0" || analysis.kind !== "image-reconstruction-analysis") {
    fail("E_CONTRACT", "unsupported analysis contract");
  }
  if (run.version !== "1.0.0" || run.producer?.skill !== "image-to-pptx") {
    fail("E_CONTRACT", "unsupported run index contract");
  }
  if (run.status !== qa.status) fail("E_CONTRACT", "run/QA status mismatch");
  if (!Array.isArray(analysis.slides) || analysis.slides.length < 1) fail("E_CONTRACT", "analysis has no slides");
  const slideIds = new Set();
  for (const slide of analysis.slides) {
    if (slideIds.has(slide.id)) fail("E_CONTRACT", `duplicate slide id ${slide.id}`);
    slideIds.add(slide.id);
    for (const object of slide.objects ?? []) {
      const box = object.pixelBox;
      if (!box || !["x", "y", "w", "h"].every((key) => Number.isFinite(box[key]))) {
        fail("E_CONTRACT", `${object.id} has invalid geometry`);
      }
      const slideWidth = Number(slide.sizePx?.width ?? slide.sizePx?.widthPx);
      const slideHeight = Number(slide.sizePx?.height ?? slide.sizePx?.heightPx);
      if (box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0
        || box.x + box.w > slideWidth + 0.1 || box.y + box.h > slideHeight + 0.1) {
        fail("E_CONTRACT", `${object.id} is outside the slide`);
      }
      if (object.type === "text" && object.renderBox) {
        const renderBox = object.renderBox;
        if (!["x", "y", "w", "h"].every((key) => Number.isFinite(renderBox[key]))
          || renderBox.x < 0 || renderBox.y < 0 || renderBox.w <= 0 || renderBox.h <= 0
          || renderBox.x + renderBox.w > slideWidth + 0.1 || renderBox.y + renderBox.h > slideHeight + 0.1) {
          fail("E_CONTRACT", `${object.id} has invalid render geometry`);
        }
      }
      if (object.type === "image") {
        const areaShare = (box.w * box.h) / (slideWidth * slideHeight);
        if ((box.x <= slideWidth * 0.05 && box.y <= slideHeight * 0.05
            && box.w >= slideWidth * 0.90 && box.h >= slideHeight * 0.90)
          || areaShare >= 0.80) {
          fail("E_WHOLE_SLIDE_FALLBACK", `${object.id} covers the slide`);
        }
        await readable(local(root, object.asset, `${object.id}.asset`), `${object.id}.asset`);
      }
    }
    if (slide.annotation) await readable(local(root, slide.annotation, `${slide.id}.annotation`), `${slide.id}.annotation`);
  }
  for (const source of analysis.sources ?? []) {
    const path = local(root, source.path, `${source.id}.path`);
    await readable(path, `${source.id}.path`);
    if (await digest(path) !== source.sha256) fail("E_CONTRACT", `${source.id} digest mismatch`);
    const normalizedPath = local(root, source.normalizedPath, `${source.id}.normalizedPath`);
    await readable(normalizedPath, `${source.id}.normalizedPath`);
    if (await digest(normalizedPath) !== source.normalizedSha256) fail("E_CONTRACT", `${source.id} normalized digest mismatch`);
  }
  const passed = qa.status === "passed";
  const pptxPath = join(root, passed ? "final.pptx" : "failed-candidate.pptx");
  if (!passed && (await present(join(root, "final.pptx")) || await present(join(root, "preview")) || await present(join(root, "html-package")))) {
    fail("E_CONTRACT", "failed delivery must not retain final/preview/html artifacts");
  }
  if (passed && await present(join(root, "failed-candidate.pptx"))) {
    fail("E_CONTRACT", "passed delivery must not retain failed candidate");
  }
  await readable(pptxPath, "PPTX candidate");
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const pptSlides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (pptSlides.length !== analysis.slides.length) fail("E_CONTRACT", "PPTX slide count mismatch");
  if (passed && (qa.visual?.status !== "passed"
      || qa.editability?.level < 3
      || qa.editability?.wholeSlideRasterCount !== 0
      || Number(qa.editability?.rasterAreaShare ?? 1) > 0.65)) {
    fail("E_CONTRACT", "passed QA lacks visual/editability evidence");
  }
  const sourceDigests = new Map((run.sourceDigests ?? []).map((item) => [item.id, item]));
  if (sourceDigests.size !== (analysis.sources ?? []).length) fail("E_CONTRACT", "run source digest summary is incomplete");
  for (const source of analysis.sources ?? []) {
    const summary = sourceDigests.get(source.id);
    if (!summary || summary.path !== source.path || summary.sha256 !== source.sha256) {
      fail("E_CONTRACT", `run source digest summary mismatch: ${source.id}`);
    }
  }
  for (const artifact of run.artifacts ?? []) {
    if (!artifact || typeof artifact.path !== "string" || !Number.isInteger(artifact.bytes) || typeof artifact.sha256 !== "string") {
      fail("E_CONTRACT", "run artifact summary is invalid");
    }
    const path = local(root, artifact.path, `run.artifacts.${artifact.path}`);
    await readable(path, artifact.path);
    const info = await stat(path);
    if (info.size !== artifact.bytes || await digest(path) !== artifact.sha256) {
      fail("E_CONTRACT", `run artifact mismatch: ${artifact.path}`);
    }
  }
  if (!Array.isArray(run.artifacts) || run.artifacts.length < 1) fail("E_CONTRACT", "run artifact summary is empty");
  const renderReportPath = local(root, "reports/render-report.json", "render report");
  await readable(renderReportPath, "render report");
  let renderReport;
  try {
    renderReport = JSON.parse(await readFile(renderReportPath, "utf8"));
  } catch (error) {
    fail("E_SCHEMA", `render report is invalid: ${error.message}`);
  }
  const lineage = renderReport.lineage;
  if (!lineage?.sourcePptx || !lineage?.preview) fail("E_CONTRACT", "preview lineage is missing");
  if (lineage.sourcePptx.path !== (passed ? "final.pptx" : "failed-candidate.pptx")) {
    fail("E_CONTRACT", "preview source PPTX lineage mismatch");
  }
  if (lineage.sourcePptx.sha256 !== await digest(pptxPath)) fail("E_CONTRACT", "preview source PPTX digest mismatch");
  const lineagePages = [];
  for (const page of lineage.preview.pages ?? []) {
    const pagePath = local(root, page.path, `preview lineage ${page.path}`);
    await readable(pagePath, `preview page ${page.path}`);
    if (await digest(pagePath) !== page.sha256) fail("E_CONTRACT", `preview page digest mismatch: ${page.path}`);
    lineagePages.push({ path: page.path, sha256: page.sha256 });
  }
  if (lineagePages.length !== analysis.slides.length) fail("E_CONTRACT", "preview page count mismatch");
  const expectedPreviewDir = passed ? "preview/" : "failed-preview/";
  if (lineage.preview.directory !== expectedPreviewDir) fail("E_CONTRACT", "preview directory lineage mismatch");
  const summary = run.summary;
  if (!summary?.qa || !summary?.pptx || !summary?.preview || !summary?.renderReport) {
    fail("E_CONTRACT", "run summary is incomplete");
  }
  if (summary.qa.path !== "qa-report.json" || summary.qa.sha256 !== await digest(qaPath)) fail("E_CONTRACT", "run QA summary mismatch");
  if (summary.pptx.path !== (passed ? "final.pptx" : "failed-candidate.pptx") || summary.pptx.sha256 !== await digest(pptxPath)) {
    fail("E_CONTRACT", "run PPTX summary mismatch");
  }
  if (summary.preview.directory !== expectedPreviewDir || summary.preview.pageCount !== lineagePages.length
      || JSON.stringify(summary.preview.pages) !== JSON.stringify(lineagePages)) {
    fail("E_CONTRACT", "run preview summary mismatch");
  }
  if (summary.renderReport.path !== "reports/render-report.json" || summary.renderReport.sha256 !== await digest(renderReportPath)) {
    fail("E_CONTRACT", "run render report summary mismatch");
  }
  let protocol = null;
  if (run.protocol) {
    protocol = await validatePresentationPackageFile(local(root, run.protocol.path, "run.protocol.path"));
  }
  return {
    status: "passed",
    deliveryStatus: qa.status,
    slideCount: analysis.slides.length,
    pptx: pptxPath,
    editabilityLevel: qa.editability?.level,
    previewPages: lineagePages.length,
    summary,
    protocol
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  validateOutput(process.argv[2]).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "E_CONTRACT", message: error.message }, null, 2)}\n`);
      process.exitCode = 1;
    }
  );
}
