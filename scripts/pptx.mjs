#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: pptx <text|html|image|pdf|manifest> ...

Routes:
  text <manifest-or-artifact-dir> <output-dir> [--creative]
  html <input.html> <output-dir>
  image <input.png> <analysis.json>
  pdf <input.pdf> <pages-dir> <hints.json>
  manifest <deck.manifest.json> <repair-patch.json> <repaired.manifest.json>`;

function requireCount(route, args, count, usage) {
  if (args.length !== count) throw new Error(`${route}: expected ${usage}`);
}

export function buildInvocation(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { help: true };

  if (command === "text") {
    const creative = rest.includes("--creative");
    const unknownFlags = rest.filter((arg) => arg.startsWith("--") && arg !== "--creative");
    if (unknownFlags.length) throw new Error(`text: unknown option ${unknownFlags[0]}`);
    const positional = rest.filter((arg) => arg !== "--creative");
    requireCount("text", positional, 2, "<manifest-or-artifact-dir> <output-dir> [--creative]");
    return creative
      ? { route: "text", script: "run-design-first-pipeline.mjs", args: positional }
      : { route: "text", script: "run-deck-pipeline.mjs", args: positional };
  }

  if (rest.some((arg) => arg.startsWith("--"))) throw new Error(`${command}: options are not supported`);
  if (command === "html") {
    requireCount("html", rest, 2, "<input.html> <output-dir>");
    return { route: "html-replica", script: "run-html-pipeline.mjs", args: rest };
  }
  if (command === "image") {
    requireCount("image", rest, 2, "<input.png> <analysis.json>");
    return { route: "image-replica", script: "run-python.mjs", args: ["scripts/image-replica-analyze.py", ...rest] };
  }
  if (command === "pdf") {
    requireCount("pdf", rest, 3, "<input.pdf> <pages-dir> <hints.json>");
    return { route: "pdf-replica", script: "run-python.mjs", args: ["scripts/pdf-to-page-hints.py", rest[0], rest[1], "-o", rest[2]] };
  }
  if (command === "manifest") {
    requireCount("manifest", rest, 3, "<deck.manifest.json> <repair-patch.json> <repaired.manifest.json>");
    return { route: "manifest-repair", script: "apply-repair-patch.mjs", args: rest };
  }
  throw new Error(`unknown route: ${command}`);
}

export async function run(argv = process.argv.slice(2)) {
  let invocation;
  try {
    invocation = buildInvocation(argv);
  } catch (error) {
    console.error(error.message);
    console.error(HELP);
    return 1;
  }
  if (invocation.help) {
    console.log(HELP);
    return 0;
  }
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(scriptsDir, invocation.script), ...invocation.args], {
      cwd: resolve(scriptsDir, ".."),
      stdio: "inherit"
    });
    child.once("error", (error) => {
      console.error(error.message);
      resolveExit(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) console.error(`child terminated by ${signal}`);
      resolveExit(code ?? 1);
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = await run();
