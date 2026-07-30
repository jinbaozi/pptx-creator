#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "./image-to-pptx.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const output = await mkdtemp(join(tmpdir(), "image-to-pptx-example-"));
const result = await build({
  output,
  title: "Minimal editable reconstruction",
  langs: "eng",
  ocrThreshold: 0.70,
  maxRepairs: 3,
  htmlPackage: true,
  inputs: [join(root, "examples", "minimal", "input.png")]
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
