import { resolve } from "node:path";
import { SkillError } from "./errors.mjs";
import { validateVisualReview } from "./report-validation.mjs";
import { inside, sha256File, sha256Text } from "./utils.mjs";

function reviewKey(value) {
  return `${value.code}\u0000${value.scope}\u0000${value.source}`;
}

function safeEvidencePath(outputDir, value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new SkillError("E_VISUAL_REVIEW_EVIDENCE", "Preview evidence paths must be non-empty output-relative strings");
  }
  const path = resolve(outputDir, value);
  if (!inside(outputDir, path)) {
    throw new SkillError("E_VISUAL_REVIEW_EVIDENCE", `Preview evidence escapes the output directory: ${value}`);
  }
  return path;
}

export async function buildVisualReviewEvidence(outputDir, qaReport, options = {}) {
  const root = resolve(outputDir);
  const hashFile = options.sha256File ?? sha256File;
  const paths = [
    ...(qaReport?.viewports ?? []).flatMap((viewport) => (viewport.slides ?? []).map((slide) => slide.screenshot)),
    ...(qaReport?.contactSheets ?? []).map((sheet) => sheet.path)
  ].filter(Boolean);
  const artifacts = [];
  for (const path of [...new Set(paths)].sort()) {
    artifacts.push({ path, sha256: await hashFile(safeEvidencePath(root, path)) });
  }
  return {
    scorecardSha256: await hashFile(resolve(root, "visual-scorecard.json")),
    previewDigest: sha256Text(JSON.stringify(artifacts)),
    previewArtifacts: artifacts
  };
}

export async function assessVisualReview({ outputDir, qaReport, scorecard, visualReview }) {
  const warnings = (scorecard?.findings ?? []).filter((finding) => finding.severity === "warning" && finding.hard !== true);
  if ((scorecard?.hardErrors ?? []).length > 0) {
    return {
      status: "blocked",
      required: false,
      blockers: [],
      warnings,
      evidence: null
    };
  }
  if (warnings.length === 0) {
    return { status: "not-required", required: false, blockers: [], warnings: [], evidence: null };
  }

  const evidence = await buildVisualReviewEvidence(outputDir, qaReport);
  if (!visualReview) {
    return {
      status: "required",
      required: true,
      blockers: [{ code: "E_VISUAL_REVIEW_REQUIRED", owner: "host" }],
      warnings,
      evidence
    };
  }
  validateVisualReview(visualReview);
  if (visualReview.bindings.scorecardSha256 !== evidence.scorecardSha256
    || visualReview.bindings.previewDigest !== evidence.previewDigest) {
    return {
      status: "stale",
      required: true,
      blockers: [{ code: "E_VISUAL_REVIEW_STALE", owner: "host" }],
      warnings,
      evidence
    };
  }
  if (visualReview.status !== "approved") {
    return {
      status: "rejected",
      required: true,
      blockers: [{ code: "E_VISUAL_REVIEW_REJECTED", owner: "host" }],
      warnings,
      evidence
    };
  }

  const expected = new Map(warnings.map((warning) => [reviewKey(warning), warning]));
  const supplied = new Map();
  let duplicate = false;
  for (const decision of visualReview.decisions) {
    const key = reviewKey(decision);
    if (supplied.has(key)) duplicate = true;
    supplied.set(key, decision);
  }
  const missing = [...expected.keys()].filter((key) => !supplied.has(key));
  const unexpected = [...supplied.keys()].filter((key) => !expected.has(key));
  if (duplicate || missing.length > 0 || unexpected.length > 0) {
    return {
      status: "incomplete",
      required: true,
      blockers: [{
        code: "E_VISUAL_REVIEW_DECISIONS",
        owner: "host",
        details: { duplicate, missingCount: missing.length, unexpectedCount: unexpected.length }
      }],
      warnings,
      evidence
    };
  }
  return { status: "approved", required: true, blockers: [], warnings, evidence };
}
