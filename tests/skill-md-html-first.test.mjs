import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

describe("SKILL.md HTML-first 推荐流程 subsection", () => {
  it("contains the bilingual subsection header", async () => {
    const skill = await read("SKILL.md");
    expect(skill).toContain("HTML-first 推荐流程");
  });

  it("lists all three HTML-first trigger conditions", async () => {
    const skill = await read("SKILL.md");
    expect(skill).toMatch(/design-first creative/i);
    expect(skill).toMatch(/rich visual/i);
    expect(skill).toMatch(/host agent explicit judgment/i);
  });

  it("makes the default text-to-manifest path explicit", async () => {
    const skill = await read("SKILL.md");
    expect(skill).toMatch(/Default:\s*text\s*[→>\-]+\s*manifest/i);
  });
});

describe("compiler-roadshow-html showcase artifacts", () => {
  const showcaseDir = "examples/design-first/compiler-roadshow-html";

  it("ships a deck.html with a slide section", async () => {
    const html = await read(`${showcaseDir}/deck.html`);
    expect(html).toContain("<section");
  });

  it("ships a qa-rubric.md with qualitative content sections", async () => {
    const rubric = await read(`${showcaseDir}/qa-rubric.md`);
    expect(rubric).toMatch(/design rationale/i);
    expect(rubric).toMatch(/tradeoffs/i);
    expect(rubric).toMatch(/known limitations/i);
  });

  it("does not assert numeric self-scores in qa-rubric.md (qualitative only)", async () => {
    const rubric = await read(`${showcaseDir}/qa-rubric.md`);
    expect(rubric).not.toMatch(/\bscore:\s*\d+/i);
    expect(rubric).not.toMatch(/\/\s*\d{1,3}\b/);
  });

  it("produces a deck.manifest.json that validates against the deck schema", async () => {
    const manifestPath = join(root, showcaseDir, "deck.manifest.json");
    await expect(access(manifestPath)).resolves.toBeUndefined();
    const manifest = JSON.parse(await read(`${showcaseDir}/deck.manifest.json`));
    expect(Array.isArray(manifest.slides)).toBe(true);
    expect(manifest.slides.length).toBeGreaterThanOrEqual(8);
    expect(manifest.slides.length).toBeLessThanOrEqual(12);

    const python = process.env.PPTX_CREATOR_PYTHON || "python3";
    const result = spawnSync(
      python,
      ["scripts/validate-manifest.py", `${showcaseDir}/deck.manifest.json`],
      { cwd: root, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("manifest valid");
  });
});