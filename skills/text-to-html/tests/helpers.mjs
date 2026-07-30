import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function examplePlan(name = "minimal") {
  const path = join(skillRoot, "examples", name, "presentation-plan.json");
  return { path, plan: JSON.parse(await readFile(path, "utf8")) };
}
