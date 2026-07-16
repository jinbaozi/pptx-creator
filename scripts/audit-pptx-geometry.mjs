#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditPptxGeometry } from "./lib/pptx-geometry-audit.mjs";

async function main(argv) {
  const [pptxArg, ...flags] = argv;
  if (!pptxArg) throw new Error("usage: audit-pptx-geometry.mjs <deck.pptx> [--manifest deck.manifest.json] [--output report.json]");
  let manifest = null;
  let output = null;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--manifest") manifest = JSON.parse(await readFile(resolve(flags[++index]), "utf8"));
    else if (flag === "--output") output = resolve(flags[++index]);
    else throw new Error(`unknown option: ${flag}`);
  }
  const report = await auditPptxGeometry(resolve(pptxArg), manifest, { requireOrder: true });
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.blocked) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
