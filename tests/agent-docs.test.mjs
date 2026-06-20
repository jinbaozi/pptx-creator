import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

function splitSkill(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter");
  return { metadata: parseYaml(match[1]), body: match[2] };
}

describe("universal Agent Skill packaging", () => {
  it("uses only portable trigger metadata", async () => {
    const { metadata } = splitSkill(await read("SKILL.md"));
    expect(Object.keys(metadata).sort()).toEqual(["description", "name"]);
    expect(metadata.name).toBe("pptx-creator");
    expect(metadata.description).toMatch(/PowerPoint/i);
    expect(metadata.description).toMatch(/HTML/);
    expect(metadata.description).toMatch(/PDF/);
  });

  it("keeps the skill body concise and routes details progressively", async () => {
    const { body } = splitSkill(await read("SKILL.md"));
    expect(body.split("\n").length).toBeLessThan(120);
    expect(body).toContain("Do not read every reference up front");

    const references = [...body.matchAll(/`(references\/[A-Za-z0-9._-]+\.md)`/g)].map((match) => match[1]);
    expect(new Set(references).size).toBeGreaterThanOrEqual(10);
    for (const relativePath of new Set(references)) {
      await expect(access(join(root, relativePath))).resolves.toBeUndefined();
    }
  });

  it("ships matching OpenAI interface metadata without coupling runtime logic", async () => {
    const metadata = parseYaml(await read("agents/openai.yaml"));
    expect(metadata.interface.display_name).toBe("PPTX Creator");
    expect(metadata.interface.short_description.length).toBeGreaterThanOrEqual(25);
    expect(metadata.interface.short_description.length).toBeLessThanOrEqual(64);
    expect(metadata.interface.default_prompt).toContain("$pptx-creator");
    expect(metadata.dependencies).toBeUndefined();
  });

  it("does not keep duplicate host-specific operating guides", async () => {
    await expect(access(join(root, "AGENT.md"))).rejects.toThrow();
    for (const adapter of ["codex.md", "claude-code.md", "cursor.md"]) {
      await expect(access(join(root, "adapters", adapter))).rejects.toThrow();
    }
  });

  it("keeps the common workflow portable and free of corrupted text", async () => {
    const workflow = await read("references/workflow.md");
    expect(workflow).toContain("node scripts/run-deck-pipeline.mjs");
    expect(workflow).toContain("output/assets");
    expect(workflow).toContain("web research");
    expect(workflow).not.toMatch(/[鑱绱潗]/);
  });

  it("documents the design-first route and strict replica boundary", async () => {
    const skill = await read("SKILL.md");
    const workflow = await read("references/design-first-workflow.md");
    expect(skill).toContain("references/design-first-workflow.md");
    expect(workflow).toMatch(/deck\.storyboard\.json/);
    expect(workflow).toMatch(/deck\.design-direction\.json/);
    expect(workflow).toMatch(/slide-design-specs\.json/);
    expect(workflow).toMatch(/Replica mode/i);
  });

  it("keeps bilingual project documentation aligned with the skill layout", async () => {
    const readme = await read("README.md");
    const englishReadme = await read("README.en.md");
    expect(readme).toContain("agents/openai.yaml");
    expect(readme).toContain("渐进加载");
    expect(englishReadme).toContain("agents/openai.yaml");
    expect(englishReadme).toContain("loaded progressively");
  });
});
