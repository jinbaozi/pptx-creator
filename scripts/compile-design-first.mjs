import fs from "node:fs";
import path from "node:path";
import { loadDesignFirstArtifacts } from "./lib/design-first-loader.mjs";
import { compileDesignFirstManifest } from "./lib/manifest-compiler.mjs";

function readOptionalJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function parseArgs(argv) {
  const [inputDir, outputPath, ...rest] = argv;
  if (!inputDir || !outputPath) {
    throw new Error("Usage: node scripts/compile-design-first.mjs <input-dir> <output-manifest> [--design-system path] [--design-system-name name]");
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const option = rest[i];
    if (!["--design-system", "--design-system-name"].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (option === "--design-system") options.designSystemSource = value;
    else options.designSystemName = value;
  }
  return { inputDir, outputPath, options };
}

const { inputDir, outputPath, options } = parseArgs(process.argv.slice(2));
const artifacts = loadDesignFirstArtifacts(inputDir);
const baseDir = path.resolve(inputDir);
options.uiSpec = readOptionalJson(path.join(baseDir, "ui-spec.json"));
options.componentSpecs = readOptionalJson(path.join(baseDir, "component-specs.json"));
const manifest = compileDesignFirstManifest(artifacts, options);
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
