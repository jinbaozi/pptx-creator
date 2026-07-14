import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const created = [];
const hash = (character) => `sha256:${character.repeat(64)}`;

function run(plan, outputDir, { reviewPath = null, statePath = null } = {}) {
  return spawnSync(process.execPath, [
    "scripts/run-design-first-pipeline.mjs", plan, outputDir,
    ...(reviewPath ? ["--host-final-review", reviewPath] : []),
    ...(statePath ? ["--refinement-state", statePath] : [])
  ], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PPTX_CREATOR_PYTHON: "/opt/homebrew/bin/python3.12" },
    timeout: 90_000
  });
}

function review(packet, { verdict, elementId = null }) {
  return {
    version: "0.1.0", packetHash: packet.packetHash, artifacts: structuredClone(packet.artifacts),
    status: "completed", overallVerdict: verdict,
    perSlide: packet.pages.map((page, index) => ({
      slideId: page.slideId, screenshotPath: page.path, screenshotHash: page.hash,
      focus: "clear", hierarchy: "clear", thumbnailReadability: "pass", attentionTargetAlignment: "pass",
      findings: verdict === "reject" && index === 0 ? [{
        severity: "P2", type: "polish-spacing", reason: "Move the title to the measured alignment line.",
        evidence: [{ path: `${page.path}#${elementId}`, hash: page.hash }]
      }] : []
    })),
    deckRhythm: {
      rhythm: verdict === "accept" ? "coherent" : "uneven", consistency: "consistent",
      signatureMoment: "absent-appropriate", reason: verdict === "accept" ? "The corrected deck is coherent." : "The first title breaks the alignment rhythm."
    },
    summary: verdict === "accept" ? "The exact refined screenshots pass." : "Reject pending one measured spacing correction.",
    findings: []
  };
}

afterEach(async () => {
  while (created.length) await rm(created.pop(), { recursive: true, force: true });
});

describe("Creative refinement three-stage resume", () => {
  it("plans, applies one approved optical delta, invalidates review, then publishes after a new accepted review", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pptx-refinement-resume-"));
    created.push(workspace);
    const outputDir = join(workspace, "output");
    const planPath = "examples/text-input/calibration/clean.deck.plan.json";

    const initial = run(planPath, outputDir);
    expect(initial.status).not.toBe(0);
    const initialPacket = JSON.parse(await readFile(join(outputDir, "creative-proof", "final-review-packet.json"), "utf8"));
    const initialManifest = JSON.parse(await readFile(join(outputDir, "deck.manifest.json"), "utf8"));
    const firstSlide = initialManifest.slides[0];
    const target = firstSlide.elements.find((element) => element.type === "text");
    const rejectPath = join(workspace, "reject-review.json");
    await writeFile(rejectPath, `${JSON.stringify(review(initialPacket, { verdict: "reject", elementId: target.id }), null, 2)}\n`);

    const rejected = run(planPath, outputDir, { reviewPath: rejectPath });
    expect(rejected.status, rejected.stderr).not.toBe(0);
    expect(JSON.parse(await readFile(join(outputDir, "pipeline-blocked.json"), "utf8")).blockedBy).toBe("awaiting-refinement-approval");
    const dryRun = JSON.parse(await readFile(join(outputDir, "refinement-plan.json"), "utf8"));
    expect(dryRun).toMatchObject({ dryRun: true, attemptBudget: { used: 0, max: 3 }, pending: dryRun.operations[0].id });

    const operation = {
      ...dryRun.operations[0],
      delta: { kind: "optical", slideId: firstSlide.id, elementId: target.id, changes: { x: { before: target.x, after: target.x + 0.05, tolerance: 0.1 } } },
      rollback: { kind: "optical", slideId: firstSlide.id, elementId: target.id, changes: { x: { before: target.x + 0.05, after: target.x, tolerance: 0.1 } } },
      approval: { status: "approved", approvedBy: "Host", evidence: "Measured against the rejected screenshot." }
    };
    const state = {
      version: "0.1.0", baseRunHash: dryRun.sourceProof.semanticIr.hash, sourceProofHash: dryRun.sourceProof.proof.hash,
      approvedOperations: [], pendingApproval: operation, attemptBudget: { used: 0, max: 3 },
      bestIdentity: { semanticIrHash: dryRun.sourceProof.semanticIr.hash, manifestHash: dryRun.sourceProof.manifest.hash, pptxHash: dryRun.sourceProof.pptx.hash, vector: dryRun.best.vector },
      reviewBindings: [{ proofHash: dryRun.sourceProof.proof.hash, packetHash: dryRun.sourceProof.renderPacket.hash, reviewHash: dryRun.sourceProof.hostReview.hash }],
      signatureMoment: null,
      hostApproval: { status: "approved", approvedBy: "Host", approvedAt: "2026-07-14T00:00:00Z", operationId: operation.id }
    };
    const statePath = join(workspace, "creative-refinement-state.json");
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const applied = run(planPath, outputDir, { statePath });
    expect(applied.status, applied.stderr).not.toBe(0);
    expect(JSON.parse(await readFile(join(outputDir, "pipeline-blocked.json"), "utf8")).blockedBy).toBe("host-final-visual-review");
    const appliedProof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(appliedProof).toMatchObject({ accepted: false, refinement: { status: "applied", plan: { attemptBudget: { used: 1, max: 3 } } } });
    expect(appliedProof.identity.refinement.hash).toMatch(/^sha256:/);
    const refinedManifest = JSON.parse(await readFile(join(outputDir, "deck.manifest.json"), "utf8"));
    expect(refinedManifest.slides[0].elements.find((element) => element.id === target.id).x).toBe(target.x + 0.05);

    const refinedPacket = JSON.parse(await readFile(join(outputDir, "creative-proof", "final-review-packet.json"), "utf8"));
    expect(refinedPacket.packetHash).not.toBe(initialPacket.packetHash);
    const acceptPath = join(workspace, "accept-review.json");
    await writeFile(acceptPath, `${JSON.stringify(review(refinedPacket, { verdict: "accept" }), null, 2)}\n`);
    const accepted = run(planPath, outputDir, { statePath, reviewPath: acceptPath });
    const acceptedAttemptProof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(accepted.status, `${accepted.stderr}\n${JSON.stringify(acceptedAttemptProof.hostVisualReview)}\nold=${refinedPacket.packetHash}\nnew=${acceptedAttemptProof.hostVisualReview.packetHash}`).toBe(0);
    const finalProof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    const runIndex = JSON.parse(await readFile(join(outputDir, "run.json"), "utf8"));
    expect(finalProof).toMatchObject({ accepted: true, acceptance: { status: "accepted" }, refinement: { status: "applied", history: [{ comparison: 1, outcome: "accepted" }] } });
    expect(runIndex).toMatchObject({ status: "accepted", artifacts: { refinementPlan: "refinement-plan.json" } });
    expect(existsSync(join(outputDir, "final.pptx"))).toBe(true);
    const replayed = run(planPath, outputDir, { statePath, reviewPath: acceptPath });
    expect(replayed.status, replayed.stderr).toBe(0);
    const replayedProof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(replayedProof.refinement.plan.attemptBudget).toEqual({ used: 1, max: 3 });
    expect(replayedProof.refinement.history).toHaveLength(1);
  }, 300_000);
});
