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
});
