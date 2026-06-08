import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractRequirements } from "./lib/requirements-extractor.mjs";
import { compileUiSpec } from "./lib/ui-spec-compiler.mjs";
import { compileComponentSpecs } from "./lib/component-spec-compiler.mjs";
import { generatePreviewArtifacts } from "./lib/preview-artifact-generator.mjs";

const STORYBOARD_ROLES = [
  "cover",
  "architecture",
  "process",
  "metrics",
  "comparison",
  "roadmap",
  "summary"
];

function parseArgs(argv) {
  const args = argv.slice();
  const positional = [];
  const options = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--audience") {
      options.audience = args.shift();
    } else if (token === "--tone") {
      options.tone = args.shift();
    } else if (token === "--objective") {
      options.objective = args.shift();
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function buildStoryboard({ inputText, audience, tone, slideCount }) {
  const roles = STORYBOARD_ROLES.slice(0, slideCount);
  const slides = roles.map((role, index) => ({
    id: `slide-${String(index + 1).padStart(2, "0")}`,
    role,
    message: `${role} message derived from input`,
    contentBlocks: [`block-${index + 1}`]
  }));
  return {
    title: "Design Artifact Deck",
    audience,
    goal: `Deliver a ${tone} deck for ${audience}.`,
    language: "en",
    slides
  };
}

function defaultDesignTokens() {
  return {
    version: "1.0",
    color: {
      background: "#FFFFFF",
      text: "#111827",
      primary: "#155EEF",
      accent: "#F97316",
      surface: "#F8FAFC"
    },
    typography: {
      heading: "Aptos Display",
      body: "Aptos"
    },
    spacing: {
      slidePadding: 48
    }
  };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [inputPath, outputDir] = positional;
  if (!inputPath || !outputDir) {
    console.error("Usage: node scripts/run-design-artifact-pipeline.mjs <input.txt> <output-dir> [--audience text] [--tone text] [--objective text]");
    process.exit(2);
  }

  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
  const previewDir = join(resolvedOutput, "preview-artifacts");
  await mkdir(previewDir, { recursive: true });

  const inputText = (await readFile(resolvedInput, "utf8")).trim();

  const requirements = extractRequirements({
    inputText,
    options: {
      audience: options.audience,
      tone: options.tone,
      objective: options.objective
    }
  });
  await writeFile(join(resolvedOutput, "requirements.json"), JSON.stringify(requirements, null, 2));

  const slideCount = Math.max(5, Math.min(7, STORYBOARD_ROLES.length));
  const storyboard = buildStoryboard({
    inputText,
    audience: requirements.audience,
    tone: requirements.tone,
    slideCount
  });

  const uiSpec = compileUiSpec({ storyboard });
  await writeFile(join(resolvedOutput, "ui-spec.json"), JSON.stringify(uiSpec, null, 2));

  const componentSpecs = compileComponentSpecs({ uiSpec });
  await writeFile(join(resolvedOutput, "component-specs.json"), JSON.stringify(componentSpecs, null, 2));

  const designTokens = defaultDesignTokens();
  await writeFile(join(resolvedOutput, "design-tokens.json"), JSON.stringify(designTokens, null, 2));

  const preview = generatePreviewArtifacts({ uiSpec, componentSpecs, designTokens });
  for (const [name, contents] of Object.entries(preview.files)) {
    await writeFile(join(previewDir, name), contents);
  }

  console.log(`design artifact pipeline wrote files to ${resolvedOutput}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
