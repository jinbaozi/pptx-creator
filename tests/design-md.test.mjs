import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));
const design = join(root, "design-systems/business-neutral/DESIGN.md");
const builtIns = [
  "business-neutral",
  "warm-editorial",
  "paper-minimal",
  "dark-tech",
  "ai-infra",
  "product-roadshow",
  "developer-docs",
  "dashboard-data",
  "premium-black",
  "chinese-government"
];

describe("DESIGN.md tooling", () => {
  it("parses frontmatter tokens and markdown sections", async () => {
    const { stdout } = await execFileAsync(node, [join(root, "scripts/parse-design-md.mjs"), design], { cwd: root });
    const profile = JSON.parse(stdout);
    expect(profile.name).toBe("Business Neutral");
    expect(profile.tokens.colors.primary).toBe("#2563EB");
    expect(profile.sections["PPTX Export Rules"]).toContain("native PowerPoint text boxes");
  });

  it("validates required tokens and sections", async () => {
    const { stdout } = await execFileAsync(node, [join(root, "scripts/validate-design-md.mjs"), design], { cwd: root });
    expect(stdout).toContain("design valid");
  });

  it("validates all built-in DESIGN.md profiles", async () => {
    for (const id of builtIns) {
      const candidate = join(root, `design-systems/${id}/DESIGN.md`);
      const { stdout } = await execFileAsync(node, [join(root, "scripts/validate-design-md.mjs"), candidate], { cwd: root });
      expect(stdout).toContain("design valid");
    }
  });

  it("rejects DESIGN.md without export rules", async () => {
    const bad = join(tmpdir(), `bad-design-${Date.now()}.md`);
    await writeFile(
      bad,
      "---\nname: Bad\ncolors:\n  primary: \"#000000\"\ntypography:\n  title:\n    fontFamily: Arial\n    fontSize: 30\n  body:\n    fontFamily: Arial\n    fontSize: 14\n---\n# Bad\n",
      "utf8"
    );
    await expect(execFileAsync(node, [join(root, "scripts/validate-design-md.mjs"), bad], { cwd: root })).rejects.toThrow();
    expect(await readFile(bad, "utf8")).toContain("# Bad");
  });
});
