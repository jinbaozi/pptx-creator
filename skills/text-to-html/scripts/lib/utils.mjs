import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, SkillError } from "./errors.mjs";

export const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function readJson(filePath, code = "E_INPUT_READ") {
  let source;
  try {
    source = await readFile(resolve(filePath), "utf8");
  } catch (error) {
    throw new SkillError(code, `Cannot read ${filePath}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SkillError("E_INPUT_JSON", `Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
  }
}

export async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function slugify(value, fallback = "deck") {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

export function normalizeRelativePath(value, fieldPath = "$.path") {
  if (typeof value !== "string" || !value || isAbsolute(value) || /^[a-z]+:\/\//i.test(value)) {
    fail("E_ASSET_PATH", `${fieldPath} must be a non-empty package-relative path`, { path: fieldPath });
  }
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    fail("E_ASSET_PATH", `${fieldPath} escapes its package root`, { path: fieldPath });
  }
  return normalized;
}

export function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function assertRegularFileInside(root, relativePath, fieldPath) {
  const normalized = normalizeRelativePath(relativePath, fieldPath);
  const candidate = resolve(root, normalized);
  if (!inside(root, candidate)) fail("E_ASSET_PATH", `${fieldPath} escapes the plan directory`, { path: fieldPath });
  let stat;
  try {
    stat = await lstat(candidate);
  } catch {
    fail("E_ASSET_MISSING", `Asset does not exist: ${normalized}`, { path: fieldPath });
  }
  if (stat.isSymbolicLink()) fail("E_ASSET_SYMLINK", `Asset cannot be a symlink: ${normalized}`, { path: fieldPath });
  if (!stat.isFile()) fail("E_ASSET_MISSING", `Asset is not a regular file: ${normalized}`, { path: fieldPath });
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(candidate);
  if (!inside(canonicalRoot, canonicalFile)) fail("E_ASSET_PATH", `Asset resolves outside the plan directory: ${normalized}`, { path: fieldPath });
  return { normalized, path: candidate };
}

export function assertSafeOutputDir(outputDir) {
  const resolved = resolve(outputDir);
  const root = parse(resolved).root;
  if (resolved === root || resolved === skillRoot || dirname(resolved) === resolved) {
    fail("E_OUTPUT_PATH", `Unsafe output directory: ${resolved}`);
  }
  return resolved;
}

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

export function mimeFromPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}
