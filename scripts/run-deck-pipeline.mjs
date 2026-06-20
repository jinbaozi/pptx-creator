/**
 * End-to-end deterministic pipeline: validate manifest → render PPTX → package output.
 * Host agent must author deck.manifest.json before invoking this script.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runPython } from "./lib/python-utils.mjs";
import { buildConsistencyReport } from "./lib/consistency-report-writer.mjs";
import { preflightFonts } from "./lib/font-preflight.mjs";
import { parseDesignFile } from "./parse-design-md.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function runStep(label, command, args) {
  try {
    const result = await execFileAsync(command, args, { cwd: root });
    return { label, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      label,
      ok: false,
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? error.message
    };
  }
}

async function runPythonStep(label, args) {
  try {
    const result = await runPython(args, { cwd: root });
    return { label, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      label,
      ok: false,
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? error.message
    };
  }
}

async function detectLibreOffice() {
  for (const binary of ["libreoffice", "soffice"]) {
    try {
      await execFileAsync("which", [binary]);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

export async function runDeckPipeline(manifestPath, outputDir, options = {}) {
  const resolvedManifest = resolve(manifestPath);
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });

  const inputType = options.inputType ?? "unknown";
  const inputSource = options.inputSource ?? resolvedManifest;

  const steps = [];
  steps.push(await runPythonStep("validate-manifest", [join(root, "scripts/validate-manifest.py"), resolvedManifest]));

  const pptxPath = join(resolvedOutput, "final.pptx");
  const renderResult = await runStep("render-pptx", process.execPath, [
    join(root, "scripts/render-pptx.mjs"),
    resolvedManifest,
    pptxPath
  ]);
  steps.push(renderResult);

  let intermediate = {
    sourceCoordinates: [],
    fontNames: [],
    paletteMatches: [],
    paletteUnmapped: [],
    inlineColors: [],
    editabilityCounter: { text: 0, shape: 0, image: 0, table: 0, croppedAsset: 0 },
    preview: { libreofficeAvailable: false, status: "deferred" },
    layoutPaths: {},
    inputHints: {}
  };
  if (renderResult.ok) {
    try {
      const parsed = JSON.parse(renderResult.stdout);
      if (parsed && parsed.intermediate && typeof parsed.intermediate === "object") {
        intermediate = { ...intermediate, ...parsed.intermediate };
      }
    } catch {
      // Render succeeded but emitted no JSON; intermediate stays as defaults.
    }
  }

  // Hoisted manifest read — shared by preflight-fonts and consistency-report.
  let manifestJson;
  try {
    manifestJson = JSON.parse(await readFile(resolvedManifest, "utf8"));
  } catch {
    manifestJson = null;
  }

  // preflight-fonts: populate intermediate.fontNames / .fontFallback
  let preflightResult;
  try {
    if (!manifestJson) throw new Error("failed to parse deck.manifest.json");
    let design = null;
    if (manifestJson.designSystem && manifestJson.designSystem.source) {
      const baseDir = dirname(resolvedManifest);
      try {
        design = await parseDesignFile(resolve(baseDir, manifestJson.designSystem.source));
      } catch {
        design = null;
      }
    }
    const preflight = await preflightFonts(manifestJson, design);
    const fallbackEntries = (preflight.fallback ?? []).map((entry) => ({
      element: "design-tokens",
      requested: entry.requested,
      fallback: entry.fallback
    }));
    intermediate.fontNames = fallbackEntries;
    intermediate.fontFallback = preflight.fallback ?? [];
    preflightResult = { label: "preflight-fonts", ok: true, stdout: preflight.source, stderr: "" };
  } catch (error) {
    preflightResult = {
      label: "preflight-fonts",
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
  steps.push(preflightResult);

  // preview-diff: LibreOffice-gated
  const libreofficeAvailable = await detectLibreOffice();
  intermediate.preview = libreofficeAvailable
    ? { libreofficeAvailable: true, status: "deferred" }
    : { libreofficeAvailable: false, status: "deferred" };
  const previewStep = {
    label: "preview-diff",
    ok: true,
    stdout: libreofficeAvailable ? "libreoffice-detected" : "libreoffice-missing",
    stderr: ""
  };
  steps.push(previewStep);

  // consistency-report: always emitted (previewDiff deferred when LO missing)
  try {
    if (!manifestJson) throw new Error("failed to parse deck.manifest.json");
    const { json, md } = buildConsistencyReport(manifestJson, intermediate, { inputType, inputSource });
    await writeFile(join(resolvedOutput, "consistency-report.json"), json + "\n", "utf8");
    await writeFile(join(resolvedOutput, "consistency-report.md"), md + "\n", "utf8");
    steps.push({ label: "consistency-report", ok: true, stdout: "written", stderr: "" });
  } catch (error) {
    steps.push({
      label: "consistency-report",
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    });
  }

  if (options.copyManifest !== false) {
    await copyFile(resolvedManifest, join(resolvedOutput, "deck.manifest.json"));
  }

  steps.push(await runPythonStep("package-output", [join(root, "scripts/package-output.py"), resolvedOutput]));

  const failed = steps.find((step) => !step.ok);
  const summary = {
    manifest: resolvedManifest,
    outputDir: resolvedOutput,
    steps: steps.map(({ label, ok }) => ({ label, ok })),
    status: failed ? "failed" : "passed"
  };

  if (failed) {
    const error = new Error(`pipeline failed at ${failed.label}: ${failed.stderr || failed.stdout}`);
    error.summary = summary;
    throw error;
  }

  return summary;
}

async function main() {
  const manifestArg = process.argv[2];
  const outputArg = process.argv[3] ?? "output";
  if (!manifestArg) {
    fail("usage: run-deck-pipeline.mjs <deck.manifest.json> [output-dir]");
  }

  try {
    const summary = await runDeckPipeline(manifestArg, outputArg);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    if (error.summary) {
      console.error(JSON.stringify(error.summary, null, 2));
    }
    fail(error instanceof Error ? error.message : String(error));
  }
}

const invokedDirectly =
  process.argv[1] &&
  (import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href ||
    import.meta.url === new URL(`file:///${resolve(process.argv[1]).replace(/\\/g, "/")}`).href);

if (invokedDirectly) {
  main();
}
