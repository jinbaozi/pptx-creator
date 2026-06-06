import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function countFiles(zip, prefix, suffix) {
  return Object.keys(zip.files).filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).length;
}

async function themeColors(zip) {
  const themeName = Object.keys(zip.files).find((name) => name.startsWith("ppt/theme/theme") && name.endsWith(".xml"));
  if (!themeName) return [];
  const xml = await zip.files[themeName].async("string");
  return [...xml.matchAll(/<a:srgbClr val="([0-9A-Fa-f]{6})"/g)].slice(0, 12).map((match) => `#${match[1].toUpperCase()}`);
}

export async function importTemplate(pptxPath, outputPath) {
  const resolvedPptx = resolve(pptxPath);
  const zip = await JSZip.loadAsync(await readFile(resolvedPptx));
  const summary = {
    version: "0.1.0",
    source: resolvedPptx,
    slideCount: countFiles(zip, "ppt/slides/slide", ".xml"),
    layoutCount: countFiles(zip, "ppt/slideLayouts/slideLayout", ".xml"),
    masterCount: countFiles(zip, "ppt/slideMasters/slideMaster", ".xml"),
    themeCount: countFiles(zip, "ppt/theme/theme", ".xml"),
    themeColors: await themeColors(zip),
    status: "ok",
    hostAgentTasks: [
      "Use themeColors as palette constraints when selecting or authoring DESIGN.md.",
      "Use layout/master counts to decide whether to preserve template structure or rebuild natively.",
      "Do not copy branded assets unless the user owns the template rights."
    ]
  };
  if (summary.masterCount === 0 || summary.layoutCount === 0) {
    summary.status = "review";
  }
  if (outputPath) {
    await writeFile(resolve(outputPath), JSON.stringify(summary, null, 2) + "\n", "utf8");
  }
  return summary;
}

async function main() {
  const [, , pptxArg, outputArg] = process.argv;
  if (!pptxArg) fail("usage: import-template.mjs <template.pptx> [template-summary.json]");
  const summary = await importTemplate(pptxArg, outputArg);
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
