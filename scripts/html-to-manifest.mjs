import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

const DEFAULT_REMOTE_LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 10 * 1024 * 1024, maxRedirects: 3 });

function isBlockedIpv4(host) {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 198 && [18, 19].includes(octets[1]))
    || octets[0] === 0
    || octets[0] >= 224;
}

function ipv6Words(host) {
  let normalized = host.replace(/^\[|\]$/g, "").split("%", 1)[0].toLowerCase();
  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = dottedTail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    normalized = `${normalized.slice(0, -dottedTail.length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function isBlockedIpv6(host) {
  const words = ipv6Words(host);
  if (!words) return false;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const embeddedIpv4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const compatibleIpv4 = words.slice(0, 6).every((word) => word === 0);
  return allZero
    || loopback
    || ((mappedIpv4 || compatibleIpv4) && isBlockedIpv4(embeddedIpv4))
    || (words[0] & 0xfe00) === 0xfc00
    || (words[0] & 0xffc0) === 0xfe80
    || (words[0] & 0xff00) === 0xff00;
}

export function assertSafeRemoteAssetUrl(src) {
  let parsed;
  try { parsed = new URL(src); } catch { throw new Error(`invalid remote asset URL: ${src}`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`unsupported remote asset protocol: ${parsed.protocol}`);
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || isBlockedIpv4(host) || isBlockedIpv6(host)) {
    throw new Error(`remote asset blocked destination: ${host}`);
  }
  return parsed;
}

export async function assertPublicRemoteResolution(parsed, resolver = lookup) {
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedIpv4(hostname) || isBlockedIpv6(hostname)) {
    throw new Error(`remote asset blocked destination: ${hostname}`);
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) return [{ address: hostname, family: literalFamily }];
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`remote asset host did not resolve: ${parsed.hostname}`);
  for (const { address } of addresses) {
    if (isBlockedIpv4(address) || isBlockedIpv6(address)) {
      throw new Error(`remote asset blocked destination: ${parsed.hostname} resolved to ${address}`);
    }
  }
  return addresses;
}

export function validateRemoteAssetResponse(response, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_REMOTE_LIMITS.maxBytes;
  const contentType = String(response.contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error(`remote asset content type is not allowed: ${contentType || "missing"}`);
  const bodyLength = response.body?.byteLength ?? response.body?.length ?? 0;
  const declared = Number(response.contentLength ?? bodyLength);
  if (declared > maxBytes || bodyLength > maxBytes) throw new Error(`remote asset exceeds maximum bytes (${maxBytes})`);
  return response.body;
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  return headers?.[name.toLowerCase()] ?? headers?.[name] ?? null;
}

function requestPinnedAsset(parsed, options) {
  return new Promise((resolveRequest, reject) => {
    const client = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(parsed, {
      timeout: options.timeoutMs,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [options.address]);
        else callback(null, options.address.address, options.address.family);
      }
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > options.maxBytes) {
          request.destroy(new Error(`remote asset exceeds maximum bytes (${options.maxBytes})`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolveRequest({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on("timeout", () => request.destroy(new Error(`remote asset request exceeded timeout (${options.timeoutMs}ms)`)));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchRemoteAssetSecure(src, options = {}) {
  const limits = { ...DEFAULT_REMOTE_LIMITS, ...options };
  const transport = options.transport ?? requestPinnedAsset;
  const deadline = Date.now() + limits.timeoutMs;
  const beforeDeadline = async (promise) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`remote asset total timeout exceeded (${limits.timeoutMs}ms)`);
    let timeoutId;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`remote asset total timeout exceeded (${limits.timeoutMs}ms)`)), remaining);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  };
  let current = src;
  for (let redirect = 0; redirect <= limits.maxRedirects; redirect += 1) {
    const parsed = assertSafeRemoteAssetUrl(current);
    const addresses = await beforeDeadline(assertPublicRemoteResolution(parsed, options.resolver ?? lookup));
    const response = await beforeDeadline(transport(parsed, {
      ...limits,
      timeoutMs: Math.max(1, deadline - Date.now()),
      address: addresses[0]
    }));
    const location = headerValue(response.headers, "location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirect === limits.maxRedirects) throw new Error(`remote asset exceeded redirect limit (${limits.maxRedirects})`);
      current = new URL(location, parsed).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`failed to download remote asset ${current}: HTTP ${response.status}`);
    return validateRemoteAssetResponse({
      contentType: headerValue(response.headers, "content-type"),
      contentLength: headerValue(response.headers, "content-length"),
      body: response.body
    }, limits);
  }
  throw new Error("unreachable remote asset redirect state");
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("fetchRemoteAsset must return Buffer, ArrayBuffer, Uint8Array, or string");
}

async function localizeRemoteAssets(manifest, manifestDir, options = {}) {
  const fetchRemoteAsset = options.fetchRemoteAsset ?? fetchRemoteAssetSecure;
  const assetsDir = resolve(manifestDir, "assets");
  let index = 0;

  async function localize(src, hint = "asset") {
    if (!isRemoteUrl(src)) return src;
    if (options.allowRemoteAssets !== true) {
      throw new Error(`remote assets are disabled; pass --allow-remote-assets to fetch ${src}`);
    }
    assertSafeRemoteAssetUrl(src);
    index += 1;
    await mkdir(assetsDir, { recursive: true });
    const ext = remoteAssetExtension(src);
    const fileName = `remote-${hint}-${String(index).padStart(3, "0")}${ext}`;
    const outputPath = resolve(assetsDir, fileName);
    const data = toBuffer(await fetchRemoteAsset(src, options.remoteAssetLimits));
    validateRemoteAssetResponse({ contentType: "image/custom", contentLength: data.byteLength, body: data }, options.remoteAssetLimits);
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
    forceHybrid: false,
    preferArchetypeFromArchetypeMd: true,
    allowContentLoss: false,
    allowRemoteAssets: false
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
    } else if (arg === "--prefer-archetype-from-archetype-md") {
      args.preferArchetypeFromArchetypeMd = true;
    } else if (arg === "--no-prefer-archetype-from-archetype-md") {
      args.preferArchetypeFromArchetypeMd = false;
    } else if (arg === "--allow-content-loss") {
      args.allowContentLoss = true;
    } else if (arg === "--allow-remote-assets") {
      args.allowRemoteAssets = true;
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
    replicaSourcePath: options.replicaSourcePath ?? inputPath,
    packageRoot: options.packageRoot ?? packageRoot,
    manifestDir: canonicalManifestDir,
    returnMetadata: true
  });
  const manifest = result.manifest ?? result;
  if (result.contentCoverage?.ratio < 1 && options.allowContentLoss !== true) {
    const preview = result.contentCoverage.missing.slice(0, 5).join(" | ");
    throw new Error(
      `HTML content coverage ${Math.round(result.contentCoverage.ratio * 100)}%; `
      + `${result.contentCoverage.missing.length} block(s) were not converted: ${preview}. `
      + "Add supported semantic structure or data-pptx-kind markers; use --allow-content-loss only for intentional omissions."
    );
  }
  await localizeRemoteAssets(manifest, manifestDir, options);
  await writeFile(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // Always write inputHints.json alongside the manifest.
  const inputHintsPath = resolve(manifestDir, "inputHints.json");
  const inputHints = result.inputHints ?? { viewportSize: { w: 1280, h: 720 }, imageDimensions: [], detectedPalette: [], ocrAvailability: "deferred" };
  await writeFile(inputHintsPath, `${JSON.stringify(inputHints, null, 2)}\n`, "utf8");
  return {
    manifest,
    layoutPaths: result.layoutPaths ?? [],
    sourceCoordinates: result.sourceCoordinates ?? [],
    inputHints,
    contentCoverage: result.contentCoverage,
    replicaCoverage: result.replicaCoverage,
    replicaCoverageBySlide: result.replicaCoverageBySlide ?? []
  };
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
    forceHybrid,
    preferArchetypeFromArchetypeMd,
    allowContentLoss,
    allowRemoteAssets
  } = parseArgs(process.argv.slice(2));
  if (!input || !output) {
    fail(
      "usage: html-to-manifest.mjs <input.html> <output/deck.manifest.json> [--design-system id] [--design-mode balanced] [--measurements layout-measurements.json] [--no-auto-paginate] [--force-auto-layout | --force-measured | --force-hybrid] [--prefer-archetype-from-archetype-md | --no-prefer-archetype-from-archetype-md] [--allow-content-loss]"
    );
  }
  const inputPath = resolve(input);
  const outputPath = resolve(output);
  const { manifest, contentCoverage } = await writeManifestFromHtml(inputPath, outputPath, {
    designSystem: designSystem ?? undefined,
    designMode,
    measurements: measurements ?? undefined,
    autoPaginate,
    forceAutoLayout,
    forceMeasured,
    forceHybrid,
    preferArchetypeFromArchetypeMd,
      allowContentLoss,
      allowRemoteAssets
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
        forceHybrid,
        contentCoverage
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
