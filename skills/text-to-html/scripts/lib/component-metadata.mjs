import { escapeHtml } from "./utils.mjs";

export const STATUS_LABELS = Object.freeze({
  inferred: "假设",
  unverified: "待核验",
  placeholder: "占位"
});

export function componentAttrs(id, kind = "text", extra = "", metadata = {}) {
  const typeTier = metadata.typeTier ?? (kind === "text" ? "body" : "none");
  const qaRegion = metadata.qaRegion ?? "content";
  return `data-pptx-id="${escapeHtml(id)}" data-pptx-kind="${escapeHtml(kind)}" data-type-tier="${escapeHtml(typeTier)}" data-qa-region="${escapeHtml(qaRegion)}"${extra ? ` ${extra}` : ""}`;
}

export function claimText(claim, visibleText = claim.text) {
  const label = STATUS_LABELS[claim.factStatus];
  return `${label ? `<span class="status-label">${label}</span>` : ""}<span>${escapeHtml(visibleText)}</span>`;
}

export function claimAttrs(claim) {
  return `data-fact-status="${escapeHtml(claim.factStatus)}" data-source-ids="${escapeHtml((claim.sourceRefs ?? []).join(" "))}"`;
}
