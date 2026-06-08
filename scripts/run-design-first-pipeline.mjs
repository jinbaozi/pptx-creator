import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadDesignFirstArtifacts } from "./lib/design-first-loader.mjs";
import { compileDesignFirstManifest } from "./lib/manifest-compiler.mjs";
import { reviewManifest } from "./lib/visual-critic.mjs";

function parseArgs(argv) {
  const [inputDir, outputDir, ...rest] = argv;
  if (!inputDir || !outputDir) {
    throw new Error("Usage: node scripts/run-design-first-pipeline.mjs <input-dir> <output-dir> [--design-system path] [--design-system-name name] [--mode creative|replica]");
  }
  const options = { mode: "creative" };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--design-system") options.designSystemSource = rest[++i];
    else if (rest[i] === "--design-system-name") options.designSystemName = rest[++i];
    else if (rest[i] === "--mode") options.mode = rest[++i];
  }
  return { inputDir, outputDir, options };
}

function runNodeScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status}`);
  }
}

const { inputDir, outputDir, options } = parseArgs(process.argv.slice(2));
fs.mkdirSync(outputDir, { recursive: true });

if (options.designSystemSource && !path.isAbsolute(options.designSystemSource)) {
  options.designSystemSource = path.resolve(options.designSystemSource);
}

const artifacts = loadDesignFirstArtifacts(inputDir);
const manifest = compileDesignFirstManifest(artifacts, options);
const manifestPath = path.join(outputDir, "deck.manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

runNodeScript("scripts/run-deck-pipeline.mjs", [manifestPath, outputDir]);

const review = reviewManifest(manifest, { mode: options.mode });
fs.writeFileSync(path.join(outputDir, "visual-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");

console.log(`Design-first pipeline complete: ${path.join(outputDir, "final.pptx")}`);
