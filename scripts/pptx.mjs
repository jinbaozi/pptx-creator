#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: pptx <text|html|image|pdf|manifest> ...

Routes:
  text <deck.html|plan-directory|deck.plan.json> <output-dir> [--creative] [--design-system <path-or-name>]
  text <deck.plan.json|plan-directory> <output-dir> --native [--creative-directions <json>] [--host-review <json>] [--host-final-review <json>] [--refinement-state <json>]
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
    let creative = false;
    let direct = false;
    let native = false;
    let designSystem = null;
    let creativeDirections = null;
    let hostReview = null;
    let hostFinalReview = null;
    let refinementState = null;
    const positional = [];
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index];
      if (argument === "--creative") creative = true;
      else if (argument === "--direct") direct = true;
      else if (argument === "--native") native = true;
      else if (argument === "--design-system") {
        if (designSystem !== null) throw new Error("text: --design-system may be provided only once");
        const value = rest[index + 1];
        if (!value || value.startsWith("--")) throw new Error("text: --design-system requires a value");
        designSystem = value;
        index += 1;
      } else if (["--creative-directions", "--host-review", "--host-final-review", "--refinement-state"].includes(argument)) {
        const key = argument === "--creative-directions" ? "creativeDirections" : argument === "--host-review" ? "hostReview" : argument === "--host-final-review" ? "hostFinalReview" : "refinementState";
        const current = key === "creativeDirections" ? creativeDirections : key === "hostReview" ? hostReview : key === "hostFinalReview" ? hostFinalReview : refinementState;
        if (current !== null) throw new Error(`text: ${argument} may be provided only once`);
        const value = rest[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`text: ${argument} requires a value`);
        if (key === "creativeDirections") creativeDirections = value;
        else if (key === "hostReview") hostReview = value;
        else if (key === "hostFinalReview") hostFinalReview = value;
        else refinementState = value;
        index += 1;
      } else if (argument.startsWith("--")) throw new Error(`text: unknown option ${argument}`);
      else positional.push(argument);
    }
    if (creative && direct) throw new Error("text: --creative and --direct are mutually exclusive");
    if (native && direct) throw new Error("text: --native and --direct are mutually exclusive");
    if (direct && designSystem) throw new Error("text: --design-system is available only for creative mode, not --direct");
    if (direct && (creativeDirections || hostReview || hostFinalReview || refinementState)) throw new Error("text: creative review options are unavailable in --direct mode");
    if (!native && (creativeDirections || hostReview || hostFinalReview || refinementState)) throw new Error("text: Creative Proof sidecars require the explicit --native compatibility route");
    if (hostReview && !creativeDirections) throw new Error("text: --host-review requires --creative-directions");
    requireCount("text", positional, 2, "<deck.html|plan-directory|deck.plan.json> <output-dir> [--design-system <path-or-name>] or <deck.plan.json> <output-dir> --native or <deck.manifest.json> <output-dir> --direct");
    return {
      route: "text",
      script: "run-route-pipeline.mjs",
      args: [
        "text", direct ? "direct" : native ? "creative" : "html-first", ...positional,
        ...(designSystem ? ["--design-system", designSystem] : []),
        ...(creativeDirections ? ["--creative-directions", creativeDirections] : []),
        ...(hostReview ? ["--host-review", hostReview] : []),
        ...(hostFinalReview ? ["--host-final-review", hostFinalReview] : []),
        ...(refinementState ? ["--refinement-state", refinementState] : [])
      ],
      ...(creative ? { warning: "--creative is deprecated because HTML-first text generation is creative by default" } : {})
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
