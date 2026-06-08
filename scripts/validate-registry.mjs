import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeRegistry, validateAssetRegistry, validateSourceRegistry } from "./lib/registry.mjs";

const [, , sourcePath = "sources.json", assetPath = "assets/asset-registry.json"] = process.argv;

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

const sources = await readJson(sourcePath);
const assets = await readJson(assetPath);
const sourceResult = validateSourceRegistry(sources);
const assetResult = validateAssetRegistry(assets);
const summary = summarizeRegistry({ sources, assets });
const output = {
  valid: sourceResult.valid && assetResult.valid,
  summary,
  issues: [...sourceResult.issues, ...assetResult.issues]
};

console.log(JSON.stringify(output, null, 2));

if (!output.valid) process.exit(1);
