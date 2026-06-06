import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPython, runPython } from "./lib/python-utils.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(root, ".pptx-creator");
const smokeDir = join(reportDir, "smoke");

async function run(command, args) {
  try {
    const result = await execFileAsync(command, args, { cwd: root });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

async function checkPlaywright() {
  try {
    const { chromium } = await import("playwright");
    const { access } = await import("node:fs/promises");
    const executablePath = chromium.executablePath();
    await access(executablePath);
    return {
      package: "installed",
      chromium: "ready",
      executablePath
    };
  } catch (error) {
    return {
      package: "unknown",
      chromium: "missing",
      installHint: "npx playwright install chromium",
      note: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkPillow() {
  const result = await runPython(["-c", "import PIL; print(PIL.__version__)"], { cwd: root }).then(
    (value) => ({ ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }),
    (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message })
  );
  return {
    status: result.ok ? "installed" : "missing",
    installHint: "pip install -r requirements.txt",
    version: result.ok ? result.stdout : null,
    note: result.ok ? null : result.stderr
  };
}

async function checkOcr() {
  const result = await runPython([
    "-c",
    "import sys; sys.path.insert(0, 'scripts/lib'); from ocr_core import tesseract_info; import json; print(json.dumps(tesseract_info()))"
  ], { cwd: root }).then(
    (value) => ({ ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }),
    (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message })
  );
  if (!result.ok) {
    return { status: "unknown", note: result.stderr };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: "unknown", note: result.stdout };
  }
}

async function checkLibreOffice() {
  const result = await runPython([
    "-c",
    "import sys; sys.path.insert(0, 'scripts/lib'); from preview_core import libreoffice_status; import json; print(json.dumps(libreoffice_status()))"
  ], { cwd: root }).then(
    (value) => ({ ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }),
    (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message })
  );
  if (!result.ok) {
    return { status: "unknown", note: result.stderr };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: "unknown", note: result.stdout };
  }
}

async function main() {
  await mkdir(smokeDir, { recursive: true });
  const design = join(root, "design-systems/business-neutral/DESIGN.md");
  const manifest = join(root, "examples/text-input/deck.manifest.json");
  const output = join(smokeDir, "final.pptx");
  const pythonPath = await findPython().catch(() => null);
  const python = pythonPath
    ? await runPython(["--version"], { cwd: root }).then(
        (value) => ({ ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }),
        (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message })
      )
    : { ok: false, stdout: "", stderr: "Python not found" };
  const playwright = await checkPlaywright();
  const pillow = await checkPillow();
  const ocr = await checkOcr();
  const libreOffice = await checkLibreOffice();
  const designValidation = await run(process.execPath, [join(root, "scripts/validate-design-md.mjs"), design]);
  const manifestValidation = pythonPath
    ? await runPython([join(root, "scripts/validate-manifest.py"), manifest], { cwd: root }).then(
        (value) => ({ ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }),
        (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message })
      )
    : { ok: false, stdout: "", stderr: "Python not found" };
  const render = await run(process.execPath, [join(root, "scripts/render-pptx.mjs"), manifest, output]);
  const report = {
    node: process.version,
    python: python.ok ? python.stdout || python.stderr : null,
    playwright,
    pillow,
    ocr,
    libreOffice,
    designValidation: designValidation.ok ? "passed" : "failed",
    manifestValidation: manifestValidation.ok ? "passed" : "failed",
    render: render.ok ? "passed" : "failed",
    smokeTest: designValidation.ok && manifestValidation.ok && render.ok ? "passed" : "failed",
    notes: [
      "Playwright Chromium is required for HTML CSS measurement (M1.4).",
      "Tesseract + pytesseract enable local OCR (M1.5); host-agent vision works without them.",
      "LibreOffice headless enables PPTX preview PNGs (M1.5); optional for PPTX output."
    ]
  };
  await writeFile(join(reportDir, "env-report.json"), JSON.stringify(report, null, 2), "utf8");
  if (report.smokeTest !== "passed") {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(report, null, 2));
}

main();
