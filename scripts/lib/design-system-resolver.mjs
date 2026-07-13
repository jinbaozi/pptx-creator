import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesignFile } from "../parse-design-md.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const remoteReference = /^[a-z][a-z0-9+.-]*:/i;

function existingDesignFile(candidate) {
  if (!fs.existsSync(candidate)) return null;
  const stats = fs.statSync(candidate);
  const designPath = stats.isDirectory() ? path.join(candidate, "DESIGN.md") : candidate;
  if (!fs.existsSync(designPath) || !fs.statSync(designPath).isFile()) {
    throw new Error(`design system directory does not contain DESIGN.md: ${candidate}`);
  }
  return path.resolve(designPath);
}

function inputDirectory(inputPath) {
  const absolute = path.resolve(inputPath);
  return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
}

export async function resolveDesignSystem({
  request,
  inputPath,
  projectRoot = repositoryRoot,
  builtInRoot = path.join(repositoryRoot, "design-systems")
} = {}) {
  if (!inputPath) throw new Error("design system resolution requires an input path");
  const normalizedRequest = request === undefined || request === null ? null : String(request).trim();
  if (normalizedRequest === "") throw new Error("--design-system requires a value");
  if (normalizedRequest && (remoteReference.test(normalizedRequest) || normalizedRequest.startsWith("//"))) {
    throw new Error("remote design-system URLs are not allowed; use a local path or built-in name");
  }

  let resolvedSource = null;
  if (normalizedRequest) {
    resolvedSource = existingDesignFile(path.resolve(normalizedRequest));
    if (!resolvedSource && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalizedRequest)) {
      resolvedSource = existingDesignFile(path.join(path.resolve(builtInRoot), normalizedRequest, "DESIGN.md"));
    }
    if (!resolvedSource) throw new Error(`unknown design system or local path not found: ${normalizedRequest}`);
  } else {
    const candidates = [
      path.join(path.resolve(projectRoot), "DESIGN.md"),
      path.join(inputDirectory(inputPath), "DESIGN.md"),
      path.join(path.resolve(builtInRoot), "business-neutral", "DESIGN.md")
    ];
    resolvedSource = candidates.map(existingDesignFile).find(Boolean) ?? null;
    if (!resolvedSource) throw new Error("no local design system could be resolved");
  }

  const design = await parseDesignFile(resolvedSource);
  return { request: normalizedRequest, resolvedSource, design };
}
