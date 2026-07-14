import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  advanceRefinementState,
  applyApprovedRefinement,
  compareRefinementProof,
  materializeRefinementDryRun,
  replayApprovedRefinements,
  refinementVector,
  routeRefinementFindings,
  validateRefinementPlan,
  validateRefinementState
} from "../scripts/lib/creative-refinement.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import { proofContentHash } from "../scripts/lib/creative-visual-proof.mjs";

const hash = (char) => `sha256:${char.repeat(64)}`;

function proof(overrides = {}) {
  return {
    version: "0.2.0",
    accepted: false,
    acceptance: { status: "blocked", reasons: ["Host rejected"] },
    identity: {
      purpose: "final-deck",
      semanticIr: { path: "semantic-slide-ir.json", hash: hash("1") },
      manifest: { path: "deck.manifest.json", hash: hash("2") },
      pptx: { path: "creative-proof/candidate/final.pptx", hash: hash("3") },
      designTokens: { path: "design-system/DESIGN.md", hash: hash("4") },
      assetRegistry: { path: "assets/asset-registry.json", hash: hash("5") },
      selection: null,
      refinement: null
    },
    rendering: { packetHash: hash("6") },
    hostVisualReview: { status: "completed", accepted: false, reviewHash: hash("7") },
    hardGates: [], suites: [], findings: [],
    tokenLedger: { status: "passed", drift: [] }, assetLedger: { status: "passed", drift: [] },
    diagnostics: { antiSlop: { risk: 10 }, quality: { deckScore: 80 }, nativeCoverage: { editabilityLevel: 4 } },
    ...overrides
  };
}

function finding(type, extra = {}) {
  return {
    severity: "P2", source: "host-visual-review", type,
    message: `${type} evidence`, slideId: "s1",
    evidence: ["creative-proof/slides/slide-1.png#title"], ...extra
  };
}

function context(extra = {}) {
  return {
    sourceProofPath: "creative-proof.json",
    attemptBudget: { used: 0, max: 3 },
    brandLocked: false,
    manifest: { slides: [{ id: "s1", elements: [{ id: "title", type: "text", x: 1, y: 1, w: 4, h: 1, style: { fontSize: 20 } }] }] },
    ir: { slides: [{ id: "s1", nodes: [{ id: "title", kind: "text", payload: { text: "Old" } }] }] },
    ...extra
  };
}

describe("evidence-led creative refinement routing", () => {
  const cases = [
    ["typeset-overflow", "typeset", "manifest"],
    ["typeset-copy", "typeset", "ir"],
    ["layout-alignment", "layout", "manifest"],
    ["layout-topology", "layout", "ir"],
    ["colorize-palette", "colorize", "ir"],
    ["bolder-hierarchy", "bolder", "ir"],
    ["quieter-density", "quieter", "ir"],
    ["distill-copy", "distill", "ir"],
    ["harden-contrast", "harden", "manifest"],
    ["harden-alt", "harden", "ir"],
    ["polish-spacing", "polish", "manifest"],
    ["overdrive-signature", "overdrive", "ir"]
  ];
  it.each(cases)("routes %s to %s/%s without inventing a delta", (type, command, targetLayer) => {
    const plan = routeRefinementFindings(proof({ findings: [finding(type)] }), context());
    expect(plan.operations[0]).toMatchObject({ command, targetLayer, approval: { status: "required" } });
    expect(plan.operations[0].delta).toBeNull();
    expect(plan.pending).toBe(plan.operations[0].id);
    expect(validateRefinementPlan(plan, context()).valid).toBe(true);
  });

  it("does not route missing Host review or unsupported findings", () => {
    expect(routeRefinementFindings(proof({ hostVisualReview: { status: "missing", accepted: false }, findings: [finding("polish-spacing")] }), context()).status).toBe("awaiting-host-review");
    const plan = routeRefinementFindings(proof({ findings: [finding("mystery-aesthetic")] }), context());
    expect(plan).toMatchObject({ status: "blocked", operations: [], pending: null });
  });

  it("suppresses generic taste under brand lock but retains hard readability", () => {
    const plan = routeRefinementFindings(proof({ findings: [finding("bolder-hierarchy"), finding("typeset-overflow")] }), context({ brandLocked: true }));
    expect(plan.operations.map((op) => op.command)).toEqual(["typeset"]);
  });

  it("requires Host-authored semantic replacement and rejects a second overdrive", () => {
    const plan = routeRefinementFindings(proof({ findings: [finding("distill-copy")] }), context());
    const semanticPath = ["slides", "s1", "nodes", "title", "payload", "text"];
    const op = { ...plan.operations[0], delta: { kind: "semantic", path: semanticPath, before: "Old", after: "Short" }, rollback: { kind: "semantic", path: semanticPath, before: "Short", after: "Old" }, provenance: { source: "host", author: "Host", hostAuthored: true }, approval: { status: "approved", approvedBy: "Host", evidence: "copy supplied" } };
    const state = stateFor(op);
    expect(applyApprovedRefinement({ state, ir: context().ir, manifest: context().manifest, design: {}, registry: {} }).ir.slides[0].nodes[0].payload.text).toBe("Short");
    expect(() => applyApprovedRefinement({ state: stateFor({ ...op, command: "overdrive" }, { signatureMoment: { operationId: "old", slideId: "s1", nodeId: "title", kind: "signature", evidence: "review" } }), ir: context().ir, manifest: context().manifest, design: {}, registry: {} })).toThrow(/signature moment/i);
    const existing = routeRefinementFindings(proof({ hostVisualReview: { status: "completed", accepted: false, reviewHash: hash("7"), signatureMoment: "restrained" }, findings: [finding("overdrive-signature")] }), context());
    expect(existing.operations).toEqual([]);
  });

  it("routes and applies evidence-bound deck-level design intent without coordinates", () => {
    const deckFinding = finding("colorize-palette", { slideId: undefined, evidence: ["creative-proof/slides/contact-sheet.png#palette"] });
    const source = context({ ir: { designIntent: { palette: "neutral" }, slides: context().ir.slides } });
    const routed = routeRefinementFindings(proof({ findings: [deckFinding] }), source).operations[0];
    expect(routed.scope).toEqual({ kind: "deck" });
    const path = ["designIntent", "palette"];
    const operation = { ...routed, delta: { kind: "semantic", path, before: "neutral", after: "high-contrast" }, rollback: { kind: "semantic", path, before: "high-contrast", after: "neutral" }, provenance: { source: "host", author: "Host", hostAuthored: true }, approval: { status: "approved", approvedBy: "Host", evidence: "palette supplied" } };
    expect(applyApprovedRefinement({ state: stateFor(operation), ir: source.ir, manifest: source.manifest, design: {}, registry: {} }).ir.designIntent.palette).toBe("high-contrast");
  });
});

function stateFor(operation, overrides = {}) {
  return {
    version: "0.1.0", baseRunHash: hash("a"), sourceProofHash: hash("b"),
    approvedOperations: [], pendingApproval: operation,
    attemptBudget: { used: 0, max: 3 },
    bestIdentity: { semanticIrHash: hash("1"), manifestHash: hash("2"), pptxHash: hash("3"), vector: [0, 0, 0, 0, 0, 0, 10, -80] },
    reviewBindings: [{ proofHash: hash("b"), packetHash: hash("6"), reviewHash: hash("7") }],
    signatureMoment: null,
    hostApproval: { status: "approved", approvedBy: "Host", approvedAt: "2026-07-14T00:00:00Z", operationId: operation.id },
    ...overrides
  };
}

describe("refinement contracts, materialization, comparison, and state", () => {
  it("publishes standalone closed plan and protected-state schemas", async () => {
    const planSchema = JSON.parse(await readFile(new URL("../schemas/refinement-plan.schema.json", import.meta.url), "utf8"));
    const stateSchema = JSON.parse(await readFile(new URL("../schemas/refinement-state.schema.json", import.meta.url), "utf8"));
    const plan = routeRefinementFindings(proof({ findings: [finding("polish-spacing")] }), context());
    expect(validateJsonSchema(plan, planSchema)).toEqual({ valid: true, errors: [] });
    const operation = { ...plan.operations[0], delta: { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1, after: 1.1, tolerance: 0.2 } } }, rollback: { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1.1, after: 1, tolerance: 0.2 } } }, approval: { status: "approved", approvedBy: "Host", evidence: "x" } };
    expect(validateJsonSchema(stateFor(operation), stateSchema)).toEqual({ valid: true, errors: [] });
    expect(validateJsonSchema({ ...plan, unexpected: true }, planSchema).valid).toBe(false);
    expect(validateJsonSchema({ ...stateFor(operation), unexpected: true }, stateSchema).valid).toBe(false);
    for (const delta of [
      { kind: "optical", slideId: "s1", elementId: "title", changes: { text: { before: "a", after: "b", tolerance: 0 } } },
      { kind: "optical", slideId: "s1", elementId: "title", changes: { style: { before: {}, after: {}, tolerance: 0 } } },
      { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1, after: 2, tolerance: 0 } }, removeElement: true },
      { kind: "semantic", path: ["slides", "s1", "x"], before: 1, after: 2 }
    ]) {
      const invalid = structuredClone(plan);
      invalid.operations[0].delta = delta;
      expect(validateJsonSchema(invalid, planSchema).valid).toBe(false);
    }
  });

  it("keeps dry-run non-mutating and accepts only closed reversible optical deltas", () => {
    const source = context();
    const plan = routeRefinementFindings(proof({ findings: [finding("polish-spacing")] }), source);
    const before = JSON.stringify(source.manifest);
    const preview = materializeRefinementDryRun({ plan, ir: source.ir, manifest: source.manifest, design: {} });
    expect(preview).toMatchObject({ dryRun: true, mutated: false });
    expect(JSON.stringify(source.manifest)).toBe(before);
    const operation = {
      ...plan.operations[0],
      delta: { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1, after: 1.1, tolerance: 0.25 } } },
      rollback: { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1.1, after: 1, tolerance: 0.25 } } },
      approval: { status: "approved", approvedBy: "Host", evidence: "aligned to screenshot" }
    };
    const result = applyApprovedRefinement({ state: stateFor(operation), ir: source.ir, manifest: source.manifest, design: {}, registry: {} });
    expect(result.manifest.slides[0].elements[0].x).toBe(1.1);
    expect(result.ir).toEqual(source.ir);
    expect(result.reviewInvalidated).toBe(true);
  });

  it("rejects manifest text/removal/style maps and IR coordinates", () => {
    const base = routeRefinementFindings(proof({ findings: [finding("polish-spacing")] }), context()).operations[0];
    for (const delta of [
      { kind: "optical", slideId: "s1", elementId: "title", changes: { text: { before: "a", after: "b", tolerance: 0 } } },
      { kind: "optical", slideId: "s1", elementId: "title", removeElement: true, changes: {} },
      { kind: "optical", slideId: "s1", elementId: "title", changes: { style: { before: {}, after: {}, tolerance: 0 } } },
      { kind: "semantic", path: ["slides", "s1", "x"], before: 1, after: 2 }
    ]) expect(() => applyApprovedRefinement({ state: stateFor({ ...base, delta, approval: { status: "approved", approvedBy: "Host", evidence: "x" } }), ir: context().ir, manifest: context().manifest, design: {}, registry: {} })).toThrow();
  });

  it("validates protected state, stale proof, approval, and shared budget", () => {
    const routed = routeRefinementFindings(proof({ findings: [finding("polish-spacing")] }), context()).operations[0];
    const op = { ...routed, delta: { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1, after: 1.1, tolerance: 0.2 } } }, rollback: { kind: "optical", slideId: "s1", elementId: "title", changes: { x: { before: 1.1, after: 1, tolerance: 0.2 } } }, approval: { status: "approved", approvedBy: "Host", evidence: "x" } };
    expect(validateRefinementState(stateFor(op), { sourceProofHash: hash("b") }).valid).toBe(true);
    expect(validateRefinementState(stateFor(op), { sourceProofHash: hash("c") }).valid).toBe(false);
    expect(() => applyApprovedRefinement({ state: stateFor({ ...op, approval: { status: "required" } }), ir: context().ir, manifest: context().manifest, design: {}, registry: {} })).toThrow(/approval/i);
    expect(() => applyApprovedRefinement({ state: stateFor({ ...op, approval: { status: "approved", approvedBy: "Host", evidence: "x" } }, { attemptBudget: { used: 3, max: 3 } }), ir: context().ir, manifest: context().manifest, design: {}, registry: {} })).toThrow(/budget/i);
  });

  it("uses severity-first vector, editability guard, and equal-accept semantics", () => {
    const best = proof();
    const severe = proof({ findings: [finding("x", { severity: "P1" })] });
    expect(refinementVector(severe)[1]).toBe(1);
    expect(compareRefinementProof(severe, best)).toBe(-1);
    const regressed = proof({ diagnostics: { ...best.diagnostics, nativeCoverage: { editabilityLevel: 3 } } });
    expect(compareRefinementProof(regressed, best)).toBe(-1);
    expect(compareRefinementProof(proof({ accepted: true, acceptance: { status: "accepted", reasons: [] }, hostVisualReview: { status: "completed", accepted: true, reviewHash: hash("8") } }), best)).toBe(1);
    expect(compareRefinementProof(best, best)).toBe(0);
  });

  it("replays an IR operation from the hash-bound base through the supplied canonical compiler", async () => {
    const source = context();
    const semanticPath = ["slides", "s1", "nodes", "title", "payload", "text"];
    const routed = routeRefinementFindings(proof({ findings: [finding("distill-copy")] }), source).operations[0];
    const operation = {
      ...routed,
      delta: { kind: "semantic", path: semanticPath, before: "Old", after: "Short" },
      rollback: { kind: "semantic", path: semanticPath, before: "Short", after: "Old" },
      provenance: { source: "host", author: "Host", hostAuthored: true },
      approval: { status: "approved", approvedBy: "Host", evidence: "copy supplied" }
    };
    const state = stateFor(operation, { baseRunHash: proofContentHash(source.ir) });
    let compiled = 0;
    const replay = await replayApprovedRefinements({
      state, ir: source.ir, manifest: source.manifest, design: {}, registry: {},
      compileIr: async (ir) => { compiled += 1; return { ...source.manifest, semanticText: ir.slides[0].nodes[0].payload.text }; }
    });
    expect(compiled).toBe(1);
    expect(replay).toMatchObject({ attemptsUsed: 1, reviewInvalidated: true, manifest: { semanticText: "Short" } });
  });

  it("advances across approval, review, comparison, stop, and deterministic accepted replay", () => {
    const op = routeRefinementFindings(proof({ findings: [finding("polish-spacing")] }), context()).operations[0];
    let state = stateFor({ ...op, approval: { status: "approved", approvedBy: "Host", evidence: "x" } });
    state = advanceRefinementState(state, { type: "delta-applied", outputIdentity: { manifestHash: hash("9") }, packetHash: hash("d") });
    expect(state).toMatchObject({ attemptBudget: { used: 1, max: 3 }, status: "awaiting-host-review" });
    const unchanged = advanceRefinementState(state, { type: "invalid-review", reason: "stale" });
    expect(unchanged.attemptBudget.used).toBe(1);
    const stopped = advanceRefinementState(state, { type: "compared", comparison: 0, accepted: false });
    expect(stopped).toMatchObject({ status: "stopped", stopReason: "no-improvement" });
    const accepted = advanceRefinementState(state, { type: "compared", comparison: 1, accepted: true });
    expect(advanceRefinementState(accepted, { type: "replay" })).toEqual(accepted);
  });
});
