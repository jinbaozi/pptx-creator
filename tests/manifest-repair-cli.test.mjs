import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "scripts/pptx.mjs");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pptx-manifest-repair-"));
  const manifest = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
  manifest.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
  const manifestPath = join(dir, "deck.manifest.json");
  const patchPath = join(dir, "repair-patch.json");
  const outputPath = join(dir, "repaired.manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { dir, manifest, manifestPath, patchPath, outputPath };
}

async function runRepair(paths, patch) {
  await writeFile(paths.patchPath, JSON.stringify(patch), "utf8");
  return execFileAsync(process.execPath, [cli, "manifest", paths.manifestPath, paths.patchPath, paths.outputPath], { cwd: root });
}

describe("public manifest repair route", () => {
  it("validates input and output around a successful repair subprocess", async () => {
    const paths = await fixture();
    await runRepair(paths, {
      attempt: 1,
      patches: [{ operation: "updateText", slideId: "slide-001", targetElementId: "title", changes: { text: "Repaired" } }]
    });
    const repaired = JSON.parse(await readFile(paths.outputPath, "utf8"));
    expect(repaired.slides[0].elements.find((element) => element.id === "title").text).toBe("Repaired");
  });

  it("blocks an invalid input manifest", async () => {
    const paths = await fixture();
    paths.manifest.version = "0.1.1";
    await writeFile(paths.manifestPath, JSON.stringify(paths.manifest), "utf8");
    await expect(runRepair(paths, { attempt: 1, patches: [] })).rejects.toThrow(/input manifest/i);
    await expect(access(paths.outputPath)).rejects.toThrow();
  });

  it.each([
    ["missing attempt", { patches: [] }],
    ["attempt four", { attempt: 4, patches: [] }],
    ["invalid patch", { attempt: 1, patches: [{ operation: "explode" }] }]
  ])("blocks %s", async (_label, patch) => {
    const paths = await fixture();
    await expect(runRepair(paths, patch)).rejects.toThrow(/repair patch/i);
    await expect(access(paths.outputPath)).rejects.toThrow();
  });

  it("validates the repaired output before publishing it", async () => {
    const paths = await fixture();
    await expect(runRepair(paths, {
      attempt: 1,
      patches: [{ operation: "move", slideId: "slide-001", targetElementId: "title", changes: { x: 99 } }]
    })).rejects.toThrow(/output manifest/i);
    await expect(access(paths.outputPath)).rejects.toThrow();
  });
});
