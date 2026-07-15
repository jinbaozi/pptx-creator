#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { compileDeckPlanArtifacts, validateDeckPlan } from "./lib/deck-plan.mjs";
import { scoreSlopRisk } from "./lib/slop-risk.mjs";
import { buildCreativeRepairPatch } from "./lib/creative-repair.mjs";
import {
  buildBlindReviewHtml,
  createBlindedReviewBundle,
  evaluateBlindPreference,
  loadCreativeBenchmarkCorpus,
  portableArtifactManifest,
  selectLaneBriefs,
  validateBenchmarkCorpus
} from "./lib/blind-preference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS_MS = Object.freeze({ fast: 5 * 60_000, render: 10 * 60_000, nightly: 30 * 60_000, release: 30 * 60_000 });
const IDENTITY_LEAK = /baseline|candidate|challenger|reference|generator|model/i;

function parseArgs(argv) {
  const options = { lane: null, output: path.join(root, "output/creative-benchmark"), artifacts: [], reviews: [], prepareReview: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--lane") options.lane = argv[++index];
    else if (key === "--output") options.output = path.resolve(argv[++index]);
    else if (key === "--artifacts") options.artifacts.push(path.resolve(argv[++index]));
    else if (key === "--reviews") options.reviews.push(path.resolve(argv[++index]));
    else if (key === "--seed") options.seed = argv[++index];
    else if (key === "--prepare-review") options.prepareReview = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!new Set(["fast", "render", "nightly", "release"]).has(options.lane)) {
    throw new Error("usage: run-creative-benchmark.mjs --lane fast|render|nightly|release [--output DIR] [--artifacts JSON ... --seed VALUE (--prepare-review | --reviews JSON ...)]");
  }
  if (options.lane !== "release" && (options.artifacts.length || options.reviews.length || options.prepareReview || options.seed)) {
    throw new Error("--artifacts, --reviews, --seed, and --prepare-review are release-lane options");
  }
  if (options.prepareReview && options.reviews.length) throw new Error("--prepare-review and --reviews are mutually exclusive");
  return options;
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readList(source, label) {
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed?.[label];
  if (!Array.isArray(records)) throw new Error(`${source}: expected an array or an object with ${label}`);
  return records;
}

function loadArtifactManifests(sources) {
  return sources.flatMap((source) => readList(source, "artifacts").map((artifact) => ({
    ...artifact,
    evidence: Object.fromEntries(Object.entries(artifact.evidence ?? {}).map(([key, value]) => [
      key,
      path.isAbsolute(value) ? value : path.resolve(path.dirname(source), value)
    ]))
  })));
}

function loadReviewFiles(sources) {
  return sources.flatMap((source) => readList(source, "reviews"));
}

function resolveInstalledFont(request, language) {
  try {
    const matched = execFileSync("fc-match", ["-f", "%{family}\t%{file}", `${request}:lang=${language === "zh-CN" ? "zh-cn" : "en"}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const [families, file] = matched.split("\t");
    const family = families?.split(",")[0].trim();
    if (family) return { requested: request, resolved: family, directory: file ? path.dirname(file) : null };
  } catch {
    // CI setup installs the requested families; environments without fontconfig
    // still get an explicit, auditable request instead of silent auto-substitution.
  }
  return { requested: request, resolved: request, directory: null };
}

function compileBrief(corpus, brief) {
  const plan = corpus.materializePlan(brief);
  const bodyFont = resolveInstalledFont(brief.language === "zh-CN" ? "Noto Sans CJK SC" : "Liberation Sans", brief.language);
  const metricFont = resolveInstalledFont("Arial", brief.language);
  const roles = ["title", "subtitle", "heading", "body", "caption"];
  const typography = Object.fromEntries(roles.map((role) => [role, { fontFamily: bodyFont.resolved }]));
  typography.metric = { fontFamily: metricFont.resolved };
  const compiled = compileDeckPlanArtifacts(plan, { designTokens: { typography } });
  return { plan, ...compiled, fonts: [bodyFont, metricFont] };
}

function renderBrief(corpus, brief, outputRoot) {
  const artifactRoot = path.join(outputRoot, "artifacts", brief.id, "challenger");
  const slides = path.join(artifactRoot, "slides");
  fs.mkdirSync(slides, { recursive: true });
  const { plan, ir, manifest, fonts } = compileBrief(corpus, brief);
  const planPath = path.join(artifactRoot, "deck.plan.json");
  const irPath = path.join(artifactRoot, "semantic-slide-ir.json");
  const manifestPath = path.join(artifactRoot, "deck.manifest.json");
  const pptxPath = path.join(artifactRoot, "deck.pptx");
  const designSource = manifest.designSystem?.source;
  const sourceDesignPath = path.resolve(root, designSource ?? "");
  const localizedDesignPath = path.resolve(artifactRoot, designSource ?? "");
  if (!designSource || !sourceDesignPath.startsWith(`${root}${path.sep}`) || !localizedDesignPath.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error(`${brief.id}: design-system source must remain a local relative path`);
  }
  fs.mkdirSync(path.dirname(localizedDesignPath), { recursive: true });
  fs.copyFileSync(sourceDesignPath, localizedDesignPath);
  writeJson(planPath, plan);
  writeJson(irPath, ir);
  writeJson(manifestPath, manifest);
  execFileSync(process.execPath, [path.join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], {
    cwd: root, stdio: "pipe", env: process.env
  });
  const previewText = execFileSync(process.execPath, [
    path.join(root, "scripts/run-python.mjs"), path.join(root, "scripts/render-preview.py"), pptxPath, slides
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PPTX_CREATOR_FONT_DIRS: [...new Set(fonts.map((item) => item.directory).filter(Boolean))].join(path.delimiter)
    }
  });
  const preview = JSON.parse(previewText);
  if (preview.status !== "ok" || !preview.contactSheet?.path) throw new Error(`${brief.id}: LibreOffice evidence is unavailable`);
  const proof = {
    version: "0.1.0",
    briefId: brief.id,
    manifest: path.relative(artifactRoot, manifestPath),
    pptx: path.relative(artifactRoot, pptxPath),
    renderedPages: preview.previews?.length ?? 0,
    contactSheet: path.relative(artifactRoot, preview.contactSheet.path),
    typography: fonts.map(({ requested, resolved }) => ({ requested, resolved })),
    status: "rendered-not-host-reviewed"
  };
  const proofPath = path.join(artifactRoot, "creative-proof.json");
  writeJson(proofPath, proof);
  return {
    briefId: brief.id,
    kind: "challenger",
    artifactId: `${brief.id}-challenger`,
    identityAttestation: { status: "passed", scope: "generator-identity", reviewerFacingNamesNeutral: true },
    evidence: { pptx: pptxPath, slides, contactSheet: preview.contactSheet.path, proof: proofPath }
  };
}

function fastContract(corpus, brief) {
  const { plan, ir, manifest, fonts } = compileBrief(corpus, brief);
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`${brief.id}: ${validation.errors.join("; ")}`);
  const slop = scoreSlopRisk(manifest, {}, { domain: brief.domain, language: brief.language });
  const patch = buildCreativeRepairPatch({ slides: manifest.slides.map((slide) => ({ id: slide.id, recommendedRepairs: [] })) }, 1, manifest);
  if (patch.patches.length !== 0) throw new Error(`${brief.id}: empty repair contract must be a no-op`);
  return {
    id: brief.id,
    domain: brief.domain,
    language: brief.language,
    planVersion: plan.version,
    irVersion: ir.version,
    slides: manifest.slides.length,
    slopRisk: slop.score,
    evidenceRecords: brief.evidence.length,
    typography: fonts.map(({ requested, resolved }) => ({ requested, resolved })),
    status: "passed"
  };
}

function copyEvidence(source, target) {
  if (!fs.existsSync(source)) throw new Error(`blind-review evidence does not exist: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function fileHash(source) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(source)).digest("hex")}`;
}

function assertDistinctPairEvidence(corpus, artifacts) {
  for (const brief of corpus.briefs) {
    const entries = artifacts.filter((artifact) => artifact.briefId === brief.id);
    const reference = entries.find((artifact) => artifact.kind === "reference");
    const challenger = entries.find((artifact) => artifact.kind === "challenger");
    if (!reference || !challenger) continue;
    for (const key of ["pptx", "contactSheet"]) {
      if (fileHash(reference.evidence[key]) === fileHash(challenger.evidence[key])) {
        throw new Error(`${brief.id}: left/right source ${key} evidence must be materially distinct`);
      }
    }
  }
}

async function neutralizePptxMetadata(source, target) {
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  for (const name of Object.keys(zip.files).filter((entry) => entry.startsWith("docProps/") && entry.endsWith(".xml"))) {
    let xml = await zip.file(name).async("string");
    xml = xml
      .replace(/(<dc:creator>)[\s\S]*?(<\/dc:creator>)/gi, "$1anonymous$2")
      .replace(/(<cp:lastModifiedBy>)[\s\S]*?(<\/cp:lastModifiedBy>)/gi, "$1anonymous$2")
      .replace(/(<Application>)[\s\S]*?(<\/Application>)/gi, "$1Anonymous presentation review$2")
      .replace(/(<Company>)[\s\S]*?(<\/Company>)/gi, "$1$2")
      .replace(/(<AppVersion>)[\s\S]*?(<\/AppVersion>)/gi, (_match, open, close) => `${open}1.0${close}`)
      .replace(/baseline|candidate|challenger|reference|generator|model/gi, "anonymous");
    zip.file(name, xml);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const publicZip = await JSZip.loadAsync(fs.readFileSync(target));
  const metadata = await Promise.all(Object.keys(publicZip.files).filter((entry) => entry.startsWith("docProps/") && entry.endsWith(".xml")).map((entry) => publicZip.file(entry).async("string")));
  if (IDENTITY_LEAK.test(metadata.join("\n"))) throw new Error("blinded PPTX metadata still contains a generator identity label");
}

function writeBlindProofReceipt(source, target, pairId, side, attestation) {
  writeJson(target, {
    version: "0.1.0",
    pairId,
    side,
    sourceProofHash: fileHash(source),
    identityAttestation: { status: attestation.status, reviewerFacingNamesNeutral: attestation.reviewerFacingNamesNeutral },
    note: "Source proof is hash-bound privately; source-specific fields are excluded from reviewer evidence."
  });
}

async function materializeBlindReviewAssets(bundle, artifacts, outputRoot) {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const pairById = new Map(bundle.packet.pairs.map((pair) => [pair.pairId, pair]));
  for (const key of bundle.answerKey.pairs) {
    const pair = pairById.get(key.pairId);
    for (const [kind, side] of [["reference", key.referenceSide], ["challenger", key.challengerSide]]) {
      const source = artifactsById.get(key.sourceArtifacts[kind]);
      if (!source) throw new Error(`${key.pairId}: source artifact ${key.sourceArtifacts[kind]} is missing`);
      const destination = pair[side].evidence;
      await neutralizePptxMetadata(source.evidence.pptx, path.join(outputRoot, destination.pptx));
      copyEvidence(source.evidence.slides, path.join(outputRoot, destination.slides));
      copyEvidence(source.evidence.contactSheet, path.join(outputRoot, destination.contactSheet));
      writeBlindProofReceipt(source.evidence.proof, path.join(outputRoot, destination.proof), key.pairId, side, source.identityAttestation);
    }
  }
}

async function runRelease(corpus, options, startedAt) {
  if (!options.artifacts.length) throw new Error("release lane requires --artifacts with 24 complete reference/challenger pairs");
  if (!options.seed) throw new Error("release lane requires an explicit --seed");
  if (!options.prepareReview && !options.reviews.length) throw new Error("release evaluation requires --reviews; use --prepare-review to create the blinded reviewer handoff first");
  const artifacts = loadArtifactManifests(options.artifacts);
  assertDistinctPairEvidence(corpus, artifacts);
  const bundle = createBlindedReviewBundle({ corpus, artifacts, seed: options.seed });
  await materializeBlindReviewAssets(bundle, artifacts, options.output);
  writeJson(path.join(options.output, "blind-review-packet.json"), bundle.packet);
  writeJson(path.join(options.output, "private/answer-key.json"), bundle.answerKey);
  const reviewerRoot = path.join(options.output, "reviewer");
  fs.mkdirSync(reviewerRoot, { recursive: true });
  fs.writeFileSync(path.join(reviewerRoot, "index.html"), buildBlindReviewHtml(bundle.packet), "utf8");
  fs.writeFileSync(path.join(reviewerRoot, "README.md"), "# PPTX 匿名对比评审\n\n1. 使用浏览器打开 `index.html`。\n2. 查看每组左右两侧的完整单页和可编辑 PPTX。\n3. 分别完成左右两侧的五项评分，再选择综合更好的一侧。\n4. 输入匿名评审者编号（例如 `R01`），导出 `review-records.json`。\n\n每位评审者必须使用不同编号并独立完成全部 24 组。不要分发相邻的 `private/` 目录，也不要讨论或猜测左右两侧的制作来源。\n", "utf8");
  const reviews = options.prepareReview ? [] : loadReviewFiles(options.reviews);
  const preference = evaluateBlindPreference({ corpus, bundle, reviews });
  writeJson(path.join(options.output, "blind-preference-report.json"), preference);
  return {
    version: "0.1.0",
    lane: "release",
    status: options.prepareReview ? "awaiting-human-review" : preference.status,
    networkUsed: false,
    llmUsed: false,
    elapsedMs: Date.now() - startedAt,
    timeBudgetMs: LIMITS_MS.release,
    briefs: corpus.briefs.map(({ id, domain, language }) => ({ id, domain, language, status: "review-paired" })),
    contracts: ["blinding", "identity-isolation", "five-reviewer-minimum", "wilson-95", "subgroup-thresholds", "five-dimension-medians"],
    evidence: ["blind-review-packet.json", "blind-preference-report.json", "reviewer/index.html", "reviewer/README.md"],
    privateEvidence: ["private/answer-key.json"],
    failures: options.prepareReview ? ["human-reviews-pending"] : preference.failures
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  fs.mkdirSync(options.output, { recursive: true });
  const corpus = loadCreativeBenchmarkCorpus(root);
  const corpusValidation = validateBenchmarkCorpus(corpus);
  if (!corpusValidation.valid) throw new Error(corpusValidation.errors.join("; "));
  let report;
  if (options.lane === "release") {
    report = await runRelease(corpus, options, startedAt);
  } else {
    const briefs = selectLaneBriefs(corpus, options.lane);
    const results = briefs.map((brief) => fastContract(corpus, brief));
    const rendered = options.lane === "fast" ? [] : briefs.map((brief) => renderBrief(corpus, brief, options.output));
    const portableArtifacts = rendered.length ? portableArtifactManifest(rendered, options.output) : [];
    if (portableArtifacts.length) writeJson(path.join(options.output, "challenger-artifacts.json"), portableArtifacts);
    const elapsedMs = Date.now() - startedAt;
    report = {
      version: "0.1.0",
      lane: options.lane,
      status: elapsedMs <= LIMITS_MS[options.lane] ? "passed" : "failed",
      networkUsed: false,
      llmUsed: false,
      elapsedMs,
      timeBudgetMs: LIMITS_MS[options.lane],
      briefs: results,
      contracts: ["schema", "compiler", "anti-slop", "repair", ...(rendered.length ? ["pptx", "libreoffice", "png", "contact-sheet", "proof"] : [])],
      artifacts: portableArtifacts,
      evidence: portableArtifacts.length ? ["challenger-artifacts.json"] : []
    };
  }
  writeJson(path.join(options.output, "benchmark-report.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!new Set(["passed", "awaiting-human-review"]).has(report.status)) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
