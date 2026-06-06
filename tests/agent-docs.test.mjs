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

  it("ships a bilingual README with core project documentation", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");

    expect(readme).toContain("## 中文版");
    expect(readme).toContain("## English");
    expect(readme).toContain("功能介绍");
    expect(readme).toContain("安装部署");
    expect(readme).toContain("整体架构");
    expect(readme).toContain("Features");
    expect(readme).toContain("Installation");
    expect(readme).toContain("Architecture");
    expect(readme).toContain("node scripts/run-deck-pipeline.mjs");
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
    expect(prompts).toContain("联网搜索");
    expect(prompts).toContain("不要编造事实");
    expect(prompts).not.toContain("浣犳");
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
});
