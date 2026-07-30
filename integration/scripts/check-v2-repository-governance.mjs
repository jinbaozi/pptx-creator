#!/usr/bin/env node
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKILL_NAMES = new Set(["text-to-html", "html-to-pptx", "image-to-pptx"]);
const ROOT_FILES = new Set([
  ".gitignore",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "package.json",
  "package-lock.json"
]);
const ROOT_WORKFLOW = ".github/workflows/ci.yml";
const IGNORED_PATH_SEGMENTS = new Set([".git", "node_modules", "dist", "output"]);
const REQUIRED_FILES = [
  "integration/protocol/presentation-package.schema.json",
  "integration/scripts/check-v2-repository-governance.mjs",
  "integration/scripts/check-v2-skill-independence.mjs",
  "integration/scripts/package-v2-skills.mjs",
  "integration/scripts/run-v2-composition-tests.mjs",
  "integration/scripts/validate-presentation-package.mjs",
  "integration/scripts/verify-v2-skills.mjs",
  "integration/scripts/lib/skill-package.mjs",
  "integration/tests/presentation-package-protocol.test.mjs",
  "integration/tests/v2-skill-independence.test.mjs",
  "integration/tests/v2-package-cli.test.mjs",
  "integration/tests/v2-skill-package.test.mjs",
  "integration/tests/v2-composition.test.mjs",
  "integration/tests/v2-repository-governance.test.mjs",
  "integration/vitest.config.mjs"
];

function normalizeTrackedPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isAllowedV2TrackedPath(value) {
  const path = normalizeTrackedPath(value);
  if (ROOT_FILES.has(path) || path === ROOT_WORKFLOW || path.startsWith("integration/")) {
    return true;
  }
  const [root, skill, ...rest] = path.split("/");
  return root === "skills" && SKILL_NAMES.has(skill) && rest.length > 0;
}

export function isIgnoredWorkspacePath(value) {
  return normalizeTrackedPath(value).split("/").some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

export async function listTrackedFiles(repositoryRoot) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  return String(stdout).split("\0").filter(Boolean).map(normalizeTrackedPath);
}

export async function checkV2RepositoryGovernance(repositoryRoot, options = {}) {
  const trackedFiles = options.trackedFiles ?? await listTrackedFiles(repositoryRoot);
  const normalizedFiles = [...new Set(trackedFiles.map(normalizeTrackedPath))]
    .filter((path) => !isIgnoredWorkspacePath(path))
    .sort();
  const findings = normalizedFiles
    .filter((path) => !isAllowedV2TrackedPath(path))
    .map((path) => ({
      code: "E_V2_ROOT_SURFACE",
      path,
      message: "tracked path is outside the V2 governance allowlist"
    }));
  for (const path of REQUIRED_FILES) {
    if (!normalizedFiles.includes(path)) {
      findings.push({
        code: "E_V2_REQUIRED_PATH",
        path,
        message: "required V2 governance path is missing from git"
      });
    }
  }
  for (const skill of SKILL_NAMES) {
    const path = `skills/${skill}/SKILL.md`;
    if (!normalizedFiles.includes(path)) {
      findings.push({
        code: "E_V2_REQUIRED_SKILL",
        path,
        message: "required independent V2 Skill contract is missing from git"
      });
    }
  }
  return {
    status: findings.length === 0 ? "passed" : "failed",
    trackedFileCount: normalizedFiles.length,
    findings
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const report = await checkV2RepositoryGovernance(repositoryRoot);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: "E_V2_GOVERNANCE_RUNTIME",
      message: error.message
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
