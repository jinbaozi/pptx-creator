import fs from "node:fs";
import path from "node:path";
import { compileDeckPlan, validateDeckPlan } from "./lib/deck-plan.mjs";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";

function parseArgs(argv) {
  const [inputDir, outputDir, ...rest] = argv;
  if (!inputDir || !outputDir) {
    throw new Error("Usage: node scripts/run-design-first-pipeline.mjs <deck.plan.json|input-dir> <output-dir> [--design-system path] [--design-system-name name]");
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

function makeDesignSourceManifestRelative(manifest, outputDir) {
  const source = manifest.designSystem?.source;
  if (!source) return manifest;
  const absoluteSource = path.resolve(source);
  const canonicalOutput = fs.realpathSync(outputDir);
  return {
    ...manifest,
    designSystem: {
      ...manifest.designSystem,
      source: path.relative(canonicalOutput, absoluteSource).replace(/\\/g, "/")
    }
  };
}

async function main() {
  const { inputDir, outputDir, options } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outputDir, { recursive: true });

  if (options.designSystemSource && !path.isAbsolute(options.designSystemSource)) {
    options.designSystemSource = path.resolve(options.designSystemSource);
  }

  const planPath = fs.statSync(inputDir).isDirectory() ? path.join(inputDir, "deck.plan.json") : inputDir;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  const manifest = makeDesignSourceManifestRelative(compileDeckPlan(plan, options), outputDir);
  const manifestPath = path.join(outputDir, "deck.manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const designFirstOptions = {
    inputType: "text",
    inputSource: planPath,
    copyManifest: false,
    mode: options.mode,
    strictLayoutSafety: true,
    protectedInputs: [
      planPath
    ],
    beforePackage: async () => {
      const target = path.join(outputDir, "deck.plan.json");
      if (path.resolve(planPath) !== path.resolve(target)) fs.copyFileSync(planPath, target);
    }
  };
  await runDeckPipeline(manifestPath, outputDir, designFirstOptions);
  console.log(`Creative text pipeline complete: ${path.join(outputDir, "final.pptx")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
