#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifySkillPackage } from "./lib/skill-package.mjs";
import { checkV2SkillIndependence, SKILL_NAMES } from "./check-v2-skill-independence.mjs";

export async function verifyV2Skills(
  repositoryRoot,
  outputRoot = join(repositoryRoot, "dist", "v2")
) {
  const results = [];
  const independence = await checkV2SkillIndependence(repositoryRoot);
  if (independence.status !== "passed") {
    throw new Error(`V2 Skill independence gate failed: ${JSON.stringify(independence.findings)}`);
  }

  for (const skillName of SKILL_NAMES) {
    results.push(await verifySkillPackage(
      join(repositoryRoot, "skills", skillName),
      join(outputRoot, `${skillName}.skill`)
    ));
  }

  return { status: "passed", skills: results };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  process.stdout.write(`${JSON.stringify(await verifyV2Skills(repositoryRoot), null, 2)}\n`);
}
