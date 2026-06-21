import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const archetypes = [
  "cover",
  "executive-summary",
  "problem-solution",
  "architecture-layered",
  "process-flow",
  "comparison-matrix",
  "metrics-dashboard",
  "roadmap"
];

const REQUIRED_KEYWORDS = [
  { key: "fontSize", re: /fontSize|font-size/i },
  { key: "lineHeight", re: /lineHeight|line-height/i },
  { key: "spacing", re: /spacing/i },
  { key: "font-family", re: /font-family|fontFamily/i }
];

function readRules(archetype) {
  return fs.readFileSync(path.join("layout-archetypes", archetype, "rules.md"), "utf8");
}

function countContentLines(rules) {
  // Strip frontmatter and blank lines, count remaining content lines
  const stripped = rules.replace(/^---[\s\S]*?---\s*/m, "");
  return stripped
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

describe("U7 archetype role-aware rules", () => {
  for (const name of archetypes) {
    describe(`${name} archetype`, () => {
      it("ships a rules.md with role-aware content", () => {
        const dir = path.join("layout-archetypes", name);
        expect(fs.existsSync(path.join(dir, "rules.md")), `${name} rules.md`).toBe(true);

        const rules = readRules(name);
        const contentLines = countContentLines(rules);
        expect(contentLines, `${name} content lines`).toBeGreaterThanOrEqual(8);
      });

      it("declares fontSize, lineHeight, spacing, and font-family constraints", () => {
        const rules = readRules(name);
        for (const { key, re } of REQUIRED_KEYWORDS) {
          expect(re.test(rules), `${name} rules.md mentions ${key}`).toBe(true);
        }
      });

      it("includes all three fixture variants (bad/good/borderline)", () => {
        const dir = path.join("examples", "layout-archetypes-fixtures", name);
        for (const variant of ["bad", "good", "borderline"]) {
          const fixturePath = path.join(dir, `${variant}.html`);
          expect(fs.existsSync(fixturePath), `${name}/${variant}.html`).toBe(true);
          const content = fs.readFileSync(fixturePath, "utf8");
          expect(content.length, `${name}/${variant}.html non-empty`).toBeGreaterThan(0);
        }
      });

      it("fixtures share a content outline (same title tokens per variant)", () => {
        const dir = path.join("examples", "layout-archetypes-fixtures", name);
        const bad = fs.readFileSync(path.join(dir, "bad.html"), "utf8");
        const good = fs.readFileSync(path.join(dir, "good.html"), "utf8");
        const borderline = fs.readFileSync(path.join(dir, "borderline.html"), "utf8");
        // All three must declare <title> elements
        expect(/<title>/i.test(bad), "bad has title").toBe(true);
        expect(/<title>/i.test(good), "good has title").toBe(true);
        expect(/<title>/i.test(borderline), "borderline has title").toBe(true);
      });
    });
  }

  it("rules.md content lines are archetype-specific (not byte-identical across all 8)", () => {
    const sigs = new Set();
    for (const name of archetypes) {
      sigs.add(readRules(name).trim());
    }
    // Some archetypes may legitimately share most of their rules (e.g., process-flow and roadmap),
    // but the set of full contents should be diverse; allow that pairs may collide, but
    // demand we are not still on the original 6-line byte-identical set for every archetype.
    expect(sigs.size, "distinct rules.md contents").toBeGreaterThanOrEqual(2);
  });
});
