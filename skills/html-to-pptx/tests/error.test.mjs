import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  injectNativeCharts,
  resolveHtmlInput
} from "../scripts/convert.mjs";

describe("diagnostic failures", () => {
  it("rejects ambiguous HTML directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-ambiguous-"));
    await writeFile(join(root, "a.html"), "<h1>A</h1>");
    await writeFile(join(root, "b.html"), "<h1>B</h1>");
    await expect(resolveHtmlInput(root)).rejects.toMatchObject({
      code: "E_INPUT_AMBIGUOUS"
    });
  });

  it("rejects chart markers with unsupported kinds", () => {
    const value = {
      deck: { size: { width: 13.333, height: 7.5 } },
      slides: [{ id: "slide-001", elements: [] }]
    };
    const html = `<div data-pptx-id="chart-001" data-pptx-chart='{"kind":"unknown","data":[1]}'></div>`;
    expect(() => injectNativeCharts(html, value, {
      elements: [{ id: "chart-001", slideIndex: 0, x: 1, y: 1, w: 2, h: 2 }]
    })).toThrow(/unsupported/);
  });

  it("reports a missing file with a stable code", async () => {
    await expect(resolveHtmlInput("/definitely/missing/deck.html")).rejects.toMatchObject({
      code: "E_INPUT_NOT_FOUND"
    });
  });
});
