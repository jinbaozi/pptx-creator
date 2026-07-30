#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  SUPPORTED_VERSION,
  validatePresentationPackageFile
} from "./validate-presentation-package.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoots = Object.freeze({
  textToHtml: join(repositoryRoot, "skills", "text-to-html"),
  htmlToPptx: join(repositoryRoot, "skills", "html-to-pptx"),
  imageToPptx: join(repositoryRoot, "skills", "image-to-pptx")
});
const cliPaths = Object.freeze({
  textToHtml: join(skillRoots.textToHtml, "scripts", "run-pipeline.mjs"),
  htmlToPptx: join(skillRoots.htmlToPptx, "scripts", "convert.mjs"),
  imageToPptx: join(skillRoots.imageToPptx, "scripts", "image-to-pptx.mjs")
});
const fixtures = Object.freeze({
  textPlan: join(skillRoots.textToHtml, "examples", "minimal", "presentation-plan.json"),
  image: join(skillRoots.imageToPptx, "examples", "minimal", "input.png")
});
const DEFAULT_PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_BROWSER_TIMEOUT_MS = 90_000;
const HEX_COLOR = /^#[0-9A-F]{6}$/i;

export class V2CompositionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "V2CompositionError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new V2CompositionError(code, message, details);
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function pathInside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function requireFile(path, label, minimumBytes = 1) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail("E_COMPOSITION_ARTIFACT", `${label} is missing`, { path });
  }
  if (!details.isFile() || details.size < minimumBytes) {
    fail("E_COMPOSITION_ARTIFACT", `${label} is not a non-empty regular file`, {
      path,
      bytes: details.size
    });
  }
  return details;
}

async function requirePptx(path, label) {
  const details = await requireFile(path, label, 1000);
  const bytes = await readFile(path);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    fail("E_COMPOSITION_PPTX", `${label} is not an OOXML ZIP package`, { path });
  }
  return { bytes: details.size, sha256: await sha256(path) };
}

async function pngCount(root) {
  let count = 0;
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) count += 1;
    }
  };
  await visit(root);
  return count;
}

function commandSummary(command, args, cwd) {
  return {
    executable: basename(command),
    script: portablePath(repositoryRoot, args[0]),
    arguments: args.slice(1).map((value) => (
      pathInside(repositoryRoot, value) ? portablePath(repositoryRoot, value) : value
    )),
    cwd: portablePath(repositoryRoot, cwd)
  };
}

async function runSkillCli(label, cliPath, args, options = {}) {
  const cwd = options.cwd ?? dirname(dirname(cliPath));
  const commandArgs = [cliPath, ...args];
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(process.execPath, commandArgs, {
      cwd,
      env: { ...process.env },
      timeout: options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024
    });
    return {
      label,
      status: "passed",
      durationMs: Date.now() - startedAt,
      command: commandSummary(process.execPath, commandArgs, cwd),
      stdout: String(result.stdout ?? "").trim()
    };
  } catch (error) {
    const stdout = String(error.stdout ?? "").trim();
    const stderr = String(error.stderr ?? "").trim();
    fail("E_COMPOSITION_COMMAND", `${label} failed`, {
      command: commandSummary(process.execPath, commandArgs, cwd),
      durationMs: Date.now() - startedAt,
      exitCode: error.code,
      signal: error.signal,
      stdout: stdout.slice(-8000),
      stderr: stderr.slice(-8000)
    });
  }
}

async function expectSkillCliRejection(label, cliPath, args, expectedCode, options = {}) {
  const cwd = options.cwd ?? dirname(dirname(cliPath));
  const commandArgs = [cliPath, ...args];
  const startedAt = Date.now();
  try {
    await execFileAsync(process.execPath, commandArgs, {
      cwd,
      env: { ...process.env },
      timeout: options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    const output = `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`;
    if (!output.includes(expectedCode)) {
      fail("E_COMPOSITION_REJECTION", `${label} failed with the wrong error`, {
        expectedCode,
        exitCode: error.code,
        output: output.trim().slice(-8000)
      });
    }
    return {
      label,
      status: "passed",
      durationMs: Date.now() - startedAt,
      command: commandSummary(process.execPath, commandArgs, cwd),
      rejectedCode: expectedCode,
      nonZeroExit: true
    };
  }
  fail("E_COMPOSITION_REJECTION", `${label} unexpectedly accepted invalid input`, {
    expectedCode,
    command: commandSummary(process.execPath, commandArgs, cwd)
  });
}

function colorLuminance(color) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const values = [colorLuminance(left), colorLuminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function uniqueColors(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && HEX_COLOR.test(value))
    .map((value) => value.toUpperCase()))];
}

function fontStack(typography = {}) {
  const families = [typography.primary, ...(typography.fallbacks ?? [])]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => `"${value.replaceAll("\"", "")}"`);
  if (!families.length) return null;
  return `${[...new Set(families)].join(", ")}, sans-serif`;
}

export function adaptImageDesignTokens(imageTokens) {
  if (!imageTokens || typeof imageTokens !== "object" || Array.isArray(imageTokens)) {
    fail("E_TOKEN_INPUT", "image design tokens must be an object");
  }
  const page = imageTokens.page ?? {};
  if (Number(page.widthPx) !== 1280 || Number(page.heightPx) !== 720) {
    fail("E_TOKEN_PAGE_SIZE", "reference design tokens must use the 1280x720 composition baseline", {
      page
    });
  }
  const colors = uniqueColors([
    imageTokens.colors?.background,
    imageTokens.colors?.primary,
    ...(imageTokens.colors?.palette ?? [])
  ]);
  if (colors.length < 2) {
    fail("E_TOKEN_COLORS", "reference design tokens require at least two valid hex colors");
  }
  const byLuminance = [...colors].sort((left, right) => colorLuminance(left) - colorLuminance(right));
  const darkest = byLuminance[0];
  const lightest = byLuminance.at(-1);
  const background = HEX_COLOR.test(imageTokens.colors?.background ?? "")
    ? imageTokens.colors.background.toUpperCase()
    : lightest;
  const surface = HEX_COLOR.test(imageTokens.colors?.primary ?? "")
    ? imageTokens.colors.primary.toUpperCase()
    : lightest;
  const middle = byLuminance.filter((color) => color !== darkest && color !== background && color !== surface);
  const readable = [...middle, darkest].find((color) => contrastRatio(color, background) >= 4.5) ?? darkest;
  const visibleAccent = [...middle, darkest].find((color) => contrastRatio(color, background) >= 3) ?? darkest;
  const primarySoft = middle.at(-1) ?? surface;
  const fonts = fontStack(imageTokens.typography);
  const tokenOverrides = {
    colors: {
      background,
      surface,
      text: darkest,
      muted: readable,
      primary: darkest,
      primarySoft,
      accent: visibleAccent,
      border: visibleAccent
    },
    ...(fonts ? { fonts: { display: fonts, body: fonts } } : {})
  };
  return {
    protocol: "pptx-creator.design-token-adaptation",
    version: "1.0.0",
    source: {
      producer: "image-to-pptx",
      tokenVersion: String(imageTokens.version ?? "unknown"),
      page: { width: 1280, height: 720, unit: "px" }
    },
    target: {
      consumer: "text-to-html",
      planVersion: "1.0.0",
      field: "$.design.tokenOverrides"
    },
    tokenOverrides,
    mappings: [
      { from: "$.colors.background", to: "$.colors.background", strategy: "direct-valid-hex" },
      { from: "$.colors.primary", to: "$.colors.surface", strategy: "direct-valid-hex" },
      { from: "$.colors.palette", to: "$.colors.text", strategy: "lowest-relative-luminance" },
      { from: "$.colors.palette", to: "$.colors.muted", strategy: "minimum-4.5-to-1-background-contrast" },
      { from: "$.colors.palette", to: "$.colors.primarySoft", strategy: "light-neutral-candidate" },
      { from: "$.typography", to: "$.fonts", strategy: "explicit-local-fallback-stack" }
    ],
    factsImported: false
  };
}

export async function createReferenceStylePlan(imageTokensPath, basePlanPath, outputDirectory) {
  const [imageTokens, basePlan] = await Promise.all([
    readJson(imageTokensPath),
    readJson(basePlanPath)
  ]);
  const adaptation = adaptImageDesignTokens(imageTokens);
  const plan = structuredClone(basePlan);
  plan.deck.id = `${plan.deck.id}-reference-style`;
  plan.design.tokenOverrides = adaptation.tokenOverrides;
  plan.assumptions = [
    ...plan.assumptions,
    {
      id: "assumption-reference-style",
      text: "视觉样式显式适配自参考图提取的设计令牌，未引入参考图中的事实内容。",
      impact: "low",
      status: "confirmed"
    }
  ];
  plan.sources = [
    ...plan.sources,
    {
      id: "source-reference-style",
      kind: "file",
      label: "image-to-pptx design-tokens.json（仅用于样式）",
      locator: "design-tokens.json",
      factStatus: "provided"
    }
  ];
  await mkdir(outputDirectory, { recursive: true });
  const copiedTokensPath = join(outputDirectory, "design-tokens.json");
  const planPath = join(outputDirectory, "adapted-presentation-plan.json");
  const reportPath = join(outputDirectory, "token-adaptation-report.json");
  await copyFile(imageTokensPath, copiedTokensPath);
  await Promise.all([
    writeJson(planPath, plan),
    writeJson(reportPath, {
      ...adaptation,
      inputs: {
        imageTokens: "design-tokens.json",
        basePlan: portablePath(repositoryRoot, basePlanPath)
      },
      output: "adapted-presentation-plan.json"
    })
  ]);
  return { planPath, reportPath, copiedTokensPath, adaptation };
}

async function validateHtmlOutput(outputDir, expectedProducer = "text-to-html") {
  const packagePath = join(outputDir, "presentation-package.json");
  const [protocol, qa] = await Promise.all([
    validatePresentationPackageFile(packagePath),
    readJson(join(outputDir, "qa-report.json")),
    requireFile(join(outputDir, "index.html"), "text-to-html index.html")
  ]);
  if (protocol.kind !== "html-presentation" || protocol.producer !== expectedProducer) {
    fail("E_COMPOSITION_PROTOCOL", "HTML producer emitted an unexpected protocol package", { protocol });
  }
  if (protocol.validationStatus !== "passed" || qa.status !== "passed") {
    fail("E_COMPOSITION_QUALITY", "HTML producer did not pass its browser quality gate", {
      protocol,
      qaStatus: qa.status
    });
  }
  const previewCount = await pngCount(join(outputDir, "preview"));
  if (previewCount < protocol.slideCount * 3) {
    fail("E_COMPOSITION_QUALITY", "HTML producer did not render all standard, desktop, and mobile previews", {
      slideCount: protocol.slideCount,
      previewCount
    });
  }
  return {
    packagePath,
    protocol,
    qa: {
      status: qa.status,
      slideCount: qa.slideCount,
      viewportCount: qa.viewports?.length ?? 0,
      findingCount: qa.findings?.length ?? 0,
      previewCount
    }
  };
}

async function validateHtmlToPptxOutput(outputDir) {
  const packagePath = join(outputDir, "presentation-package.json");
  const [protocol, qa, pptx] = await Promise.all([
    validatePresentationPackageFile(packagePath),
    readJson(join(outputDir, "qa-report.json")),
    requirePptx(join(outputDir, "final.pptx"), "html-to-pptx final.pptx")
  ]);
  const gates = qa.gates ?? {};
  if (protocol.kind !== "pptx-delivery" || protocol.producer !== "html-to-pptx") {
    fail("E_COMPOSITION_PROTOCOL", "html-to-pptx emitted an unexpected protocol package", { protocol });
  }
  if (protocol.validationStatus !== "passed"
      || qa.status !== "passed"
      || gates.htmlLayout?.blocked !== false
      || gates.mobileHtmlDiagnostic?.blocked !== false
      || gates.layoutSafety?.blocked !== false
      || gates.pptxGeometry?.blocked !== false
      || gates.visual?.passed !== true
      || gates.editability?.passed !== true
      || Number(gates.editability?.level ?? 0) < 3
      || gates.fullSlideRaster?.forbidden !== true
      || Number(gates.fullSlideRaster?.violations ?? 1) !== 0) {
    fail("E_COMPOSITION_QUALITY", "html-to-pptx did not pass all blocking gates", {
      status: qa.status,
      gates
    });
  }
  return {
    packagePath,
    protocol,
    pptx,
    qa: {
      status: qa.status,
      inputKind: qa.inputKind,
      slideCount: qa.slideCount,
      editabilityLevel: gates.editability.level,
      nativeCoverage: gates.editability.nativeCoverage,
      minimumSimilarity: gates.visual.minimumSimilarity,
      fullSlideRasterViolations: gates.fullSlideRaster.violations
    }
  };
}

async function validateImageOutput(outputDir) {
  const [qa, run, pptx] = await Promise.all([
    readJson(join(outputDir, "qa-report.json")),
    readJson(join(outputDir, "run.json")),
    requirePptx(join(outputDir, "final.pptx"), "image-to-pptx final.pptx")
  ]);
  if (qa.status !== "passed"
      || qa.visual?.status !== "passed"
      || qa.editability?.status !== "passed"
      || Number(qa.editability?.level ?? 0) < 3
      || Number(qa.editability?.wholeSlideRasterCount ?? 1) !== 0
      || run.status !== "passed"
      || run.producer?.skill !== "image-to-pptx") {
    fail("E_COMPOSITION_QUALITY", "image-to-pptx did not pass independent visual and editability gates", {
      qa,
      runStatus: run.status,
      producer: run.producer
    });
  }
  const htmlPackagePath = join(outputDir, "html-package", "presentation-package.json");
  const htmlProtocol = await validatePresentationPackageFile(htmlPackagePath);
  await requireFile(join(outputDir, "html-package", "index.html"), "image-to-pptx optional HTML entrypoint");
  if (htmlProtocol.kind !== "image-reconstruction" || htmlProtocol.producer !== "image-to-pptx") {
    fail("E_COMPOSITION_PROTOCOL", "image-to-pptx optional HTML package has unexpected metadata", {
      htmlProtocol
    });
  }
  const previewCount = await pngCount(join(outputDir, "preview"));
  if (previewCount < qa.slideCount) {
    fail("E_COMPOSITION_QUALITY", "image-to-pptx did not publish a preview for every slide", {
      slideCount: qa.slideCount,
      previewCount
    });
  }
  await requireFile(join(outputDir, "design-tokens.json"), "image-to-pptx design-tokens.json");
  return {
    protocol: htmlProtocol,
    htmlPackagePath,
    pptx,
    qa: {
      status: qa.status,
      slideCount: qa.slideCount,
      attemptsUsed: qa.attemptsUsed,
      editabilityLevel: qa.editability.level,
      ssim: qa.visual.aggregate?.ssim,
      wholeSlideRasterCount: qa.editability.wholeSlideRasterCount,
      previewCount
    }
  };
}

function assertTextTokenAdaptation(generatedTokens, adaptation) {
  for (const [group, values] of Object.entries(adaptation.tokenOverrides)) {
    for (const [key, value] of Object.entries(values)) {
      if (generatedTokens?.[group]?.[key] !== value) {
        fail("E_TOKEN_ADAPTATION", `text-to-html did not materialize adapted token ${group}.${key}`, {
          expected: value,
          actual: generatedTokens?.[group]?.[key]
        });
      }
    }
  }
}

function chainResult(id, label, commands, evidence) {
  return {
    id,
    label,
    status: "passed",
    commands: commands.map(({ stdout, ...command }) => command),
    evidence
  };
}

export async function runV2CompositionTests(options = {}) {
  const browserTimeoutMs = Number(options.browserTimeoutMs ?? MIN_BROWSER_TIMEOUT_MS);
  const processTimeoutMs = Number(options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
  const keepArtifacts = Boolean(options.keepArtifacts);
  if (!Number.isFinite(browserTimeoutMs) || browserTimeoutMs < MIN_BROWSER_TIMEOUT_MS) {
    fail("E_ARGUMENT", `browserTimeoutMs must be at least ${MIN_BROWSER_TIMEOUT_MS}`);
  }
  if (!Number.isFinite(processTimeoutMs) || processTimeoutMs < browserTimeoutMs) {
    fail("E_ARGUMENT", "processTimeoutMs must be at least browserTimeoutMs");
  }
  for (const path of [...Object.values(cliPaths), ...Object.values(fixtures)]) {
    await access(path);
  }
  const workRoot = await mkdtemp(join(tmpdir(), "pptx-creator-v2-composition-"));
  const reportPath = join(workRoot, "composition-report.json");
  const startedAt = new Date();
  const chains = [];
  try {
    const chain1Root = join(workRoot, "01-text-to-html-to-pptx");
    const chain1Html = join(chain1Root, "html");
    const chain1Pptx = join(chain1Root, "pptx");
    const chain1TextCommand = await runSkillCli(
      "text-to-html minimal plan",
      cliPaths.textToHtml,
      [
        fixtures.textPlan,
        chain1Html,
        "--max-attempts",
        "3",
        "--timeout-ms",
        String(browserTimeoutMs)
      ],
      { cwd: skillRoots.textToHtml, timeoutMs: processTimeoutMs }
    );
    const chain1HtmlEvidence = await validateHtmlOutput(chain1Html);
    const chain1PptxCommand = await runSkillCli(
      "html-to-pptx consumes text presentation-package",
      cliPaths.htmlToPptx,
      [
        chain1HtmlEvidence.packagePath,
        chain1Pptx,
        "--max-repair-attempts",
        "3",
        "--browser-timeout-ms",
        String(browserTimeoutMs)
      ],
      { cwd: skillRoots.htmlToPptx, timeoutMs: processTimeoutMs }
    );
    const chain1PptxEvidence = await validateHtmlToPptxOutput(chain1Pptx);
    chains.push(chainResult(
      "text-to-html-to-pptx",
      "text-to-html → presentation-package → html-to-pptx",
      [chain1TextCommand, chain1PptxCommand],
      {
        html: chain1HtmlEvidence.qa,
        pptx: chain1PptxEvidence.qa,
        pptxArtifact: chain1PptxEvidence.pptx
      }
    ));

    const chain2Root = join(workRoot, "02-image-to-pptx-independent");
    const chain2Output = join(chain2Root, "output");
    const chain2ImageCommand = await runSkillCli(
      "image-to-pptx independent build",
      cliPaths.imageToPptx,
      [
        "build",
        "--output",
        chain2Output,
        "--title",
        "V2 composition reference",
        "--langs",
        "eng",
        "--ocr-threshold",
        "0.70",
        "--max-repairs",
        "3",
        "--html-package",
        fixtures.image
      ],
      { cwd: skillRoots.imageToPptx, timeoutMs: processTimeoutMs }
    );
    const chain2Evidence = await validateImageOutput(chain2Output);
    chains.push(chainResult(
      "image-to-pptx-independent",
      "image-to-pptx 独立生成可编辑 PPTX",
      [chain2ImageCommand],
      {
        image: chain2Evidence.qa,
        pptxArtifact: chain2Evidence.pptx,
        optionalHtmlProtocol: chain2Evidence.protocol
      }
    ));

    const chain3Root = join(workRoot, "03-image-html-to-pptx");
    const chain3Pptx = join(chain3Root, "pptx");
    const chain3Command = await runSkillCli(
      "html-to-pptx consumes image optional HTML package",
      cliPaths.htmlToPptx,
      [
        chain2Evidence.htmlPackagePath,
        chain3Pptx,
        "--max-repair-attempts",
        "3",
        "--browser-timeout-ms",
        String(browserTimeoutMs)
      ],
      { cwd: skillRoots.htmlToPptx, timeoutMs: processTimeoutMs }
    );
    const chain3Evidence = await validateHtmlToPptxOutput(chain3Pptx);
    chains.push(chainResult(
      "image-html-to-pptx",
      "image-to-pptx 可选 HTML 包 → html-to-pptx",
      [chain3Command],
      {
        sourceChain: "image-to-pptx-independent",
        sourceProtocol: chain2Evidence.protocol,
        pptx: chain3Evidence.qa,
        pptxArtifact: chain3Evidence.pptx
      }
    ));

    const chain4Root = join(workRoot, "04-reference-style-to-html-presentation-to-pptx");
    const chain4Adapter = join(chain4Root, "adapter");
    const chain4Html = join(chain4Root, "html");
    const chain4Pptx = join(chain4Root, "pptx");
    const adapted = await createReferenceStylePlan(
      join(chain2Output, "design-tokens.json"),
      fixtures.textPlan,
      chain4Adapter
    );
    const chain4TextCommand = await runSkillCli(
      "text-to-html consumes explicitly adapted reference style",
      cliPaths.textToHtml,
      [
        adapted.planPath,
        chain4Html,
        "--max-attempts",
        "3",
        "--timeout-ms",
        String(browserTimeoutMs)
      ],
      { cwd: skillRoots.textToHtml, timeoutMs: processTimeoutMs }
    );
    const chain4HtmlEvidence = await validateHtmlOutput(chain4Html);
    assertTextTokenAdaptation(
      await readJson(join(chain4Html, "design-tokens.json")),
      adapted.adaptation
    );
    const chain4PptxCommand = await runSkillCli(
      "html-to-pptx consumes reference-style text HTML package",
      cliPaths.htmlToPptx,
      [
        chain4HtmlEvidence.packagePath,
        chain4Pptx,
        "--max-repair-attempts",
        "3",
        "--browser-timeout-ms",
        String(browserTimeoutMs)
      ],
      { cwd: skillRoots.htmlToPptx, timeoutMs: processTimeoutMs }
    );
    const chain4PptxEvidence = await validateHtmlToPptxOutput(chain4Pptx);
    chains.push(chainResult(
      "reference-style-to-text-to-html-to-pptx",
      "image design-tokens → 显式适配 → text-to-html → html-to-pptx",
      [chain4TextCommand, chain4PptxCommand],
      {
        sourceChain: "image-to-pptx-independent",
        adaptation: {
          protocol: adapted.adaptation.protocol,
          version: adapted.adaptation.version,
          factsImported: adapted.adaptation.factsImported,
          mappingCount: adapted.adaptation.mappings.length,
          reportSha256: await sha256(adapted.reportPath)
        },
        html: chain4HtmlEvidence.qa,
        pptx: chain4PptxEvidence.qa,
        pptxArtifact: chain4PptxEvidence.pptx
      }
    ));

    const chain5Root = join(workRoot, "05-incompatible-protocol");
    const chain5PackageRoot = join(chain5Root, "package");
    const chain5Output = join(chain5Root, "pptx");
    await mkdir(chain5PackageRoot, { recursive: true });
    await Promise.all([
      copyFile(join(chain1Html, "index.html"), join(chain5PackageRoot, "index.html")),
      copyFile(
        join(chain1Html, "presentation-package.json"),
        join(chain5PackageRoot, "presentation-package.json")
      )
    ]);
    const incompatiblePath = join(chain5PackageRoot, "presentation-package.json");
    const incompatible = await readJson(incompatiblePath);
    incompatible.version = "2.0.0";
    await writeJson(incompatiblePath, incompatible);
    const chain5Command = await expectSkillCliRejection(
      "html-to-pptx rejects an incompatible presentation-package version",
      cliPaths.htmlToPptx,
      [incompatiblePath, chain5Output],
      "E_PROTOCOL_VERSION",
      { cwd: skillRoots.htmlToPptx, timeoutMs: processTimeoutMs }
    );
    let rootValidatorCode = null;
    try {
      await validatePresentationPackageFile(incompatiblePath);
    } catch (error) {
      rootValidatorCode = error.code;
    }
    if (rootValidatorCode !== "E_PROTOCOL_VERSION") {
      fail("E_COMPOSITION_REJECTION", "canonical validator did not reject the incompatible version", {
        expected: "E_PROTOCOL_VERSION",
        actual: rootValidatorCode
      });
    }
    try {
      await access(join(chain5Output, "final.pptx"));
      fail("E_COMPOSITION_REJECTION", "incompatible protocol unexpectedly published final.pptx");
    } catch (error) {
      if (error instanceof V2CompositionError) throw error;
    }
    chains.push(chainResult(
      "incompatible-protocol-rejection",
      "presentation-package 版本不兼容时显式失败",
      [chain5Command],
      {
        supportedVersion: SUPPORTED_VERSION,
        rejectedVersion: incompatible.version,
        consumerCode: chain5Command.rejectedCode,
        canonicalValidatorCode: rootValidatorCode,
        finalPptxPublished: false
      }
    ));

    const report = {
      version: "1.0.0",
      status: "passed",
      gate: "v2-explicit-composition",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      temporaryRoot: keepArtifacts ? workRoot : null,
      browserTimeoutMs,
      processTimeoutMs,
      implicitSiblingInvocation: false,
      protocol: {
        id: "pptx-creator.presentation-package",
        supportedVersion: SUPPORTED_VERSION
      },
      chainCount: chains.length,
      chains
    };
    await writeJson(reportPath, report);
    return {
      ...report,
      reportPath: keepArtifacts ? reportPath : null,
      cleaned: !keepArtifacts
    };
  } catch (error) {
    const failureReport = {
      version: "1.0.0",
      status: "failed",
      gate: "v2-explicit-composition",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      temporaryRoot: keepArtifacts ? workRoot : null,
      browserTimeoutMs,
      processTimeoutMs,
      implicitSiblingInvocation: false,
      protocol: {
        id: "pptx-creator.presentation-package",
        supportedVersion: SUPPORTED_VERSION
      },
      completedChainCount: chains.length,
      chains,
      failure: {
        code: error.code ?? "E_UNKNOWN",
        message: error.message,
        details: error.details ?? null
      }
    };
    await writeJson(reportPath, failureReport).catch(() => {});
    if (error instanceof V2CompositionError) {
      error.details = {
        ...error.details,
        temporaryRoot: workRoot,
        ...(keepArtifacts ? { reportPath } : {})
      };
    }
    throw error;
  } finally {
    if (!keepArtifacts) await rm(workRoot, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const options = {
    keepArtifacts: false,
    browserTimeoutMs: MIN_BROWSER_TIMEOUT_MS,
    processTimeoutMs: DEFAULT_PROCESS_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--keep") options.keepArtifacts = true;
    else if (value === "--browser-timeout-ms") options.browserTimeoutMs = Number(argv[++index]);
    else if (value === "--process-timeout-ms") options.processTimeoutMs = Number(argv[++index]);
    else fail(
      "E_ARGUMENT",
      "usage: run-v2-composition-tests.mjs [--keep] [--browser-timeout-ms >=90000] [--process-timeout-ms >=browser-timeout-ms]"
    );
  }
  return options;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runV2CompositionTests(parseCli(process.argv.slice(2))).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({
        status: "failed",
        code: error.code ?? "E_UNKNOWN",
        message: error.message,
        details: error.details ?? null
      }, null, 2)}\n`);
      process.exitCode = 1;
    }
  );
}
