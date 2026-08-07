import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("doctor imports and reports the versioned visual measurement stack", async () => {
  let stdout = "";
  let executionError = null;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ["scripts/image-to-pptx.mjs", "doctor"], {
      cwd: new URL("..", import.meta.url).pathname,
      maxBuffer: 2 * 1024 * 1024
    }));
  } catch (error) {
    executionError = error;
    stdout = error.stdout || "";
  }
  assert.ok(stdout, executionError ? `doctor failed without JSON stdout: ${executionError.message}` : "doctor returned no JSON stdout");
  const result = JSON.parse(String(stdout));
  assert.ok(["passed", "failed"].includes(result.status));
  assert.equal(result.skill, "image-to-pptx");
  assert.equal(result.version, "2.0.0");
  assert.ok(Array.isArray(result.checks));
  assert.deepEqual(
    result.checks.map((item) => item.name).sort(),
    ["fontTools", "libreoffice", "pdftoppm", "python", "tesseract"]
  );
  for (const check of result.checks) {
    assert.ok(["available", "missing"].includes(check.status));
    if (check.status === "available") assert.equal(typeof check.version, "string");
    if (check.status === "missing") assert.equal(typeof check.detail, "string");
  }
  if (executionError) assert.equal(result.status, "failed");
  const python = result.checks.find((item) => item.name === "python");
  assert.ok(python);
  if (process.env.IMAGE_TO_PPTX_PYTHON) {
    assert.equal(python.status, "available");
    assert.match(python.version, /numpy/);
    assert.match(python.version, /scikit-image/);
  } else if (python.status === "available") {
    assert.match(python.version, /numpy/);
    assert.match(python.version, /scikit-image/);
  }
});
