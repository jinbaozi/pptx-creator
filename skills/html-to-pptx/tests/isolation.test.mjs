import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const isolationIt = process.env.ISOLATION_RUN === "1" ? it : it.skip;

async function sourceFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "output") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:mjs|js|py)$/.test(entry.name)) files.push(path);
    }
  }
  await visit(root);
  return files;
}

describe("clean-directory independent installation", () => {
  isolationIt("installs and converts with no sibling Skill or repository runtime", async () => {
    const staging = await mkdtemp(join(tmpdir(), "html-to-pptx-isolation-"));
    const isolatedSkill = join(staging, "html-to-pptx");
    await cp(resolve("."), isolatedSkill, {
      recursive: true,
      filter: (source) => !source.includes(`${resolve(".")}/node_modules`)
        && !/\/examples\/(?:minimal|complex)\/output(?:\/|$)/.test(source)
    });
    const files = await sourceFiles(isolatedSkill);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/skills\/(?:text-to-html|image-to-pptx)/);
    }
    await execFileAsync("npm", ["ci", "--ignore-scripts"], {
      cwd: isolatedSkill,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024
    });
    const output = join(staging, "result");
    await execFileAsync(process.execPath, [
      join(isolatedSkill, "scripts", "convert.mjs"),
      join(isolatedSkill, "examples", "minimal", "index.html"),
      output
    ], {
      cwd: isolatedSkill,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024
    });
    const qa = JSON.parse(await readFile(join(output, "qa-report.json"), "utf8"));
    expect(qa.status).toBe("passed");
    expect(qa.gates.editability.level).toBeGreaterThanOrEqual(3);
    expect(qa.gates.visual.passed).toBe(true);
  });
});
