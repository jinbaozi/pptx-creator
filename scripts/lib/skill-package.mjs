import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeRelative(value) {
  const normalized = path.posix.normalize(toPosix(value)).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`invalid package path: ${value}`);
  }
  return normalized;
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
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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
  return spec;
}

export async function collectSkillFiles(root, spec) {
  const selected = new Set();
  for (const candidate of spec.files || []) {
    const relativePath = normalizeRelative(candidate);
    if (isExcluded(relativePath, spec)) continue;
    const stat = await fs.stat(path.join(root, relativePath));
    if (!stat.isFile()) throw new Error(`package allowlist entry is not a file: ${relativePath}`);
    selected.add(relativePath);
  }
  for (const directory of spec.directories || []) {
    for (const relativePath of await listFiles(root, directory, spec)) selected.add(relativePath);
  }
  const files = [...selected].sort((a, b) => a.localeCompare(b));
  for (const required of ["SKILL.md", "agents/openai.yaml", "package.json"]) {
    if (!files.includes(required)) throw new Error(`required skill package file is missing: ${required}`);
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
  const archiveFiles = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
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
  if (!skillMd.startsWith("---\nname: pptx-creator\ndescription:")) throw new Error("SKILL.md frontmatter is not the published pptx-creator contract");
  const openAiYaml = await zip.file(`${prefix}agents/openai.yaml`).async("string");
  if (!openAiYaml.includes("$pptx-creator")) throw new Error("agents/openai.yaml default_prompt must explicitly mention $pptx-creator");

  return {
    skillName: spec.skillName,
    archivePath,
    archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"),
    fileCount: expectedFiles.length,
    totalBytes: archive.byteLength
  };
}
