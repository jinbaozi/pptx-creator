import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function countFiles(zip, prefix, suffix) {
  return Object.keys(zip.files).filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).length;
}

export async function inspectOpenXml(pptxPath, outputPath) {
  const resolvedPptx = resolve(pptxPath);
  const zip = await JSZip.loadAsync(await readFile(resolvedPptx));
  const requiredParts = REQUIRED_PARTS.map((name) => ({ name, present: Boolean(zip.files[name]) }));
  const slideCount = countFiles(zip, "ppt/slides/slide", ".xml");
  const layoutCount = countFiles(zip, "ppt/slideLayouts/slideLayout", ".xml");
  const masterCount = countFiles(zip, "ppt/slideMasters/slideMaster", ".xml");
  const issues = [];
  for (const part of requiredParts) {
    if (!part.present) issues.push(`missing required part: ${part.name}`);
  }
  if (slideCount === 0) issues.push("no slide XML parts found");
  const report = {
    version: "0.1.0",
    pptx: resolvedPptx,
    requiredParts,
    slideCount,
    layoutCount,
    masterCount,
    issues,
    status: issues.length === 0 ? "ok" : "repair-needed",
    repairActions: issues.length === 0 ? [] : ["Re-render from manifest or use PowerPoint/WPS repair dialog."]
  };
  if (outputPath) {
    await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  return report;
}

async function main() {
  const [, , pptxArg, outputArg] = process.argv;
  if (!pptxArg) fail("usage: openxml-repair.mjs <file.pptx> [openxml-repair-report.json]");
  const report = await inspectOpenXml(pptxArg, outputArg);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ok") process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
