#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySkillPackage } from "./lib/skill-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;

try {
  const result = await verifySkillPackage(root, archivePath);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
