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
    expect(body.split("\n").length).toBeLessThanOrEqual(80);
    expect(body).toContain("Select exactly one route");

    const references = [...body.matchAll(/`(references\/routes\/[A-Za-z0-9._-]+\.md)`/g)].map((match) => match[1]);
    expect(new Set(references).size).toBe(5);
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
    expect(workflow).toContain("npm run pptx -- text");
    expect(workflow).not.toContain("node scripts/run-deck-pipeline.mjs");
    expect(workflow).toContain("output/assets");
    expect(workflow).toContain("web research");
    expect(workflow).not.toMatch(/[鑱绱潗]/);
  });

  it("documents the design-first route and strict replica boundary", async () => {
    const skill = await read("SKILL.md");
    const textRoute = await read("references/routes/text.md");
    const workflow = await read("references/design-first-workflow.md");
    expect(skill).toContain("references/routes/text.md");
    expect(textRoute).toContain("references/design-first-workflow.md");
    expect(workflow).toMatch(/deck\.plan\.json/);
    expect(workflow).not.toMatch(/deck\.storyboard\.json|deck\.design-direction\.json|slide-design-specs\.json/);
    expect(workflow).toMatch(/Replica routes/i);
  });

  it("publishes one progressive Creative Director host contract", async () => {
    const paths = [
      "SKILL.md",
      "references/routes/text.md",
      "references/design-first-workflow.md",
      "references/creative-intent.md",
      "references/creative-direction-probes.md",
      "references/semantic-slide-ir.md",
      "references/creative-visual-proof.md",
      "references/creative-refinement.md",
      "references/creative-benchmark.md"
    ];
    const documents = await Promise.all(paths.map(read));
    const combined = documents.join("\n");
    expect(combined).toMatch(/Creative Director Pipeline/i);
    expect(combined).toMatch(/deck\.plan\.json[^\n]*(?:authoring truth|authoring contract)/i);
    expect(combined).toMatch(/Semantic Slide IR[^\n]*authoring truth/i);
    expect(combined).toMatch(/manifest[^\n]*render truth/i);
    expect(combined).toContain("deck.plan.json version `0.2.0`");
    expect(combined).toMatch(/conditional[^\n]*(?:direction|candidate)/i);
    expect(combined).toMatch(/mandatory Host[^\n]*(?:visual|screenshot) review/i);
    expect(combined).toMatch(/native-first/i);
    expect(combined).toMatch(/safe refinement/i);
    expect(combined).toMatch(/24 briefs/i);
    expect(combined).toMatch(/Wilson 95% lower bound > 50%/i);
    expect(combined).not.toMatch(/deck\.plan(?:\.json)?[^\n]*0\.1\.0/i);
    expect(combined).not.toMatch(/always (?:generate|create|render)[^\n]*\b[234]\b[^\n]*candidates?/i);
  });

  it("pins external design provenance without claiming runtime integration or effect", async () => {
    const provenance = await read("references/external-design-provenance.md");
    const pins = {
      "leonxlnx/taste-skill": "b17742737e796305d829b3ad39eda3add0d79060",
      "pbakaus/impeccable": "f2049c2b76383b444bf30cd6184f7d49a6c580d1",
      "jinbaozi/Visual-Proof-Gate": "9742d87b8d6441d1b344ebc9de16548656e60b3e",
      "Trystan-SA/claude-design-system-prompt": "3c3ddb07d7aa3fef051d83608596470c95cfd8fe"
    };
    for (const [repository, commit] of Object.entries(pins)) {
      expect(provenance).toContain(repository);
      expect(provenance).toContain(commit);
      expect(provenance).toContain(`https://github.com/${repository}/tree/${commit}`);
    }
    expect(provenance).toMatch(/adapted protocols/i);
    expect(provenance).toMatch(/not runtime (?:dependencies|integrations)/i);
    expect(provenance).toMatch(/do not independently prove/i);
  });

  it("ships a completion audit that leaves absent human blind review open", async () => {
    const audit = await read("references/creative-director-completion-audit.md");
    expect(audit).toMatch(/global constraints/i);
    expect(audit).toMatch(/schemas\/deck-plan\.schema\.json/);
    expect(audit).toMatch(/scripts\/lib\/semantic-slide-ir\.mjs/);
    expect(audit).toMatch(/\.github\/workflows\/ci\.yml/);
    expect(audit).toMatch(/24 briefs x at least five reviewers/i);
    expect(audit).toMatch(/missing/i);
    expect(audit).toMatch(/goal remains active/i);
    expect(audit).toMatch(/release quality is unproven/i);
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
