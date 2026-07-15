import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { repairHtmlLayout } from "./lib/html-layout-repair.mjs";
import { runHtmlPipeline } from "./run-html-pipeline.mjs";

async function regularFile(path) {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveTextHtmlInput(inputPath) {
  const input = resolve(inputPath);
  let inputStat;
  try { inputStat = await stat(input); } catch {
    throw new Error(`text HTML-first input does not exist: ${input}`);
  }
  const candidates = [];
  if (inputStat.isDirectory()) {
    candidates.push(join(input, "deck.html"), join(input, "visual-source.html"));
  } else if (inputStat.isFile() && extname(input).toLowerCase() === ".html") {
    candidates.push(input);
  } else if (inputStat.isFile()) {
    candidates.push(join(dirname(input), "deck.html"), join(dirname(input), "visual-source.html"));
  }
  for (const candidate of candidates) {
    if (await regularFile(candidate)) return resolve(candidate);
  }
  throw new Error(
    "text generation is HTML-first by default: author deck.html (or visual-source.html) beside the input, "
    + "or pass --native to use the legacy Semantic Slide IR compiler"
  );
}

export async function runTextHtmlPipeline(inputPath, outputDir, options = {}) {
  const htmlInput = await resolveTextHtmlInput(inputPath);
  const output = resolve(outputDir);
  await mkdir(output, { recursive: true });

  // Freeze the Host-authored visual source before deterministic repair. The
  // repaired HTML becomes the strict replica source proved against the PPTX.
  const sourcePath = join(output, "deck.source.html");
  await writeFile(sourcePath, await readFile(htmlInput, "utf8"), "utf8");
  const repaired = await repairHtmlLayout(sourcePath, output, {
    maxAttempts: options.maxAttempts ?? 3,
    screenshots: true
  });
  if (repaired.report.summary.status !== "passed") {
    throw new Error(`HTML authoring proof blocked with ${repaired.report.summary.criticalRemaining} critical issue(s)`);
  }

  const summary = await runHtmlPipeline(repaired.repairedPath, output, {
    mode: "replica",
    maxAttempts: options.maxAttempts ?? 3,
    designSystem: options.designSystem,
    protectedInputs: [sourcePath, repaired.repairedPath, repaired.reportPath],
    replicaSourcePath: repaired.repairedPath,
    replicaPolicyRoute: "html-editable"
  });
  const textSummary = {
    ...summary,
    route: "text",
    mode: "html-first",
    sourceHtml: sourcePath,
    replicaHtml: repaired.repairedPath,
    htmlRepairReport: repaired.reportPath
  };
  await writeFile(join(output, "text-html-pipeline-summary.json"), `${JSON.stringify(textSummary, null, 2)}\n`, "utf8");
  return textSummary;
}
