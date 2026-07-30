#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { validatePresentationPackageFile } from "./validate-presentation-package.mjs";

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

function local(root, path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path)) fail("E_CONTRACT", `${label} must be relative`);
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
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  const qa = JSON.parse(await readFile(qaPath, "utf8"));
  const run = JSON.parse(await readFile(runPath, "utf8"));
  if (analysis.version !== "1.0.0" || analysis.kind !== "image-reconstruction-analysis") {
    fail("E_CONTRACT", "unsupported analysis contract");
  }
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
      if (box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0
        || box.x + box.w > slide.sizePx.width + 0.1 || box.y + box.h > slide.sizePx.height + 0.1) {
        fail("E_CONTRACT", `${object.id} is outside the slide`);
      }
      if (object.type === "image") {
        const areaShare = (box.w * box.h) / (slide.sizePx.width * slide.sizePx.height);
        if ((box.x <= slide.sizePx.width * 0.05 && box.y <= slide.sizePx.height * 0.05
            && box.w >= slide.sizePx.width * 0.90 && box.h >= slide.sizePx.height * 0.90)
          || areaShare >= 0.80) {
          fail("E_WHOLE_SLIDE_FALLBACK", `${object.id} covers the slide`);
        }
        await readable(local(root, object.asset, `${object.id}.asset`), `${object.id}.asset`);
      }
    }
  }
  for (const source of analysis.sources ?? []) {
    const path = local(root, source.path, `${source.id}.path`);
    await readable(path, `${source.id}.path`);
    if (await digest(path) !== source.sha256) fail("E_CONTRACT", `${source.id} digest mismatch`);
  }
  const passed = qa.status === "passed";
  const pptxPath = join(root, passed ? "final.pptx" : "failed-candidate.pptx");
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
  for (const artifact of run.artifacts ?? []) {
    const path = local(root, artifact.path, `run.artifacts.${artifact.path}`);
    await readable(path, artifact.path);
    const info = await stat(path);
    if (info.size !== artifact.bytes || await digest(path) !== artifact.sha256) {
      fail("E_CONTRACT", `run artifact mismatch: ${artifact.path}`);
    }
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
