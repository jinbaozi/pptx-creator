import { proofContentHash } from "./creative-visual-proof.mjs";

const COMMANDS = new Set(["typeset", "layout", "colorize", "bolder", "quieter", "distill", "harden", "polish", "overdrive"]);
const GENERIC_TASTE = new Set(["colorize", "bolder", "quieter", "polish", "overdrive"]);
const OPTICAL_FIELDS = new Set(["x", "y", "w", "h", "fontSize", "lineHeight", "transparency", "contrast", "crop"]);
const ROUTES = new Map([
  ["typeset-overflow", ["typeset", "manifest"]], ["typeset-copy", ["typeset", "ir"]],
  ["layout-alignment", ["layout", "manifest"]], ["layout-topology", ["layout", "ir"]],
  ["colorize-palette", ["colorize", "ir"]], ["bolder-hierarchy", ["bolder", "ir"]],
  ["quieter-density", ["quieter", "ir"]], ["distill-copy", ["distill", "ir"]],
  ["harden-contrast", ["harden", "manifest"]], ["harden-alt", ["harden", "ir"]],
  ["polish-spacing", ["polish", "manifest"]], ["overdrive-signature", ["overdrive", "ir"]]
]);

const clone = (value) => structuredClone(value);
const nonEmpty = (value) => typeof value === "string" && /\S/.test(value);
const hashPattern = /^sha256:[a-f0-9]{64}$/;

function sourceIdentity(proof, context) {
  return {
    proof: { path: context.sourceProofPath ?? "creative-proof.json", hash: proofContentHash(proof) },
    semanticIr: clone(proof.identity.semanticIr), manifest: clone(proof.identity.manifest), pptx: clone(proof.identity.pptx),
    renderPacket: { path: "creative-proof/final-review-packet.json", hash: proof.rendering?.packetHash ?? proof.hostVisualReview?.packetHash ?? proofContentHash(proof.rendering ?? {}) },
    hostReview: { path: "host-visual-review.json", hash: proof.hostVisualReview?.reviewHash ?? proofContentHash(proof.hostVisualReview ?? {}) }
  };
}

function operationFor(finding, index) {
  const route = ROUTES.get(finding.type);
  if (!route) return null;
  const [command, targetLayer] = route;
  const evidence = (finding.evidence ?? []).filter(nonEmpty).map((path) => ({ source: finding.source, path }));
  if (evidence.length === 0) return null;
  const fragment = evidence[0].path.includes("#") ? evidence[0].path.split("#").pop() : null;
  return {
    id: `refine-${String(index + 1).padStart(2, "0")}-${command}`,
    command,
    scope: finding.slideId
      ? { kind: "slide", slideId: finding.slideId, ...(fragment ? { nodeId: fragment, elementId: fragment } : {}) }
      : { kind: "deck" },
    evidence,
    reason: finding.message,
    risk: targetLayer === "ir" ? "semantic" : "optical",
    expectedDelta: targetLayer === "ir" ? "Host-authored semantic change followed by canonical recompilation" : "Bounded measurable native-object correction",
    targetLayer,
    delta: null,
    rollback: null,
    provenance: { source: "router", author: "deterministic", hostAuthored: false },
    approval: { status: "required" }
  };
}

export function routeRefinementFindings(proof, context = {}) {
  const budget = { used: Number(context.attemptBudget?.used ?? proof?.repair?.attempts ?? 0), max: 3 };
  const base = {
    version: "0.1.0", planId: `refinement-${proofContentHash({ identity: proof?.identity, findings: proof?.findings }).slice(7, 31)}`,
    status: "blocked", sourceProof: proof?.identity ? sourceIdentity(proof, context) : null,
    dryRun: true, attemptBudget: budget,
    best: proof?.identity ? { identity: clone(proof.identity), vector: refinementVector(proof), accepted: proof.accepted === true } : null,
    operations: [], pending: null, history: [], signatureMoment: context.signatureMoment ?? null,
    provenance: { generator: "pptx-creator", policy: "evidence-led-host-approved", generatedAt: null }
  };
  if (proof?.version !== "0.2.0" || !proof?.identity) return base;
  if (!["completed"].includes(proof.hostVisualReview?.status)) return { ...base, status: "awaiting-host-review" };
  if (budget.used >= budget.max) return { ...base, status: "budget-exhausted" };
  const routed = [];
  for (const finding of proof.findings ?? []) {
    const operation = operationFor(finding, routed.length);
    if (!operation) continue;
    if ((context.brandLocked || context.sourceLocked) && GENERIC_TASTE.has(operation.command)) continue;
    if (operation.command === "overdrive" && (context.signatureMoment || ["restrained", "overused"].includes(proof.hostVisualReview?.signatureMoment))) continue;
    routed.push(operation);
  }
  if (routed.length === 0) return base;
  return { ...base, status: "awaiting-refinement-approval", operations: routed, pending: routed[0].id };
}

function allowedOperationKeys(operation) {
  const expected = ["id", "command", "scope", "evidence", "reason", "risk", "expectedDelta", "targetLayer", "delta", "rollback", "provenance", "approval"];
  return Object.keys(operation ?? {}).every((key) => expected.includes(key)) && expected.every((key) => Object.hasOwn(operation ?? {}, key));
}

export function validateRefinementPlan(plan, context = {}) {
  const errors = [];
  const keys = ["version", "planId", "status", "sourceProof", "dryRun", "attemptBudget", "best", "operations", "pending", "history", "signatureMoment", "provenance"];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { valid: false, errors: ["plan must be an object"] };
  if (!Object.keys(plan).every((key) => keys.includes(key)) || !keys.every((key) => Object.hasOwn(plan, key))) errors.push("plan contract is not closed");
  if (plan.version !== "0.1.0" || plan.dryRun !== true) errors.push("plan must be version 0.1.0 and dryRun true");
  if (plan.attemptBudget?.max !== 3 || !Number.isInteger(plan.attemptBudget?.used) || plan.attemptBudget.used < 0 || plan.attemptBudget.used > 3) errors.push("attempt budget must be shared max 3");
  if (!Array.isArray(plan.operations)) errors.push("operations must be an array");
  for (const operation of plan.operations ?? []) {
    if (!allowedOperationKeys(operation)) errors.push(`operation ${operation?.id ?? "unknown"} contract is not closed`);
    if (!COMMANDS.has(operation?.command) || !["ir", "manifest"].includes(operation?.targetLayer)) errors.push(`operation ${operation?.id ?? "unknown"} route is invalid`);
    if (!nonEmpty(operation?.reason) || !nonEmpty(operation?.expectedDelta) || !(operation?.evidence?.length > 0)) errors.push(`operation ${operation?.id ?? "unknown"} lacks evidence/reason/expectedDelta`);
  }
  if (plan.pending !== null && !plan.operations?.some((operation) => operation.id === plan.pending)) errors.push("pending operation is unknown");
  if (context.sourceProofHash && plan.sourceProof?.proof?.hash !== context.sourceProofHash) errors.push("source proof is stale");
  return { valid: errors.length === 0, errors };
}

export function materializeRefinementDryRun({ plan, ir, manifest, design }) {
  const validation = validateRefinementPlan(plan);
  if (!validation.valid) throw new Error(`invalid refinement plan: ${validation.errors.join("; ")}`);
  return {
    version: "0.1.0", planId: plan.planId, dryRun: true, mutated: false,
    sourceHashes: { ir: proofContentHash(ir), manifest: proofContentHash(manifest), design: proofContentHash(design) },
    operations: clone(plan.operations), pending: plan.pending
  };
}

function validateOpticalDelta(delta, rollback) {
  if (delta?.kind !== "optical" || !nonEmpty(delta.slideId) || !nonEmpty(delta.elementId) || !delta.changes || typeof delta.changes !== "object") throw new Error("manifest refinement requires a closed optical delta");
  if (delta.removeElement || Object.keys(delta).some((key) => !["kind", "slideId", "elementId", "changes"].includes(key))) throw new Error("manifest removal or unknown delta fields are forbidden");
  for (const [field, change] of Object.entries(delta.changes)) {
    if (!OPTICAL_FIELDS.has(field) || !change || typeof change !== "object" || !Object.keys(change).every((key) => ["before", "after", "tolerance"].includes(key))) throw new Error(`manifest field ${field} is not an allowed optical correction`);
    if (!Number.isFinite(change.tolerance) || change.tolerance < 0) throw new Error(`manifest field ${field} requires a non-negative tolerance`);
  }
  if (!rollback || rollback.kind !== "optical") throw new Error("manifest refinement requires inverse rollback");
}

function validateSemanticDelta(operation) {
  const delta = operation.delta;
  if (delta?.kind !== "semantic" || !Array.isArray(delta.path) || delta.path.length < 2) throw new Error("IR refinement requires a semantic path delta");
  if (delta.path.some((part) => ["x", "y", "w", "h", "elements"].includes(part))) throw new Error("IR refinement cannot carry coordinates or manifest elements");
  if (!operation.provenance?.hostAuthored || operation.provenance?.source !== "host") throw new Error("semantic replacement must be Host-authored");
  const rollback = operation.rollback;
  if (rollback?.kind !== "semantic" || JSON.stringify(rollback.path) !== JSON.stringify(delta.path)
    || JSON.stringify(rollback.before) !== JSON.stringify(delta.after)
    || JSON.stringify(rollback.after) !== JSON.stringify(delta.before)) {
    throw new Error("IR refinement requires an exact inverse semantic rollback");
  }
}

function findManifestElement(manifest, slideId, elementId) {
  const slide = manifest.slides?.find((entry) => entry.id === slideId);
  const element = slide?.elements?.find((entry) => entry.id === elementId);
  if (!element) throw new Error(`manifest optical target not found: ${slideId}/${elementId}`);
  return element;
}

function setSemanticPath(ir, path, before, after) {
  const [root, slideId, collection, nodeId, ...tail] = path;
  let cursor;
  let remaining;
  if (root === "slides") {
    const slide = ir.slides?.find((entry) => entry.id === slideId);
    if (!slide) throw new Error(`IR slide not found: ${slideId}`);
    if (collection === "nodes") { cursor = slide.nodes?.find((entry) => entry.id === nodeId); remaining = tail; }
    else { cursor = slide; remaining = [collection, nodeId, ...tail].filter((part) => part !== undefined); }
  } else if (["designIntent", "story", "context"].includes(root)) {
    cursor = ir[root]; remaining = path.slice(1);
  } else if (root === "assets") {
    cursor = ir.assets?.find((entry) => entry.id === slideId); remaining = path.slice(2);
  } else throw new Error("semantic delta must target slides, designIntent, story, context, or assets");
  if (!cursor) throw new Error("IR semantic target was not found");
  for (const part of remaining.slice(0, -1)) cursor = cursor?.[part];
  const key = remaining.at(-1);
  if (!key || JSON.stringify(cursor?.[key]) !== JSON.stringify(before)) throw new Error("semantic delta before-value drifted");
  cursor[key] = clone(after);
}

export function validateRefinementState(state, context = {}) {
  const errors = [];
  const keys = ["version", "baseRunHash", "sourceProofHash", "approvedOperations", "pendingApproval", "attemptBudget", "bestIdentity", "reviewBindings", "signatureMoment", "hostApproval"];
  if (!state || typeof state !== "object" || !Object.keys(state).every((key) => keys.includes(key)) || !keys.every((key) => Object.hasOwn(state ?? {}, key))) errors.push("refinement state contract is not closed");
  if (state?.version !== "0.1.0" || !hashPattern.test(state?.baseRunHash ?? "") || !hashPattern.test(state?.sourceProofHash ?? "")) errors.push("state identity hashes are invalid");
  if (state?.attemptBudget?.max !== 3 || !Number.isInteger(state?.attemptBudget?.used) || state.attemptBudget.used < 0 || state.attemptBudget.used > 3) errors.push("state attempt budget is invalid");
  if ((state?.approvedOperations?.length ?? -1) !== state?.attemptBudget?.used) errors.push("approved operation count does not match used budget");
  const bestKeys = ["semanticIrHash", "manifestHash", "pptxHash", "vector"];
  if (!state?.bestIdentity || !Object.keys(state.bestIdentity).every((key) => bestKeys.includes(key)) || !bestKeys.every((key) => Object.hasOwn(state.bestIdentity, key))
    || ![state.bestIdentity.semanticIrHash, state.bestIdentity.manifestHash, state.bestIdentity.pptxHash].every((value) => hashPattern.test(value ?? ""))
    || !Array.isArray(state.bestIdentity.vector) || state.bestIdentity.vector.length !== 8 || !state.bestIdentity.vector.every(Number.isFinite)) errors.push("best identity is invalid or open");
  const approvalKeys = ["status", "approvedBy", "approvedAt", "operationId"];
  if (!state?.hostApproval || !Object.keys(state.hostApproval).every((key) => approvalKeys.includes(key)) || !approvalKeys.every((key) => Object.hasOwn(state.hostApproval, key))) errors.push("Host approval contract is not closed");
  if (!Array.isArray(state?.reviewBindings) || state.reviewBindings.length < 1 || state.reviewBindings.some((binding) => {
    const keys = ["proofHash", "packetHash", "reviewHash"];
    return !binding || !Object.keys(binding).every((key) => keys.includes(key)) || !keys.every((key) => Object.hasOwn(binding, key))
      || [binding.proofHash, binding.packetHash, binding.reviewHash].some((value) => value !== null && !hashPattern.test(value));
  })) errors.push("review bindings are invalid or open");
  if (context.sourceProofHash && state?.sourceProofHash !== context.sourceProofHash) errors.push("source proof hash is stale");
  if (context.baseRunHash && state?.baseRunHash !== context.baseRunHash) errors.push("base run hash is stale");
  if (state?.hostApproval?.operationId !== state?.pendingApproval?.id) errors.push("Host approval is not bound to pending operation");
  for (const operation of [...(state?.approvedOperations ?? []), state?.pendingApproval].filter(Boolean)) {
    if (!allowedOperationKeys(operation)) { errors.push(`operation ${operation?.id ?? "unknown"} contract is not closed`); continue; }
    if (!COMMANDS.has(operation.command) || !["ir", "manifest"].includes(operation.targetLayer)) errors.push(`operation ${operation.id} route is invalid`);
    if (!nonEmpty(operation.reason) || !nonEmpty(operation.expectedDelta) || !(operation.evidence?.length > 0)) errors.push(`operation ${operation.id} lacks evidence/reason/expectedDelta`);
    if (!operation.delta) { errors.push(`operation ${operation.id} lacks an approved concrete delta`); continue; }
    try {
      if (operation.targetLayer === "manifest") validateOpticalDelta(operation.delta, operation.rollback);
      else validateSemanticDelta(operation);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { valid: errors.length === 0, errors };
}

export function applyApprovedRefinement({ state, ir, manifest, design, registry }) {
  const validation = validateRefinementState(state);
  if (!validation.valid) throw new Error(`invalid refinement state: ${validation.errors.join("; ")}`);
  const operation = state.pendingApproval;
  if (state.attemptBudget.used >= 3) throw new Error("shared refinement budget is exhausted");
  if (state.hostApproval?.status !== "approved" || operation?.approval?.status !== "approved") throw new Error("explicit Host approval is required");
  if (operation.command === "overdrive" && state.signatureMoment) throw new Error("only one signature moment is allowed");
  const nextIr = clone(ir); const nextManifest = clone(manifest);
  if (operation.targetLayer === "manifest") {
    validateOpticalDelta(operation.delta, operation.rollback);
    if (operation.scope.kind !== "slide" || operation.delta.slideId !== operation.scope.slideId
      || (operation.scope.elementId && operation.delta.elementId !== operation.scope.elementId)) {
      throw new Error("manifest optical delta target is outside the approved scope");
    }
    const element = findManifestElement(nextManifest, operation.delta.slideId, operation.delta.elementId);
    for (const [field, change] of Object.entries(operation.delta.changes)) {
      if (JSON.stringify(element[field] ?? element.style?.[field]) !== JSON.stringify(change.before)) throw new Error(`manifest ${field} before-value drifted`);
      if (["fontSize", "lineHeight", "transparency", "contrast"].includes(field) && element[field] === undefined) {
        element.style = { ...(element.style ?? {}), [field]: change.after };
      } else element[field] = change.after;
    }
  } else {
    validateSemanticDelta(operation);
    if (operation.delta.path[0] === "slides" && (operation.scope.kind !== "slide" || operation.delta.path[1] !== operation.scope.slideId)) {
      throw new Error("IR semantic delta target is outside the approved slide scope");
    }
    if (operation.delta.path[0] !== "slides" && operation.scope.kind !== "deck") {
      throw new Error("global IR semantic delta requires deck scope");
    }
    setSemanticPath(nextIr, operation.delta.path, operation.delta.before, operation.delta.after);
  }
  const signatureMoment = operation.command === "overdrive"
    ? { operationId: operation.id, slideId: operation.scope.slideId, nodeId: operation.scope.nodeId, kind: "signature", evidence: operation.evidence[0].path }
    : state.signatureMoment;
  return {
    ir: nextIr, manifest: nextManifest, design: clone(design), registry: clone(registry),
    targetLayer: operation.targetLayer, requiresRecompile: operation.targetLayer === "ir", reviewInvalidated: true,
    inputHashes: { ir: proofContentHash(ir), manifest: proofContentHash(manifest) },
    outputHashes: { ir: proofContentHash(nextIr), manifest: proofContentHash(nextManifest) },
    appliedOperation: clone(operation), signatureMoment
  };
}

export async function replayApprovedRefinements({ state, ir, manifest, design, registry, compileIr }) {
  const validation = validateRefinementState(state);
  if (!validation.valid) throw new Error(`invalid refinement state: ${validation.errors.join("; ")}`);
  const chain = [...state.approvedOperations, state.pendingApproval];
  if (chain.length > 3 || chain.length !== state.attemptBudget.used + 1) throw new Error("approved operation chain does not match the shared attempt budget");
  if (proofContentHash(ir) !== state.baseRunHash) throw new Error("canonical base IR drifted from the protected refinement state");
  let current = { ir: clone(ir), manifest: clone(manifest), design: clone(design), registry: clone(registry) };
  let signatureMoment = state.signatureMoment;
  const history = [];
  for (const [index, operation] of chain.entries()) {
    if (operation.approval?.status !== "approved") throw new Error(`operation ${operation.id} is not explicitly approved`);
    const result = applyApprovedRefinement({
      state: {
        ...clone(state), approvedOperations: [], pendingApproval: clone(operation), attemptBudget: { used: index, max: 3 },
        signatureMoment,
        hostApproval: index === chain.length - 1 ? clone(state.hostApproval) : {
          status: "approved", approvedBy: operation.approval.approvedBy, approvedAt: state.hostApproval.approvedAt, operationId: operation.id
        }
      },
      ...current
    });
    current = { ir: result.ir, manifest: result.manifest, design: result.design, registry: result.registry };
    if (result.requiresRecompile) {
      if (typeof compileIr !== "function") throw new Error("IR refinement requires the canonical Semantic IR compiler");
      current.manifest = await compileIr(current.ir, { design: current.design });
      result.outputHashes.manifest = proofContentHash(current.manifest);
    }
    signatureMoment = result.signatureMoment;
    history.push({
      attempt: index + 1, operationId: operation.id, targetLayer: operation.targetLayer,
      inputHashes: result.inputHashes, outputHashes: { ir: proofContentHash(current.ir), manifest: proofContentHash(current.manifest) },
      reviewInvalidated: true, outcome: "applied", rollback: clone(operation.rollback)
    });
    if (state.approvedOperations.length > 0 && index === state.approvedOperations.length - 1) {
      const expectedIr = state.bestIdentity?.semanticIrHash ?? state.bestIdentity?.identity?.semanticIr?.hash;
      const expectedManifest = state.bestIdentity?.manifestHash ?? state.bestIdentity?.identity?.manifest?.hash;
      if (proofContentHash(current.ir) !== expectedIr || proofContentHash(current.manifest) !== expectedManifest) {
        throw new Error("approved operation replay does not reconstruct the artifact-bound best identity");
      }
    }
  }
  return { ...current, history, signatureMoment, attemptsUsed: chain.length, reviewInvalidated: true };
}

export function refinementVector(proof = {}) {
  const findings = proof.findings ?? [];
  const p0 = findings.filter((finding) => finding.severity === "P0").length;
  const p1 = findings.filter((finding) => finding.severity === "P1").length;
  const hardLayout = (proof.hardGates ?? []).filter((gate) => gate.required && ["text-fit", "layout-safety", "render-completeness"].includes(gate.id) && gate.status !== "passed").length;
  const suiteFailures = (proof.suites ?? []).filter((suite) => suite.required && suite.status !== "passed").length;
  const drift = (proof.tokenLedger?.drift?.length ?? 0) + (proof.assetLedger?.drift?.length ?? 0);
  const editabilityRegression = Math.max(0, 4 - Number(proof.diagnostics?.nativeCoverage?.editabilityLevel ?? 0));
  return [p0, p1, hardLayout, suiteFailures, drift, editabilityRegression, Number(proof.diagnostics?.antiSlop?.risk ?? 100), -Number(proof.diagnostics?.quality?.deckScore ?? 0)];
}

export function compareRefinementProof(candidate, best) {
  if (candidate?.version !== "0.2.0" || best?.version !== "0.2.0") throw new Error("comparison requires complete Proof 0.2 records");
  if (candidate.hostVisualReview?.status !== "completed" || best.hostVisualReview?.status !== "completed") throw new Error("comparison requires artifact-bound completed Host reviews");
  const candidateEditability = Number(candidate.diagnostics?.nativeCoverage?.editabilityLevel ?? 0);
  const bestEditability = Number(best.diagnostics?.nativeCoverage?.editabilityLevel ?? 0);
  if (candidateEditability < bestEditability) return -1;
  const left = refinementVector(candidate); const right = refinementVector(best);
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] < right[index] ? 1 : -1;
  if (candidate.accepted === true && best.accepted !== true) return 1;
  return 0;
}

export function advanceRefinementState(state, event) {
  const next = clone(state);
  if (next.status === "accepted" && event.type === "replay") return next;
  if (event.type === "invalid-review") {
    next.status = "awaiting-host-review"; next.stopReason = event.reason ?? "invalid-review"; return next;
  }
  if (event.type === "delta-applied") {
    if (next.attemptBudget.used >= 3) throw new Error("attempt 4 is forbidden by shared budget");
    next.attemptBudget.used += 1; next.status = "awaiting-host-review"; next.stopReason = null;
    next.approvedOperations = [...next.approvedOperations, clone(next.pendingApproval)];
    next.reviewBindings = [...next.reviewBindings, { proofHash: null, packetHash: event.packetHash, reviewHash: null }];
    next.pendingApproval = null; next.hostApproval = { status: "required", approvedBy: null, approvedAt: null, operationId: null };
    next.candidateIdentity = clone(event.outputIdentity); return next;
  }
  if (event.type === "compared") {
    if (event.accepted && event.comparison >= 0) { next.status = "accepted"; next.stopReason = "accepted"; return next; }
    if (!(event.comparison > 0)) { next.status = "stopped"; next.stopReason = "no-improvement"; return next; }
    if (next.attemptBudget.used >= 3) { next.status = "stopped"; next.stopReason = "attempt-limit"; return next; }
    next.status = "awaiting-refinement-approval"; next.stopReason = null; return next;
  }
  if (event.type === "publication-failed") { next.status = "stopped"; next.stopReason = "publication-failed"; next.rollback = "best-restored"; return next; }
  if (event.type === "replay") return next;
  throw new Error(`unsupported refinement event: ${event.type}`);
}
