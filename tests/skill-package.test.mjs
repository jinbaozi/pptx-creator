import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectSkillFiles, loadSkillPackageSpec } from "../scripts/lib/skill-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("standard skill package allowlist", () => {
  it("contains the public contract and runtime resources without repository-only files", async () => {
    const spec = await loadSkillPackageSpec(root);
    const files = await collectSkillFiles(root, spec);

    expect(files).toContain("SKILL.md");
    expect(files).toContain("agents/openai.yaml");
    expect(files).toContain("references/routes/text.md");
    expect(files).toContain("scripts/pptx.mjs");
    expect(files).toContain("schemas/deck-plan.schema.json");
    expect(files).toContain("examples/creative-benchmark/corpus.json");
    expect(files.some((file) => file.startsWith("tests/"))).toBe(false);
    expect(files.some((file) => file.startsWith("output/"))).toBe(false);
    expect(files.some((file) => file.includes("__pycache__") || file.endsWith(".pyc"))).toBe(false);
    expect(files.some((file) => ["README.md", "README.en.md", "AGENTS.md"].includes(path.basename(file)))).toBe(false);
    expect(files.every((file) => fs.statSync(path.join(root, file)).isFile())).toBe(true);
  });
});
