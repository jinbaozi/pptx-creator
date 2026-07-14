#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
import { runHtmlPipeline } from "./run-html-pipeline.mjs";
import { runImagePipeline } from "./run-image-pipeline.mjs";

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
    const code = await runInternal("run-design-first-pipeline.mjs", [
      input,
      outputDir,
      "--mode",
      "creative",
      ...(options.designSystem ? ["--design-system", options.designSystem] : []),
      ...(options.creativeDirections ? ["--creative-directions", options.creativeDirections] : []),
      ...(options.hostReview ? ["--host-review", options.hostReview] : []),
      ...(options.hostFinalReview ? ["--host-final-review", options.hostFinalReview] : []),
      ...(options.refinementState ? ["--refinement-state", options.refinementState] : [])
    ]);
    if (code !== 0) throw new Error(`creative text pipeline failed with exit ${code}`);
    return { route, mode, outputDir: resolve(outputDir), status: "passed" };
  }
  if (route === "html" && mode === "replica") return runHtmlPipeline(input, outputDir, {
    mode: "replica",
    maxAttempts: 3,
    allowRemoteAssets: options.allowRemoteAssets === true
  });
  if (route === "image" && mode === "replica") return runImagePipeline(input, outputDir, options);
  if (route === "pdf" && mode === "replica") {
    throw new Error(`strict ${route} replica pipeline blocked: fidelity proof capability is unavailable until the replica compiler is implemented`);
  }
  throw new Error(`unsupported route/mode: ${route}/${mode}`);
}

export function buildRouteInvocation(argv) {
  const [route, mode, input, outputDir, ...flags] = argv;
  if (!route || !mode || !input || !outputDir) {
    throw new Error("usage: run-route-pipeline.mjs <text|html|image|pdf> <direct|creative|replica> <input> <output-dir>");
  }
  let allowRemoteAssets = false;
  let designSystem = null;
  let creativeDirections = null;
  let hostReview = null;
  let hostFinalReview = null;
  let refinementState = null;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--allow-remote-assets") allowRemoteAssets = true;
    else if (flag === "--design-system") {
      if (designSystem !== null) throw new Error("--design-system may be provided only once");
      const value = flags[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--design-system requires a value");
      designSystem = value;
      index += 1;
    } else if (["--creative-directions", "--host-review", "--host-final-review", "--refinement-state"].includes(flag)) {
      const value = flags[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--creative-directions") {
        if (creativeDirections !== null) throw new Error("--creative-directions may be provided only once");
        creativeDirections = value;
      } else if (flag === "--host-review") {
        if (hostReview !== null) throw new Error("--host-review may be provided only once");
        hostReview = value;
      } else if (flag === "--host-final-review") {
        if (hostFinalReview !== null) throw new Error("--host-final-review may be provided only once");
        hostFinalReview = value;
      } else {
        if (refinementState !== null) throw new Error("--refinement-state may be provided only once");
        refinementState = value;
      }
      index += 1;
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (designSystem && (route !== "text" || mode !== "creative")) {
    throw new Error("--design-system is available only for creative text mode");
  }
  if ((creativeDirections || hostReview || hostFinalReview || refinementState) && (route !== "text" || mode !== "creative")) {
    throw new Error("creative review options are available only for creative text mode");
  }
  if (hostReview && !creativeDirections) throw new Error("--host-review requires --creative-directions");
  if (allowRemoteAssets && (route !== "html" || mode !== "replica")) {
    throw new Error("--allow-remote-assets is available only for HTML replica mode");
  }
  return { route, mode, input, outputDir, options: {
    designSystem,
    allowRemoteAssets,
    ...(creativeDirections ? { creativeDirections } : {}),
    ...(hostReview ? { hostReview } : {}),
    ...(hostFinalReview ? { hostFinalReview } : {}),
    ...(refinementState ? { refinementState } : {})
  } };
}

export async function run(argv = process.argv.slice(2)) {
  const invocation = buildRouteInvocation(argv);
  return runRoutePipeline(invocation.route, invocation.mode, invocation.input, invocation.outputDir, invocation.options);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  run().then(
    (summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`),
    (error) => {
      if (error?.summary) console.error(JSON.stringify(error.summary, null, 2));
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
