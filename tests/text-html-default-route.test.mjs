import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTextHtmlInput } from "../scripts/run-text-html-pipeline.mjs";

describe("default text HTML-first route", () => {
  it("resolves deck.html from a plan directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-text-html-"));
    const html = join(dir, "deck.html");
    await writeFile(html, "<section class=\"pptx-slide\"></section>", "utf8");
    await expect(resolveTextHtmlInput(dir)).resolves.toBe(html);
  });

  it("resolves visual-source.html beside a plan file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-text-plan-"));
    const plan = join(dir, "deck.plan.json");
    const html = join(dir, "visual-source.html");
    await writeFile(plan, "{}", "utf8");
    await writeFile(html, "<section class=\"pptx-slide\"></section>", "utf8");
    await expect(resolveTextHtmlInput(plan)).resolves.toBe(html);
  });

  it("fails closed when the Host did not author HTML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-text-no-html-"));
    const plan = join(dir, "deck.plan.json");
    await writeFile(plan, "{}", "utf8");
    await expect(resolveTextHtmlInput(plan)).rejects.toThrow(/HTML-first by default/);
  });
});
