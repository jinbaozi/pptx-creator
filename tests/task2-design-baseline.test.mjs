import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("Task 2 shared design export baseline", () => {
  it("keeps exact common export/editability language in one shared baseline", async () => {
    const baseline = await readFile(join(root, "design-systems/_shared/editability-baseline.md"), "utf8");
    expect(baseline).toContain("All visible titles must be exported as native PowerPoint text boxes");
    expect(baseline).toContain("Level 5 means all major objects are native PowerPoint objects");
    const dirs = (await readdir(join(root, "design-systems"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "_shared");
    const themed = [];
    for (const dir of dirs) {
      const text = await readFile(join(root, "design-systems", dir.name, "DESIGN.md"), "utf8");
      if (text.includes("Default target: Level 4.")) {
        themed.push(text);
        expect(text).toContain("../_shared/editability-baseline.md");
        expect(text).not.toContain("All visible titles must be exported as native PowerPoint text boxes");
        expect(text).not.toContain("Level 5 means all major objects are native PowerPoint objects");
      }
    }
    expect(themed.length).toBeGreaterThanOrEqual(9);
  });
});
