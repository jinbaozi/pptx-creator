import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const created = [];

function run(plan, outputDir, reviewPath = null) {
  return spawnSync(process.execPath, [
    "scripts/run-design-first-pipeline.mjs",
    plan,
    outputDir,
    ...(reviewPath ? ["--host-final-review", reviewPath] : [])
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PPTX_CREATOR_PYTHON: "/opt/homebrew/bin/python3.12" },
    timeout: 60_000
  });
}

function acceptedReview(packet) {
  return {
    version: "0.1.0",
    packetHash: packet.packetHash,
    artifacts: structuredClone(packet.artifacts),
    status: "completed",
    overallVerdict: "accept",
    perSlide: packet.pages.map((page) => ({
      slideId: page.slideId,
      screenshotPath: page.path,
      screenshotHash: page.hash,
      focus: "clear",
      hierarchy: "clear",
      thumbnailReadability: "pass",
      attentionTargetAlignment: "pass",
      findings: []
    })),
    deckRhythm: {
      rhythm: "coherent",
      consistency: "consistent",
      signatureMoment: "restrained",
      reason: "The full-deck contact sheet and every full-size slide form a coherent, restrained sequence."
    },
    summary: "All rendered slides pass final visual review against the packet-bound evidence.",
    findings: []
  };
}

afterEach(async () => {
  while (created.length) await rm(created.pop(), { recursive: true, force: true });
});

describe("Creative Proof 0.2 final Host review resume", () => {
  it("withholds deliverables, resumes against exact evidence, and publishes only an accepted run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pptx-final-review-"));
    created.push(workspace);
    const outputDir = join(workspace, "output");
    const plan = "examples/text-input/calibration/clean.deck.plan.json";
    const first = run(plan, outputDir);
    expect(first.status, first.stderr).not.toBe(0);
    const blocked = JSON.parse(await readFile(join(outputDir, "pipeline-blocked.json"), "utf8"));
    expect(blocked.blockedBy).toBe("host-final-visual-review");
    expect(existsSync(join(outputDir, "creative-proof", "candidate", "final.pptx"))).toBe(true);
    for (const name of ["final.pptx", "run.json", "output-manifest.json"]) expect(existsSync(join(outputDir, name))).toBe(false);

    const packet = JSON.parse(await readFile(join(outputDir, "creative-proof", "final-review-packet.json"), "utf8"));
    const reviewPath = join(workspace, "creative-final-review.json");
    await writeFile(reviewPath, `${JSON.stringify(acceptedReview(packet), null, 2)}\n`, "utf8");
    const resumed = run(plan, outputDir, reviewPath);
    const resumedProof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(resumed.status, `${resumed.stderr}\n${JSON.stringify(resumedProof.hostVisualReview)}\n${JSON.stringify(resumedProof.acceptance)}\nold=${JSON.stringify(packet.artifacts)}\nnew=${JSON.stringify(resumedProof.identity)}\nrender=${JSON.stringify(resumedProof.rendering.renderReport)}\ncontact=${JSON.stringify(resumedProof.rendering.contactSheet.hash)}`).toBe(0);

    const proof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    const runIndex = JSON.parse(await readFile(join(outputDir, "run.json"), "utf8"));
    const outputManifest = JSON.parse(await readFile(join(outputDir, "output-manifest.json"), "utf8"));
    expect(proof).toMatchObject({ version: "0.2.0", accepted: true, acceptance: { status: "accepted", reasons: [] }, hostVisualReview: { status: "completed" } });
    expect(runIndex).toMatchObject({ status: "accepted", artifacts: { creativeProof: "creative-proof.json", creativeProofEvidence: "creative-proof", hostVisualReview: "host-visual-review.json" } });
    expect(outputManifest.files).toEqual(expect.arrayContaining(["final.pptx", "creative-proof.json", "creative-proof", "host-visual-review.json", "run.json"]));
  }, 120_000);
});
