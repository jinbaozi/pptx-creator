import { buildRunIndex, writeRunIndex } from "./lib/run-index.mjs";

const [, , outputDir = "output", runId = new Date().toISOString().slice(0, 10), mode = "creative", summary = "pptx-creator run"] = process.argv;

const run = await buildRunIndex(outputDir, {
  runId,
  mode,
  input: { type: "text", summary }
});
const path = await writeRunIndex(outputDir, run);

console.log(`wrote ${path}`);
