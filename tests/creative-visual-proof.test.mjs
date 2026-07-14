import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildFinalReviewPacket,
  evaluateCreativeVisualProof,
  validateHostVisualReview
} from "../scripts/lib/creative-visual-proof.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;

function identity(purpose = "final-deck") {
  return {
    purpose,
    semanticIr: { path: "semantic-slide-ir.json", hash: hash("1") },
    manifest: { path: "deck.manifest.json", hash: hash("2") },
    pptx: { path: purpose === "direction-probe" ? "creative-proof/candidate.pptx" : "final.pptx", hash: hash("3") },
    designTokens: { path: "design-system/DESIGN.md", hash: hash("4") },
    assetRegistry: { path: "assets/asset-registry.json", hash: hash("5") },
    selection: null,
    refinement: null
  };
}

function rendering() {
  return {
    status: "passed",
    environment: {
      renderer: "libreoffice",
      suite: "libreoffice",
      platform: "darwin",
      architecture: "arm64",
      libreOfficeVersion: "LibreOffice 25.2",
      pythonVersion: "3.12.10",
      commandIdentity: "libreoffice-headless-pdf+pdftoppm-png-96dpi",
      settings: { dpi: 96, colorMode: "RGB", timestampFree: true }
    },
    expectedPageCount: 2,
    renderedPageCount: 2,
    pages: [
      { slideId: "slide-1", index: 0, path: "creative-proof/slides/slide-1.png", hash: hash("6"), width: 1280, height: 720 },
      { slideId: "slide-2", index: 1, path: "creative-proof/slides/slide-2.png", hash: hash("7"), width: 1280, height: 720 }
    ],
    contactSheet: {
      path: "creative-proof/slides/contact-sheet.png",
      hash: hash("8"),
      width: 1488,
      height: 890,
      slideIds: ["slide-1", "slide-2"],
      slideHashes: [hash("6"), hash("7")]
    },
    renderReport: { path: "creative-proof/render-report.json", hash: hash("9") }
  };
}

const tokenLedger = {
  version: "0.1.0",
  status: "passed",
  expectedSnapshotHash: hash("4"),
  actualSnapshotHash: hash("4"),
  designSystem: { name: "Test", source: "design-system/DESIGN.md" },
  protectedTokens: [],
  drift: [],
  lineage: "snapshot-only"
};

const assetLedger = { version: "0.1.0", status: "passed", assets: [], drift: [] };

const diagnostics = {
  thumbnailReadability: { status: "passed", checkedSlides: 2, failures: [] },
  antiSlop: { status: "passed", risk: 4, findings: [] },
  nativeCoverage: { status: "passed", editabilityLevel: 5, nativeObjects: 18, rasterObjects: 0 },
  rhythm: { status: "passed", topologyRuns: [], densityRuns: [] },
  quality: { status: "passed", deckScore: 92, slideFloor: 86 },
  visualCritic: { status: "passed", findings: [] }
};

const selection = { status: "not-applicable", reason: "direction exploration did not occur" };
const suites = [
  { suite: "libreoffice", required: true, status: "passed", environment: "LibreOffice 25.2", artifacts: ["creative-proof/render-report.json"], reason: "full render completed" },
  { suite: "powerpoint", required: false, status: "unavailable", environment: null, artifacts: [], reason: "not installed in this environment" }
];
const repair = { attempts: 0, stopReason: "not-run", history: [] };
const refinement = { status: "not-applicable", plan: null, history: [] };
const hardGateInputs = { schema: true, textFit: true, layoutSafety: true, editability: true, visualCritic: true };

function completedReview(packet, verdict = "accept") {
  return {
    version: "0.1.0",
    packetHash: packet.packetHash,
    artifacts: structuredClone(packet.artifacts),
    status: "completed",
    overallVerdict: verdict,
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
      reason: "The hierarchy and pacing remain coherent across the full deck."
    },
    summary: verdict === "accept"
      ? "Every slide has a clear focus and the deck reads coherently at thumbnail scale."
      : "The deck remains visually inconsistent despite deterministic gates passing.",
    findings: verdict === "accept" ? [] : [{
      severity: "P1",
      type: "deck-inconsistency",
      reason: "The selected visual rhythm breaks between the two content sections.",
      evidence: [{ path: packet.contactSheet.path, hash: packet.contactSheet.hash }]
    }]
  };
}

function proofInput(review = null, overrides = {}) {
  const proofIdentity = overrides.identity ?? identity();
  const proofRendering = overrides.rendering ?? rendering();
  const packet = buildFinalReviewPacket({ identity: proofIdentity, rendering: proofRendering });
  return {
    identity: proofIdentity,
    rendering: proofRendering,
    tokenLedger: overrides.tokenLedger ?? tokenLedger,
    assetLedger: overrides.assetLedger ?? assetLedger,
    diagnostics: overrides.diagnostics ?? diagnostics,
    hostReview: { packet, review },
    selection: overrides.selection ?? selection,
    suites: overrides.suites ?? suites,
    repair: overrides.repair ?? repair,
    refinement: overrides.refinement ?? refinement,
    findings: overrides.findings ?? [],
    hardGateInputs: overrides.hardGateInputs ?? hardGateInputs
  };
}

describe("Creative Visual Proof 0.2", () => {
  it("blocks perfect deterministic evidence until a completed Host review exists", () => {
    const proof = evaluateCreativeVisualProof(proofInput());
    expect(proof).toMatchObject({
      version: "0.2.0",
      accepted: false,
      acceptance: { status: "awaiting-host-review" },
      hostVisualReview: { status: "missing" }
    });
    expect(proof.hardGates.find((gate) => gate.id === "final-host-review")).toMatchObject({ status: "unavailable", required: true });
  });

  it("accepts only a complete packet-bound Host review and validates the closed schema", () => {
    const input = proofInput();
    input.hostReview.review = completedReview(input.hostReview.packet);
    const proof = evaluateCreativeVisualProof(input);
    expect(proof.accepted).toBe(true);
    expect(proof.acceptance).toEqual({ status: "accepted", reasons: [] });
    expect(proof.hostVisualReview).toMatchObject({ status: "completed", overallVerdict: "accept" });
    const schema = JSON.parse(readFileSync("schemas/creative-proof.schema.json", "utf8"));
    expect(validateJsonSchema(proof, schema)).toEqual({ valid: true, errors: [] });
    const forged = { ...proof, accepted: false };
    expect(validateJsonSchema(forged, schema).valid).toBe(true);
    expect(evaluateCreativeVisualProof({ ...input, claimedAccepted: false }).accepted).toBe(true);
  });

  it("rejects stale, duplicate, incomplete, or unavailable Host screenshot review", () => {
    const input = proofInput();
    const review = completedReview(input.hostReview.packet);
    expect(validateHostVisualReview({ packet: input.hostReview.packet, review })).toMatchObject({ valid: true, status: "completed", accepted: true });
    expect(validateHostVisualReview({ packet: input.hostReview.packet, review: { ...review, packetHash: hash("0") } }).valid).toBe(false);
    expect(validateHostVisualReview({ packet: input.hostReview.packet, review: { ...review, perSlide: [review.perSlide[0], review.perSlide[0]] } }).valid).toBe(false);
    expect(validateHostVisualReview({ packet: input.hostReview.packet, review: { ...review, perSlide: review.perSlide.slice(0, 1) } }).valid).toBe(false);
    expect(validateHostVisualReview({ packet: input.hostReview.packet, review: { ...review, status: "unavailable", overallVerdict: "unavailable" } }).accepted).toBe(false);
    const staleScreenshot = structuredClone(review);
    staleScreenshot.perSlide[0].screenshotHash = hash("a");
    expect(validateHostVisualReview({ packet: input.hostReview.packet, review: staleScreenshot }).valid).toBe(false);
  });

  it("never lets diagnostics override a Host reject or a P0/P1 finding", () => {
    const input = proofInput();
    input.hostReview.review = completedReview(input.hostReview.packet, "reject");
    const proof = evaluateCreativeVisualProof(input);
    expect(proof.accepted).toBe(false);
    expect(proof.acceptance.status).toBe("blocked");
    expect(proof.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "P1", type: "deck-inconsistency" })]));
  });

  it("blocks token, asset, rendering, selection, and required-suite drift independently", () => {
    const cases = [
      { tokenLedger: { ...tokenLedger, status: "failed", actualSnapshotHash: hash("f"), drift: [{ field: "tokenSnapshotHash", expected: hash("4"), actual: hash("f") }] } },
      { assetLedger: { ...assetLedger, status: "failed", drift: [{ assetId: "hero", field: "contentHash", expected: hash("1"), actual: hash("2") }] } },
      { rendering: { ...rendering(), renderedPageCount: 1 } },
      { selection: { status: "invalid", reason: "selection hash is stale" } },
      { suites: [{ ...suites[0], status: "unavailable", reason: "LibreOffice missing" }] }
    ];
    for (const override of cases) {
      const input = proofInput(null, override);
      input.hostReview.review = completedReview(input.hostReview.packet);
      expect(evaluateCreativeVisualProof(input).accepted, JSON.stringify(override)).toBe(false);
    }
  });

  it("treats optional unavailable suites as capability notes and probe proof as evidence-only", () => {
    const input = proofInput();
    input.hostReview.review = completedReview(input.hostReview.packet);
    expect(evaluateCreativeVisualProof(input).accepted).toBe(true);

    const probeInput = proofInput(null, { identity: identity("direction-probe") });
    const probe = evaluateCreativeVisualProof(probeInput);
    expect(probe.accepted).toBe(false);
    expect(probe.acceptance.status).toBe("evidence-ready");
    expect(probe.hardGates.find((gate) => gate.id === "final-host-review")).toMatchObject({ required: false, status: "not-applicable" });
  });
});
