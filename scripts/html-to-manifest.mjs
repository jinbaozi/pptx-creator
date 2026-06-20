import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertHtmlToManifest } from "./lib/html-to-manifest-core.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isRemoteUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function remoteAssetExtension(src) {
  try {
    const ext = extname(new URL(src).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return ext;
  } catch {
    return ".bin";
  }
  return ".bin";
}

async function defaultFetchRemoteAsset(src) {
  if (typeof fetch !== "function") {
    throw new Error("remote asset download requires global fetch; use Node 18+ or provide fetchRemoteAsset");
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`failed to download remote asset ${src}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("fetchRemoteAsset must return Buffer, ArrayBuffer, Uint8Array, or string");
}

async function localizeRemoteAssets(manifest, manifestDir, options = {}) {
  const fetchRemoteAsset = options.fetchRemoteAsset ?? defaultFetchRemoteAsset;
  const assetsDir = resolve(manifestDir, "assets");
  let index = 0;

  async function localize(src, hint = "asset") {
    if (!isRemoteUrl(src)) return src;
    index += 1;
    await mkdir(assetsDir, { recursive: true });
    const ext = remoteAssetExtension(src);
    const fileName = `remote-${hint}-${String(index).padStart(3, "0")}${ext}`;
    const outputPath = resolve(assetsDir, fileName);
    const data = toBuffer(await fetchRemoteAsset(src));
    await writeFile(outputPath, data);
    return relative(manifestDir, outputPath).replace(/\\/g, "/");
  }

  for (const asset of manifest.assets ?? []) {
    if (asset?.src) asset.src = await localize(asset.src, "asset");
  }
  for (const slide of manifest.slides ?? []) {
    if (slide.background?.type === "image" && slide.background.src) {
      slide.background.src = await localize(slide.background.src, "background");
    }
    for (const element of slide.elements ?? []) {
      if (element.type === "image" && element.src) {
        element.src = await localize(element.src, "image");
      }
    }
  }
}

function parseArgs(argv) {
  const args = {
    designSystem: null,
    designMode: "balanced",
    measurements: null,
    autoPaginate: true,
    forceAutoLayout: false,
    forceMeasured: false,
    forceHybrid: false
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--design-system") {
      args.designSystem = argv[i + 1];
      i += 1;
    } else if (arg === "--design-mode") {
      args.designMode = argv[i + 1];
      i += 1;
    } else if (arg === "--measurements") {
      args.measurements = argv[i + 1];
      i += 1;
    } else if (arg === "--no-auto-paginate") {
      args.autoPaginate = false;
    } else if (arg === "--force-auto-layout") {
      args.forceAutoLayout = true;
    } else if (arg === "--force-measured") {
      args.forceMeasured = true;
    } else if (arg === "--force-hybrid") {
      args.forceHybrid = true;
    } else {
      positional.push(arg);
    }
  }
  // Force flags are mutually exclusive — the last one wins.
  const forceCount = Number(args.forceAutoLayout) + Number(args.forceMeasured) + Number(args.forceHybrid);
  if (forceCount > 1) {
    if (args.forceHybrid) {
      args.forceAutoLayout = false;
      args.forceMeasured = false;
    } else if (args.forceMeasured) {
      args.forceAutoLayout = false;
    }
  }
  return { ...args, input: positional[0], output: positional[1] };
}

export async function writeManifestFromHtml(inputPath, outputPath, options = {}) {
  const html = await readFile(inputPath, "utf8");
  const resolvedOutput = resolve(outputPath);
  const manifestDir = dirname(resolvedOutput);
  await mkdir(manifestDir, { recursive: true });
  const canonicalManifestDir = await realpath(manifestDir);
  let measurements = options.measurements ?? null;
  if (typeof measurements === "string") {
    measurements = JSON.parse(await readFile(resolve(measurements), "utf8"));
  }
  const result = convertHtmlToManifest(html, {
    ...options,
    measurements,
    packageRoot: options.packageRoot ?? packageRoot,
    manifestDir: canonicalManifestDir,
    returnMetadata: true
  });
  const manifest = result.manifest ?? result;
  await localizeRemoteAssets(manifest, manifestDir, options);
  await writeFile(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // Always write inputHints.json alongside the manifest.
  const inputHintsPath = resolve(manifestDir, "inputHints.json");
  const inputHints = result.inputHints ?? { viewportSize: { w: 1280, h: 720 }, imageDimensions: [], detectedPalette: [], ocrAvailability: "deferred" };
  await writeFile(inputHintsPath, `${JSON.stringify(inputHints, null, 2)}\n`, "utf8");
  return { manifest, layoutPaths: result.layoutPaths ?? [], sourceCoordinates: result.sourceCoordinates ?? [], inputHints };
}

async function main() {
  const {
    input,
    output,
    designSystem,
    designMode,
    measurements,
    autoPaginate,
    forceAutoLayout,
    forceMeasured,
    forceHybrid
  } = parseArgs(process.argv.slice(2));
  if (!input || !output) {
    fail(
      "usage: html-to-manifest.mjs <input.html> <output/deck.manifest.json> [--design-system id] [--design-mode balanced] [--measurements layout-measurements.json] [--no-auto-paginate] [--force-auto-layout | --force-measured | --force-hybrid]"
    );
  }
  const inputPath = resolve(input);
  const outputPath = resolve(output);
  const { manifest } = await writeManifestFromHtml(inputPath, outputPath, {
    designSystem: designSystem ?? undefined,
    designMode,
    measurements: measurements ?? undefined,
    autoPaginate,
    forceAutoLayout,
    forceMeasured,
    forceHybrid
  });
  console.log(
    JSON.stringify(
      {
        manifestPath: outputPath,
        slides: manifest.slides.length,
        designSystem: manifest.designSystem.name,
        elements: manifest.slides.reduce((sum, slide) => sum + slide.elements.length, 0),
        measurementsApplied: Boolean(measurements),
        autoPaginate,
        forceAutoLayout,
        forceMeasured,
        forceHybrid
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
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
