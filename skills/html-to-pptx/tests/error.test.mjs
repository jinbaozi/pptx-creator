import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  HtmlToPptxError,
  buildOutputManifest,
  discardPublishedArtifacts,
  finalizeFailedOutput,
  injectNativeCharts,
  resolveHtmlInput,
  runConversion
} from "../scripts/convert.mjs";
import { expandChartElement } from "../scripts/lib/chart-renderer.mjs";

describe("diagnostic failures", () => {
  it("rejects ambiguous HTML directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-ambiguous-"));
    await writeFile(join(root, "a.html"), "<h1>A</h1>");
    await writeFile(join(root, "b.html"), "<h1>B</h1>");
    await expect(resolveHtmlInput(root)).rejects.toMatchObject({
      code: "E_INPUT_AMBIGUOUS"
    });
  });

  it("rejects unrecognized overwrite residue before browser work", async () => {
    const output = await mkdtemp(join(tmpdir(), "html-to-pptx-stale-output-"));
    await writeFile(join(output, "stale.txt"), "stale");
    try {
      await expect(runConversion(
        join(process.cwd(), "examples/minimal/index.html"),
        output,
        { overwrite: true }
      )).rejects.toMatchObject({ code: "E_OUTPUT_STALE" });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("rejects output roots and nested output entries that are symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-output-symlink-"));
    const realOutput = join(root, "real-output");
    const linkedOutput = join(root, "linked-output");
    const nestedOutput = join(root, "nested-output");
    const victim = join(root, "victim.txt");
    await mkdir(realOutput);
    await mkdir(nestedOutput);
    await writeFile(victim, "do not modify");
    await symlink(realOutput, linkedOutput);
    await symlink(victim, join(nestedOutput, "assets"));
    const input = join(process.cwd(), "examples/minimal/index.html");
    try {
      await expect(runConversion(input, linkedOutput, { overwrite: true }))
        .rejects.toMatchObject({ code: "E_OUTPUT_SYMLINK" });
      await expect(runConversion(input, nestedOutput, { overwrite: true }))
        .rejects.toMatchObject({ code: "E_OUTPUT_SYMLINK" });
      await expect(readFile(victim, "utf8")).resolves.toBe("do not modify");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes all publication artifacts during failure cleanup", async () => {
    const output = await mkdtemp(join(tmpdir(), "html-to-pptx-publication-cleanup-"));
    const artifacts = [
      "final.pptx",
      "final.pptx.pending",
      "presentation-package.json",
      "output-manifest.json"
    ];
    try {
      await Promise.all(artifacts.map((name) => writeFile(join(output, name), "artifact")));
      await expect(discardPublishedArtifacts(output)).resolves.toEqual(artifacts);
      await expect(readdir(output)).resolves.toEqual([]);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("replaces passed QA evidence with failed evidence when finalization aborts", async () => {
    const output = await mkdtemp(join(tmpdir(), "html-to-pptx-failed-finalization-"));
    const artifacts = [
      "final.pptx",
      "final.pptx.pending",
      "presentation-package.json",
      "output-manifest.json"
    ];
    try {
      await Promise.all([
        ...artifacts.map((name) => writeFile(join(output, name), "artifact")),
        writeFile(join(output, "qa-report.json"), JSON.stringify({ status: "passed" })),
        writeFile(join(output, "qa-report.md"), "- Status: passed\n")
      ]);
      const report = await finalizeFailedOutput(
        output,
        new HtmlToPptxError("E_FINALIZATION", "finalization sentinel"),
        { runId: "run-001", input: "index.html", inputKind: "plain-html" }
      );
      expect(report).toMatchObject({
        status: "failed",
        code: "E_FINALIZATION",
        finalPublished: false,
        removedPublishedArtifacts: artifacts
      });
      await expect(readdir(output)).resolves.toEqual([
        "failure-report.json",
        "qa-report.json",
        "qa-report.md"
      ]);
      await expect(readFile(join(output, "qa-report.json"), "utf8"))
        .resolves.toContain('"status": "failed"');
      await expect(readFile(join(output, "qa-report.md"), "utf8"))
        .resolves.toContain("Status: failed");
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("indexes every nested output artifact and rejects missing required reports", async () => {
    const output = await mkdtemp(join(tmpdir(), "html-to-pptx-output-manifest-"));
    try {
      await mkdir(join(output, "evidence", "attempt-0"), { recursive: true });
      await mkdir(join(output, "assets"));
      await Promise.all([
        writeFile(join(output, "qa-report.json"), "qa"),
        writeFile(join(output, "evidence", "attempt-0", "visual-comparison.json"), "visual"),
        writeFile(join(output, "assets", "fallback-001.png"), "fallback")
      ]);
      const manifest = await buildOutputManifest(output, ["qa-report.json"]);
      expect(manifest).toMatchObject({ status: "passed" });
      expect(manifest.rootSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
        "assets/fallback-001.png",
        "evidence/attempt-0/visual-comparison.json",
        "qa-report.json"
      ]);
      await expect(buildOutputManifest(output, ["missing-report.json"]))
        .rejects.toMatchObject({ code: "E_OUTPUT_MANIFEST" });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("rejects removed chart kinds at the HTML and renderer boundaries", () => {
    const value = {
      deck: { size: { width: 13.333, height: 7.5 } },
      slides: [{ id: "slide-001", elements: [] }]
    };
    const html = `<div data-pptx-id="chart-001" data-pptx-chart='{"kind":"bar","data":[1]}'></div>`;
    expect(() => injectNativeCharts(html, value, {
      elements: [{ id: "chart-001", slideIndex: 0, x: 1, y: 1, w: 2, h: 2 }]
    })).toThrow(/unsupported/);
    expect(() => expandChartElement({
      type: "chart",
      kind: "bar",
      data: [{ label: "A", value: 1 }],
      x: 1,
      y: 1,
      w: 2,
      h: 2
    })).toThrow(/unsupported chart kind/);
  });

  it("reports a missing file with a stable code", async () => {
    await expect(resolveHtmlInput("/definitely/missing/deck.html")).rejects.toMatchObject({
      code: "E_INPUT_NOT_FOUND"
    });
  });
});
