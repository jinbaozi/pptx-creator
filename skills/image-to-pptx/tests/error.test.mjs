import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderPptx } from "../scripts/render_pptx.mjs";

const execFileAsync = promisify(execFile);

test("CLI rejects a build without any source image", async () => {
  const output = await mkdtemp(join(tmpdir(), "image-to-pptx-empty-"));
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/image-to-pptx.mjs", "build", "--output", join(output, "out")], {
      cwd: new URL("..", import.meta.url).pathname
    }),
    (error) => /E_INPUT_REQUIRED/.test(error.stderr)
  );
});

test("renderer rejects a whole-slide raster fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-raster-"));
  const analysis = {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: { id: "deck", title: "Bad", size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 } },
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Bad",
      sourceRef: "source-001",
      background: "#FFFFFF",
      objects: [{
        id: "cheat",
        type: "image",
        asset: "cheat.png",
        pixelBox: { x: 0, y: 0, w: 1280, h: 720 },
        z: 0
      }]
    }]
  };
  const source = join(directory, "analysis.json");
  await writeFile(source, JSON.stringify(analysis));
  await assert.rejects(
    renderPptx(source, join(directory, "bad.pptx"), null, directory),
    (error) => error.code === "E_WHOLE_SLIDE_FALLBACK"
  );
});

test("renderer rejects a near-whole-slide raster disguised by a small inset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-to-pptx-near-raster-"));
  const analysis = {
    version: "1.0.0",
    kind: "image-reconstruction-analysis",
    generator: "image-to-pptx",
    deck: { id: "deck", title: "Bad", size: { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 } },
    slides: [{
      id: "slide-001",
      order: 1,
      title: "Bad",
      sourceRef: "source-001",
      background: "#FFFFFF",
      objects: [{
        id: "inset-cheat",
        type: "image",
        asset: "cheat.png",
        pixelBox: { x: 16, y: 12, w: 1248, h: 696 },
        z: 0
      }]
    }]
  };
  const source = join(directory, "analysis.json");
  await writeFile(source, JSON.stringify(analysis));
  await assert.rejects(
    renderPptx(source, join(directory, "bad.pptx"), null, directory),
    (error) => error.code === "E_WHOLE_SLIDE_FALLBACK"
  );
});
