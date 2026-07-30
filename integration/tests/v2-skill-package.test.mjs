import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildSkillPackage,
  collectSkillFiles,
  loadSkillPackageSpec,
  verifySkillPackage
} from "../scripts/lib/skill-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("V2 independent Skill packages", () => {

  it("rejects an explicit allowlist file that is a symlink", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-package-symlink-"));
    try {
      fs.writeFileSync(path.join(temporaryRoot, "outside.txt"), "outside");
      fs.mkdirSync(path.join(temporaryRoot, "skill"));
      fs.symlinkSync(path.join(temporaryRoot, "outside.txt"), path.join(temporaryRoot, "skill", "linked.txt"));
      await expect(collectSkillFiles(path.join(temporaryRoot, "skill"), {
        version: 1,
        skillName: "fixture",
        files: ["linked.txt"],
        directories: []
      })).rejects.toThrow(/symbolic links are not allowed/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("verifies archive bytes plus checksum and manifest sidecars", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-package-sidecars-"));
    const skillRoot = path.join(temporaryRoot, "fixture-skill");
    const outputRoot = path.join(temporaryRoot, "dist");
    try {
      for (const directory of ["agents", "scripts", "references", "examples", "tests", "schemas"]) {
        fs.mkdirSync(path.join(skillRoot, directory), { recursive: true });
        fs.writeFileSync(path.join(skillRoot, directory, "fixture.txt"), `${directory}\n`);
      }
      fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture\n---\n");
      fs.writeFileSync(path.join(skillRoot, "agents", "openai.yaml"), "default_prompt: Use $fixture-skill.\n");
      fs.writeFileSync(path.join(skillRoot, "package.json"), "{\"name\":\"fixture-skill\",\"version\":\"1.0.0\"}\n");
      fs.writeFileSync(path.join(skillRoot, "skill-package.files.json"), `${JSON.stringify({
        version: 1,
        skillName: "fixture-skill",
        files: ["SKILL.md", "package.json", "skill-package.files.json"],
        directories: ["agents", "scripts", "references", "examples", "tests", "schemas"],
        requiredFiles: ["SKILL.md", "agents/openai.yaml"],
        requiredDirectories: ["scripts", "references", "examples", "tests", "schemas"]
      }, null, 2)}\n`);

      const built = await buildSkillPackage(skillRoot, outputRoot);
      await expect(verifySkillPackage(skillRoot, built.archivePath)).resolves.toMatchObject({
        skillName: "fixture-skill",
        archiveSha256: built.archiveSha256,
        fileCount: built.fileCount
      });

      fs.writeFileSync(built.checksumPath, "0".repeat(64) + "  fixture-skill.skill\n");
      await expect(verifySkillPackage(skillRoot, built.archivePath)).rejects.toThrow(/checksum sidecar mismatch/);

      fs.writeFileSync(built.checksumPath, `${built.archiveSha256}  fixture-skill.skill\n`);
      const manifest = JSON.parse(fs.readFileSync(built.manifestPath, "utf8"));
      manifest.sourceCommit = "0".repeat(40);
      fs.writeFileSync(built.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(verifySkillPackage(skillRoot, built.archivePath)).rejects.toThrow(/manifest sidecar mismatch/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects cross-platform traversal names, unsafe ZIP entries, and symlinked output roots", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-package-paths-"));
    const skillRoot = path.join(temporaryRoot, "fixture-skill");
    const realOutput = path.join(temporaryRoot, "real-output");
    const linkedOutput = path.join(temporaryRoot, "linked-output");
    try {
      for (const directory of ["agents", "scripts", "references", "examples", "tests", "schemas"]) {
        fs.mkdirSync(path.join(skillRoot, directory), { recursive: true });
        fs.writeFileSync(path.join(skillRoot, directory, "fixture.txt"), `${directory}\n`);
      }
      fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture\n---\n");
      fs.writeFileSync(path.join(skillRoot, "agents", "openai.yaml"), "default_prompt: Use $fixture-skill.\n");
      fs.writeFileSync(path.join(skillRoot, "package.json"), "{\"name\":\"fixture-skill\",\"version\":\"1.0.0\"}\n");
      const spec = {
        version: 1,
        skillName: "fixture-skill",
        files: ["SKILL.md", "package.json"],
        directories: ["agents", "scripts", "references", "examples", "tests", "schemas"]
      };
      fs.writeFileSync(path.join(skillRoot, "skill-package.files.json"), `${JSON.stringify(spec, null, 2)}\n`);

      await expect(collectSkillFiles(skillRoot, {
        ...spec,
        files: ["SKILL.md", "..\\outside.txt"]
      })).rejects.toThrow(/invalid package path/);

      fs.mkdirSync(realOutput);
      fs.symlinkSync(realOutput, linkedOutput);
      await expect(buildSkillPackage(skillRoot, linkedOutput)).rejects.toThrow(/output path contains a symbolic link/);

      const built = await buildSkillPackage(skillRoot, realOutput);
      const zip = await JSZip.loadAsync(fs.readFileSync(built.archivePath));
      zip.file("fixture-skill/..\\outside.txt", "unsafe");
      fs.writeFileSync(built.archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      await expect(verifySkillPackage(skillRoot, built.archivePath)).rejects.toThrow(/unsafe or unexpected skill archive entry/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("loads every V2 package specification and selects its independent runtime", async () => {
    for (const skillName of ["text-to-html", "html-to-pptx", "image-to-pptx"]) {
      const skillRoot = path.join(root, "skills", skillName);
      const spec = await loadSkillPackageSpec(skillRoot);
      const files = await collectSkillFiles(skillRoot, spec);

      expect(spec).toMatchObject({ version: 1, skillName });
      expect(files).toContain("SKILL.md");
      expect(files).toContain("agents/openai.yaml");
      expect(files).toContain("schemas/presentation-package.schema.json");
      expect(files.some((file) => file.startsWith("scripts/"))).toBe(true);
      expect(files.some((file) => file.startsWith("references/"))).toBe(true);
      expect(files.some((file) => file.startsWith("examples/"))).toBe(true);
      expect(files.some((file) => file.startsWith("tests/"))).toBe(true);
      expect(files.some((file) => file.includes("node_modules"))).toBe(false);
      expect(files.some((file) => file.includes("/output/"))).toBe(false);
    }
  });
});
