import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { skillRoot } from "../helpers.mjs";

const execFileAsync = promisify(execFile);

test("a copy containing no parent or sibling Skill installs and completes its core task", { timeout: 360_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "text-to-html-isolated-"));
  const isolated = join(temp, "text-to-html");
  await cp(skillRoot, isolated, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      if (name === "node_modules") return false;
      if (name === "output" && source.includes(`${join("examples", "")}`)) return false;
      return true;
    }
  });
  try {
    await execFileAsync("npm", ["ci", "--ignore-scripts"], { cwd: isolated, timeout: 180_000 });
    await execFileAsync(
      process.execPath,
      ["scripts/run-pipeline.mjs", "examples/minimal/presentation-plan.json", join(temp, "delivery"), "--timeout-ms", "90000"],
      { cwd: isolated, timeout: 180_000 }
    );
    const packageRecord = JSON.parse(await readFile(join(temp, "delivery", "presentation-package.json"), "utf8"));
    assert.equal(packageRecord.producer.skill, "text-to-html");
    assert.equal(packageRecord.validation.status, "passed");
    assert.equal(packageRecord.deck.slides.length, 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
