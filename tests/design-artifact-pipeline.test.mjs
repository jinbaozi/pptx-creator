import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function exists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

describe("design artifact pipeline CLI", () => {
  it("writes requirements, ui spec, component specs, design tokens, and preview artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-artifact-pipeline-"));
    const inputPath = join(dir, "input.txt");
    await writeFile(inputPath, "Build a business technology roadshow deck highlighting layered architecture, process flow, and roadmap for technical executives.\n");

    const outputDir = join(dir, "design-artifacts");
    await execFileAsync(process.execPath, [
      "scripts/run-design-artifact-pipeline.mjs",
      inputPath,
      outputDir,
      "--audience",
      "technical executives",
      "--tone",
      "business technology roadshow"
    ]);

    const expected = [
      "requirements.json",
      "ui-spec.json",
      "component-specs.json",
      "design-tokens.json",
      "preview-artifacts/index.html",
      "preview-artifacts/styles.css",
      "preview-artifacts/components.jsx",
      "preview-artifacts/data.jsx"
    ];
    for (const relative of expected) {
      const full = join(outputDir, relative);
      expect(await exists(full), `expected file: ${relative}`).toBe(true);
    }

    const requirements = JSON.parse(await readFile(join(outputDir, "requirements.json"), "utf8"));
    expect(requirements.audience).toBe("technical executives");
    expect(requirements.tone).toBe("business technology roadshow");

    const uiSpec = JSON.parse(await readFile(join(outputDir, "ui-spec.json"), "utf8"));
    expect(Array.isArray(uiSpec.slides)).toBe(true);
    expect(uiSpec.slides.length).toBeGreaterThanOrEqual(5);
    expect(uiSpec.slides.length).toBeLessThanOrEqual(7);

    const componentSpecs = JSON.parse(await readFile(join(outputDir, "component-specs.json"), "utf8"));
    expect(componentSpecs.slides.length).toBe(uiSpec.slides.length);

    const designTokens = JSON.parse(await readFile(join(outputDir, "design-tokens.json"), "utf8"));
    expect(designTokens.color).toBeTruthy();
    expect(designTokens.typography).toBeTruthy();
    expect(designTokens.spacing).toBeTruthy();
  });
});
