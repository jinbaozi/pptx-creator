import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export function contentDerivedRunId(value) {
  const canonical = canonicalJson(value);
  if (canonical === undefined) throw new TypeError("run ID input must be JSON-serializable");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `run-${digest.slice(0, 24)}`;
}

export async function buildRunIndex(outputDir, options) {
  const root = resolve(outputDir);
  const artifacts = {
    deckPlan: await exists(root, "deck.plan.json"),
    semanticIr: await exists(root, "semantic-slide-ir.json"),
    manifest: await exists(root, "deck.manifest.json"),
    pptx: await exists(root, "final.pptx"),
    previews: await listFiles(root, "previews", ".png"),
    reviews: await listReviewFiles(root),
    consistencyReport: await exists(root, "consistency-report.json"),
    sources: await exists(root, "sources.json"),
    assetRegistry: await exists(root, join("assets", "asset-registry.json")),
    creativeCandidates: await exists(root, "creative-candidates.json"),
    creativeSelection: await exists(root, "creative-selection.json"),
    blindPacket: await exists(root, join("creative-direction-blind", "blind-packet.json")),
    creativeProof: await exists(root, "creative-proof.json"),
    creativeProofEvidence: await exists(root, "creative-proof"),
    hostVisualReview: await exists(root, "host-visual-review.json"),
    refinementPlan: await exists(root, "refinement-plan.json")
  };

  let accepted = false;
  if (artifacts.creativeProof && artifacts.hostVisualReview) {
    try {
      const proof = JSON.parse(await readFile(join(root, artifacts.creativeProof), "utf8"));
      accepted = proof.version === "0.2.0" && proof.accepted === true && proof.acceptance?.status === "accepted";
    } catch {}
  }

  return {
    runId: options.runId,
    mode: options.mode,
    status: accepted ? "accepted" : artifacts.pptx ? "ready-for-review" : "in-progress",
    input: options.input,
    artifacts,
    ...(options.metadata ? { metadata: structuredClone(options.metadata) } : {})
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? "null").join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalJson(value[key]);
      if (encoded !== undefined) entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
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
  const names = ["visual-review.json", "layout-safety-report.json", "text-fit-report.json", "consistency-report.json", "consistency-report.md"];
  const present = [];
  for (const name of names) {
    if (await exists(root, name)) present.push(name);
  }
  return present;
}

function normalize(path) {
  return path.split(sep).join("/");
}
