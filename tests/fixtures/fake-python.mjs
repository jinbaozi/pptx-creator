#!/usr/bin/env node
// tests/fixtures/fake-python.mjs
//
// Fake Python interpreter used by the image-to-manifest wrapper tests.
// Reads script path and args from process.argv[2:] (mimicking how python
// interprets argv[1:] when invoked as `python script.py args...`).
//
// We use this instead of mocking because the wrapper is invoked via
// execFile() in a child process — vi.mock() in the test process cannot
// intercept imports in the child.
//
// Behavior:
//   - image-to-manifest-hints.py <image> <output.json> --preset ... --palette-count N --deck-title ...
//     -> writes a hints JSON stub to <output.json>
//   - image-replica-analyze.py <image> <output.json> --preset ... --palette-count N --deck-title ...
//     -> writes an analysis JSON stub to <output.json>
//   - image-replica-plan.py <analysis.json> <output.json> [--ocr-confidence N]
//     -> writes a plan JSON stub to <output.json>
//   - any script called with --help
//     -> prints a usage string that reflects the flags it accepts. The
//        image-replica-plan.py --help intentionally does NOT mention
//        --ocr-confidence (so the wrapper probe correctly skips it until U5).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("fake-python: no script provided");
  process.exit(2);
}

const script = String(args[0]);
const rest = args.slice(1);

function findOutputPath(argsList) {
  for (let i = argsList.length - 1; i >= 1; i -= 1) {
    const candidate = String(argsList[i]);
    if (candidate.endsWith(".json")) return resolve(candidate);
  }
  return null;
}

async function writeJsonArtifact(outputPath, payload) {
  if (!outputPath) {
    process.stdout.write(JSON.stringify(payload, null, 2));
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2));
}

if (rest.includes("--help") || rest.includes("-h")) {
  if (script.endsWith("image-to-manifest-hints.py")) {
    process.stdout.write(
      "usage: image-to-manifest-hints.py [-h] [--preset PRESET] [--palette-count PALETTE_COUNT] [--deck-title DECK_TITLE] image [output]\n"
    );
  } else if (script.endsWith("image-replica-analyze.py")) {
    process.stdout.write(
      "usage: image-replica-analyze.py [-h] [--preset PRESET] [--palette-count PALETTE_COUNT] [--deck-title DECK_TITLE] image [output]\n"
    );
  } else if (script.endsWith("image-replica-plan.py")) {
    // v1: image-replica-plan.py does not yet accept --ocr-confidence.
    process.stdout.write("usage: image-replica-plan.py [-h] analysis [output]\n");
  } else {
    process.stdout.write("usage: stub\n");
  }
  process.exit(0);
}

if (script.endsWith("image-to-manifest-hints.py")) {
  const outputPath = findOutputPath(rest);
  const imagePath = rest.find((arg) => !arg.startsWith("--") && arg !== outputPath);
  const hints = {
    version: "0.1.0",
    sourceImage: imagePath ? imagePath.split("/").pop() : "fixture.png",
    image: { widthPx: 1920, heightPx: 1080, aspectRatio: 1.7778 },
    slideMapping: { preset: "wide", widthIn: 13.333, heightIn: 7.5, unit: "in" },
    palette: [{ hex: "#EFF6FF", share: 0.5 }],
    layoutHints: { regions: [], coordinateRule: "test" },
    ocr: { status: "deferred" },
    designSystemSuggestion: { id: "business-neutral", reason: "stub" },
    manifestSkeleton: {
      version: "0.1.1",
      designSystem: { source: "../../design-systems/business-neutral/DESIGN.md", name: "business-neutral", mode: "balanced" },
      deck: { title: "Stub", language: "zh-CN", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
      assets: [],
      slides: [
        {
          id: "slide-001",
          type: "content",
          title: "Stub Slide",
          notes: "stub",
          background: { type: "solid", color: "{colors.background}" },
          elements: []
        }
      ]
    }
  };
  await writeJsonArtifact(outputPath, hints);
  process.exit(0);
}

if (script.endsWith("image-replica-analyze.py")) {
  const outputPath = findOutputPath(rest);
  const imagePath = rest.find((arg) => !arg.startsWith("--") && arg !== outputPath);
  const analysis = {
    version: "0.2.0",
    sourceImage: imagePath ? imagePath.split("/").pop() : "fixture.png",
    regions: [],
    objectCandidates: [],
    detectors: {},
    qualityTargets: {}
  };
  await writeJsonArtifact(outputPath, analysis);
  process.exit(0);
}

if (script.endsWith("image-replica-plan.py")) {
  const outputPath = findOutputPath(rest);
  const plan = {
    version: "0.2.0",
    "source-reference": {},
    "editable-text": [],
    "editable-shapes": [],
    "cropped-assets": []
  };
  await writeJsonArtifact(outputPath, plan);
  process.exit(0);
}

console.error(`fake-python: unhandled script ${script}`);
process.exit(1);