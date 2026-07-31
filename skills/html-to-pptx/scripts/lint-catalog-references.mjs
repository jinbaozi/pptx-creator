import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_DIRECTORIES = Object.freeze([
  "design-systems",
  "layout-archetypes",
  "slide-archetypes"
]);

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\s*\)/g;

function isWithin(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function documentPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function localReference(value) {
  const target = value.split("#", 1)[0];
  if (!target || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
  return target;
}

async function catalogDocuments(root, catalogDirectories) {
  const documents = [];
  const issues = [];

  for (const catalogDirectory of catalogDirectories) {
    const directory = resolve(root, catalogDirectory);
    if (!isWithin(root, directory)) {
      issues.push({
        code: "E_CATALOG_DIRECTORY",
        source: catalogDirectory,
        message: "catalog directory escapes the Skill root"
      });
      continue;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        issues.push({
          code: "E_CATALOG_DIRECTORY",
          source: catalogDirectory,
          message: "catalog directory is missing"
        });
        continue;
      }
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await catalogDocuments(root, [documentPath(root, path)]);
        documents.push(...nested.documents);
        issues.push(...nested.issues);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        documents.push(path);
      }
    }
  }

  return { documents, issues };
}

export async function lintCatalogReferences(rootDir, catalogDirectories = CATALOG_DIRECTORIES) {
  const root = resolve(rootDir);
  const { documents, issues } = await catalogDocuments(root, catalogDirectories);

  for (const sourcePath of documents) {
    const source = documentPath(root, sourcePath);
    const content = await readFile(sourcePath, "utf8");
    for (const match of content.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? match[2];
      const reference = localReference(target);
      if (!reference) continue;
      if (isAbsolute(reference)) {
        issues.push({
          code: "E_REFERENCE_ABSOLUTE",
          source,
          target,
          message: "local Markdown reference must be relative"
        });
        continue;
      }

      const resolved = resolve(dirname(sourcePath), reference);
      if (!isWithin(root, resolved)) {
        issues.push({
          code: "E_REFERENCE_ESCAPE",
          source,
          target,
          message: "local Markdown reference escapes the Skill root"
        });
        continue;
      }

      try {
        const info = await lstat(resolved);
        if (!info.isFile()) {
          issues.push({
            code: "E_REFERENCE_TARGET",
            source,
            target,
            message: "local Markdown reference must resolve to a file"
          });
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          issues.push({
            code: "E_REFERENCE_MISSING",
            source,
            target,
            message: "local Markdown reference target is missing"
          });
          continue;
        }
        throw error;
      }
    }
  }

  return { documents: documents.map((path) => documentPath(root, path)), issues };
}

function formatIssue(issue) {
  return `${issue.code} ${issue.source}${issue.target ? ` -> ${issue.target}` : ""}: ${issue.message}`;
}

async function main() {
  const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await lintCatalogReferences(skillRoot);
  if (result.issues.length > 0) {
    console.error(result.issues.map(formatIssue).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Catalog reference lint passed for ${result.documents.length} documents.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
