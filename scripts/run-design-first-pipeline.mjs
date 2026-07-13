import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compileDeckPlan, validateDeckPlan } from "./lib/deck-plan.mjs";
import { resolveDesignSystem } from "./lib/design-system-resolver.mjs";
import { createFontMetricsCatalog } from "./lib/font-preflight.mjs";
import { fitManifestText, materializeTextFonts } from "./lib/text-fit.mjs";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteReference = /^[a-z][a-z0-9+.-]*:/i;

function parseArgs(argv) {
  const [inputDir, outputDir, ...rest] = argv;
  if (!inputDir || !outputDir) {
    throw new Error("Usage: node scripts/run-design-first-pipeline.mjs <deck.plan.json|input-dir> <output-dir> [--design-system <path-or-name>]");
  }
  const options = { mode: "creative" };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--design-system") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--design-system requires a value");
      options.designSystem = value;
      i += 1;
    } else if (rest[i] === "--mode") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--mode requires a value");
      options.mode = value;
      i += 1;
      if (options.mode !== "creative") throw new Error("deck.plan pipeline supports creative mode only");
    } else throw new Error(`unknown option: ${rest[i]}`);
  }
  return { inputDir, outputDir, options };
}

function localizedAssetName(asset, bytes, sourcePath) {
  const safeId = String(asset.id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const extension = path.extname(sourcePath).toLowerCase() || ".bin";
  return `${safeId}-${digest}${extension}`;
}

function localizePlanAssets(plan, planPath, outputDir) {
  const planDirectory = path.dirname(path.resolve(planPath));
  const assets = plan.assets.map((asset) => {
    const sourceRef = asset.provenance.sourceRef;
    if (remoteReference.test(sourceRef) || sourceRef.startsWith("//")) {
      throw new Error(`asset ${asset.id} uses a remote sourceRef; localize it before running the creative pipeline`);
    }
    const sourcePath = path.isAbsolute(sourceRef) ? path.resolve(sourceRef) : path.resolve(planDirectory, sourceRef);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`asset ${asset.id} source file not found: ${sourcePath}`);
    }
    const bytes = fs.readFileSync(sourcePath);
    const fileName = localizedAssetName(asset, bytes, sourcePath);
    const targetPath = path.resolve(outputDir, "assets", fileName);
    return { asset, sourcePath, targetPath, relativePath: path.posix.join("assets", fileName) };
  });

  if (assets.length > 0) fs.mkdirSync(path.resolve(outputDir, "assets"), { recursive: true });
  for (const asset of assets) {
    if (asset.sourcePath !== asset.targetPath) fs.copyFileSync(asset.sourcePath, asset.targetPath);
  }
  return {
    sourceById: Object.fromEntries(assets.map((asset) => [asset.asset.id, asset.relativePath])),
    protectedPaths: assets.flatMap((asset) => [asset.sourcePath, asset.targetPath])
  };
}

async function main() {
  const { inputDir, outputDir, options } = parseArgs(process.argv.slice(2));
  const resolvedInput = path.resolve(inputDir);
  const planPath = fs.statSync(resolvedInput).isDirectory() ? path.join(resolvedInput, "deck.plan.json") : resolvedInput;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  const selection = await resolveDesignSystem({ request: options.designSystem, inputPath: planPath, projectRoot });
  const localizedAssets = localizePlanAssets(plan, planPath, outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const designOutputDir = path.join(outputDir, "design-system");
  const designOutputPath = path.join(designOutputDir, "DESIGN.md");
  fs.mkdirSync(designOutputDir, { recursive: true });
  if (selection.resolvedSource !== path.resolve(designOutputPath)) fs.copyFileSync(selection.resolvedSource, designOutputPath);
  const design = selection.design;
  const compiledManifest = compileDeckPlan(plan, {
    designSystemSource: "design-system/DESIGN.md",
    designSystemName: design.name,
    designTokens: design.tokens,
    designSystemSelection: { request: selection.request, resolvedSource: selection.resolvedSource },
    assetSourceById: localizedAssets.sourceById
  });
  const fontCatalog = await createFontMetricsCatalog();
  const materializedFonts = materializeTextFonts(compiledManifest, design.tokens, fontCatalog);
  const fitted = await fitManifestText(materializedFonts.manifest, {
    designTokens: design.tokens,
    fontCatalog,
    ...(fontCatalog.source === "unavailable"
      ? { source: "unavailable", reason: "fontkit could not open any installed font faces" }
      : {})
  });
  if (fitted.unresolved.length > 0 || fitted.report.status !== "passed") {
    throw new Error(`creative text fit unresolved: ${fitted.unresolved.map((item) => `${item.slideId}/${item.elementId}:${item.status}`).join(", ")}`);
  }
  const manifest = fitted.manifest;
  const manifestPath = path.join(outputDir, "deck.manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const designFirstOptions = {
    inputType: "text",
    inputSource: planPath,
    copyManifest: false,
    mode: options.mode,
    strictLayoutSafety: true,
    protectedInputs: [
      planPath,
      designOutputPath,
      ...localizedAssets.protectedPaths
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
