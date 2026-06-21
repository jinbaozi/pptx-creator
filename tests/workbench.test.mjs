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
    expect(await cells.count()).toBe(9);
    await expect(panel.locator(".cell.pass").first()).toBeAttached();

    // Click expands the detail panel.
    const detail = panel.locator("#consistency-cell-detail");
    await expect(detail).toBeHidden();
    await cells.first().click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("editabilityLevel");

    await browser.close();
  });

  it("renders 9 cells when consistency report includes layoutSafety", async () => {
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
      layoutSafety: "passed",
      editabilityFloor: {
        level: 4,
        satisfied: true,
        floorViolation: { pipelineCausal: [], sourceCausal: [] }
      },
      previewDiff: { status: "ok", perSlide: [{ slideId: "s1" }] }
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), sample);

    const panel = page.locator("[data-panel='consistency-report']");
    await expect(panel).toContainText("Layout safety");

    const cells = panel.locator(".cell");
    expect(await cells.count()).toBe(9);
    // layoutSafety: passed → pass tone
    const layoutSafetyCell = panel.locator(".cell[data-cell='layoutSafety']");
    await expect(layoutSafetyCell).toHaveClass(/pass/);
    await browser.close();
  });

  it("renders 8 cells with 'not measured' placeholder when layoutSafety is absent", async () => {
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
      // layoutSafety intentionally absent
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), sample);

    const panel = page.locator("[data-panel='consistency-report']");
    const cells = panel.locator(".cell");
    expect(await cells.count()).toBe(9);
    const layoutSafetyCell = panel.locator(".cell[data-cell='layoutSafety']");
    await expect(layoutSafetyCell).toContainText("not measured");
    // warn tone class applied for missing values
    await expect(layoutSafetyCell).toHaveClass(/warn/);
    await browser.close();
  });

  it("maps layoutSafety: 'violated-blocked' to the fail tone class", async () => {
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
      layoutSafety: "violated-blocked",
      editabilityFloor: {
        level: 4,
        satisfied: true,
        floorViolation: { pipelineCausal: [], sourceCausal: [] }
      },
      previewDiff: { status: "ok", perSlide: [{ slideId: "s1" }] }
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), sample);

    const panel = page.locator("[data-panel='consistency-report']");
    const layoutSafetyCell = panel.locator(".cell[data-cell='layoutSafety']");
    await expect(layoutSafetyCell).toHaveClass(/fail/);
    await expect(layoutSafetyCell).toContainText("violated-blocked");
    await browser.close();
  });

  it("maps layoutSafety: 'violated-with-flag' to the warn tone class", async () => {
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
      layoutSafety: "violated-with-flag",
      editabilityFloor: {
        level: 4,
        satisfied: true,
        floorViolation: { pipelineCausal: [], sourceCausal: [] }
      },
      previewDiff: { status: "ok", perSlide: [{ slideId: "s1" }] }
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), sample);

    const panel = page.locator("[data-panel='consistency-report']");
    const layoutSafetyCell = panel.locator(".cell[data-cell='layoutSafety']");
    await expect(layoutSafetyCell).toHaveClass(/warn/);
    await expect(layoutSafetyCell).toContainText("violated-with-flag");
    await browser.close();
  });

  it("maps layoutSafety: 'passed' to the pass tone class", async () => {
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
      layoutSafety: "passed",
      editabilityFloor: {
        level: 4,
        satisfied: true,
        floorViolation: { pipelineCausal: [], sourceCausal: [] }
      },
      previewDiff: { status: "ok", perSlide: [{ slideId: "s1" }] }
    };
    await page.evaluate((report) => window.renderConsistencyReport(report), sample);

    const panel = page.locator("[data-panel='consistency-report']");
    const layoutSafetyCell = panel.locator(".cell[data-cell='layoutSafety']");
    await expect(layoutSafetyCell).toHaveClass(/pass/);
    await expect(layoutSafetyCell).toContainText("passed");
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

describe("Visual Quality tab (U10)", () => {
  it("exposes the Visual Quality tab button and panel article in index.html", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    await expect(page.locator("button[data-tab='visual-quality']")).toBeAttached();
    await expect(page.locator("[data-panel='visual-quality']")).toBeAttached();
    await expect(page.locator("#visual-quality-panel")).toBeAttached();
    await browser.close();
  });

  it("renders the loading placeholder initially when neither report file is present", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.fetch = async () => new Response("Not Found", { status: 404, statusText: "Not Found" });
    });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    await page.waitForTimeout(50);
    const panel = page.locator("[data-panel='visual-quality']");
    // Both files 404 -> "Run npm run pipeline first" empty state
    await expect(panel.locator(".consistency-empty")).toBeAttached();
    await expect(panel).toContainText("npm run pipeline");
    await browser.close();
  });

  it("renders 'slopRisk not measured' when only visual-review.json is missing", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.fetch = async (input) => {
        if (typeof input === "string" && input.includes("visual-review.json")) {
          return new Response("Not Found", { status: 404, statusText: "Not Found" });
        }
        return new Response(JSON.stringify({
          checks: [],
          summary: { criticalCount: 0, warningCount: 0, blocked: false }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    await page.waitForTimeout(50);
    const panel = page.locator("[data-panel='visual-quality']");
    await expect(panel.locator(".consistency-empty")).toBeAttached();
    await expect(panel).toContainText("slopRisk not measured");
    await browser.close();
  });

  it("renders 'Layout safety not measured' when only layout-safety-report.json is missing", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.fetch = async (input) => {
        if (typeof input === "string" && input.includes("layout-safety-report.json")) {
          return new Response("Not Found", { status: 404, statusText: "Not Found" });
        }
        return new Response(JSON.stringify({
          mode: "creative",
          deckScore: 80,
          slopRisk: 22,
          slides: []
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    await page.waitForTimeout(50);
    const panel = page.locator("[data-panel='visual-quality']");
    await expect(panel.locator(".consistency-empty")).toBeAttached();
    await expect(panel).toContainText("Layout safety not measured");
    await browser.close();
  });

  it("renders the malformed-JSON state when a report file is unparseable", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.fetch = async (input) => {
        if (typeof input === "string" && input.includes("visual-review.json")) {
          return new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          checks: [],
          summary: { criticalCount: 0, warningCount: 0, blocked: false }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    await page.waitForTimeout(50);
    const panel = page.locator("[data-panel='visual-quality']");
    await expect(panel.locator(".consistency-empty")).toBeAttached();
    await expect(panel).toContainText("malformed");
    await browser.close();
  });

  it("renders the two side-by-side traffic-light grids when both files are present", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const visual = {
      mode: "creative",
      deckScore: 80,
      slopRisk: 22,
      slides: []
    };
    const layout = {
      deckSize: { width: 13.333, height: 7.5 },
      checks: [
        { kind: "bounds", severity: "critical", slideId: "s1", elementId: "e1" },
        { kind: "overlap", severity: "warning", slideId: "s2", elementId: "e2" }
      ],
      summary: { criticalCount: 1, warningCount: 1, blocked: false }
    };
    await page.evaluate(
      ([v, l]) => window.renderVisualQualityReport(v, l, {}),
      [visual, layout]
    );
    const panel = page.locator("[data-panel='visual-quality']");
    // 1 slopRisk cell + 8 layout-safety kind cells = 9 cells
    const cells = panel.locator(".cell");
    expect(await cells.count()).toBe(9);
    await expect(panel.locator(".cell[data-cell='slopRisk']")).toHaveClass(/pass/);
    await expect(panel.locator(".cell[data-cell='bounds']")).toHaveClass(/fail/);
    await expect(panel.locator(".cell[data-cell='overlap']")).toHaveClass(/warn/);
    await expect(panel.locator(".cell[data-cell='contrast-fail']")).toHaveClass(/pass/);
    await browser.close();
  });

  it("maps slopRisk thresholds: <40 pass, 40-74 warn, >=75 fail", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const layout = { checks: [], summary: { criticalCount: 0, warningCount: 0, blocked: false } };
    for (const [score, expectedTone] of [[10, "pass"], [50, "warn"], [88, "fail"]]) {
      await page.evaluate(
        ([s, l]) => window.renderVisualQualityReport({ slopRisk: s }, l, {}),
        [score, layout]
      );
      const cell = page.locator("[data-panel='visual-quality'] .cell[data-cell='slopRisk']");
      await expect(cell).toHaveClass(new RegExp(expectedTone));
    }
    await browser.close();
  });

  it("renders termination signals: accepted=true shows muted checkmark", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const signal = await page.evaluate(() => window.renderTerminationSignals({
      retryCount: 0,
      accepted: true,
      acceptedAt: "2026-06-21T00:00:00.000Z"
    }));
    expect(signal).toContain("termination-accepted");
    expect(signal).toContain("Accepted");
    expect(signal).toContain("2026-06-21T00:00:00.000Z");
    await browser.close();
  });

  it("renders termination signals: retryCount=2 shows warn banner", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const signal = await page.evaluate(() => window.renderTerminationSignals({
      retryCount: 2,
      accepted: null,
      acceptedAt: null
    }));
    expect(signal).toContain("termination-warn");
    expect(signal).toContain("Attempt 2 of 3");
    await browser.close();
  });

  it("renders termination signals: retryCount=3 shows red fail banner", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const signal = await page.evaluate(() => window.renderTerminationSignals({
      retryCount: 3,
      accepted: null,
      acceptedAt: null
    }));
    expect(signal).toContain("termination-fail");
    expect(signal).toContain("Attempt 3 of 3");
    await browser.close();
  });

  it("deeplinks from the consistency-report layoutSafety cell to the Visual Quality tab", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(resolve("workbench/index.html")).href);
    const report = {
      version: "1.0",
      inputType: "html",
      inputSource: "demo.html",
      editabilityLevel: 4,
      coordinateDriftPx: 0.5,
      fontFallback: [],
      paletteMatch: 0.92,
      rasterizedRegions: [],
      layoutSafety: "passed",
      editabilityFloor: {
        level: 4,
        satisfied: true,
        floorViolation: { pipelineCausal: [], sourceCausal: [] }
      },
      previewDiff: { status: "ok", perSlide: [{ slideId: "s1" }] }
    };
    await page.evaluate((r) => window.renderConsistencyReport(r), report);
    const consistencyPanel = page.locator("[data-panel='consistency-report']");
    const layoutSafetyCell = consistencyPanel.locator(".cell[data-cell='layoutSafety']");
    // Mark Visual Quality panel with manual override so we can detect tab switch
    await page.evaluate(() => {
      const panel = document.querySelector("[data-panel='visual-quality']");
      panel.dataset.manualOverride = "true";
      panel.innerHTML = "<p>ok</p>";
    });
    await layoutSafetyCell.click();
    // The Visual Quality tab should now be active
    const activeTab = page.locator("button[data-tab='visual-quality']");
    await expect(activeTab).toHaveClass(/is-active/);
    await browser.close();
  });
});
