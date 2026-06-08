import fs from "node:fs";
import path from "node:path";
import { loadDesignFirstArtifacts } from "./lib/design-first-loader.mjs";
import { compileDesignFirstManifest } from "./lib/manifest-compiler.mjs";

function parseArgs(argv) {
  const [inputDir, outputPath, ...rest] = argv;
  if (!inputDir || !outputPath) {
    throw new Error("Usage: node scripts/compile-design-first.mjs <input-dir> <output-manifest> [--design-system path] [--design-system-name name]");
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--design-system") options.designSystemSource = rest[++i];
    else if (rest[i] === "--design-system-name") options.designSystemName = rest[++i];
    else if (rest[i] === "--design-system-mode") options.designSystemMode = rest[++i];
  }
  return { inputDir, outputPath, options };
}

const { inputDir, outputPath, options } = parseArgs(process.argv.slice(2));
const artifacts = loadDesignFirstArtifacts(inputDir);
const manifest = compileDesignFirstManifest(artifacts, options);
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
