import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONTENT_HEAVY_RUBRIC_PATH = resolve(
  "examples/showcase/content-heavy-warm-editorial/qa-rubric.md"
);

describe("content-heavy-warm-editorial showcase qa-rubric", () => {
  const rubric = readFileSync(CONTENT_HEAVY_RUBRIC_PATH, "utf8");

  it("exists and is a markdown file", () => {
    expect(rubric.length).toBeGreaterThan(0);
    expect(rubric).toMatch(/^# /m);
  });

  it("contains the qualitative Design rationale section", () => {
    expect(rubric).toMatch(/##\s+Design rationale/);
  });

  it("contains the qualitative Tradeoffs section", () => {
    expect(rubric).toMatch(/##\s+Tradeoffs/);
  });

  it("contains the qualitative Known limitations section", () => {
    expect(rubric).toMatch(/##\s+Known limitations/);
  });

  it("does not include a numeric score section (per R17 update in U9)", () => {
    // Heuristic: ensure no `## Score` or `## Numeric` headings, and that
    // the rubric does not claim a "score" followed by a number.
    expect(rubric).not.toMatch(/^##\s+Score\b/m);
    expect(rubric).not.toMatch(/^##\s+Numeric\b/m);
    // No "out of 10" / "out of 100" patterns.
    expect(rubric).not.toMatch(/\d+\s*\/\s*\d+/);
  });
});
