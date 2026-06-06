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
  if (explicit && (await fileExists(explicit))) {
    return explicit;
  }

  for (const command of ["python", "python3"]) {
    if (await commandWorks(command)) {
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
    if (await fileExists(codexPython)) {
      return codexPython;
    }
  }

  if (await commandWorks("py", ["-3", "--version"])) {
    return "py";
  }

  throw new Error("Python not found. Set PPTX_CREATOR_PYTHON to a Python 3 executable.");
}

export async function runPython(args, options = {}) {
  const python = await findPython();
  const finalArgs = python === "py" ? ["-3", ...args] : args;
  return execFileAsync(python, finalArgs, options);
}
