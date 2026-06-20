import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// We invoke the wrapper as a child process so vi.mock() in this file cannot
// intercept its imports. Instead we point PPTX_CREATOR_PYTHON at a fake
// "python" interpreter (tests/fixtures/fake-python.mjs) that simulates the
// real Python scripts by writing JSON stubs. This keeps tests fast,
// hermetic, and independent of a working Python install in CI.

const execFileAsync = promisify(execFile);
const node = process.execPath;
const root = process.cwd();
const wrapperScript = join(root, "scripts/image-to-manifest.mjs");
const fakePython = join(root, "tests/fixtures/fake-python.mjs");

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function writeFixturePng(path) {
  await writeFile(path, Buffer.from(PNG_1X1_BASE64, "base64"));
}

function env() {
  return { ...process.env, PPTX_CREATOR_PYTHON: fakePython };
}

function scriptArgs(args) {
  return [wrapperScript, ...args];
}

describe("image-to-manifest wrapper", () => {
  it("prints help with both creative and replica paths listed", async () => {
    const { stdout } = await execFileAsync(node, scriptArgs(["--help"]), { env: env() });
    expect(stdout).toMatch(/creative/);
    expect(stdout).toMatch(/replica/);
    expect(stdout).not.toMatch(/quick-preview fallback/i);
    expect(stdout).toMatch(/--ocr-confidence/);
    expect(stdout).toMatch(/--mode/);
  });

  it("rejects unknown flags with a clear error", async () => {
    let stderr = "";
    let code = 0;
    try {
      await execFileAsync(node, scriptArgs(["--definitely-not-a-flag"]), { env: env() });
    } catch (error) {
      stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString() : String(error.stderr ?? "");
      code = error.code ?? 1;
    }
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown flag/i);
  });

  it("runs creative hints flow by default for a single image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-img-creative-"));
    const imgPath = join(dir, "fixture.png");
    await writeFixturePng(imgPath);
    const outDir = join(dir, "out");
    const { stdout } = await execFileAsync(node, scriptArgs(["--input", imgPath, "--output", outDir]), {
      env: env(),
      cwd: root
    });
    const summary = JSON.parse(stdout);
    expect(summary.mode).toBe("creative");
    expect(summary.multiImage).toBe(false);
    expect(summary.designSystem).toBe("business-neutral");
    const manifest = JSON.parse(await readFile(join(outDir, "deck.manifest.skeleton.json"), "utf8"));
    expect(manifest.slides).toHaveLength(1);
    expect(manifest._generator.wrapper).toBe("image-to-manifest.mjs");
    expect(manifest._generator.mode).toBe("creative");
    // image-hints.json should exist as the canonical creative artifact.
    await readFile(join(outDir, "image-hints.json"), "utf8");
  });

  it("runs replica flow when --mode replica is set, producing all three artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-img-replica-"));
    const imgPath = join(dir, "fixture.png");
    await writeFixturePng(imgPath);
    const outDir = join(dir, "out");
    const { stdout } = await execFileAsync(
      node,
      scriptArgs(["--mode", "replica", "--input", imgPath, "--output", outDir]),
      { env: env(), cwd: root }
    );
    const summary = JSON.parse(stdout);
    expect(summary.mode).toBe("replica");
    expect(summary.multiImage).toBe(false);
    expect(summary.artifacts.analysis).toContain("image-replica-analysis.json");
    expect(summary.artifacts.plan).toContain("replica-layer-plan.json");
    // All three replica artifacts should exist.
    await readFile(join(outDir, "image-replica-analysis.json"), "utf8");
    await readFile(join(outDir, "replica-layer-plan.json"), "utf8");
    await readFile(join(outDir, "image-hints.json"), "utf8");
    const manifest = JSON.parse(await readFile(join(outDir, "deck.manifest.skeleton.json"), "utf8"));
    expect(manifest._generator.mode).toBe("replica");
  });

  it("concatenates directory of PNGs into a multi-slide manifest with consistent designSystem and deck.size", async () => {
    const inputDir = await mkdtemp(join(tmpdir(), "pptx-img-batch-input-"));
    const outDir = await mkdtemp(join(tmpdir(), "pptx-img-batch-out-"));
    await writeFixturePng(join(inputDir, "slide-a.png"));
    await writeFixturePng(join(inputDir, "slide-b.png"));
    await writeFixturePng(join(inputDir, "slide-c.png"));
    const { stdout } = await execFileAsync(
      node,
      scriptArgs(["--mode", "creative", "--input", inputDir, "--output", outDir]),
      { env: env(), cwd: root }
    );
    const summary = JSON.parse(stdout);
    expect(summary.multiImage).toBe(true);
    expect(summary.slideCount).toBe(3);
    const manifest = JSON.parse(await readFile(join(outDir, "deck.manifest.skeleton.json"), "utf8"));
    expect(manifest.slides).toHaveLength(3);
    // designSystem and deck.size must be consistent across slides.
    expect(manifest.designSystem.name).toBe("business-neutral");
    expect(manifest.deck.size.width).toBe(13.333);
    expect(manifest.deck.size.height).toBe(7.5);
    // Each slide id derived from filename.
    const ids = manifest.slides.map((s) => s.id);
    expect(ids.some((id) => id.includes("slide-a"))).toBe(true);
    expect(ids.some((id) => id.includes("slide-b"))).toBe(true);
    expect(ids.some((id) => id.includes("slide-c"))).toBe(true);
    // assets array has one entry per image.
    expect(manifest.assets).toHaveLength(3);
  });

  it("records --ocr-confidence in manifest metadata when --mode replica is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-img-ocr-"));
    const imgPath = join(dir, "fixture.png");
    await writeFixturePng(imgPath);
    const outDir = join(dir, "out");
    const { stdout } = await execFileAsync(
      node,
      scriptArgs(["--mode", "replica", "--ocr-confidence", "0.5", "--input", imgPath, "--output", outDir]),
      { env: env(), cwd: root }
    );
    const summary = JSON.parse(stdout);
    expect(summary.mode).toBe("replica");
    expect(summary.ocrConfidence).toBeCloseTo(0.5);
    // The wrapper records the configured value in the manifest metadata so U10
    // calibration can read it. The fake-python intentionally does not advertise
    // --ocr-confidence in image-replica-plan.py --help, so the wrapper does NOT
    // forward the flag (avoids argparse error). When U5 adds the flag to the
    // real script, the wrapper will start forwarding it automatically.
    const manifest = JSON.parse(await readFile(join(outDir, "deck.manifest.skeleton.json"), "utf8"));
    expect(manifest._generator.ocrConfidence).toBeCloseTo(0.5);
  });

  it("propagates Python exit code as a non-zero wrapper exit", async () => {
    // Use a fake python that always exits 7 to simulate a Python failure.
    const failingPython = join(root, "tests/fixtures/fake-python-fail.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pptx-img-fail-"));
    const imgPath = join(dir, "fixture.png");
    await writeFixturePng(imgPath);
    const outDir = join(dir, "out");
    let code = 0;
    let stderr = "";
    try {
      await execFileAsync(node, scriptArgs(["--input", imgPath, "--output", outDir]), {
        env: { ...env(), PPTX_CREATOR_PYTHON: failingPython },
        cwd: root
      });
    } catch (error) {
      code = error.code ?? 1;
      stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString() : String(error.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/simulated python failure/i);
  });

  it("rejects --ocr-confidence outside 0..1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-img-bad-ocr-"));
    const imgPath = join(dir, "fixture.png");
    await writeFixturePng(imgPath);
    const outDir = join(dir, "out");
    let code = 0;
    let stderr = "";
    try {
      await execFileAsync(
        node,
        scriptArgs(["--mode", "replica", "--ocr-confidence", "1.5", "--input", imgPath, "--output", outDir]),
        { env: env(), cwd: root }
      );
    } catch (error) {
      code = error.code ?? 1;
      stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString() : String(error.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/ocr-confidence/i);
  });

  it("ignores non-image files in multi-image directory input", async () => {
    const inputDir = await mkdtemp(join(tmpdir(), "pptx-img-batch-mixed-"));
    const outDir = await mkdtemp(join(tmpdir(), "pptx-img-batch-mixed-out-"));
    await writeFixturePng(join(inputDir, "real-slide.png"));
    await writeFile(join(inputDir, "notes.txt"), "should be ignored");
    await mkdir(join(inputDir, "subdir"), { recursive: true });
    await writeFixturePng(join(inputDir, "subdir", "nested.png"));
    const { stdout } = await execFileAsync(
      node,
      scriptArgs(["--mode", "creative", "--input", inputDir, "--output", outDir]),
      { env: env(), cwd: root }
    );
    const summary = JSON.parse(stdout);
    // Only top-level PNGs count; subdirectories are not recursed (v1).
    expect(summary.slideCount).toBe(1);
  });
});