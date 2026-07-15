#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillPackage } from "./lib/skill-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await buildSkillPackage(root);
  console.log(JSON.stringify({
    skillName: result.skillName,
    packageVersion: result.packageVersion,
    sourceBranch: result.sourceBranch,
    sourceCommit: result.sourceCommit,
    archiveSha256: result.archiveSha256,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
    packageRoot: result.packageRoot,
    archivePath: result.archivePath
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
