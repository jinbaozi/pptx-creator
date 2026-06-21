import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export async function buildRunIndex(outputDir, options) {
  const root = resolve(outputDir);
  const artifacts = {
    storyboard: await exists(root, "deck.storyboard.json"),
    designDirection: await exists(root, "deck.design-direction.json"),
    slideDesignSpecs: await exists(root, "slide-design-specs.json"),
    manifest: await exists(root, "deck.manifest.json"),
    pptx: await exists(root, "final.pptx"),
    previews: await listFiles(root, "previews", ".png"),
    reviews: await listReviewFiles(root),
    consistencyReport: await exists(root, "consistency-report.json"),
    sources: await exists(root, "sources.json"),
    assetRegistry: await exists(root, join("assets", "asset-registry.json"))
  };

  return {
    runId: options.runId,
    mode: options.mode,
    status: artifacts.pptx ? "ready-for-review" : "in-progress",
    input: options.input,
    artifacts,
    directions: await listDirections(root)
  };
}

export async function writeRunIndex(outputDir, run) {
  const path = join(resolve(outputDir), "run.json");
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

async function exists(root, path) {
  try {
    await stat(join(root, path));
    return normalize(path);
  } catch {
    return null;
  }
}

async function listFiles(root, folder, extension) {
  try {
    const entries = await readdir(join(root, folder));
    return entries
      .filter((name) => name.endsWith(extension))
      .sort()
      .map((name) => normalize(join(folder, name)));
  } catch {
    return [];
  }
}

async function listReviewFiles(root) {
  const names = ["visual-review.json", "vision-review.json", "merged-review.json", "layout-safety-report.json", "consistency-report.json", "consistency-report.md"];
  const present = [];
  for (const name of names) {
    if (await exists(root, name)) present.push(name);
  }
  return present;
}

async function listDirections(root) {
  try {
    const dirs = await readdir(join(root, "directions"), { withFileTypes: true });
    const results = [];
    for (const dir of dirs.filter((entry) => entry.isDirectory())) {
      const scorePath = join(root, "directions", dir.name, "scorecard.json");
      let score = null;
      let status = "candidate";
      try {
        const scorecard = JSON.parse(await readFile(scorePath, "utf8"));
        score = scorecard.total;
        status = scorecard.recommendation === "approve" ? "approved" : "candidate";
      } catch {}
      results.push({
        id: dir.name,
        label: dir.name,
        status,
        score,
        path: normalize(join("directions", dir.name, "direction.json"))
      });
    }
    return results.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function normalize(path) {
  return path.split(sep).join("/");
}
