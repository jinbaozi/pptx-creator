import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { arch, platform } from "node:os";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import JSZip from "jszip";
import { runPython } from "./python-utils.mjs";
import { validateJsonSchema } from "./schema-utils.mjs";
import { buildAssetLedger, buildTokenLedger } from "./creative-proof-ledgers.mjs";

const HOST_REVIEW_SCHEMA = JSON.parse(await readFile(
  new URL("../../schemas/host-visual-review.schema.json", import.meta.url),
  "utf8"
));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function proofContentHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

export function proofByteHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizePptxEntry(name, bytes) {
  if (name !== "docProps/core.xml") return bytes;
  const text = bytes.toString("utf8").replace(
    /(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
    "$1TIMESTAMP-NORMALIZED$2"
  );
  return Buffer.from(text, "utf8");
}

export async function proofPptxHash(path) {
  const archive = await JSZip.loadAsync(await readFile(path));
  const digest = createHash("sha256");
  for (const name of Object.keys(archive.files).filter((entry) => !archive.files[entry].dir).sort()) {
    const bytes = normalizePptxEntry(name, await archive.files[name].async("nodebuffer"));
    digest.update(Buffer.from(name, "utf8"));
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
  }
  return `sha256:${digest.digest("hex")}`;
}

function localPath(outputDir, absolutePath) {
  const root = realpathSync(outputDir);
  const target = realpathSync(absolutePath);
  const value = String(relative(root, target)).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) throw new Error(`creative proof artifact escapes output directory: ${absolutePath}`);
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function artifactHashes(identity, rendering) {
  return {
    semanticIrHash: identity.semanticIr.hash,
    manifestHash: identity.manifest.hash,
    pptxHash: identity.pptx.hash,
    designTokenHash: identity.designTokens.hash,
    assetRegistryHash: identity.assetRegistry.hash,
    selectionHash: identity.selection?.hash ?? null,
    refinementHash: identity.refinement?.hash ?? null,
    renderReportHash: rendering.renderReport.hash,
    contactSheetHash: rendering.contactSheet.hash
  };
}

export function buildFinalReviewPacket({ identity, rendering }) {
  if (!identity || !rendering) throw new TypeError("final review packet requires identity and rendering evidence");
  const unsigned = {
    version: "0.1.0",
    artifacts: artifactHashes(identity, rendering),
    pages: (rendering.pages ?? []).map((page) => ({
      slideId: page.slideId,
      index: page.index,
      path: page.path,
      hash: page.hash,
      width: page.width,
      height: page.height
    })),
    contactSheet: structuredClone(rendering.contactSheet),
    renderingEnvironment: structuredClone(rendering.environment)
  };
  return { ...unsigned, packetHash: proofContentHash(unsigned) };
}

function hostFinding(finding, slideId = null) {
  return {
    severity: finding.severity,
    source: "host-visual-review",
    type: finding.type,
    message: finding.reason,
    ...(slideId ? { slideId } : {}),
    evidence: (finding.evidence ?? []).map((entry) => entry.path)
  };
}

export function validateHostVisualReview({ packet, review }) {
  if (!review) return { valid: true, status: "missing", accepted: false, errors: [], findings: [] };
  const structural = validateJsonSchema(review, HOST_REVIEW_SCHEMA);
  const errors = structural.errors.map((entry) => `${entry.path}: ${entry.message}`);
  if (review.packetHash !== packet?.packetHash) errors.push("Host final review packetHash is stale");
  if (!deepEqual(review.artifacts, packet?.artifacts)) errors.push("Host final review artifact hashes are stale");
  if (review.status === "unavailable") {
    return { valid: errors.length === 0, status: "unavailable", accepted: false, errors, findings: [] };
  }
  if (review.status !== "completed") errors.push("Host final visual review status must be completed or unavailable");
  const pages = new Map((packet?.pages ?? []).map((page) => [page.slideId, page]));
  const seen = new Set();
  const findings = [];
  let hardJudgmentFailed = false;
  for (const slide of review.perSlide ?? []) {
    if (seen.has(slide?.slideId)) errors.push(`Host final review duplicates slide ${slide?.slideId}`);
    seen.add(slide?.slideId);
    const page = pages.get(slide?.slideId);
    if (!page) errors.push(`Host final review references unknown slide ${slide?.slideId}`);
    else if (slide.screenshotPath !== page.path || slide.screenshotHash !== page.hash) errors.push(`Host final review screenshot evidence is stale for ${slide.slideId}`);
    if (slide?.focus !== "clear" || slide?.hierarchy !== "clear"
      || slide?.thumbnailReadability !== "pass" || slide?.attentionTargetAlignment !== "pass") hardJudgmentFailed = true;
    for (const finding of slide?.findings ?? []) findings.push(hostFinding(finding, slide.slideId));
  }
  if (seen.size !== pages.size || [...pages.keys()].some((slideId) => !seen.has(slideId))) errors.push("Host final review must cover every rendered slide exactly once");
  for (const finding of review.findings ?? []) findings.push(hostFinding(finding));
  const severe = findings.some((finding) => ["P0", "P1"].includes(finding.severity));
  const deckFailed = review.deckRhythm?.rhythm === "broken"
    || review.deckRhythm?.consistency === "inconsistent"
    || review.deckRhythm?.signatureMoment === "overused";
  if (review.overallVerdict === "accept" && (hardJudgmentFailed || severe || deckFailed)) {
    errors.push("Host accept verdict conflicts with per-slide hard judgments, deck rhythm, or P0/P1 findings");
  }
  const accepted = errors.length === 0 && review.overallVerdict === "accept" && !hardJudgmentFailed && !severe && !deckFailed;
  return { valid: errors.length === 0, status: errors.length ? "invalid" : "completed", accepted, errors, findings };
}

function gate(id, status, required, evidence = [], reasons = []) {
  return { id, status, required, evidence, reasons };
}

function renderingValidation(rendering) {
  const reasons = [];
  const pages = rendering?.pages ?? [];
  if (rendering?.status !== "passed") reasons.push(`rendering status is ${rendering?.status ?? "missing"}`);
  if (rendering?.expectedPageCount !== rendering?.renderedPageCount || pages.length !== rendering?.expectedPageCount) reasons.push("rendered page count does not match expected pages");
  const indexes = pages.map((page) => page.index);
  const slideIds = pages.map((page) => page.slideId);
  const paths = pages.map((page) => page.path);
  if (new Set(indexes).size !== pages.length || indexes.some((index, expected) => index !== expected)) reasons.push("rendered page indexes are duplicated or non-contiguous");
  if (new Set(slideIds).size !== pages.length || new Set(paths).size !== pages.length) reasons.push("rendered page slide IDs or paths are duplicated");
  if (pages.some((page) => !page.hash || page.width <= 0 || page.height <= 0)) reasons.push("rendered page hash or dimensions are missing");
  return { passed: reasons.length === 0, reasons };
}

function contactSheetValidation(rendering) {
  const reasons = [];
  const contact = rendering?.contactSheet;
  const pages = rendering?.pages ?? [];
  if (!contact?.hash || contact?.width <= 0 || contact?.height <= 0) reasons.push("contact sheet hash or dimensions are missing");
  if (!deepEqual(contact?.slideIds, pages.map((page) => page.slideId))) reasons.push("contact sheet slide membership is stale");
  if (!deepEqual(contact?.slideHashes, pages.map((page) => page.hash))) reasons.push("contact sheet slide hashes are stale");
  return { passed: reasons.length === 0, reasons };
}

function hostReviewSummary(packet, review, validation) {
  return {
    status: validation.status,
    packetHash: packet.packetHash,
    reviewHash: review ? proofContentHash(review) : null,
    overallVerdict: review?.overallVerdict ?? null,
    perSlideCount: review?.perSlide?.length ?? 0,
    summary: review?.summary ?? null,
    findings: validation.findings
  };
}

function normalizeFinding(finding) {
  return {
    severity: finding?.severity ?? "P2",
    source: finding?.source ?? "deterministic",
    type: finding?.type ?? "finding",
    message: finding?.message ?? finding?.reason ?? "Finding",
    ...(finding?.slideId ? { slideId: finding.slideId } : {}),
    evidence: Array.isArray(finding?.evidence) ? finding.evidence.map((entry) => typeof entry === "string" ? entry : entry?.path).filter(Boolean) : []
  };
}

export function evaluateCreativeVisualProof({
  identity,
  rendering,
  tokenLedger,
  assetLedger,
  diagnostics,
  hostReview,
  selection,
  suites,
  repair,
  refinement,
  findings = [],
  hardGateInputs = {}
} = {}) {
  const packet = hostReview?.packet ?? buildFinalReviewPacket({ identity, rendering });
  const reviewValidation = validateHostVisualReview({ packet, review: hostReview?.review ?? null });
  const render = renderingValidation(rendering);
  const contact = contactSheetValidation(rendering);
  const requiredSuitesPassed = (suites ?? []).every((entry) => !entry.required || entry.status === "passed");
  const selectionPassed = selection?.status === "valid" || selection?.status === "not-applicable";
  const probe = identity?.purpose === "direction-probe";
  const hostRequired = !probe;
  const hostStatus = probe ? "not-applicable"
    : reviewValidation.status === "completed" && reviewValidation.accepted ? "passed"
      : reviewValidation.status === "missing" || reviewValidation.status === "unavailable" ? "unavailable" : "failed";
  const hardGates = [
    gate("schema", hardGateInputs.schema === true ? "passed" : "failed", true, ["schemas/creative-proof.schema.json"], hardGateInputs.schema === true ? [] : ["proof input contract is incomplete"]),
    gate("render-completeness", render.passed ? "passed" : rendering?.status === "unavailable" ? "unavailable" : "failed", true, [rendering?.renderReport?.path].filter(Boolean), render.reasons),
    gate("contact-sheet", contact.passed ? "passed" : "failed", true, [rendering?.contactSheet?.path].filter(Boolean), contact.reasons),
    gate("text-fit", hardGateInputs.textFit === true ? "passed" : "failed", true, ["text-fit-report.json"], hardGateInputs.textFit === true ? [] : ["text fit did not pass"]),
    gate("layout-safety", hardGateInputs.layoutSafety === true ? "passed" : "failed", true, ["layout-safety-report.json"], hardGateInputs.layoutSafety === true ? [] : ["layout safety did not pass"]),
    gate("token-drift", tokenLedger?.status === "passed" ? "passed" : tokenLedger?.status === "unavailable" ? "unavailable" : "failed", true, ["creative-proof/token-ledger.json"], tokenLedger?.drift?.map((entry) => `${entry.field} drift`) ?? ["token ledger missing"]),
    gate("asset-drift", assetLedger?.status === "passed" ? "passed" : assetLedger?.status === "unavailable" ? "unavailable" : "failed", true, ["creative-proof/asset-ledger.json"], assetLedger?.drift?.map((entry) => `${entry.field} drift`) ?? ["asset ledger missing"]),
    gate("editability-native-coverage", hardGateInputs.editability === true && diagnostics?.nativeCoverage?.status === "passed" ? "passed" : "failed", true, ["quality-report.json"], hardGateInputs.editability === true ? [] : ["native editability coverage did not pass"]),
    gate("required-suites", requiredSuitesPassed ? "passed" : "failed", true, (suites ?? []).flatMap((entry) => entry.artifacts ?? []), requiredSuitesPassed ? [] : ["a required office suite is unavailable or failed"]),
    gate("selection-validity", selectionPassed ? "passed" : "failed", true, identity?.selection ? [identity.selection.path] : [], selectionPassed ? [] : [selection?.reason ?? "selection is invalid"]),
    gate("visual-critic", hardGateInputs.visualCritic === true && diagnostics?.visualCritic?.status === "passed" ? "passed" : "failed", true, ["visual-review.json"], hardGateInputs.visualCritic === true ? [] : ["deterministic visual critic did not pass"]),
    gate("final-host-review", hostStatus, hostRequired, ["creative-proof/final-review-packet.json"], probe ? [] : reviewValidation.errors.length ? reviewValidation.errors : hostStatus === "passed" ? [] : ["Host final visual review is missing or unavailable"])
  ];
  const allFindings = [...findings.map(normalizeFinding), ...reviewValidation.findings.map(normalizeFinding)];
  const severeFindings = allFindings.filter((finding) => ["P0", "P1"].includes(finding.severity));
  const deterministicPassed = hardGates.filter((entry) => entry.required && entry.id !== "final-host-review").every((entry) => entry.status === "passed")
    && severeFindings.length === 0;
  const accepted = !probe && deterministicPassed && hostStatus === "passed";
  let acceptanceStatus;
  if (probe) acceptanceStatus = deterministicPassed ? "evidence-ready" : "blocked";
  else if (accepted) acceptanceStatus = "accepted";
  else if (deterministicPassed && reviewValidation.status === "missing") acceptanceStatus = "awaiting-host-review";
  else acceptanceStatus = "blocked";
  const reasons = accepted ? [] : [
    ...hardGates.filter((entry) => entry.required && entry.status !== "passed").flatMap((entry) => entry.reasons.length ? entry.reasons : [`${entry.id} did not pass`]),
    ...severeFindings.map((finding) => `${finding.severity} ${finding.type}: ${finding.message}`)
  ];
  return {
    version: "0.2.0",
    identity: structuredClone(identity),
    rendering: structuredClone(rendering),
    hardGates,
    tokenLedger: structuredClone(tokenLedger),
    assetLedger: structuredClone(assetLedger),
    diagnostics: structuredClone(diagnostics),
    hostVisualReview: hostReviewSummary(packet, hostReview?.review ?? null, reviewValidation),
    selection: structuredClone(selection),
    suites: structuredClone(suites),
    repair: structuredClone(repair),
    refinement: structuredClone(refinement),
    findings: allFindings,
    acceptance: { status: acceptanceStatus, reasons: [...new Set(reasons)] },
    accepted
  };
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function summarizeCreativeQuality(quality = {}) {
  const slideScores = (quality.slides ?? []).map((slide) => Number(slide?.score)).filter(Number.isFinite);
  return {
    deckScore: finite(quality.deckScore, 0),
    slideFloor: finite(quality.slideFloor, slideScores.length ? Math.min(...slideScores) : 0),
    slopRisk: finite(quality.slopRisk, 100),
    criticalFindings: finite(quality.criticalFindings, 0),
    editabilityLevel: finite(quality.editabilityLevel, 1),
    gate: {
      passed: quality.gate?.passed === true,
      reasons: Array.isArray(quality.gate?.reasons) ? quality.gate.reasons.map(String) : []
    }
  };
}

export function summarizeCreativeRepair(repair = {}) {
  return {
    attempts: Number.isInteger(repair.attempts) ? repair.attempts : 0,
    stopReason: typeof repair.stopReason === "string" && repair.stopReason ? repair.stopReason : "not-run",
    history: structuredClone(repair.history ?? [])
  };
}

function buildDiagnostics({ manifest, review, quality, intermediate }) {
  const qualitySummary = summarizeCreativeQuality(quality);
  const elements = (manifest?.slides ?? []).flatMap((slide) => slide.elements ?? []);
  const nativeObjects = elements.filter((element) => ["text", "shape", "table", "line", "icon", "chart", "diagram", "image"].includes(element.type)).length;
  const rasterObjects = elements.filter((element) => element.type === "cropped-asset").length;
  const criticFindings = (review?.slides ?? []).flatMap((slide) => (slide.issues ?? []).map((finding) => ({ ...finding, slideId: slide.id })));
  const thumbnailFailures = (manifest?.slides ?? []).flatMap((slide) => {
    const slideElements = slide.elements ?? [];
    const failures = [];
    for (const element of slideElements.filter((entry) => entry.type === "text")) {
      const fontSize = Number(element.style?.fontSize ?? element.fontSize);
      if (Number.isFinite(fontSize) && fontSize < 16) failures.push({ slideId: slide.id, elementId: element.id, metric: "fontSize", value: fontSize, minimum: 16 });
    }
    if (slideElements.length > 18) failures.push({ slideId: slide.id, metric: "objectCount", value: slideElements.length, maximum: 18 });
    return failures;
  });
  const consecutiveRuns = (values) => {
    const runs = [];
    for (let start = 0; start < values.length;) {
      let end = start + 1;
      while (end < values.length && values[end] === values[start]) end += 1;
      if (end - start >= 3) runs.push({ value: values[start], start, end: end - 1, length: end - start });
      start = end;
    }
    return runs;
  };
  const topology = (manifest?.slides ?? []).map((slide) => slide.metadata?.compositionBlock?.id ?? slide.type ?? "unknown");
  const density = (manifest?.slides ?? []).map((slide) => {
    const count = (slide.elements ?? []).length;
    return count <= 6 ? "low" : count <= 12 ? "medium" : "high";
  });
  const topologyRuns = consecutiveRuns(topology);
  const densityRuns = consecutiveRuns(density);
  return {
    thumbnailReadability: { status: thumbnailFailures.length ? "failed" : "passed", checkedSlides: manifest?.slides?.length ?? 0, failures: thumbnailFailures },
    antiSlop: { status: qualitySummary.slopRisk <= 20 ? "passed" : "failed", risk: qualitySummary.slopRisk, findings: criticFindings.filter((finding) => /slop|default|repetition/i.test(finding.type ?? "")) },
    nativeCoverage: { status: qualitySummary.editabilityLevel >= 4 && rasterObjects === 0 ? "passed" : "failed", editabilityLevel: qualitySummary.editabilityLevel, nativeObjects, rasterObjects },
    rhythm: { status: topologyRuns.length || densityRuns.length ? "failed" : "passed", topologyRuns, densityRuns },
    quality: { status: qualitySummary.gate.passed ? "passed" : "failed", deckScore: qualitySummary.deckScore, slideFloor: qualitySummary.slideFloor },
    visualCritic: { status: criticFindings.some((finding) => ["critical", "high"].includes(finding.severity)) ? "failed" : "passed", findings: criticFindings }
  };
}

function buildSuites(targetSuites, rendering, externalSuiteEvidence = {}) {
  const requested = new Map((targetSuites ?? [{ suite: "libreoffice", required: true }]).map((entry) => [entry.suite, entry]));
  return ["libreoffice", "powerpoint", "wps"].map((suite) => {
    const target = requested.get(suite);
    if (!target) return { suite, required: false, status: "not-applicable", environment: null, artifacts: [], reason: "suite was not requested" };
    if (suite === "libreoffice") return {
      suite,
      required: target.required,
      status: rendering.status === "passed" ? "passed" : rendering.status === "failed" ? "failed" : "unavailable",
      environment: rendering.environment?.libreOfficeVersion ?? null,
      artifacts: [rendering.renderReport.path],
      reason: rendering.status === "passed" ? "full render completed" : "LibreOffice render evidence is unavailable or failed"
    };
    const evidence = externalSuiteEvidence[suite];
    return evidence
      ? { suite, required: target.required, status: evidence.status, environment: evidence.environment ?? null, artifacts: evidence.artifacts ?? [], reason: evidence.reason ?? "external suite evidence" }
      : { suite, required: target.required, status: "unavailable", environment: null, artifacts: [], reason: "no real suite adapter evidence was supplied" };
  });
}

async function buildRenderingEvidence({ preview, manifest, outputDir, evidenceDir, reportPath }) {
  const pages = [];
  for (const [index, previewPath] of (preview.previews ?? []).entries()) {
    const metadata = preview.pages?.[index] ?? {};
    const bytes = await readFile(previewPath);
    pages.push({
      slideId: manifest.slides[index]?.id ?? `slide-${index + 1}`,
      index,
      path: localPath(outputDir, previewPath),
      hash: metadata.hash ?? proofByteHash(bytes),
      width: metadata.width ?? 0,
      height: metadata.height ?? 0
    });
  }
  const contactPath = preview.contactSheet?.path;
  const contactHash = contactPath ? proofByteHash(await readFile(contactPath)) : proofByteHash(Buffer.alloc(0));
  const reportBytes = await readFile(reportPath);
  const environment = preview.environment ?? {
    renderer: "libreoffice", suite: "libreoffice", platform: platform(), architecture: arch(),
    libreOfficeVersion: preview.renderer?.version ?? "unknown", pythonVersion: preview.pythonVersion ?? "unknown",
    commandIdentity: "libreoffice-headless-pdf+pdftoppm-png-96dpi",
    settings: { dpi: 96, colorMode: "RGB", timestampFree: true }
  };
  return {
    status: preview.status === "ok" ? "passed" : preview.status === "failed" ? "failed" : "unavailable",
    environment,
    expectedPageCount: manifest.slides.length,
    renderedPageCount: pages.length,
    pages,
    contactSheet: {
      path: contactPath ? localPath(outputDir, contactPath) : localPath(outputDir, join(evidenceDir, "slides", "contact-sheet.png")),
      hash: contactHash,
      width: preview.contactSheet?.width ?? 0,
      height: preview.contactSheet?.height ?? 0,
      slideIds: pages.map((page) => page.slideId),
      slideHashes: pages.map((page) => page.hash)
    },
    renderReport: { path: localPath(outputDir, reportPath), hash: proofByteHash(reportBytes) }
  };
}

export async function buildCreativeVisualProof({
  root,
  pptxPath,
  outputDir,
  evidenceDir,
  manifest,
  review,
  textFit,
  quality,
  repair,
  intermediate = {},
  proofContext = {},
  hostFinalReview = null
}) {
  const proofDir = evidenceDir ?? join(outputDir, "creative-proof");
  const renderDir = join(proofDir, "slides");
  const reportPath = join(proofDir, "render-report.json");
  await mkdir(renderDir, { recursive: true });
  const candidatePptxPath = join(proofDir, "candidate", "final.pptx");
  await mkdir(join(proofDir, "candidate"), { recursive: true });
  if (candidatePptxPath !== pptxPath) await copyFile(pptxPath, candidatePptxPath);
  try {
    await runPython([join(root, "scripts/render-preview.py"), pptxPath, renderDir, "--report", reportPath], { cwd: root });
  } catch (error) {
    try { await readFile(reportPath, "utf8"); } catch { throw error; }
  }
  const preview = JSON.parse(await readFile(reportPath, "utf8"));
  const rendering = await buildRenderingEvidence({ preview, manifest, outputDir, evidenceDir: proofDir, reportPath });
  const ir = proofContext.ir;
  const registry = typeof proofContext.assetRegistry === "function"
    ? await proofContext.assetRegistry(manifest)
    : proofContext.assetRegistry;
  const tokenLedger = buildTokenLedger({ ir, design: proofContext.design, manifest });
  const assetLedger = await buildAssetLedger({ ir, registry, manifest, outputDir });
  const selectionDocument = proofContext.selection ?? null;
  const refinementDocument = proofContext.refinement ?? null;
  const identity = {
    purpose: proofContext.purpose ?? "final-deck",
    semanticIr: { path: "semantic-slide-ir.json", hash: proofContentHash(ir) },
    manifest: { path: "deck.manifest.json", hash: proofContentHash(manifest) },
    pptx: { path: localPath(outputDir, candidatePptxPath), hash: await proofPptxHash(candidatePptxPath) },
    designTokens: { path: "design-system/DESIGN.md", hash: tokenLedger.actualSnapshotHash },
    assetRegistry: { path: "assets/asset-registry.json", hash: proofContentHash(registry) },
    selection: selectionDocument ? { path: "creative-selection.json", hash: proofContentHash(selectionDocument) } : null,
    refinement: refinementDocument ? { path: "refinement-plan.json", hash: proofContentHash(refinementDocument) } : null
  };
  const packet = buildFinalReviewPacket({ identity, rendering });
  await writeFile(join(proofDir, "final-review-packet.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(join(proofDir, "token-ledger.json"), `${JSON.stringify(tokenLedger, null, 2)}\n`, "utf8");
  await writeFile(join(proofDir, "asset-ledger.json"), `${JSON.stringify(assetLedger, null, 2)}\n`, "utf8");
  const selection = selectionDocument
    ? { status: proofContext.selectionValid === true ? "valid" : "invalid", reason: proofContext.selectionValid === true ? "Task 7 selection hashes are valid" : "Task 7 selection is missing or stale", candidateSetHash: proofContext.candidateSet?.candidateSetHash, selectionHash: proofContentHash(selectionDocument), selectedCandidateId: selectionDocument.selectedCandidateId }
    : { status: "not-applicable", reason: "direction exploration did not occur" };
  const diagnostics = buildDiagnostics({ manifest, review, quality, intermediate });
  const suites = buildSuites(ir?.context?.targetSuites, rendering, proofContext.externalSuiteEvidence);
  const criticFindings = (review?.slides ?? []).flatMap((slide) => (slide.issues ?? []).map((finding) => ({
    severity: finding.severity === "critical" ? "P0" : finding.severity === "high" ? "P1" : "P2",
    source: "visual-critic",
    type: finding.type ?? "visual-finding",
    message: finding.message ?? "Visual critic finding",
    slideId: slide.id,
    evidence: ["visual-review.json"]
  })));
  const proof = evaluateCreativeVisualProof({
    identity,
    rendering,
    tokenLedger,
    assetLedger,
    diagnostics,
    hostReview: { packet, review: hostFinalReview },
    selection,
    suites,
    repair: summarizeCreativeRepair(repair),
    refinement: proofContext.refinementState ?? { status: "not-applicable", plan: null, history: [] },
    findings: criticFindings,
    hardGateInputs: {
      schema: true,
      textFit: textFit?.status === "passed" && Number(textFit?.summary?.overflowCount ?? 0) === 0,
      layoutSafety: proofContext.layoutSafety !== false,
      editability: summarizeCreativeQuality(quality).editabilityLevel >= 4,
      visualCritic: !criticFindings.some((finding) => ["P0", "P1"].includes(finding.severity))
    }
  });
  if (proof.hostVisualReview.status === "completed") {
    await writeFile(join(proofDir, "host-visual-review.json"), `${JSON.stringify(hostFinalReview, null, 2)}\n`, "utf8");
  }
  return proof;
}
