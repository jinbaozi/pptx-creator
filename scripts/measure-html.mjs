import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_VIEWPORT,
  buildMeasurementsDocument,
  convertMeasurementPxToInches
} from "./lib/html-measurement-core.mjs";
import { SLIDE_SIZE } from "./lib/html-to-manifest-core.mjs";
import { withSettledHtmlPage } from "./lib/html-layout-audit.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    viewportWidth: DEFAULT_VIEWPORT.width,
    viewportHeight: DEFAULT_VIEWPORT.height,
    slideWidth: SLIDE_SIZE.width,
    slideHeight: SLIDE_SIZE.height,
    selector: "[data-pptx-kind],[data-pptx-type]"
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--viewport-width") {
      args.viewportWidth = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--viewport-height") {
      args.viewportHeight = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--slide-width") {
      args.slideWidth = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--slide-height") {
      args.slideHeight = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--selector") {
      args.selector = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  return { ...args, input: positional[0], output: positional[1] };
}

export async function measureHtmlFile(inputPath, options = {}) {
  const resolvedInput = resolve(inputPath);
  const viewport = {
    width: options.viewportWidth ?? DEFAULT_VIEWPORT.width,
    height: options.viewportHeight ?? DEFAULT_VIEWPORT.height
  };
  const slideSize = {
    preset: "wide",
    width: options.slideWidth ?? SLIDE_SIZE.width,
    height: options.slideHeight ?? SLIDE_SIZE.height,
    unit: "in"
  };
  const selector = options.selector ?? "[data-pptx-kind],[data-pptx-type]";

  return withSettledHtmlPage(resolvedInput, options, async (page) => {
    const rawElements = await page.evaluate(({ measureSelector }) => {
      const slideNodes = [...document.querySelectorAll(".pptx-slide, [data-slide]")];
      const slides = slideNodes.length > 0 ? slideNodes : [document.querySelector(".pptx-deck") ?? document.body];
      const seenIds = new Set();
      const measured = [];
      slides.forEach((slide, slideIndex) => {
        const slideId = slide.getAttribute("data-slide-id") || slide.id || `slide-${String(slideIndex + 1).padStart(3, "0")}`;
        const slideRect = slide.getBoundingClientRect();
        for (const node of slide.querySelectorAll(measureSelector)) {
          const rect = node.getBoundingClientRect();
          const id = node.getAttribute("data-pptx-id") ?? node.getAttribute("data-id") ?? node.id ?? null;
          const kind = node.getAttribute("data-pptx-kind") ?? node.getAttribute("data-pptx-type");
          if (!id || !kind) continue;
          if (seenIds.has(id)) throw new Error(`duplicate measured HTML id: ${id}`);
          seenIds.add(id);
          measured.push({
            id,
            slideId,
            kind,
            tagName: node.tagName.toLowerCase(),
            selector: `[data-pptx-id="${id}"]`,
            px: {
              x: rect.left - slideRect.left,
              y: rect.top - slideRect.top,
              w: rect.width,
              h: rect.height
            }
          });
        }
      });
      return measured;
    }, { measureSelector: selector });

    const elements = rawElements.map((element) => ({
      ...element,
      inches: convertMeasurementPxToInches(element.px, viewport, slideSize)
    }));
    return buildMeasurementsDocument({ source: resolvedInput, viewport, slideSize, elements });
  });
}

export async function writeMeasurements(inputPath, outputPath, options = {}) {
  const measurements = await measureHtmlFile(inputPath, options);
  const resolvedOutput = resolve(outputPath);
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(measurements, null, 2)}\n`, "utf8");
  return measurements;
}

async function main() {
  const { input, output, viewportWidth, viewportHeight, slideWidth, slideHeight, selector } = parseArgs(
    process.argv.slice(2)
  );
  if (!input || !output) {
    fail(
      "usage: measure-html.mjs <input.html> <output/layout-measurements.json> [--viewport-width 1280] [--viewport-height 720] [--selector \"[data-pptx-kind],[data-pptx-type]\"]"
    );
  }

  const measurements = await writeMeasurements(input, output, {
    viewportWidth,
    viewportHeight,
    slideWidth,
    slideHeight,
    selector,
    packageRoot
  });

  console.log(
    JSON.stringify(
      {
        measurementsPath: resolve(output),
        elements: measurements.elements.length,
        viewport: measurements.viewport,
        slideSize: measurements.slideSize
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
