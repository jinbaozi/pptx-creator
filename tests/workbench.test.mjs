import { describe, it } from "vitest";
import { chromium, expect } from "playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

describe("Visual Workbench", () => {
  it("loads the static workbench shell", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    await expect(page.locator("text=Visual Workbench")).toBeVisible();
    await expect(page.locator("[data-panel='directions']")).toBeVisible();
    await browser.close();
  });

  it("exposes artifact category panels in the DOM", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const hooks = [
      "requirements",
      "ui-spec",
      "component-specs",
      "preview-artifacts",
      "vision-review",
      "repair-patch"
    ];
    for (const hook of hooks) {
      await expect(page.locator(`[data-panel='${hook}']`)).toBeAttached();
    }
    // backward compat with original panel hooks
    await expect(page.locator("[data-panel='directions']")).toBeAttached();
    await expect(page.locator("[data-panel='slides']")).toBeAttached();
    await expect(page.locator("[data-panel='reviews']")).toBeAttached();
    // consistency report panel (U10)
    await expect(page.locator("[data-panel='consistency-report']")).toBeAttached();
    await browser.close();
  });

  it("renders loaded design artifacts in their panels", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const sample = {
      runId: "test-run",
      mode: "creative",
      status: "in-progress",
      input: { type: "text", summary: "Sample run" },
      artifacts: {
        requirements: {
          version: "1.0",
          audience: "execs",
          objective: "Demo deck",
          sourceFacts: [],
          mustInclude: ["R1"],
          mustAvoid: [],
          tone: "neutral",
          confidenceNotes: []
        },
        uiSpec: { version: "1.0", slides: [{ id: "s1", layoutPattern: "title", regions: [] }] },
        componentSpecs: { version: "1.0", slides: [{ id: "s1", components: [] }] },
        previews: ["previews/slide-1.png"],
        reviews: ["vision-review.json"],
        visionReview: {
          reviewer: { type: "vision", provider: "mock", model: "v1", createdAt: "2025-01-01" },
          deckScore: 88,
          slides: []
        },
        repairPatch: { attempt: 1, patches: [] }
      },
      directions: []
    };
    await page.evaluate((run) => window.renderRun(run), sample);
    await expect(page.locator("[data-panel='requirements']")).toContainText("execs");
    await expect(page.locator("[data-panel='ui-spec']")).toContainText("title");
    await expect(page.locator("[data-panel='component-specs']")).toContainText("s1");
    await expect(page.locator("[data-panel='preview-artifacts']")).toContainText("slide-1.png");
    await expect(page.locator("[data-panel='vision-review']")).toContainText("88");
    await expect(page.locator("[data-panel='repair-patch']")).toContainText("1");
    await browser.close();
  });

  it("renders traffic-light cells when a consistency report is provided", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);

    const sample = {
      version: "1.0",
      inputType: "html",
      inputSource: "examples/html-input/sample.html",
      editabilityLevel: 4,
      coordinateDriftPx: 0.5,
      fontFallback: [],
      paletteMatch: 0.92,
      rasterizedRegions: [],
      editabilityFloor: {
        level: 4,
        satisfied: true,
        floorViolation: { pipelineCausal: [], sourceCausal: [] }
      },
      previewDiff: { status: "ok", perSlide: [{ slideId: "s1" }] }
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), sample);

    const panel = page.locator("[data-panel='consistency-report']");
    await expect(panel).toContainText("Editability");
    await expect(panel).toContainText("Coord drift");
    await expect(panel).toContainText("Font fallback");
    await expect(panel).toContainText("Palette match");
    await expect(panel).toContainText("Rasterized");
    await expect(panel).toContainText("Floor");
    await expect(panel).toContainText("Preview diff");
    await expect(panel).toContainText("Input type");

    // All cells present with tone classes.
    const cells = panel.locator(".cell");
    expect(await cells.count()).toBe(8);
    await expect(panel.locator(".cell.pass").first()).toBeAttached();

    // Click expands the detail panel.
    const detail = panel.locator("#consistency-cell-detail");
    await expect(detail).toBeHidden();
    await cells.first().click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("editabilityLevel");

    await browser.close();
  });

  it("classifies failed image input as fail cells", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);

    const failed = {
      version: "1.0",
      inputType: "image",
      inputSource: "examples/image-input/calibration/sparse.png",
      editabilityLevel: 1,
      coordinateDriftPx: 4.5,
      fontFallback: [{ element: "title", requested: "Inter", fallback: "Arial" }],
      paletteMatch: 0.4,
      rasterizedRegions: [{ slideId: "s1", elementId: "e1", areaPct: 0.8, reason: "raster-fallback" }],
      editabilityFloor: {
        level: 3,
        satisfied: false,
        floorViolation: {
          pipelineCausal: [],
          sourceCausal: [{ reason: "source-caused-raster-fallback", recoverable: false }]
        }
      },
      previewDiff: { status: "deferred" }
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), failed);
    const panel = page.locator("[data-panel='consistency-report']");
    await expect(panel.locator(".cell.fail").first()).toBeAttached();
    await expect(panel).toContainText("violated");
    await browser.close();
  });

  it("shows the empty-state guidance when consistencyReport is null", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);

    await page.evaluate(() => window.renderConsistencyReport(null));
    const panel = page.locator("[data-panel='consistency-report']");
    await expect(panel.locator(".consistency-empty")).toBeAttached();
    await expect(panel).toContainText("npm run pipeline");
    await browser.close();
  });

  it("falls back gracefully when output/consistency-report.json is missing", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Stub fetch to simulate a 404 from the static server (workbench/ has no output/).
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (typeof input === "string" && input.includes("consistency-report.json")) {
          return new Response("Not Found", { status: 404, statusText: "Not Found" });
        }
        return originalFetch(input, init);
      };
    });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    // Give the DOMContentLoaded hook a tick to run.
    await page.waitForTimeout(50);
    const panel = page.locator("[data-panel='consistency-report']");
    await expect(panel.locator(".consistency-empty")).toBeAttached();
    await browser.close();
  });
});
