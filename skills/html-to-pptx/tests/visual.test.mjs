import { access, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runConversion } from "../scripts/convert.mjs";

const visualIt = process.env.PLAYWRIGHT_RUN === "1" ? it : it.skip;

describe("HTML -> editable PPTX visual proof", () => {
  visualIt("runs the full generation, render, compare, and gate loop", async () => {
    const output = await mkdtemp(join(tmpdir(), "html-to-pptx-visual-"));
    const result = await runConversion(
      resolve("examples/minimal/index.html"),
      output,
      { overwrite: true, browserTimeoutMs: 90_000, maxRepairAttempts: 3 }
    );
    expect(result).toMatchObject({
      status: "passed",
      slides: 1,
      editabilityLevel: 5,
      nativeCoverage: 1
    });
    await access(join(output, "final.pptx"));
    const qa = JSON.parse(await readFile(join(output, "qa-report.json"), "utf8"));
    expect(qa.gates.pptxGeometry.criticalCount).toBe(0);
    expect(qa.gates.visual.passed).toBe(true);
    expect(qa.gates.fullSlideRaster.violations).toBe(0);
  });
});
