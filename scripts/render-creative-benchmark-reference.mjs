#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { portableArtifactManifest } from "./lib/blind-preference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { sourceRoot: null, revision: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--source-root") options.sourceRoot = path.resolve(argv[++index]);
    else if (key === "--revision") options.revision = argv[++index];
    else if (key === "--output") options.output = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!options.sourceRoot || !options.revision || !options.output) {
    throw new Error("usage: render-creative-benchmark-reference.mjs --source-root CHECKOUT --revision COMMIT --output DIR");
  }
  options.sourceRoot = fs.realpathSync.native(options.sourceRoot);
  return options;
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function gitRevision(sourceRoot, revision = "HEAD") {
  return execFileSync("git", ["-C", sourceRoot, "rev-parse", revision], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function copyDesignSource(sourceRoot, artifactRoot, manifest) {
  const designSource = manifest.designSystem?.source;
  if (typeof designSource !== "string" || path.isAbsolute(designSource) || designSource.split(/[\\/]/).includes("..")) {
    throw new Error("reference manifest design source must be a safe relative path");
  }
  const source = path.resolve(sourceRoot, designSource);
  const target = path.resolve(artifactRoot, designSource);
  if (!source.startsWith(`${sourceRoot}${path.sep}`) || !target.startsWith(`${artifactRoot}${path.sep}`) || !fs.existsSync(source)) {
    throw new Error(`reference design source is unavailable: ${designSource}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expectedRevision = gitRevision(options.sourceRoot, options.revision);
  const actualRevision = gitRevision(options.sourceRoot);
  if (expectedRevision !== actualRevision) throw new Error(`reference checkout mismatch: expected ${expectedRevision}, found ${actualRevision}`);
  const deckPlanPath = path.join(options.sourceRoot, "scripts/lib/deck-plan.mjs");
  const renderPath = path.join(options.sourceRoot, "scripts/render-pptx.mjs");
  for (const required of [deckPlanPath, renderPath, path.join(options.sourceRoot, "package.json")]) {
    if (!fs.existsSync(required)) throw new Error(`reference checkout is incomplete: ${required}`);
  }
  const legacy = await import(`${pathToFileURL(deckPlanPath).href}?revision=${actualRevision}`);
  if (typeof legacy.buildPlanFromBriefFixture !== "function" || typeof legacy.compileDeckPlan !== "function") {
    throw new Error("reference revision does not expose the required benchmark fixture/compiler interface");
  }
  const corpus = JSON.parse(fs.readFileSync(path.join(root, "examples/creative-benchmark/corpus.json"), "utf8"));
  const startedAt = Date.now();
  const artifacts = [];
  for (const brief of corpus.briefs) {
    const fixture = { id: brief.id, domain: brief.compilerDomain, language: brief.language, brief: brief.brief, input: brief.input };
    const plan = legacy.buildPlanFromBriefFixture(fixture);
    const validation = legacy.validateDeckPlan(plan);
    if (!validation.valid) throw new Error(`${brief.id}: reference plan invalid: ${validation.errors.join("; ")}`);
    const manifest = legacy.compileDeckPlan(plan);
    const artifactRoot = path.join(options.output, "artifacts", brief.id, "reference");
    const slides = path.join(artifactRoot, "slides");
    fs.mkdirSync(slides, { recursive: true });
    copyDesignSource(options.sourceRoot, artifactRoot, manifest);
    const planPath = path.join(artifactRoot, "deck.plan.json");
    const manifestPath = path.join(artifactRoot, "deck.manifest.json");
    const pptxPath = path.join(artifactRoot, "deck.pptx");
    writeJson(planPath, plan);
    writeJson(manifestPath, manifest);
    execFileSync(process.execPath, [renderPath, manifestPath, pptxPath], { cwd: options.sourceRoot, env: process.env, stdio: "pipe" });
    const previewText = execFileSync(process.execPath, [
      path.join(root, "scripts/run-python.mjs"), path.join(root, "scripts/render-preview.py"), pptxPath, slides
    ], { cwd: root, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const preview = JSON.parse(previewText);
    if (preview.status !== "ok" || !preview.contactSheet?.path) throw new Error(`${brief.id}: reference render evidence is unavailable`);
    const proofPath = path.join(artifactRoot, "creative-proof.json");
    writeJson(proofPath, {
      version: "0.1.0",
      briefId: brief.id,
      comparatorRevision: actualRevision,
      manifest: "deck.manifest.json",
      pptx: "deck.pptx",
      renderedPages: preview.previews?.length ?? 0,
      contactSheet: "slides/contact-sheet.png",
      status: "rendered-frozen-comparator"
    });
    artifacts.push({
      briefId: brief.id,
      kind: "reference",
      artifactId: `${brief.id}-reference-${actualRevision.slice(0, 12)}`,
      identityAttestation: { status: "passed", scope: "generator-identity", reviewerFacingNamesNeutral: true },
      provenance: { revision: actualRevision, route: "frozen-repository-comparator" },
      evidence: { pptx: pptxPath, slides, contactSheet: preview.contactSheet.path, proof: proofPath }
    });
  }
  const portable = portableArtifactManifest(artifacts, options.output);
  writeJson(path.join(options.output, "reference-artifacts.json"), portable);
  const report = {
    version: "0.1.0",
    status: "passed",
    revision: actualRevision,
    networkUsed: false,
    llmUsed: false,
    briefs: portable.length,
    elapsedMs: Date.now() - startedAt,
    evidence: ["reference-artifacts.json"]
  };
  writeJson(path.join(options.output, "reference-report.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
