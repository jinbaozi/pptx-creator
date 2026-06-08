import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeVisionReview, runVisionReview } from "./lib/vision-review.mjs";

const args = process.argv.slice(2);
const outputDir = resolve(args[0] ?? "output");
const provider = valueAfter(args, "--provider") ?? "mock";

const previewDir = join(outputDir, "previews");
const previews = await listPreviewFiles(previewDir);

const result = await runVisionReview({
  screenshots: previews,
  manifest: null,
  provider,
  options: { outputDir }
});

const fileReview = {
  reviewer: result.reviewer,
  deckScore: result.deckScore,
  slides: result.slides,
  ...(result.metadata ? { metadata: result.metadata } : {})
};

await writeFile(join(outputDir, "vision-review.json"), `${JSON.stringify(normalizeVisionReview(fileReview), null, 2)}\n`);
console.log(`wrote ${join(outputDir, "vision-review.json")}`);

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function listPreviewFiles(previewDir) {
  try {
    return (await readdir(previewDir)).filter((name) => name.endsWith(".png")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
