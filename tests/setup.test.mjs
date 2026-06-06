import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));

describe("setup", () => {
  it("validates DESIGN.md, validates manifest, renders smoke deck, and writes env report", async () => {
    await execFileAsync(node, [join(root, "scripts/setup.mjs")], { cwd: root });
    await access(join(root, ".pptx-creator/env-report.json"));
    const report = JSON.parse(await readFile(join(root, ".pptx-creator/env-report.json"), "utf8"));
    expect(report.designValidation).toBe("passed");
    expect(report.manifestValidation).toBe("passed");
    expect(report.smokeTest).toBe("passed");
  });
});
