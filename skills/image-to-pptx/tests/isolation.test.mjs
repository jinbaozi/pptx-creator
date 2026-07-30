import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const enabled = process.env.IMAGE_TO_PPTX_ISOLATION === "1";
const root = resolve(new URL("..", import.meta.url).pathname);

test("a copied Skill installs and runs without sibling Skills", { skip: !enabled, timeout: 240_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "image-to-pptx-isolation-"));
  const isolated = join(parent, "image-to-pptx");
  await cp(root, isolated, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules"
  });
  await execFileAsync("npm", ["ci", "--offline", "--ignore-scripts"], {
    cwd: isolated,
    timeout: 120_000,
    env: process.env
  });
  const output = join(parent, "output");
  await execFileAsync(process.execPath, [
    "scripts/image-to-pptx.mjs",
    "build",
    "--output", output,
    "examples/minimal/input.png"
  ], {
    cwd: isolated,
    timeout: 180_000,
    env: process.env
  });
  const validated = JSON.parse((await execFileAsync(process.execPath, [
    "scripts/validate_output.mjs", output
  ], { cwd: isolated, env: process.env })).stdout);
  assert.equal(validated.deliveryStatus, "passed");
  assert.equal(validated.slideCount, 1);
});
