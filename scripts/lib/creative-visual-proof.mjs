import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPython } from "./python-utils.mjs";

const issue = (type, message, slideId = null) => ({ type, message, ...(slideId ? { slideId } : {}) });

export function evaluateCreativeVisualProof({ manifest = {}, preview = {}, review = {}, textFit = null } = {}) {
  const expectedSlides = manifest.slides?.length ?? 0;
  const decorativeBackgroundLines = (manifest.slides ?? []).reduce((count, slide) => count + (slide.elements ?? []).filter(
    (element) => element?.type === "line" && (element.role === "decorative" || /(?:background-)?grid/i.test(element.id ?? ""))
  ).length, 0);
  const renderedSlides = preview.previewCount ?? preview.previews?.length ?? 0;
  const p0 = [];
  const p1 = [];
  const p2 = [];
  if (preview.status !== "ok") p0.push(issue("render-unavailable", `LibreOffice slide evidence is ${preview.status ?? "missing"}`));
  if (renderedSlides !== expectedSlides) p0.push(issue("render-page-count", `Rendered ${renderedSlides} of ${expectedSlides} expected slides`));
  if (preview.status === "ok" && (!preview.contactSheet || preview.contactSheet.slideCount !== expectedSlides)) {
    p0.push(issue("contact-sheet-incomplete", "Contact sheet does not cover every rendered slide"));
  }
  if (!textFit || textFit.status === "unavailable") {
    p1.push(issue("text-fit-unavailable", "Deterministic text-fit evidence is unavailable."));
  } else if (textFit.status !== "passed" || Number(textFit.summary?.overflowCount ?? 0) > 0) {
    p1.push(issue("text-overflow", `Text-fit evidence reports ${Number(textFit.summary?.overflowCount ?? 0)} overflowing element(s).`));
  }
  for (const slide of review.slides ?? []) {
    for (const finding of slide.issues ?? []) {
      const normalized = issue(finding.type ?? "visual-finding", finding.message ?? "Visual finding", slide.id);
      if (["critical"].includes(finding.severity)) p0.push(normalized);
      else if (["high"].includes(finding.severity)) p1.push(normalized);
      else p2.push(normalized);
    }
  }
  return {
    version: "0.1.0",
    mode: "creative",
    accepted: p0.length === 0 && p1.length === 0,
    expectedSlides,
    renderedSlides,
    decorativeBackgroundLines,
    previews: preview.previews ?? [],
    contactSheet: preview.contactSheet ?? null,
    textFit: textFit ? {
      status: textFit.status,
      source: textFit.source,
      summary: textFit.summary
    } : {
      status: "unavailable",
      source: "unavailable",
      summary: { checked: 0, overflowCount: 0 }
    },
    p0,
    p1,
    p2
  };
}

export async function buildCreativeVisualProof({ root, pptxPath, outputDir, manifest, review, textFit }) {
  const renderDir = join(outputDir, "creative-proof", "slides");
  const reportPath = join(outputDir, "creative-proof", "render-report.json");
  await mkdir(renderDir, { recursive: true });
  await runPython([join(root, "scripts/render-preview.py"), pptxPath, renderDir, "--report", reportPath], { cwd: root });
  const preview = JSON.parse(await readFile(reportPath, "utf8"));
  return evaluateCreativeVisualProof({ manifest, preview, review, textFit });
}
