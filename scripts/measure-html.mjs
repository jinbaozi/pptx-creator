import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_VIEWPORT,
  buildMeasurementsDocument,
  convertMeasurementPxToInches
} from "./lib/html-measurement-core.mjs";
import { SLIDE_SIZE } from "./lib/html-to-manifest-core.mjs";

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
    selector: "[data-pptx-kind]"
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

async function loadPlaywright() {
  try {
    const playwright = await import("playwright");
    return playwright.chromium;
  } catch (error) {
    fail(
      [
        "Playwright is not installed.",
        "Run: npm install",
        "Then: npx playwright install chromium",
        error instanceof Error ? error.message : String(error)
      ].join("\n")
    );
  }
}

export async function measureHtmlFile(inputPath, options = {}) {
  const chromium = await loadPlaywright();
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
  const selector = options.selector ?? "[data-pptx-kind]";
  const slideSelector = ".pptx-slide, [data-slide], .pptx-deck, body";

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(pathToFileURL(resolvedInput).href, { waitUntil: "networkidle" });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

    const rawElements = await page.evaluate(({ measureSelector, slideSelector: slideSel }) => {
      const slide =
        document.querySelector(".pptx-slide") ??
        document.querySelector("[data-slide]") ??
        document.querySelector(".pptx-deck") ??
        document.body;
      const slideRect = slide.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(measureSelector)];

      return nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const id = node.getAttribute("data-pptx-id") ?? node.getAttribute("data-id") ?? node.id ?? null;
        return {
          id,
          kind: node.getAttribute("data-pptx-kind"),
          tagName: node.tagName.toLowerCase(),
          selector: id ? `[data-pptx-id="${id}"]` : null,
          px: {
            x: rect.left - slideRect.left,
            y: rect.top - slideRect.top,
            w: rect.width,
            h: rect.height
          }
        };
      });
    }, { measureSelector: selector, slideSelector });

    const elements = rawElements
      .filter((element) => element.id && element.kind)
      .map((element) => ({
        ...element,
        inches: convertMeasurementPxToInches(element.px, viewport, slideSize)
      }));

    return buildMeasurementsDocument({
      source: resolvedInput,
      viewport,
      slideSize,
      elements
    });
  } finally {
    await browser.close();
  }
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
      "usage: measure-html.mjs <input.html> <output/layout-measurements.json> [--viewport-width 1280] [--viewport-height 720] [--selector \"[data-pptx-kind]\"]"
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
