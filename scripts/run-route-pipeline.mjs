#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { runHtmlPipeline } from "./run-html-pipeline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runInternal(script, args) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${script} terminated by ${signal}`)) : resolveExit(code ?? 1));
  });
}

export async function runRoutePipeline(route, mode, input, outputDir, options = {}) {
  if (!route || !mode || !input || !outputDir) {
    throw new Error("usage: run-route-pipeline.mjs <text|html|image|pdf> <direct|creative|replica> <input> <output-dir>");
  }
  if (route === "text" && mode === "direct") return runDeckPipeline(input, outputDir, { mode: "direct" });
  if (route === "text" && mode === "creative") {
    const code = await runInternal("run-design-first-pipeline.mjs", [input, outputDir, "--mode", "creative"]);
    if (code !== 0) throw new Error(`creative text pipeline failed with exit ${code}`);
    return { route, mode, outputDir: resolve(outputDir), status: "passed" };
  }
  if (route === "html" && mode === "replica") return runHtmlPipeline(input, outputDir, {
    mode: "replica",
    maxAttempts: 3,
    allowRemoteAssets: options.allowRemoteAssets === true
  });
  if (["image", "pdf"].includes(route) && mode === "replica") {
    throw new Error(`strict ${route} replica pipeline blocked: fidelity proof capability is unavailable until the replica compiler is implemented`);
  }
  throw new Error(`unsupported route/mode: ${route}/${mode}`);
}

const [route, mode, input, outputDir, ...flags] = process.argv.slice(2);
const unknownFlags = flags.filter((flag) => flag !== "--allow-remote-assets");
const routePromise = unknownFlags.length
  ? Promise.reject(new Error(`unknown option: ${unknownFlags[0]}`))
  : runRoutePipeline(route, mode, input, outputDir, { allowRemoteAssets: flags.includes("--allow-remote-assets") });
routePromise.then(
  (summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`),
  (error) => {
    if (error?.summary) console.error(JSON.stringify(error.summary, null, 2));
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
