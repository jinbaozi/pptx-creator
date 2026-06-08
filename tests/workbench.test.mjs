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
});
