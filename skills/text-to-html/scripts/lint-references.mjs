#!/usr/bin/env node
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_REFERENCE_METADATA = ["purpose", "trigger", "prereqs", "next", "contract"];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultSkillRoot = resolve(scriptDirectory, "..");
export const defaultReferenceDirectory = join(defaultSkillRoot, "references");
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^\n)]+)\)/g;
const METADATA_LINE = /^\s*>\s*\*\*(Purpose|Trigger|Prereqs|Next|Contract):\*\*\s*(.*?)\s*$/i;

function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function displayPath(root, target) {
  return relative(root, target).replaceAll("\\", "/") || ".";
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitDestination(raw) {
  const text = raw.trim();
  if (!text) return "";
  if (text.startsWith("<")) {
    const end = text.indexOf(">");
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  return text.split(/\s+/, 1)[0];
}

function localPathFromDestination(destination) {
  const fragmentStart = destination.search(/[?#]/);
  return decodePath(fragmentStart === -1 ? destination : destination.slice(0, fragmentStart));
}

function isUnsafeProtocol(value) {
  return /^(?:file|javascript|data|vbscript):/i.test(value);
}

function isExternalProtocol(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function metadataFindings(source, file, skillRoot) {
  const findings = [];
  const lines = source.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim() !== "");
  if (titleIndex === -1 || !/^#\s+\S/.test(lines[titleIndex])) {
    findings.push({
      code: "E_REFERENCE_TITLE",
      file: displayPath(skillRoot, file),
      line: titleIndex === -1 ? 1 : titleIndex + 1,
      message: "Reference documents must begin with one level-one title."
    });
    return findings;
  }

  const values = new Map();
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    const match = lines[index].match(METADATA_LINE);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (values.has(key)) {
      findings.push({
        code: "E_REFERENCE_METADATA_DUPLICATE",
        file: displayPath(skillRoot, file),
        line: index + 1,
        message: `Reference metadata repeats ${key}.`
      });
    }
    values.set(key, { value, line: index + 1 });
  }

  for (const key of REQUIRED_REFERENCE_METADATA) {
    const item = values.get(key);
    if (!item || !item.value) {
      findings.push({
        code: "E_REFERENCE_METADATA",
        file: displayPath(skillRoot, file),
        line: titleIndex + 1,
        message: `Reference metadata requires a non-empty ${key} field before the first level-two heading.`
      });
    }
  }
  return findings;
}

async function markdownFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() && entry.name.endsWith(".md")) {
      files.push({ path, symlink: true });
    } else if (entry.isDirectory()) {
      files.push(...await markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push({ path, symlink: false });
    }
  }
  return files;
}

async function linkFindings(source, file, skillRoot, canonicalSkillRoot) {
  const findings = [];
  for (const match of source.matchAll(MARKDOWN_LINK)) {
    const destination = splitDestination(match[1]);
    const line = lineAt(source, match.index ?? 0);
    const doc = displayPath(skillRoot, file);
    if (!destination || destination.startsWith("#")) continue;
    const path = localPathFromDestination(destination);
    if (!path) continue;
    const portable = path.replaceAll("\\", "/");

    if (isUnsafeProtocol(path) || isAbsolute(portable) || win32.isAbsolute(path) || portable.startsWith("//") || portable.startsWith("~")) {
      findings.push({
        code: "E_REFERENCE_PATH_EXTERNAL",
        file: doc,
        line,
        message: `Reference link uses an unsafe package-external path: ${destination}`
      });
      continue;
    }
    if (isExternalProtocol(path)) continue;

    const resolved = resolve(dirname(file), portable);
    if (!isInside(canonicalSkillRoot, resolved)) {
      findings.push({
        code: "E_REFERENCE_PATH_EXTERNAL",
        file: doc,
        line,
        message: `Reference link escapes the Skill package: ${destination}`
      });
      continue;
    }

    try {
      await stat(resolved);
    } catch (error) {
      if (error?.code === "ENOENT") {
        findings.push({
          code: "E_REFERENCE_LINK_MISSING",
          file: doc,
          line,
          message: `Reference link does not exist: ${destination}`
        });
        continue;
      }
      throw error;
    }

    const canonicalTarget = await realpath(resolved);
    if (!isInside(canonicalSkillRoot, canonicalTarget)) {
      findings.push({
        code: "E_REFERENCE_PATH_EXTERNAL",
        file: doc,
        line,
        message: `Reference link resolves outside the Skill package: ${destination}`
      });
    }
  }
  return findings;
}

/**
 * Check reference metadata and package-local Markdown links without loading any
 * runtime dependency outside this Skill directory.
 */
export async function lintReferences({ skillRoot = defaultSkillRoot, referenceDirectory = defaultReferenceDirectory } = {}) {
  const resolvedSkillRoot = resolve(skillRoot);
  const resolvedReferenceDirectory = resolve(referenceDirectory);
  const canonicalSkillRoot = await realpath(resolvedSkillRoot);
  const canonicalReferenceDirectory = await realpath(resolvedReferenceDirectory);
  if (!isInside(canonicalSkillRoot, canonicalReferenceDirectory)) {
    throw new Error("referenceDirectory must be inside skillRoot");
  }

  const entries = await markdownFiles(canonicalReferenceDirectory);
  const findings = [];
  let checkedFiles = 0;
  for (const entry of entries) {
    if (entry.symlink) {
      findings.push({
        code: "E_REFERENCE_SYMLINK",
        file: displayPath(canonicalSkillRoot, entry.path),
        line: 1,
        message: "Reference documents cannot be symbolic links."
      });
      continue;
    }
    checkedFiles += 1;
    const source = await readFile(entry.path, "utf8");
    findings.push(...metadataFindings(source, entry.path, canonicalSkillRoot));
    findings.push(...await linkFindings(source, entry.path, canonicalSkillRoot, canonicalSkillRoot));
  }

  return {
    status: findings.length === 0 ? "passed" : "failed",
    referenceDirectory: displayPath(canonicalSkillRoot, canonicalReferenceDirectory),
    checkedFiles,
    findings
  };
}

export async function assertReferences(options) {
  const report = await lintReferences(options);
  if (report.status === "failed") {
    const error = new Error(`reference lint failed with ${report.findings.length} finding(s)`);
    error.code = "E_REFERENCE_LINT";
    error.report = report;
    throw error;
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) throw new Error("usage: lint-references.mjs [references-directory]");
  const referenceDirectory = argv[0] ? resolve(process.cwd(), argv[0]) : defaultReferenceDirectory;
  const report = await lintReferences({ referenceDirectory });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "failed") process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? "E_REFERENCE_LINT", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
