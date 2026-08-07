import { join, resolve } from "node:path";
import { SkillError } from "./errors.mjs";
import { readJson, sha256File, sha256Text, skillRoot } from "./utils.mjs";

export const RUNTIME_COMPONENT_PATHS = Object.freeze({
  packageJson: "package.json",
  renderer: "scripts/lib/render.mjs",
  browserQa: "scripts/lib/qa.mjs",
  deckCss: "assets/deck.css",
  deckJs: "assets/deck.js"
});

function rootDigest(components) {
  const entries = Object.entries(components).map(([name, component]) => ({ name, ...component }));
  return sha256Text(JSON.stringify(entries));
}

export function assertTestRuntimeOverrides(runtime, caller) {
  const overrides = Object.keys(runtime ?? {});
  if (overrides.length === 0) return;
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new SkillError("E_RUNTIME_OVERRIDE", `${caller} runtime overrides are restricted to Node test workers`, {
      details: { overrides }
    });
  }
}

export async function buildRuntimeProvenance(options = {}) {
  const root = resolve(options.root ?? skillRoot);
  const hashFile = options.sha256File ?? sha256File;
  const components = {};
  for (const [name, path] of Object.entries(RUNTIME_COMPONENT_PATHS)) {
    components[name] = { path, sha256: await hashFile(join(root, path)) };
  }
  return {
    version: "1.0.0",
    kind: "text-to-html.runtime-provenance",
    components,
    rootDigest: rootDigest(components)
  };
}

function mismatchDetails(actual, expected) {
  const mismatches = [];
  for (const [name, component] of Object.entries(expected.components)) {
    const candidate = actual?.components?.[name];
    if (candidate?.path !== component.path || candidate?.sha256 !== component.sha256) {
      mismatches.push({ name, expected: component, actual: candidate ?? null });
    }
  }
  if (actual?.version !== expected.version) mismatches.push({ name: "version", expected: expected.version, actual: actual?.version ?? null });
  if (actual?.kind !== expected.kind) mismatches.push({ name: "kind", expected: expected.kind, actual: actual?.kind ?? null });
  if (actual?.rootDigest !== expected.rootDigest) mismatches.push({ name: "rootDigest", expected: expected.rootDigest, actual: actual?.rootDigest ?? null });
  const actualNames = Object.keys(actual?.components ?? {});
  const unexpected = actualNames.filter((name) => !(name in expected.components));
  if (unexpected.length > 0) mismatches.push({ name: "components", unexpected });
  return mismatches;
}

export function assertRuntimeProvenance(actual, expected, source) {
  const mismatches = mismatchDetails(actual, expected);
  if (mismatches.length > 0) {
    throw new SkillError("E_RUNTIME_PROVENANCE", `${source} does not match the installed text-to-html runtime`, {
      details: { source, mismatches }
    });
  }
  return actual;
}

export async function verifyOutputRuntimeProvenance(outputDir, options = {}) {
  const root = resolve(outputDir);
  const expected = await buildRuntimeProvenance(options.runtime ?? {});
  const packageRecord = options.packageRecord ?? await readJson(join(root, "presentation-package.json"));
  const extension = packageRecord?.extensions?.["pptx-creator.text-to-html/v2"];
  assertRuntimeProvenance(extension?.runtime, expected, "presentation-package extension runtime");
  if (options.generationReport) {
    assertRuntimeProvenance(options.generationReport.runtime, expected, "generation-report runtime");
  }
  for (const [name, outputPath] of [["deckCss", "assets/deck.css"], ["deckJs", "assets/deck.js"]]) {
    let outputDigest;
    try {
      outputDigest = await sha256File(join(root, outputPath));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SkillError("E_RUNTIME_PROVENANCE", `Cannot verify emitted runtime asset ${outputPath}: ${message}`, { cause });
    }
    if (outputDigest !== expected.components[name].sha256) {
      throw new SkillError("E_RUNTIME_PROVENANCE", `Emitted runtime asset ${outputPath} differs from the installed Skill`, {
        details: { path: outputPath, expected: expected.components[name].sha256, actual: outputDigest }
      });
    }
  }
  return expected;
}
