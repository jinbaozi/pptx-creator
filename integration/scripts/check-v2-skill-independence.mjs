#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SKILL_NAMES = ["text-to-html", "html-to-pptx", "image-to-pptx"];
const IGNORED_SEGMENTS = new Set(["node_modules", "dist", "output", "__pycache__"]);
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".json", ".md", ".yaml", ".yml", ".html", ".css"]);

function inside(root, target) {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function walk(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const target = join(directory, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      result.push({ path: target, kind: "symlink" });
    } else if (stat.isDirectory()) {
      result.push(...await walk(root, target));
    } else if (stat.isFile()) {
      result.push({ path: target, kind: "file" });
    }
  }
  return result;
}

function localSpecifiers(source) {
  const values = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'()]*?\sfrom\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    /\b(?:readFile|readFileSync|open|openSync|stat|lstat|access)\s*\(\s*["']([^"']+)["']/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith(".")) values.push(match[1]);
    }
  }
  return values;
}

function normalizedValidatorSource(bytes) {
  return bytes.toString("utf8").replace(
    /\.\.\/(?:protocol|schemas)\/presentation-package\.schema\.json/g,
    "../PROTOCOL_SCHEMA"
  );
}

async function inspectSkill(skillRoot, canonicalSchemaBytes, canonicalValidatorBytes, repositoryRoot) {
  const findings = [];
  const required = new Map([
    ["SKILL.md", "file"],
    ["agents/openai.yaml", "file"],
    ["package.json", "file"],
    ["scripts/validate-presentation-package.mjs", "file"],
    ["scripts", "directory"],
    ["references", "directory"],
    ["examples", "directory"],
    ["tests", "directory"]
  ]);
  for (const [item, expectedKind] of required) {
    try {
      const stat = await lstat(join(skillRoot, item));
      if ((expectedKind === "file" && !stat.isFile()) || (expectedKind === "directory" && !stat.isDirectory())) {
        findings.push({ code: "E_SKILL_REQUIRED_PATH_TYPE", path: item, message: `required path ${item} must be a ${expectedKind}` });
      }
    } catch {
      findings.push({ code: "E_SKILL_REQUIRED_PATH", path: item, message: `missing required path ${item}` });
    }
  }

  const files = await walk(skillRoot);
  for (const entry of files) {
    const localPath = relative(skillRoot, entry.path).split(sep).join("/");
    if (entry.kind === "symlink") {
      findings.push({ code: "E_SKILL_SYMLINK", path: localPath, message: "symlinks are forbidden in independent Skill packages" });
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue;
    const source = await readFile(entry.path, "utf8");
    const normalizedSource = source.replaceAll("\\", "/");
    const normalizedRepositoryRoot = repositoryRoot.split(sep).join("/");
    if (normalizedSource.includes(normalizedRepositoryRoot)) {
      findings.push({ code: "E_SKILL_ABSOLUTE_REPO_PATH", path: localPath, message: "runtime contains an absolute development checkout path" });
    }
    const extension = extname(entry.path).toLowerCase();
    if ([".js", ".mjs", ".cjs", ".ts", ".py", ".sh"].includes(extension)
        && /(?:^|["'(\s])(?:\/Users\/[^/"'\s]+\/|\/home\/[^/"'\s]+\/|[A-Za-z]:[\\/](?:Users|home)[\\/])/m.test(source)) {
      findings.push({ code: "E_SKILL_ABSOLUTE_RUNTIME_PATH", path: localPath, message: "runtime contains a machine-specific absolute path" });
    }
    for (const sibling of SKILL_NAMES) {
      if (sibling !== skillRoot.split(sep).at(-1) && source.includes(`skills/${sibling}`)) {
        findings.push({ code: "E_SKILL_SIBLING_REFERENCE", path: localPath, message: `runtime references sibling Skill ${sibling}` });
      }
    }
    if ([".js", ".mjs", ".cjs", ".ts"].includes(extname(entry.path).toLowerCase())) {
      for (const specifier of localSpecifiers(source)) {
        const target = resolve(dirname(entry.path), specifier);
        if (!inside(skillRoot, target)) {
          findings.push({ code: "E_SKILL_IMPORT_ESCAPE", path: localPath, message: `local import escapes Skill root: ${specifier}` });
        }
      }
    }
  }

  try {
    const packageJson = JSON.parse(await readFile(join(skillRoot, "package.json"), "utf8"));
    for (const [section, dependencies] of Object.entries({
      dependencies: packageJson.dependencies ?? {},
      devDependencies: packageJson.devDependencies ?? {},
      optionalDependencies: packageJson.optionalDependencies ?? {}
    })) {
      for (const [name, value] of Object.entries(dependencies)) {
        const normalizedValue = String(value).replaceAll("\\", "/");
        if (/^(?:(?:file|link|workspace):|\.\.?\/|[A-Za-z]:|\/)/i.test(normalizedValue)
            || normalizedValue.split("/").includes("..")) {
          findings.push({ code: "E_SKILL_LOCAL_DEPENDENCY", path: "package.json", message: `${section}.${name} uses local dependency ${value}` });
        }
      }
    }
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      const normalizedCommand = String(command).replaceAll("\\", "/");
      if (normalizedCommand.includes(repositoryRoot.split(sep).join("/"))
          || normalizedCommand.split(/[ \t"'=()]+/).some((token) => token.split("/").includes(".."))
          || SKILL_NAMES.some((sibling) => sibling !== skillRoot.split(sep).at(-1) && normalizedCommand.includes(`skills/${sibling}`))) {
        findings.push({ code: "E_SKILL_SCRIPT_ESCAPE", path: "package.json", message: `script ${name} escapes or references another development root` });
      }
    }
  } catch (error) {
    findings.push({ code: "E_SKILL_PACKAGE_JSON", path: "package.json", message: error.message });
  }

  const protocolPaths = [
    "schemas/presentation-package.schema.json",
    "references/presentation-package.schema.json"
  ];
  let protocolPath = null;
  for (const candidate of protocolPaths) {
    try {
      const bytes = await readFile(join(skillRoot, candidate));
      protocolPath = candidate;
      if (!bytes.equals(canonicalSchemaBytes)) {
        findings.push({ code: "E_SKILL_PROTOCOL_DRIFT", path: candidate, message: "protocol schema differs from the canonical 1.0.0 schema" });
      }
      try {
        const protocol = JSON.parse(bytes);
        if (protocol?.properties?.protocol?.const !== "pptx-creator.presentation-package"
            || protocol?.properties?.version?.const !== "1.0.0"
            || !protocol?.$defs?.slide
            || !protocol?.$defs?.component) {
          findings.push({ code: "E_SKILL_PROTOCOL_SCHEMA", path: candidate, message: "protocol schema is missing required 1.0.0 anchors" });
        }
      } catch (error) {
        findings.push({ code: "E_SKILL_PROTOCOL_SCHEMA", path: candidate, message: `protocol schema is not valid JSON: ${error.message}` });
      }
      break;
    } catch {
      // Try the next accepted package-local location.
    }
  }
  if (!protocolPath) {
    findings.push({ code: "E_SKILL_PROTOCOL_MISSING", path: "schemas/presentation-package.schema.json", message: "package-local protocol schema is missing" });
  }
  try {
    const validatorPath = "scripts/validate-presentation-package.mjs";
    const validatorBytes = await readFile(join(skillRoot, validatorPath));
    if (normalizedValidatorSource(validatorBytes) !== normalizedValidatorSource(canonicalValidatorBytes)) {
      findings.push({ code: "E_SKILL_PROTOCOL_VALIDATOR_DRIFT", path: validatorPath, message: "protocol validator differs from the canonical 1.0.0 validator" });
    }
  } catch {
    findings.push({ code: "E_SKILL_PROTOCOL_VALIDATOR_MISSING", path: "scripts/validate-presentation-package.mjs", message: "package-local protocol validator is missing" });
  }

  return {
    skill: skillRoot.split(sep).at(-1),
    fileCount: files.filter((entry) => entry.kind === "file").length,
    protocolPath,
    findings
  };
}

export async function checkV2SkillIndependence(repositoryRoot) {
  const canonicalSchemaBytes = await readFile(join(repositoryRoot, "integration", "protocol", "presentation-package.schema.json"));
  const canonicalValidatorBytes = await readFile(join(repositoryRoot, "integration", "scripts", "validate-presentation-package.mjs"));
  const reports = [];
  for (const name of SKILL_NAMES) {
    reports.push(await inspectSkill(
      join(repositoryRoot, "skills", name),
      canonicalSchemaBytes,
      canonicalValidatorBytes,
      repositoryRoot
    ));
  }
  const findings = reports.flatMap((report) => report.findings.map((finding) => ({ skill: report.skill, ...finding })));
  return {
    status: findings.length === 0 ? "passed" : "failed",
    skills: reports,
    findings
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const report = await checkV2SkillIndependence(repositoryRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
