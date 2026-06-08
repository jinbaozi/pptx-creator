import fs from "node:fs";
import path from "node:path";
import { reviewManifest } from "./lib/visual-critic.mjs";

const [manifestPath, outputPath, ...rest] = process.argv.slice(2);
if (!manifestPath || !outputPath) {
  throw new Error("Usage: node scripts/run-visual-critic.mjs <manifest> <output-json> [--mode creative|replica]");
}

let mode = "creative";
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--mode") mode = rest[++i];
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const review = reviewManifest(manifest, { mode });
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
