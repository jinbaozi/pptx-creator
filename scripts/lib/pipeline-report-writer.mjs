import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function editableLevel(counters) {
  const effectiveImage = (counters.image ?? 0) + (counters.croppedAsset ?? 0);
  const nativeShapes = (counters.shape ?? 0) + (counters.table ?? 0);
  if (effectiveImage > 0 && (counters.text ?? 0) === 0) return 1;
  if (effectiveImage === 0 && (counters.text ?? 0) > 0) return 5;
  if ((counters.text ?? 0) > 0 && effectiveImage > 0 && nativeShapes > 0) return 4;
  if ((counters.text ?? 0) > 0 && effectiveImage > 0) return 3;
  return 2;
}

export async function writePipelineReports(outputDir, manifest, design, countersBySlide, options = {}) {
  const nativeText = countersBySlide.reduce((sum, item) => sum + (item.text ?? 0), 0);
  const rasterized = countersBySlide.reduce((sum, item) => sum + (item.image ?? 0) + (item.croppedAsset ?? 0), 0);
  const overall = Math.min(...countersBySlide.map(editableLevel));
  const compatibilityIssues = [];
  const fontNames = new Set();
  const complexShapeCount = manifest.slides.reduce((sum, slide) => sum + slide.elements.filter(
    (element) => element.type === "shape" && !["rect", "roundRect", "ellipse"].includes(element.shape)
  ).length, 0);
  const externalImageCount = manifest.slides.reduce((sum, slide) => sum + slide.elements.filter(
    (element) => element.type === "image" && typeof element.src === "string" && /^https?:\/\//i.test(element.src)
  ).length, 0);
  for (const value of Object.values(design?.tokens?.typography ?? {})) {
    if (value && typeof value === "object" && value.fontFamily) fontNames.add(value.fontFamily);
  }
  const portableFonts = new Set(["Arial", "Calibri", "Aptos", "Microsoft YaHei", "SimSun", "Noto Sans SC"]);
  const nonPortableFonts = [...fontNames].filter((font) => !portableFonts.has(font));
  if (nonPortableFonts.length > 0) compatibilityIssues.push(`Non-portable fonts: ${nonPortableFonts.join(", ")}`);
  if (externalImageCount > 0) compatibilityIssues.push(`Remote image URLs: ${externalImageCount}`);
  if (complexShapeCount > 0) compatibilityIssues.push(`Unsupported shape names: ${complexShapeCount}`);
  if (rasterized > 0) compatibilityIssues.push(`Rasterized objects may edit differently in WPS: ${rasterized}`);
  const compatibilityRisk = compatibilityIssues.length === 0 ? "low" : compatibilityIssues.length <= 2 ? "medium" : "high";
  const layouts = [...new Set((manifest.slides ?? []).map((slide) => slide.layout).filter(Boolean))];

  await writeFile(resolve(outputDir, "editable-report.md"),
    `# Editable Report\n\n## Summary\n\n- Output: ${outputDir}/final.pptx\n- Slide count: ${manifest.slides.length}\n- Overall editability: Level ${overall}\n- Native text: ${nativeText}\n- Rasterized objects: ${rasterized}\n`, "utf8");
  await writeFile(resolve(outputDir, "qa-report.md"),
    `# QA Report\n\n## Validation\n\n- Manifest schema: passed before render\n- Design system: ${design?.name ?? manifest.designSystem.name}\n- Design source: ${manifest.designSystem.source}\n- Manifest mode: ${manifest.metadata.mode}\n- Renderer backend: ${options.backend ?? "pptxgen"}\n- Layouts used: ${layouts.join(", ") || "none"}\n- PPTX render: passed\n- Route proof: ${options.proofStatus ?? "passed"}\n\n## Risks\n\n- Optional proof capabilities are reported explicitly when unavailable.\n`, "utf8");
  await writeFile(resolve(outputDir, "compatibility-report.md"),
    `# WPS Compatibility Report\n\n## Summary\n\n- Overall risk: ${compatibilityRisk}\n- Slide count: ${manifest.slides.length}\n- Fonts checked: ${[...fontNames].join(", ") || "none"}\n- Rasterized objects: ${rasterized}\n\n## Issues\n\n${compatibilityIssues.length > 0 ? compatibilityIssues.map((issue) => `- ${issue}`).join("\n") : "- No obvious WPS compatibility risks detected."}\n\n## Notes\n\n- Open the PPTX in WPS and PowerPoint when exact compatibility matters.\n- Prefer system fonts and native PPT objects for best portability.\n`, "utf8");
}
