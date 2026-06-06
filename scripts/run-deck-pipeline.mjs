/**
 * End-to-end deterministic pipeline: validate manifest → render PPTX → package output.
 * Host agent must author deck.manifest.json before invoking this script.
 */
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runPython } from "./lib/python-utils.mjs";

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

export async function runDeckPipeline(manifestPath, outputDir, options = {}) {
  const resolvedManifest = resolve(manifestPath);
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });

  const steps = [];
  steps.push(await runPythonStep("validate-manifest", [join(root, "scripts/validate-manifest.py"), resolvedManifest]));

  const pptxPath = join(resolvedOutput, "final.pptx");
  steps.push(
    await runStep("render-pptx", process.execPath, [join(root, "scripts/render-pptx.mjs"), resolvedManifest, pptxPath])
  );

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
