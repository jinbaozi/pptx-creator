import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function textValue(element) {
  return typeof element.text === "string" ? element.text.trim() : "";
}

function issue(rule, severity, slideId, elementId, message) {
  return { rule, severity, slideId, elementId, message };
}

function collectIssues(manifest) {
  const issues = [];
  for (const slide of manifest.slides ?? []) {
    const elements = slide.elements ?? [];
    const textElements = elements.filter((element) => element.type === "text" && textValue(element));
    if (textElements.length === 0) {
      issues.push(issue("slide-title", "warning", slide.id, null, "Slide has no readable text."));
    }
    const titleLike = textElements.some((element) => /title|heading|headline/i.test(element.id ?? "") || element.h >= 0.45);
    if (!titleLike) {
      issues.push(issue("slide-title", "warning", slide.id, null, "Slide may be missing a title or heading."));
    }
    for (const element of elements) {
      if (element.type === "image" && !element.alt && element.role !== "decorative") {
        issues.push(issue("image-alt", "error", slide.id, element.id, "Image needs alt text or role=decorative."));
      }
      const style = element.style ?? {};
      const fontSize = style.fontSize ?? style.typography?.fontSize;
      if (element.type === "text" && typeof fontSize === "number" && fontSize < 10) {
        issues.push(issue("small-text", "warning", slide.id, element.id, "Text font size is below 10pt."));
      }
      if (element.type === "chart" && !element.description) {
        issues.push(issue("chart-description", "warning", slide.id, element.id, "Chart should include a plain-language description."));
      }
    }
  }
  return issues;
}

function statusFor(issues) {
  if (issues.some((item) => item.severity === "error")) return "review";
  if (issues.length > 0) return "warning";
  return "passed";
}

function markdownReport(report) {
  const rows =
    report.issues.length > 0
      ? report.issues.map((item) => `- [${item.severity}] ${item.slideId}${item.elementId ? `/${item.elementId}` : ""}: ${item.message} (${item.rule})`).join("\n")
      : "- No accessibility issues detected.";
  return `# Accessibility Report

## Summary

- Status: ${report.status}
- Slide count: ${report.slideCount}
- Issues: ${report.issues.length}

## Issues

${rows}

## Notes

- This is a deterministic manifest-level check, not a full screen-reader audit.
- Prefer native text, meaningful image alt text, chart descriptions, and clear slide titles.
`;
}

export async function analyzeAccessibility(manifestPath, outputPath) {
  const resolvedManifest = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
  const issues = collectIssues(manifest);
  const report = {
    version: "0.1.0",
    manifest: resolvedManifest,
    slideCount: manifest.slides?.length ?? 0,
    issues,
    status: statusFor(issues)
  };
  if (outputPath) {
    const resolvedOutput = resolve(outputPath);
    await mkdir(dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, markdownReport(report), "utf8");
  }
  return report;
}

async function main() {
  const [, , manifestArg, outputArg] = process.argv;
  if (!manifestArg) fail("usage: analyze-accessibility.mjs <deck.manifest.json> [accessibility-report.md]");
  const report = await analyzeAccessibility(manifestArg, outputArg);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "review") process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
