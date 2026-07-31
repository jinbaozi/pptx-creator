#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { createSecureAssetFetcher } from "./lib/asset-fetcher.mjs";
import { localizeAssets } from "./lib/assets.mjs";
import { runCli } from "./lib/errors.mjs";
import { validatePlanFile } from "./lib/plan.mjs";
import { parseOptions, writeJson } from "./lib/utils.mjs";

export async function localizePlanAssets(planPath, outputDir, options = {}) {
  const validated = await validatePlanFile(planPath);
  const allowHosts = options.allowHosts ?? [];
  const fetchAsset = allowHosts.length > 0
    ? createSecureAssetFetcher({ allowHosts, timeoutMs: options.timeoutMs })
    : undefined;
  const result = await localizeAssets({
    assets: validated.plan.assets,
    sourceRoot: validated.planDirectory,
    outputDir,
    networkPolicy: validated.plan.brief.networkPolicy,
    fetchAsset
  });
  await writeJson(join(resolve(outputDir), "asset-ledger.json"), { version: "2.0.0", assets: result.provenanceLedger });
  await writeJson(join(resolve(outputDir), "license-report.json"), {
    version: "2.0.0",
    status: "reported",
    notice: "NOTICE",
    assets: result.assetRecords.map((asset) => ({
      id: asset.id,
      path: asset.outputPath,
      sha256: asset.sha256,
      rights: asset.rights
    }))
  });
  await writeJson(join(resolve(outputDir), "asset-localization.json"), {
    schemaVersion: "1.0.0",
    command: "assets-localize",
    status: "passed",
    stage: "assets",
    errors: [],
    warnings: result.assetRecords.filter((asset) => asset.fallbackUsed).map((asset) => ({
      code: "W_ASSET_FALLBACK",
      assetId: asset.id,
      fallback: asset.fallbackUsed
    })),
    artifacts: { ledger: "asset-ledger.json", license: "license-report.json", notice: "NOTICE" },
    nextActions: []
  });
  await writeFile(join(resolve(outputDir), "NOTICE"), result.notice, "utf8");
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseOptions(argv);
  if (positional.length !== 2) {
    const error = new Error("usage: localize-assets.mjs <presentation-plan.json> <output-dir> [--allow-host host[,host]] [--timeout-ms 15000]");
    error.code = "E_USAGE";
    throw error;
  }
  const allowHosts = typeof options["allow-host"] === "string" ? options["allow-host"].split(",") : [];
  const result = await localizePlanAssets(positional[0], positional[1], {
    allowHosts,
    timeoutMs: options["timeout-ms"]
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "1.0.0",
    command: "assets-localize",
    status: "passed",
    stage: "assets",
    errors: [],
    warnings: result.assetRecords.filter((asset) => asset.fallbackUsed).map((asset) => ({ code: "W_ASSET_FALLBACK", assetId: asset.id })),
    artifacts: { assetCount: result.assetRecords.length, ledger: "asset-ledger.json", notice: "NOTICE" },
    nextActions: []
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(() => main());
}
