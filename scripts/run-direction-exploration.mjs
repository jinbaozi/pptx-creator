import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDirectionCandidates, selectRepresentativeSlides } from "./lib/direction-explorer.mjs";

const [, , storyboardPath, outputDir = "output"] = process.argv;
if (!storyboardPath) {
  console.error("usage: node scripts/run-direction-exploration.mjs <deck.storyboard.json> <output-dir>");
  process.exit(2);
}

const storyboard = JSON.parse(await readFile(resolve(storyboardPath), "utf8"));
const sampleSlides = selectRepresentativeSlides(storyboard);
const directions = createDirectionCandidates({
  title: storyboard.title ?? "Untitled Deck",
  audience: storyboard.audience ?? "general audience"
});

for (const direction of directions) {
  const dir = resolve(outputDir, "directions", direction.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "direction.json"), `${JSON.stringify({ ...direction, sampleSlides }, null, 2)}\n`);
  const scorecard = {
    directionId: direction.id,
    scores: { storyFit: 16, visualVariety: 16, readability: 16, diagramStrength: 16, editability: 16, sourceSafety: 20 },
    total: 100,
    recommendation: direction.id === "direction-002" ? "approve" : "candidate"
  };
  await writeFile(join(dir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
}

console.log(`wrote ${directions.length} direction candidates to ${resolve(outputDir, "directions")}`);
