import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function commandWorks(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function pythonVersion(command) {
  const args = command === "py" ? ["-3", "--version"] : ["--version"];
  try {
    const result = await execFileAsync(command, args, { timeout: 5000 });
    const text = `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim();
    const match = text.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text };
  } catch {
    return null;
  }
}

function isSupportedPython(version) {
  return version && (version.major > 3 || (version.major === 3 && version.minor >= 10));
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findPython() {
  const explicit = process.env.PPTX_CREATOR_PYTHON || process.env.PYTHON;
  if (explicit) {
    const looksLikePath = explicit.includes("/") || explicit.includes("\\");
    if (looksLikePath && !(await fileExists(explicit))) {
      throw new Error(`Configured Python executable not found: ${explicit}`);
    }
    const version = await pythonVersion(explicit);
    if (!isSupportedPython(version)) {
      throw new Error(`PPTX Creator requires Python 3.10+; configured executable reported ${version?.text ?? "an unsupported version"}`);
    }
    return explicit;
  }

  for (const command of ["python", "python3"]) {
    if (isSupportedPython(await pythonVersion(command))) {
      return command;
    }
  }

  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const codexPython = join(
      home,
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      "python.exe"
    );
    if ((await fileExists(codexPython)) && isSupportedPython(await pythonVersion(codexPython))) {
      return codexPython;
    }
  }

  if (isSupportedPython(await pythonVersion("py"))) {
    return "py";
  }

  throw new Error("Python 3.10+ not found. Set PPTX_CREATOR_PYTHON to a supported executable.");
}

export async function runPython(args, options = {}) {
  const python = await findPython();
  const finalArgs = python === "py" ? ["-3", ...args] : args;
  return execFileAsync(python, finalArgs, options);
}
