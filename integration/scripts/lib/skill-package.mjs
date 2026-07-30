import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const compareStrings = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function normalizeRelative(value) {
  if (typeof value !== "string") throw new Error(`package path must be a string: ${String(value)}`);
  if (!value || value.includes("\0") || /^[A-Za-z]:/.test(value) || path.win32.isAbsolute(value)) {
    throw new Error(`invalid package path: ${value}`);
  }
  const portable = toPosix(value);
  if (portable.split("/").includes("..")) throw new Error(`invalid package path: ${value}`);
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`invalid package path: ${value}`);
  }
  return normalized;
}

async function assertNotSymlink(target, label) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`skill package output path contains a symbolic link: ${label}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertSafeArchiveEntry(entry) {
  const originalName = entry.unsafeOriginalName ?? entry.name;
  if (entry.dir || originalName !== entry.name || entry.name.includes("\\")
      || entry.name.includes("\0") || /^[A-Za-z]:/.test(entry.name)
      || path.posix.isAbsolute(entry.name)
      || entry.name.split("/").includes("..")
      || path.posix.normalize(entry.name) !== entry.name) {
    throw new Error(`unsafe or unexpected skill archive entry: ${originalName}`);
  }
  const rawPermissions = entry.unixPermissions;
  const permissions = typeof rawPermissions === "string"
    ? Number.parseInt(rawPermissions, 8)
    : rawPermissions;
  const fileType = Number.isInteger(permissions) ? permissions & 0o170000 : 0;
  if (fileType !== 0 && fileType !== 0o100000) {
    throw new Error(`skill archive entry is not a regular file: ${entry.name}`);
  }
}

function isExcluded(relativePath, spec) {
  const normalized = normalizeRelative(relativePath);
  if ((spec.excludeFiles || []).includes(normalized)) return true;
  const parts = normalized.split("/");
  if (parts.some((part) => (spec.excludeSegments || []).includes(part))) return true;
  const basename = parts.at(-1);
  if ((spec.excludeBasenames || []).includes(basename)) return true;
  return (spec.excludeExtensions || []).some((extension) => basename.endsWith(extension));
}

async function listFiles(root, relativeDirectory, spec) {
  const normalizedDirectory = normalizeRelative(relativeDirectory);
  const absoluteDirectory = path.join(root, normalizedDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    const relativePath = normalizeRelative(path.posix.join(normalizedDirectory, entry.name));
    if (isExcluded(relativePath, spec)) continue;
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in a skill package: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath, spec));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

export async function loadSkillPackageSpec(root) {
  const raw = await fs.readFile(path.join(root, "skill-package.files.json"), "utf8");
  const spec = JSON.parse(raw);
  if (spec.version !== 1) throw new Error(`unsupported skill package spec version: ${spec.version}`);
  if (!/^[a-z0-9-]{1,64}$/.test(spec.skillName || "")) throw new Error(`invalid skill name: ${spec.skillName}`);
  for (const field of [
    "files",
    "directories",
    "requiredFiles",
    "requiredDirectories",
    "excludeFiles",
    "excludeSegments",
    "excludeBasenames",
    "excludeExtensions"
  ]) {
    if (spec[field] !== undefined && (!Array.isArray(spec[field]) || spec[field].some((value) => typeof value !== "string"))) {
      throw new Error(`skill package spec ${field} must be an array of strings`);
    }
  }
  return spec;
}

export async function collectSkillFiles(root, spec) {
  const canonicalRoot = await fs.realpath(root);
  const assertInsideRoot = async (absolutePath, label) => {
    const canonicalPath = await fs.realpath(absolutePath);
    const relation = path.relative(canonicalRoot, canonicalPath);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      throw new Error(`skill package path escapes the package root: ${label}`);
    }
  };
  const selected = new Set();
  for (const candidate of spec.files || []) {
    const relativePath = normalizeRelative(candidate);
    if (isExcluded(relativePath, spec)) continue;
    const absolutePath = path.join(root, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in a skill package: ${relativePath}`);
    if (!stat.isFile()) throw new Error(`package allowlist entry is not a file: ${relativePath}`);
    await assertInsideRoot(absolutePath, relativePath);
    selected.add(relativePath);
  }
  for (const directory of spec.directories || []) {
    const normalizedDirectory = normalizeRelative(directory);
    const absoluteDirectory = path.join(root, normalizedDirectory);
    const stat = await fs.lstat(absoluteDirectory);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in a skill package: ${normalizedDirectory}`);
    if (!stat.isDirectory()) throw new Error(`package allowlist entry is not a directory: ${normalizedDirectory}`);
    await assertInsideRoot(absoluteDirectory, normalizedDirectory);
    for (const relativePath of await listFiles(root, directory, spec)) selected.add(relativePath);
  }
  const files = [...selected].sort(compareStrings);
  for (const required of ["SKILL.md", "agents/openai.yaml", "package.json"]) {
    if (!files.includes(required)) throw new Error(`required skill package file is missing: ${required}`);
  }
  for (const required of spec.requiredFiles || []) {
    const normalized = normalizeRelative(required);
    if (!files.includes(normalized)) throw new Error(`declared required skill package file is missing: ${normalized}`);
  }
  for (const required of spec.requiredDirectories || []) {
    const normalized = `${normalizeRelative(required).replace(/\/$/, "")}/`;
    if (!files.some((file) => file.startsWith(normalized))) {
      throw new Error(`declared required skill package directory is empty or missing: ${normalized.slice(0, -1)}`);
    }
  }
  return files;
}

function gitValue(root, args, fallback) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function buildSkillPackage(root, outputRoot = path.join(root, "dist")) {
  const spec = await loadSkillPackageSpec(root);
  const files = await collectSkillFiles(root, spec);
  const packageRoot = path.join(outputRoot, spec.skillName);
  const archivePath = path.join(outputRoot, `${spec.skillName}.skill`);
  const checksumPath = `${archivePath}.sha256`;
  const manifestPath = path.join(outputRoot, `${spec.skillName}.skill-manifest.json`);

  for (const [target, label] of [
    [path.dirname(outputRoot), "output parent"],
    [outputRoot, "output root"],
    [packageRoot, "extracted package"],
    [archivePath, "archive"],
    [checksumPath, "checksum sidecar"],
    [manifestPath, "manifest sidecar"]
  ]) {
    await assertNotSymlink(target, label);
  }
  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(packageRoot, { recursive: true });

  const zip = new JSZip();
  let totalBytes = 0;
  for (const relativePath of files) {
    const bytes = await fs.readFile(path.join(root, relativePath));
    totalBytes += bytes.byteLength;
    const target = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    zip.file(`${spec.skillName}/${relativePath}`, bytes, {
      date: FIXED_ZIP_DATE,
      createFolders: false,
      unixPermissions: 0o100644
    });
  }

  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: true
  });
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(archivePath, archive);
  const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
  await fs.writeFile(checksumPath, `${archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");

  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const manifest = {
    schemaVersion: 1,
    skillName: spec.skillName,
    packageVersion: packageJson.version,
    sourceBranch: gitValue(root, ["branch", "--show-current"], "unknown"),
    sourceCommit: gitValue(root, ["rev-parse", "HEAD"], "unknown"),
    archiveSha256,
    fileCount: files.length,
    totalBytes
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, packageRoot, archivePath, checksumPath, manifestPath, files };
}

export async function verifySkillPackage(root, archivePath = path.join(root, "dist", "pptx-creator.skill")) {
  const spec = await loadSkillPackageSpec(root);
  const expectedFiles = await collectSkillFiles(root, spec);
  const archive = await fs.readFile(archivePath);
  const zip = await JSZip.loadAsync(archive);
  const prefix = `${spec.skillName}/`;
  const archiveEntries = Object.values(zip.files);
  for (const entry of archiveEntries) assertSafeArchiveEntry(entry);
  const archiveFiles = archiveEntries.map((entry) => entry.name).sort(compareStrings);
  const expectedArchiveFiles = expectedFiles.map((relativePath) => `${prefix}${relativePath}`);
  if (JSON.stringify(archiveFiles) !== JSON.stringify(expectedArchiveFiles)) {
    const unexpected = archiveFiles.filter((name) => !expectedArchiveFiles.includes(name));
    const missing = expectedArchiveFiles.filter((name) => !archiveFiles.includes(name));
    throw new Error(`skill archive membership mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }

  for (const relativePath of expectedFiles) {
    const entry = zip.file(`${prefix}${relativePath}`);
    const [sourceBytes, archivedBytes] = await Promise.all([
      fs.readFile(path.join(root, relativePath)),
      entry.async("nodebuffer")
    ]);
    if (!sourceBytes.equals(archivedBytes)) throw new Error(`skill archive byte mismatch: ${relativePath}`);
  }

  const skillMd = await zip.file(`${prefix}SKILL.md`).async("string");
  if (!skillMd.startsWith(`---\nname: ${spec.skillName}\ndescription:`)) {
    throw new Error(`SKILL.md frontmatter is not the published ${spec.skillName} contract`);
  }
  const openAiYaml = await zip.file(`${prefix}agents/openai.yaml`).async("string");
  if (!openAiYaml.includes(`$${spec.skillName}`)) {
    throw new Error(`agents/openai.yaml default_prompt must explicitly mention $${spec.skillName}`);
  }

  const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const checksumPath = `${archivePath}.sha256`;
  const expectedChecksum = `${archiveSha256}  ${path.basename(archivePath)}\n`;
  const checksum = await fs.readFile(checksumPath, "utf8");
  if (checksum !== expectedChecksum) throw new Error(`skill package checksum sidecar mismatch: ${checksumPath}`);

  const manifestPath = path.join(path.dirname(archivePath), `${spec.skillName}.skill-manifest.json`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const expectedSourceBranch = gitValue(root, ["branch", "--show-current"], "unknown");
  const expectedSourceCommit = gitValue(root, ["rev-parse", "HEAD"], "unknown");
  const sourceTotalBytes = (await Promise.all(expectedFiles.map(async (relativePath) => (
    await fs.stat(path.join(root, relativePath))
  ).size))).reduce((sum, value) => sum + value, 0);
  if (manifest.schemaVersion !== 1
      || manifest.skillName !== spec.skillName
      || manifest.packageVersion !== packageJson.version
      || manifest.archiveSha256 !== archiveSha256
      || manifest.fileCount !== expectedFiles.length
      || manifest.totalBytes !== sourceTotalBytes
      || manifest.sourceBranch !== expectedSourceBranch
      || manifest.sourceCommit !== expectedSourceCommit
      || !/^(?:unknown|[a-f0-9]{40})$/.test(manifest.sourceCommit)) {
    throw new Error(`skill package manifest sidecar mismatch: ${manifestPath}`);
  }

  return {
    skillName: spec.skillName,
    archivePath,
    archiveSha256,
    fileCount: expectedFiles.length,
    sourceBytes: sourceTotalBytes,
    archiveBytes: archive.byteLength,
    checksumPath,
    manifestPath
  };
}
