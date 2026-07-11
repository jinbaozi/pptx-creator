import fs from "node:fs";
import path from "node:path";
import { compileDeckPlan, validateDeckPlan } from "./lib/deck-plan.mjs";
import { createFontMetricsCatalog } from "./lib/font-preflight.mjs";
import { fitManifestText, materializeTextFonts } from "./lib/text-fit.mjs";
import { parseDesignFile } from "./parse-design-md.mjs";
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
    else if (rest[i] === "--mode") {
      options.mode = rest[++i];
      if (options.mode !== "creative") throw new Error("deck.plan pipeline supports creative mode only");
    } else throw new Error(`unknown option: ${rest[i]}`);
  }
  return { inputDir, outputDir, options };
}

async function main() {
  const { inputDir, outputDir, options } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outputDir, { recursive: true });

  const selectedDesignSource = path.resolve(options.designSystemSource || "design-systems/business-neutral/DESIGN.md");

  const planPath = fs.statSync(inputDir).isDirectory() ? path.join(inputDir, "deck.plan.json") : inputDir;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const validation = validateDeckPlan(plan);
  if (!validation.valid) throw new Error(`deck.plan invalid: ${validation.errors.join("; ")}`);
  const designOutputDir = path.join(outputDir, "design-system");
  const designOutputPath = path.join(designOutputDir, "DESIGN.md");
  fs.mkdirSync(designOutputDir, { recursive: true });
  fs.copyFileSync(selectedDesignSource, designOutputPath);
  const compiledManifest = compileDeckPlan(plan, { ...options, designSystemSource: "design-system/DESIGN.md" });
  const design = await parseDesignFile(selectedDesignSource);
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
      designOutputPath
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
