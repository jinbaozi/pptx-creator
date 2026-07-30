import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageV2Skills } from "../scripts/package-v2-skills.mjs";
import { verifyV2Skills } from "../scripts/verify-v2-skills.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = ["text-to-html", "html-to-pptx", "image-to-pptx"];

describe("V2 package and verify wrappers", () => {
  it("builds all three archives deterministically and verifies their bytes and sidecars", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-package-cli-"));
    try {
      const first = await packageV2Skills(root, path.join(temporaryRoot, "first"));
      const second = await packageV2Skills(root, path.join(temporaryRoot, "second"));
      const verified = await verifyV2Skills(root, path.join(temporaryRoot, "second"));

      expect(first.status).toBe("passed");
      expect(second.status).toBe("passed");
      expect(verified.status).toBe("passed");
      expect(first.skills.map((item) => item.skillName)).toEqual(skillNames);
      expect(second.skills.map((item) => item.archiveSha256)).toEqual(
        first.skills.map((item) => item.archiveSha256)
      );
      expect(verified.skills.map((item) => item.archiveSha256)).toEqual(
        second.skills.map((item) => item.archiveSha256)
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails before packaging when an independent Skill boundary is incomplete", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-package-blocked-"));
    try {
      fs.mkdirSync(path.join(fixtureRoot, "schemas"), { recursive: true });
      fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
      fs.copyFileSync(
        path.join(root, "schemas", "presentation-package.schema.json"),
        path.join(fixtureRoot, "schemas", "presentation-package.schema.json")
      );
      fs.copyFileSync(
        path.join(root, "scripts", "validate-presentation-package.mjs"),
        path.join(fixtureRoot, "scripts", "validate-presentation-package.mjs")
      );
      for (const skillName of skillNames) {
        const skillRoot = path.join(fixtureRoot, "skills", skillName);
        for (const directory of ["agents", "scripts", "references", "examples", "tests", "schemas"]) {
          fs.mkdirSync(path.join(skillRoot, directory), { recursive: true });
        }
        fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `---\nname: ${skillName}\ndescription: fixture\n---\n`);
        fs.writeFileSync(path.join(skillRoot, "agents", "openai.yaml"), `default_prompt: Use $${skillName}.\n`);
        fs.writeFileSync(path.join(skillRoot, "package.json"), `${JSON.stringify({
          name: skillName,
          version: "1.0.0",
          type: "module"
        }, null, 2)}\n`);
      }

      await expect(packageV2Skills(
        fixtureRoot,
        path.join(fixtureRoot, "dist")
      )).rejects.toThrow(/independence gate failed/);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
