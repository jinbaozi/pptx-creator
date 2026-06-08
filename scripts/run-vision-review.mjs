import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeVisionReview } from "./lib/vision-review.mjs";

const args = process.argv.slice(2);
const outputDir = resolve(args[0] ?? "output");
const provider = valueAfter(args, "--provider") ?? "mock";

const previewDir = join(outputDir, "previews");
const previews = (await readdir(previewDir)).filter((name) => name.endsWith(".png")).sort();

let review;
if (provider === "mock") {
  review = createMockReview(previews);
} else {
  throw new Error(`provider ${provider} is not configured in this CLI. Use --provider mock until a host agent supplies model integration.`);
}

await writeFile(join(outputDir, "vision-review.json"), `${JSON.stringify(normalizeVisionReview(review), null, 2)}\n`);
console.log(`wrote ${join(outputDir, "vision-review.json")}`);

function createMockReview(previews) {
  return {
    reviewer: {
      type: "vision-model",
      provider: "mock",
      model: "mock-vlm",
      createdAt: new Date().toISOString()
    },
    deckScore: 80,
    slides: previews.map((preview, index) => ({
      slideId: preview.replace(/\.png$/, ""),
      score: 80,
      findings: [
        {
          id: `mock-${index + 1}`,
          severity: "info",
          category: "polish",
          message: "Mock review completed for screenshot-level review plumbing."
        }
      ]
    }))
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}
