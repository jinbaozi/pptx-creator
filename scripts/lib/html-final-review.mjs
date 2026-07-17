import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { validateJsonSchema } from "./schema-utils.mjs";

export const HTML_FINAL_REVIEW_VERSION = "0.4.0";
const JUDGMENTS = ["noOcclusion", "textRhythm", "whitespaceBalance", "connectorSemantics", "componentVisibility"];
const REQUIRED_SUITES = ["libreoffice", "powerpoint", "wps"];

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !["createdAt", "generatedAt"].includes(key)).map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function canonicalJsonHash(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalJson(value)), "utf8"));
}

async function jsonHash(path) {
  return canonicalJsonHash(JSON.parse(await readFile(path, "utf8")));
}

async function fileHash(path) {
  return sha256(await readFile(path));
}

async function assertBoundReviewArtifact(outputDir, artifact, label) {
  const relativePath = String(artifact?.path ?? "");
  const target = resolve(outputDir, relativePath);
  const portable = relative(outputDir, target).replaceAll("\\", "/");
  if (!relativePath.startsWith("evidence/") || portable !== relativePath || portable.startsWith("../")) {
    throw reviewError(`${label} must stay below evidence/ as a normalized relative path`);
  }
  if (await fileHash(target) !== artifact.hash) throw reviewError(`${label} hash is stale`);
}

async function canonicalPptxHash(path) {
  const zip = await JSZip.loadAsync(await readFile(path));
  const digest = createHash("sha256");
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  for (const name of names) {
    let bytes = await zip.file(name).async("nodebuffer");
    if (name === "docProps/core.xml") {
      bytes = Buffer.from(bytes.toString("utf8").replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, "$1TIMESTAMP-NORMALIZED$2"), "utf8");
    }
    digest.update(name);
    digest.update("\u0000");
    digest.update(bytes);
    digest.update("\u0000");
  }
  return `sha256:${digest.digest("hex")}`;
}

function connectorTopology(manifest) {
  return (manifest.slides ?? []).flatMap((slide) => (slide.elements ?? [])
    .filter((element) => element?.type === "line" && (element.connector || element.role === "axis"))
    .map((element) => ({
      slideId: slide.id,
      elementId: element.id,
      role: element.role ?? (element.connector ? "connector" : null),
      sourceId: element.connector?.sourceId ?? null,
      targetId: element.connector?.targetId ?? null,
      sourceAnchor: element.connector?.sourceAnchor ?? null,
      targetAnchor: element.connector?.targetAnchor ?? null,
      route: element.connector?.route ?? null,
      axisDirection: element.axisDirection ?? null,
      endMarker: element.style?.endArrowType ?? null
    })));
}

async function readHistory(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(value.attempts) ? value : { version: HTML_FINAL_REVIEW_VERSION, attempts: [] };
  } catch {
    return { version: HTML_FINAL_REVIEW_VERSION, attempts: [] };
  }
}

async function writeHistory(path, history) {
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

function reviewError(message, stage = "host-final-visual-review") {
  const error = new Error(message);
  error.stage = stage;
  error.preserveReviewEvidence = true;
  return error;
}

export async function enforceHtmlFinalReview(options) {
  const outputDir = resolve(options.outputDir);
  const manifest = options.manifest;
  const reviewDir = join(outputDir, "html-final-review");
  const candidatePath = join(reviewDir, "candidate.pptx");
  const packetPath = join(reviewDir, "review-packet.json");
  const templatePath = join(reviewDir, "host-final-review.template.json");
  const historyPath = join(reviewDir, "review-history.json");
  const renderDir = join(outputDir, "evidence", "render");
  await mkdir(reviewDir, { recursive: true });
  await copyFile(join(outputDir, "final.pptx"), candidatePath);

  const renderNames = new Set(await readdir(renderDir));
  const slides = [];
  for (const [index, slide] of (manifest.slides ?? []).entries()) {
    const name = `slide-${index + 1}.png`;
    if (!renderNames.has(name)) throw reviewError(`final review evidence is missing ${name}`);
    const absolute = join(renderDir, name);
    slides.push({
      slideId: slide.id,
      slideNumber: index + 1,
      screenshotPath: relative(outputDir, absolute).replaceAll("\\", "/"),
      screenshotHash: await fileHash(absolute)
    });
  }
  const contactSheetPath = join(renderDir, "contact-sheet.png");
  if (!renderNames.has("contact-sheet.png")) throw reviewError("final review evidence is missing contact-sheet.png");

  const artifacts = {
    repairedHtmlHash: await fileHash(resolve(options.repairedHtmlPath)),
    manifestHash: await fileHash(join(outputDir, "deck.manifest.json")),
    pptxHash: await canonicalPptxHash(candidatePath),
    htmlLayoutReportHash: await jsonHash(join(outputDir, "html-layout-report.json")),
    pptxGeometryReportHash: await jsonHash(join(outputDir, "pptx-geometry-report.json")),
    contactSheetHash: await fileHash(contactSheetPath)
  };
  const unsignedPacket = {
    version: HTML_FINAL_REVIEW_VERSION,
    route: "text/html-first",
    artifacts,
    candidatePptx: relative(outputDir, candidatePath).replaceAll("\\", "/"),
    repairedHtml: relative(outputDir, resolve(options.repairedHtmlPath)).replaceAll("\\", "/"),
    manifest: "deck.manifest.json",
    contactSheet: relative(outputDir, contactSheetPath).replaceAll("\\", "/"),
    slides,
    connectorTopology: connectorTopology(manifest),
    judgments: JUDGMENTS,
    suiteTargets: REQUIRED_SUITES,
    maxReviewRounds: 3
  };
  const packet = { ...unsignedPacket, packetHash: canonicalJsonHash(unsignedPacket) };
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

  const template = {
    version: HTML_FINAL_REVIEW_VERSION,
    packetHash: packet.packetHash,
    artifacts,
    status: "pending",
    overallVerdict: null,
    slides: slides.map((slide) => ({
      slideId: slide.slideId,
      screenshotPath: slide.screenshotPath,
      screenshotHash: slide.screenshotHash,
      noOcclusion: null,
      textRhythm: null,
      whitespaceBalance: null,
      connectorSemantics: null,
      componentVisibility: null,
      observations: null,
      findings: []
    })),
    suites: REQUIRED_SUITES.map((suite) => ({ suite, required: true, status: "pending", environment: null, artifacts: [], reason: null })),
    summary: null
  };
  await writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  if (!options.reviewPath) {
    throw reviewError(`review packet ready at ${relative(outputDir, packetPath)}; inspect every full-size slide and rerun with --host-final-review <json>`);
  }
  let review;
  try {
    review = JSON.parse(await readFile(resolve(options.reviewPath), "utf8"));
  } catch (error) {
    throw reviewError(`unable to read HTML-first Host final review ${basename(options.reviewPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const schema = JSON.parse(await readFile(resolve(options.schemaPath), "utf8"));
  const validation = validateJsonSchema(review, schema);
  if (!validation.valid) throw reviewError(`HTML-first Host final review contract invalid: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  if (review.packetHash !== packet.packetHash || JSON.stringify(review.artifacts) !== JSON.stringify(artifacts)) {
    throw reviewError("HTML-first Host final review is bound to stale artifacts or a stale packet");
  }
  const expectedSlides = new Map(slides.map((slide) => [slide.slideId, slide]));
  if (review.slides.length !== slides.length || new Set(review.slides.map((slide) => slide.slideId)).size !== slides.length) {
    throw reviewError("HTML-first Host final review must contain exactly one assessment for every slide");
  }
  for (const assessment of review.slides) {
    const expected = expectedSlides.get(assessment.slideId);
    if (!expected || assessment.screenshotPath !== expected.screenshotPath || assessment.screenshotHash !== expected.screenshotHash) {
      throw reviewError(`HTML-first Host final review contains stale screenshot evidence for ${assessment.slideId}`);
    }
  }
  const suiteNames = review.suites.map((entry) => entry.suite);
  if (new Set(suiteNames).size !== REQUIRED_SUITES.length || REQUIRED_SUITES.some((suite) => !suiteNames.includes(suite))) {
    throw reviewError("HTML-first Host final review must assess LibreOffice, PowerPoint, and WPS exactly once");
  }
  for (const suite of review.suites) {
    for (const [index, artifact] of suite.artifacts.entries()) {
      await assertBoundReviewArtifact(outputDir, artifact, `${suite.suite} evidence ${index + 1}`);
    }
  }

  const failed = review.overallVerdict !== "accept"
    || review.slides.some((slide) => JUDGMENTS.some((key) => slide[key] !== "pass")
      || slide.findings.some((finding) => ["P0", "P1"].includes(finding.severity)))
    || review.suites.some((suite) => suite.required !== true || suite.status !== "passed");
  if (failed) {
    const history = await readHistory(historyPath);
    history.attempts.push({ packetHash: packet.packetHash, reviewHash: canonicalJsonHash(review), verdict: review.overallVerdict });
    await writeHistory(historyPath, history);
    const stage = history.attempts.length >= 3 ? "host-final-visual-review-exhausted" : "host-final-visual-review";
    throw reviewError(`HTML-first Host review rejected the candidate in round ${history.attempts.length}; repair the earliest responsible HTML/layout layer`, stage);
  }
  await writeFile(join(outputDir, "host-html-visual-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return { packetPath, reviewPath: join(outputDir, "host-html-visual-review.json"), packetHash: packet.packetHash };
}
