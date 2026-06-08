import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const requiredDocs = [
  "AGENT.md",
  "adapters/codex.md",
  "adapters/claude-code.md",
  "adapters/cursor.md"
];

describe("M3 agent productization docs", () => {
  it.each(requiredDocs)("ships %s", async (relativePath) => {
    await access(join(root, relativePath));
  });

  it("documents the universal pipeline contract", async () => {
    const guide = await readFile(join(root, "AGENT.md"), "utf8");

    expect(guide).toContain("SKILL.md");
    expect(guide).toContain("DESIGN.md");
    expect(guide).toContain("deck.manifest.json");
    expect(guide).toContain("node scripts/run-deck-pipeline.mjs");
    expect(guide).toContain("editable-report.md");
    expect(guide).toContain("qa-report.md");
  });

  it("ships split Chinese and English READMEs with core project documentation", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const englishReadme = await readFile(join(root, "README.en.md"), "utf8");

    expect(readme).toContain("## 中文版");
    expect(readme).toContain("[English](README.en.md)");
    expect(readme).toContain("核心能力");
    expect(readme).toContain("安装部署");
    expect(readme).toContain("整体架构");
    expect(readme).toContain("npm run pipeline");
    expect(readme).not.toContain("## English");

    expect(englishReadme).toContain("## English");
    expect(englishReadme).toContain("[中文](README.md)");
    expect(englishReadme).toContain("Core Capabilities");
    expect(englishReadme).toContain("Installation");
    expect(englishReadme).toContain("Architecture");
    expect(englishReadme).toContain("npm run pipeline");
  });

  it("documents autonomous web search and source-safe asset handling", async () => {
    const guide = await readFile(join(root, "AGENT.md"), "utf8");
    const skill = await readFile(join(root, "SKILL.md"), "utf8");
    const workflow = await readFile(join(root, "references/workflow.md"), "utf8");
    const prompts = await readFile(join(root, "references/prompt-library.md"), "utf8");

    for (const content of [guide, skill, workflow, prompts]) {
      const lower = content.toLowerCase();
      expect(lower).toContain("web search");
      expect(lower).toContain("source");
      expect(content).toContain("output/assets");
    }
    expect(prompts).not.toContain("fabricate facts");
  });

  it("documents Codex, Claude Code, and Cursor adapters", async () => {
    for (const relativePath of requiredDocs.slice(1)) {
      const content = await readFile(join(root, relativePath), "utf8");
      expect(content).toContain("npm install");
      expect(content).toContain("npm run setup");
      expect(content).toContain("node scripts/run-deck-pipeline.mjs");
      expect(content).toContain("PPTX_CREATOR_PYTHON");
    }
  });

  it("documents design-first creative deck workflow", async () => {
    const files = [
      "AGENT.md",
      "SKILL.md",
      "references/workflow.md",
      "references/design-first-workflow.md",
      "README.md",
      "README.en.md"
    ];
    for (const file of files) {
      const text = await readFile(join(root, file), "utf8");
      expect(text).toMatch(/design-first/i);
    }
    const workflow = await readFile(join(root, "references/design-first-workflow.md"), "utf8");
    expect(workflow).toMatch(/deck\.storyboard\.json/);
    expect(workflow).toMatch(/deck\.design-direction\.json/);
    expect(workflow).toMatch(/slide-design-specs\.json/);
    expect(workflow).toMatch(/Replica mode/i);
    expect(workflow).toMatch(/Creative mode/i);
  });

  it("documents design-first agent roles and future visual roadmap", async () => {
    const promptLibrary = await readFile(join(root, "references/prompt-library.md"), "utf8");
    expect(promptLibrary).toMatch(/Planner/i);
    expect(promptLibrary).toMatch(/Art Director/i);
    expect(promptLibrary).toMatch(/Slide Designer/i);
    expect(promptLibrary).toMatch(/Critic/i);
    expect(promptLibrary).toMatch(/Repair/i);

    const readme = await readFile(join(root, "README.md"), "utf8");
    const englishReadme = await readFile(join(root, "README.en.md"), "utf8");
    for (const content of [readme, englishReadme]) {
      expect(content).toMatch(/Visual Workbench/i);
      expect(content).toMatch(/Screenshot-Level Vision Model Review/i);
    }
  });

  it("documents the design artifact pipeline and review deliverables in both READMEs", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const englishReadme = await readFile(join(root, "README.en.md"), "utf8");
    for (const content of [readme, englishReadme]) {
      expect(content).toMatch(/design artifacts?/i);
      expect(content).toMatch(/preview artifacts?/i);
      expect(content).toMatch(/screenshot-level review/i);
      expect(content).toMatch(/editable PPTX/i);
    }
  });
});
