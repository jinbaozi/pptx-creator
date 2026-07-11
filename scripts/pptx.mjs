#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: pptx <text|html|image|pdf|manifest> ...

Routes:
  text <deck.plan.json|plan-directory> <output-dir> [--creative]
  text <deck.manifest.json> <output-dir> --direct
  html <input.html> <output-dir> [--allow-remote-assets]
  image <input.png> <output-dir>
  pdf <input.pdf> <output-dir>
  manifest <deck.manifest.json> <repair-patch.json> <repaired.manifest.json>`;

function requireCount(route, args, count, usage) {
  if (args.length !== count) throw new Error(`${route}: expected ${usage}`);
}

export function buildInvocation(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { help: true };

  if (command === "text") {
    const creative = rest.includes("--creative");
    const direct = rest.includes("--direct");
    if (creative && direct) throw new Error("text: --creative and --direct are mutually exclusive");
    const unknownFlags = rest.filter((arg) => arg.startsWith("--") && !["--creative", "--direct"].includes(arg));
    if (unknownFlags.length) throw new Error(`text: unknown option ${unknownFlags[0]}`);
    const positional = rest.filter((arg) => !["--creative", "--direct"].includes(arg));
    requireCount("text", positional, 2, "<deck.plan.json|plan-directory> <output-dir> [--creative] or <deck.manifest.json> <output-dir> --direct");
    return {
      route: "text",
      script: "run-route-pipeline.mjs",
      args: ["text", direct ? "direct" : "creative", ...positional],
      ...(creative ? { warning: "--creative is deprecated because text generation is creative by default" } : {})
    };
  }

  if (command === "html") {
    const allowRemoteAssets = rest.includes("--allow-remote-assets");
    const unknownFlags = rest.filter((arg) => arg.startsWith("--") && arg !== "--allow-remote-assets");
    if (unknownFlags.length) throw new Error(`html: unknown option ${unknownFlags[0]}`);
    const positional = rest.filter((arg) => arg !== "--allow-remote-assets");
    requireCount("html", positional, 2, "<input.html> <output-dir> [--allow-remote-assets]");
    return {
      route: "html-replica",
      script: "run-route-pipeline.mjs",
      args: ["html", "replica", ...positional, ...(allowRemoteAssets ? ["--allow-remote-assets"] : [])]
    };
  }
  if (rest.some((arg) => arg.startsWith("--"))) throw new Error(`${command}: options are not supported`);
  if (command === "image") {
    requireCount("image", rest, 2, "<input.png> <output-dir>");
    return { route: "image-replica", script: "run-route-pipeline.mjs", args: ["image", "replica", ...rest] };
  }
  if (command === "pdf") {
    requireCount("pdf", rest, 2, "<input.pdf> <output-dir>");
    return { route: "pdf-replica", script: "run-route-pipeline.mjs", args: ["pdf", "replica", ...rest] };
  }
  if (command === "manifest") {
    requireCount("manifest", rest, 3, "<deck.manifest.json> <repair-patch.json> <repaired.manifest.json>");
    return { route: "manifest-repair", script: "run-manifest-repair.mjs", args: rest };
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
  if (invocation.warning) console.error(`warning: ${invocation.warning}`);
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
