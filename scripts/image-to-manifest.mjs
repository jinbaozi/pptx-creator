#!/usr/bin/env node
// scripts/image-to-manifest.mjs
//
// Unified entry point for image-driven manifest authoring. Auto-detects between
// two first-class flows:
//
//   * creative hints flow  -> scripts/image-to-manifest-hints.py
//   * replica flow         -> scripts/image-replica-analyze.py + scripts/image-replica-plan.py
//
// Both flows are first-class. The wrapper emits a `deck.manifest.skeleton.json`
// in the output directory and (for replica mode) a paired
// `image-replica-analysis.json` + `replica-layer-plan.json`. Multi-image input
// (a directory of PNGs) produces one manifest where each PNG becomes a slide,
// with `designSystem` and `deck.size` kept consistent across the deck.
//
// Invocation patterns:
//
//   # single image, default creative hints flow
//   node scripts/image-to-manifest.mjs --input examples/image-input/business-slide.png \
//                                       --output output/image-deck
//
//   # single image, replica flow with custom OCR confidence
//   node scripts/image-to-manifest.mjs --mode replica --input ref.png --output output/replica \
//                                       --ocr-confidence 0.6
//
//   # multi-image: a directory of PNGs, one slide each
//   node scripts/image-to-manifest.mjs --mode creative --input examples/image-batch --output output/batch
//
//   # auto-detect mode: dispatch to replica when --mode auto + low color variance / text-heavy
//   node scripts/image-to-manifest.mjs --mode auto --input ref.png --output output/auto

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runPython } from "./lib/python-utils.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = resolve(packageRoot, "scripts");
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const HELP_TEXT = `usage: image-to-manifest.mjs --input <file|dir> --output <dir> [options]

Unified entry point for image-driven manifest authoring. Two first-class flows:

  creative  -> scripts/image-to-manifest-hints.py
               Emits image-hints.json + a manifest skeleton. Fast, deterministic,
               designed for design-first or single-image creative decks.

  replica   -> scripts/image-replica-analyze.py + scripts/image-replica-plan.py
               Emits image-replica-analysis.json + replica-layer-plan.json + a
               manifest skeleton. Targets higher-fidelity reconstruction and
               Level 3-4 editability.

  auto      -> Same as creative for v1. (Future: pick replica when the image
               looks low-variance / text-heavy.) Documented to preserve the
               existing single-image behavior.

Options:
  --mode <replica|creative|auto>   Pipeline to run. Default: creative.
  --input <file|dir>               Single image (PNG/JPEG/etc) or a directory of PNGs.
  --output <dir>                   Output directory for artifacts.
  --multi                          Enable multi-image flow when --input is a directory.
                                   Default: on when --input resolves to a directory.
  --ocr-confidence <0-1>           Pass through to image-replica-plan when --mode replica.
                                   Default: 0.7. Calibrated in U10.
  --deck-title <string>            Override the deck title (otherwise derived from
                                   the image filename / first slide).
  --preset <wide|narrow|...>       Slide size preset forwarded to hints/replica.
                                   Default: wide.
  --palette-count <int>            Number of palette colors. Default: 6 (creative) /
                                   8 (replica).
  --help                           Print this message and exit.
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    mode: "creative",
    input: null,
    output: null,
    multi: null, // null = auto-detect from input path
    ocrConfidence: 0.7,
    deckTitle: null,
    preset: "wide",
    paletteCount: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = String(argv[i + 1] ?? "").toLowerCase();
      if (!["replica", "creative", "auto"].includes(value)) {
        fail(`invalid --mode value: ${argv[i + 1]} (expected replica | creative | auto)`);
      }
      options.mode = value;
      i += 1;
    } else if (arg === "--input") {
      options.input = argv[i + 1];
      i += 1;
    } else if (arg === "--output") {
      options.output = argv[i + 1];
      i += 1;
    } else if (arg === "--multi") {
      options.multi = true;
    } else if (arg === "--no-multi") {
      options.multi = false;
    } else if (arg === "--ocr-confidence") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        fail(`invalid --ocr-confidence value: ${argv[i + 1]} (expected 0..1)`);
      }
      options.ocrConfidence = value;
      i += 1;
    } else if (arg === "--deck-title") {
      options.deckTitle = argv[i + 1];
      i += 1;
    } else if (arg === "--preset") {
      options.preset = argv[i + 1];
      i += 1;
    } else if (arg === "--palette-count") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 12) {
        fail(`invalid --palette-count value: ${argv[i + 1]} (expected integer 1..12)`);
      }
      options.paletteCount = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      fail(`unknown flag: ${arg}`);
    } else {
      fail(`unexpected positional argument: ${arg}`);
    }
  }
  if (!options.input) fail("--input is required (image file or directory)");
  if (!options.output) fail("--output is required (output directory)");
  return options;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function listImages(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTS.has(extname(entry.name).toLowerCase()))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

// Probe whether a Python CLI accepts a flag by inspecting --help output.
async function pythonCliSupportsFlag(scriptRelPath, flag) {
  try {
    const { stdout } = await runPython([resolve(SCRIPTS_DIR, scriptRelPath), "--help"], {
      cwd: packageRoot
    });
    return stdout.includes(` ${flag}`) || stdout.includes(`${flag} `) || stdout.includes(`${flag}\n`);
  } catch (error) {
    const combined = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    return combined.includes(` ${flag}`) || combined.includes(`${flag} `) || combined.includes(`${flag}\n`);
  }
}

async function runCreativeHints({ imagePath, outputDir, preset, paletteCount, deckTitle }) {
  const args = [resolve(SCRIPTS_DIR, "image-to-manifest-hints.py")];
  args.push(imagePath);
  const hintsPath = resolve(outputDir, "image-hints.json");
  args.push(hintsPath);
  args.push("--preset", preset);
  if (paletteCount) args.push("--palette-count", String(paletteCount));
  if (deckTitle) args.push("--deck-title", deckTitle);

  await runPython(args, { cwd: packageRoot });
  const data = JSON.parse(await readFile(hintsPath, "utf8"));
  return { hintsPath, data };
}

async function runReplicaFlow({ imagePath, outputDir, preset, paletteCount, deckTitle, ocrConfidence }) {
  // Step 1: image-replica-analyze.py
  const analysisPath = resolve(outputDir, "image-replica-analysis.json");
  const analyzeArgs = [
    resolve(SCRIPTS_DIR, "image-replica-analyze.py"),
    imagePath,
    analysisPath,
    "--preset",
    preset
  ];
  if (paletteCount) analyzeArgs.push("--palette-count", String(paletteCount));
  if (deckTitle) analyzeArgs.push("--deck-title", deckTitle);
  await runPython(analyzeArgs, { cwd: packageRoot });

  // Step 2: image-replica-plan.py — optionally forward --ocr-confidence.
  const planPath = resolve(outputDir, "replica-layer-plan.json");
  const planArgs = [resolve(SCRIPTS_DIR, "image-replica-plan.py"), analysisPath, planPath];
  const replicaPlanSupportsOcr = await pythonCliSupportsFlag("image-replica-plan.py", "--ocr-confidence");
  if (replicaPlanSupportsOcr) {
    planArgs.push("--ocr-confidence", String(ocrConfidence));
  }
  await runPython(planArgs, { cwd: packageRoot });

  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  const plan = JSON.parse(await readFile(planPath, "utf8"));

  // Step 3: also emit a hints JSON so downstream readers see a consistent shape.
  const hintsPath = resolve(outputDir, "image-hints.json");
  const { data: hintsData } = await runCreativeHints({
    imagePath,
    outputDir,
    preset,
    paletteCount,
    deckTitle
  });
  // Save the hints under the canonical name but keep the original returned path stable.
  await writeFile(hintsPath, JSON.stringify(hintsData, null, 2));
  return { analysisPath, planPath, hintsPath, analysis, plan, hints: hintsData, replicaPlanSupportsOcr };
}

function deriveSlideId(imagePath, fallbackIndex) {
  const base = basename(imagePath) || `slide-${fallbackIndex}`;
  const stem = base.replace(/\.[^.]+$/, "");
  return `slide-${stem || fallbackIndex}`;
}

function buildSlideSkeleton({ imagePath, slideIndex, mode, data, hints }) {
  const skeleton = hints?.manifestSkeleton;
  const slideFromHints = skeleton?.slides?.[0];
  const slideId = deriveSlideId(imagePath, slideIndex);
  const title = hints?.designSystemSuggestion?.id
    ? `${slideId} (${hints.designSystemSuggestion.id})`
    : slideId;
  if (slideFromHints && typeof slideFromHints === "object") {
    return {
      ...slideFromHints,
      id: slideId,
      title: slideFromHints.title ?? title,
      notes:
        slideFromHints.notes ??
        `Skeleton from ${mode} flow for ${imagePath}. Host agent must replace placeholders.`,
      sourceImage: basename(imagePath)
    };
  }
  // Fallback: synthesize a minimal slide when the upstream didn't emit a skeleton.
  return {
    id: slideId,
    type: "content",
    title,
    notes: `Skeleton from ${mode} flow for ${imagePath}.`,
    background: { type: "solid", color: "{colors.background}" },
    elements: [],
    sourceImage: basename(imagePath)
  };
}

function mergeMultiImageManifest({ mode, images, slideRecords, designSystem, deckSize, deckTitle }) {
  const slides = slideRecords.map(({ slide, imagePath }, idx) => ({
    ...slide,
    id: `slide-${String(idx + 1).padStart(3, "0")}-${basename(imagePath).replace(/\.[^.]+$/, "") ?? idx}`
  }));
  return {
    version: "0.1.1",
    designSystem,
    deck: {
      title: deckTitle,
      language: "zh-CN",
      size: deckSize
    },
    assets: images.map((imagePath, idx) => ({
      id: `source-slide-${String(idx + 1).padStart(3, "0")}`,
      src: basename(imagePath),
      role: "reference",
      note: `Reference screenshot ${idx + 1}; remove from final manifest unless needed as cropped asset.`
    })),
    slides,
    _skeleton: true,
    _generator: {
      wrapper: "image-to-manifest.mjs",
      mode,
      multiImage: true,
      slideCount: slides.length
    }
  };
}

function singleImageManifest({ mode, imagePath, slide, designSystem, deckSize, deckTitle, ocrConfidence }) {
  const fileName = basename(imagePath);
  return {
    version: "0.1.1",
    designSystem,
    deck: {
      title: deckTitle,
      language: "zh-CN",
      size: deckSize
    },
    assets: [
      {
        id: "source-slide",
        src: fileName,
        role: "reference",
        note: "Reference screenshot; remove from final manifest unless needed as cropped asset."
      }
    ],
    slides: [slide],
    _skeleton: true,
    _generator: {
      wrapper: "image-to-manifest.mjs",
      mode,
      multiImage: false,
      ocrConfidence: mode === "replica" ? ocrConfidence : undefined
    }
  };
}

function pickDesignSystemFromHints(hints) {
  const suggestion = hints?.designSystemSuggestion ?? {};
  const id = suggestion.id ?? "business-neutral";
  return {
    source: `../../design-systems/${id}/DESIGN.md`,
    name: id,
    mode: "balanced"
  };
}

function pickDeckSizeFromHints(hints) {
  const mapping = hints?.slideMapping ?? { preset: "wide", widthIn: 13.333, heightIn: 7.5, unit: "in" };
  return {
    preset: mapping.preset,
    width: mapping.widthIn,
    height: mapping.heightIn,
    unit: mapping.unit
  };
}

async function detectReplicaHeuristic(imagePath) {
  // Lightweight stdlib-only PNG IHDR probe for aspect-ratio heuristic. v1 is
  // intentionally conservative: wide banner aspect ratios suggest a slide
  // replica; everything else falls back to creative.
  try {
    const script = `
const fs = require("node:fs");
const buf = fs.readFileSync(${JSON.stringify(imagePath)});
if (buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  console.log(JSON.stringify({ ok: false }));
  process.exit(0);
}
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
console.log(JSON.stringify({ ok: true, width, height }));
`;
    const { stdout } = await execFileAsync(process.execPath, ["-e", script]);
    const parsed = JSON.parse(stdout.trim().split("\n").pop());
    if (!parsed.ok) return false;
    const ratio = parsed.width / Math.max(1, parsed.height);
    return ratio >= 1.6;
  } catch {
    return false;
  }
}

async function resolveMode(options, inputIsDirectory) {
  if (options.mode !== "auto") return options.mode;
  if (inputIsDirectory) return "creative";
  return (await detectReplicaHeuristic(options.input)) ? "replica" : "creative";
}

async function runSingleImageFlow({ imagePath, outputDir, mode, ocrConfidence, deckTitle, preset, paletteCount }) {
  await mkdir(outputDir, { recursive: true });
  if (mode === "replica") {
    const replica = await runReplicaFlow({
      imagePath,
      outputDir,
      preset,
      paletteCount,
      deckTitle,
      ocrConfidence
    });
    return { mode, hints: replica.hints, analysis: replica.analysis, plan: replica.plan };
  }
  const creative = await runCreativeHints({ imagePath, outputDir, preset, paletteCount, deckTitle });
  return { mode, hints: creative.data };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(options.input);
  if (!(await pathExists(inputPath))) {
    fail(`input not found: ${inputPath}`);
  }
  await mkdir(resolve(options.output), { recursive: true });

  const inputIsDirectory = await isDirectory(inputPath);
  const shouldMulti = options.multi === null ? inputIsDirectory : Boolean(options.multi);
  const effectiveMode = await resolveMode(options, inputIsDirectory);
  const resolvedPaletteCount = options.paletteCount ?? (effectiveMode === "replica" ? 8 : 6);
  const resolvedDeckTitle =
    options.deckTitle ??
    (inputIsDirectory && shouldMulti
      ? "Image Batch Deck"
      : basename(inputPath).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ") || "Image Deck");

  if (inputIsDirectory && shouldMulti) {
    const images = await listImages(inputPath);
    if (images.length === 0) {
      fail(`no images found in directory: ${inputPath}`);
    }
    const slideRecords = [];
    let aggregateDesignSystem = null;
    let aggregateDeckSize = null;
    for (let idx = 0; idx < images.length; idx += 1) {
      const imagePath = images[idx];
      const perImageDir = resolve(options.output, `slide-${String(idx + 1).padStart(3, "0")}`);
      const record = await runSingleImageFlow({
        imagePath,
        outputDir: perImageDir,
        mode: effectiveMode,
        ocrConfidence: options.ocrConfidence,
        deckTitle: `${resolvedDeckTitle} ${idx + 1}`,
        preset: options.preset,
        paletteCount: resolvedPaletteCount
      });
      const design = pickDesignSystemFromHints(record.hints);
      const deckSize = pickDeckSizeFromHints(record.hints);
      if (!aggregateDesignSystem) aggregateDesignSystem = design;
      if (!aggregateDeckSize) aggregateDeckSize = deckSize;
      slideRecords.push({
        imagePath,
        slide: buildSlideSkeleton({
          imagePath,
          slideIndex: idx + 1,
          mode: effectiveMode,
          data: record,
          hints: record.hints
        })
      });
    }
    const finalManifest = mergeMultiImageManifest({
      mode: effectiveMode,
      images,
      slideRecords,
      designSystem: aggregateDesignSystem,
      deckSize: aggregateDeckSize,
      deckTitle: resolvedDeckTitle
    });
    const manifestPath = resolve(options.output, "deck.manifest.skeleton.json");
    await writeFile(manifestPath, JSON.stringify(finalManifest, null, 2));
    console.log(
      JSON.stringify(
        {
          manifestPath,
          mode: effectiveMode,
          multiImage: true,
          slideCount: finalManifest.slides.length,
          designSystem: finalManifest.designSystem.name,
          deckSize: finalManifest.deck.size
        },
        null,
        2
      )
    );
    return;
  }

  const record = await runSingleImageFlow({
    imagePath: inputPath,
    outputDir: resolve(options.output),
    mode: effectiveMode,
    ocrConfidence: options.ocrConfidence,
    deckTitle: resolvedDeckTitle,
    preset: options.preset,
    paletteCount: resolvedPaletteCount
  });
  const design = pickDesignSystemFromHints(record.hints);
  const deckSize = pickDeckSizeFromHints(record.hints);
  const slide = buildSlideSkeleton({
    imagePath: inputPath,
    slideIndex: 1,
    mode: effectiveMode,
    data: record,
    hints: record.hints
  });
  const manifest = singleImageManifest({
    mode: effectiveMode,
    imagePath: inputPath,
    slide,
    designSystem: design,
    deckSize,
    deckTitle: resolvedDeckTitle,
    ocrConfidence: options.ocrConfidence
  });
  const manifestPath = resolve(options.output, "deck.manifest.skeleton.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    JSON.stringify(
      {
        manifestPath,
        mode: effectiveMode,
        multiImage: false,
        slideCount: manifest.slides.length,
        designSystem: manifest.designSystem.name,
        deckSize: manifest.deck.size,
        ocrConfidence: effectiveMode === "replica" ? options.ocrConfidence : undefined,
        artifacts: {
          hints: resolve(options.output, "image-hints.json"),
          analysis: effectiveMode === "replica" ? resolve(options.output, "image-replica-analysis.json") : undefined,
          plan: effectiveMode === "replica" ? resolve(options.output, "replica-layer-plan.json") : undefined
        }
      },
      null,
      2
    )
  );
}

const invokedDirectly =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href);

if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  });
}