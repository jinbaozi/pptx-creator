#!/usr/bin/env node
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyRepairPatch } from "./lib/repair-patch.mjs";
import { runPython } from "./lib/python-utils.mjs";
import { validateJsonSchema } from "./lib/schema-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} invalid JSON: ${error.message}`);
  }
}

async function validateManifest(path, label) {
  try {
    await runPython([join(root, "scripts/validate-manifest.py"), path], { cwd: root });
  } catch (error) {
    const detail = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`${label} invalid: ${detail}`);
  }
}

export async function runManifestRepair(manifestPath, patchPath, outputPath) {
  const input = resolve(manifestPath);
  const patchFile = resolve(patchPath);
  const output = resolve(outputPath);
  await validateManifest(input, "input manifest");

  const patch = await readJson(patchFile, "repair patch");
  const schema = await readJson(join(root, "schemas/repair-patch.schema.json"), "repair patch schema");
  const validation = validateJsonSchema(patch, schema);
  if (!validation.valid) {
    throw new Error(`repair patch invalid: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
  }

  const manifest = await readJson(input, "input manifest");
  const repaired = applyRepairPatch(manifest, patch);
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${process.pid}-${Date.now()}-${output.split(/[\\/]/).at(-1)}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");
    await validateManifest(temporary, "output manifest");
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

async function main() {
  const [manifestPath, patchPath, outputPath, ...extra] = process.argv.slice(2);
  if (!manifestPath || !patchPath || !outputPath || extra.length) {
    throw new Error("usage: run-manifest-repair.mjs <deck.manifest.json> <repair-patch.json> <repaired.manifest.json>");
  }
  const output = await runManifestRepair(manifestPath, patchPath, outputPath);
  console.log(`Wrote ${output}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
