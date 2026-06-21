import fs from "node:fs";
import path from "node:path";
import { loadDesignFirstArtifacts } from "./lib/design-first-loader.mjs";
import { compileDesignFirstManifest } from "./lib/manifest-compiler.mjs";
import { buildRunIndex, writeRunIndex } from "./lib/run-index.mjs";
import { validateAssetRegistry, validateSourceRegistry } from "./lib/registry.mjs";
import { reviewManifest } from "./lib/visual-critic.mjs";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";

function parseArgs(argv) {
  const [inputDir, outputDir, ...rest] = argv;
  if (!inputDir || !outputDir) {
    throw new Error("Usage: node scripts/run-design-first-pipeline.mjs <input-dir> <output-dir> [--design-system path] [--design-system-name name] [--mode creative|replica] [--emit-run-index] [--validate-registry] [--run-id id] [--input-summary text]");
  }
  const options = { mode: "creative" };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--design-system") options.designSystemSource = rest[++i];
    else if (rest[i] === "--design-system-name") options.designSystemName = rest[++i];
    else if (rest[i] === "--mode") options.mode = rest[++i];
    else if (rest[i] === "--emit-run-index") options.emitRunIndex = true;
    else if (rest[i] === "--validate-registry") options.validateRegistry = true;
    else if (rest[i] === "--run-id") options.runId = rest[++i];
    else if (rest[i] === "--input-summary") options.inputSummary = rest[++i];
  }
  return { inputDir, outputDir, options };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateRegistries(outputDir) {
  const sources = readJsonIfExists(path.join(outputDir, "sources.json"));
  const assets = readJsonIfExists(path.join(outputDir, "assets", "asset-registry.json"));
  const issues = [];
  if (sources) issues.push(...validateSourceRegistry(sources).issues);
  if (assets) issues.push(...validateAssetRegistry(assets).issues);
  const blocking = issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    throw new Error(`registry validation failed: ${blocking.map((issue) => issue.message).join("; ")}`);
  }
}

function makeDesignSourceManifestRelative(manifest, outputDir) {
  const source = manifest.designSystem?.source;
  if (!source || path.isAbsolute(source)) return manifest;
  const absoluteSource = path.resolve(source);
  return {
    ...manifest,
    designSystem: {
      ...manifest.designSystem,
      source: path.relative(outputDir, absoluteSource).replace(/\\/g, "/")
    }
  };
}

async function main() {
  const { inputDir, outputDir, options } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outputDir, { recursive: true });

  if (options.designSystemSource && !path.isAbsolute(options.designSystemSource)) {
    options.designSystemSource = path.resolve(options.designSystemSource);
  }

  const artifacts = loadDesignFirstArtifacts(inputDir);
  const manifest = makeDesignSourceManifestRelative(compileDesignFirstManifest(artifacts, options), outputDir);
  const manifestPath = path.join(outputDir, "deck.manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const designFirstOptions = {
    inputType: "design-first",
    inputSource: path.join(inputDir, "deck.storyboard.json"),
    copyManifest: false,
    mode: options.mode,
    strictLayoutSafety: true
  };
  await runDeckPipeline(manifestPath, outputDir, designFirstOptions);
  console.log(`Consistency report written: ${path.join(outputDir, "consistency-report.json")}`);

  let consistencyReport = null;
  const consistencyReportPath = path.join(outputDir, "consistency-report.json");
  if (fs.existsSync(consistencyReportPath)) {
    try {
      consistencyReport = JSON.parse(fs.readFileSync(consistencyReportPath, "utf8"));
    } catch {
      consistencyReport = null;
    }
  }

  if (options.mode !== "replica") {
    const review = reviewManifest(manifest, { mode: options.mode }, consistencyReport);
    fs.writeFileSync(path.join(outputDir, "visual-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
  }

  if (options.validateRegistry) {
    validateRegistries(outputDir);
  }

  if (options.emitRunIndex) {
    const run = await buildRunIndex(outputDir, {
      runId: options.runId ?? new Date().toISOString().slice(0, 10),
      mode: options.mode,
      input: {
        type: "design-first",
        summary: options.inputSummary ?? artifacts.storyboard?.title ?? "design-first deck"
      }
    });
    await writeRunIndex(outputDir, run);
  }

  console.log(`Design-first pipeline complete: ${path.join(outputDir, "final.pptx")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
