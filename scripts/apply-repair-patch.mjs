import fs from "node:fs";
import path from "node:path";
import { applyRepairPatch } from "./lib/repair-patch.mjs";

const [manifestPath, patchPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !patchPath || !outputPath) {
  throw new Error("Usage: node scripts/apply-repair-patch.mjs <manifest> <repair.patch.json> <output-manifest>");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
const next = applyRepairPatch(manifest, patch);
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
