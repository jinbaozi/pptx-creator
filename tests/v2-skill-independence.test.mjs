import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { checkV2SkillIndependence, SKILL_NAMES } from "../scripts/check-v2-skill-independence.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

function isolatedFixture() {
  const fixtureRoot = fs.mkdtempSync(join(os.tmpdir(), "v2-independence-"));
  fs.mkdirSync(join(fixtureRoot, "schemas"), { recursive: true });
  fs.copyFileSync(
    join(root, "schemas", "presentation-package.schema.json"),
    join(fixtureRoot, "schemas", "presentation-package.schema.json")
  );
  fs.mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    join(root, "scripts", "validate-presentation-package.mjs"),
    join(fixtureRoot, "scripts", "validate-presentation-package.mjs")
  );
  for (const name of SKILL_NAMES) {
    const skillRoot = join(fixtureRoot, "skills", name);
    for (const directory of ["agents", "scripts", "references", "examples", "tests", "schemas"]) {
      fs.mkdirSync(join(skillRoot, directory), { recursive: true });
    }
    fs.writeFileSync(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
    fs.writeFileSync(join(skillRoot, "agents", "openai.yaml"), `default_prompt: Use $${name}.\n`);
    fs.writeFileSync(join(skillRoot, "scripts", "index.mjs"), "export const ok = true;\n");
    fs.copyFileSync(
      join(root, "scripts", "validate-presentation-package.mjs"),
      join(skillRoot, "scripts", "validate-presentation-package.mjs")
    );
    fs.writeFileSync(join(skillRoot, "references", "contract.md"), "# Contract\n");
    fs.writeFileSync(join(skillRoot, "examples", "input.txt"), "fixture\n");
    fs.writeFileSync(join(skillRoot, "tests", "unit.test.mjs"), "export {};\n");
    fs.copyFileSync(
      join(root, "schemas", "presentation-package.schema.json"),
      join(skillRoot, "schemas", "presentation-package.schema.json")
    );
    fs.writeFileSync(join(skillRoot, "package.json"), `${JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      scripts: { test: "node --test tests" },
      dependencies: {}
    }, null, 2)}\n`);
  }
  return fixtureRoot;
}

describe("V2 Skill independence", () => {
  it("keeps all three runtime and protocol boundaries self-contained", async () => {
    const report = await checkV2SkillIndependence(root);
    expect(report.skills.map((item) => item.skill)).toEqual(SKILL_NAMES);
    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
    expect(report.status).toBe("passed");
  });

  it("detects local dependencies, escaping scripts, imports, and machine paths", async () => {
    const fixtureRoot = isolatedFixture();
    try {
      const skillRoot = join(fixtureRoot, "skills", "text-to-html");
      fs.writeFileSync(join(skillRoot, "package.json"), `${JSON.stringify({
        name: "text-to-html",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node ../../outside.mjs" },
        dependencies: { local: "../local" }
      }, null, 2)}\n`);
      fs.writeFileSync(
        join(skillRoot, "scripts", "index.mjs"),
        "import value from '../../../outside.mjs';\nexport const path = '/Users/example/dev/runtime';\n"
      );
      const report = await checkV2SkillIndependence(fixtureRoot);
      const codes = report.findings.map((finding) => finding.code);
      expect(codes).toContain("E_SKILL_LOCAL_DEPENDENCY");
      expect(codes).toContain("E_SKILL_SCRIPT_ESCAPE");
      expect(codes).toContain("E_SKILL_IMPORT_ESCAPE");
      expect(codes).toContain("E_SKILL_ABSOLUTE_RUNTIME_PATH");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a required directory replaced by a file", async () => {
    const fixtureRoot = isolatedFixture();
    try {
      const testsPath = join(fixtureRoot, "skills", "image-to-pptx", "tests");
      fs.rmSync(testsPath, { recursive: true, force: true });
      fs.writeFileSync(testsPath, "not a directory\n");
      const report = await checkV2SkillIndependence(fixtureRoot);
      expect(report.findings).toContainEqual(expect.objectContaining({
        skill: "image-to-pptx",
        code: "E_SKILL_REQUIRED_PATH_TYPE",
        path: "tests"
      }));
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects protocol validator drift and traversal hidden inside a package script path", async () => {
    const fixtureRoot = isolatedFixture();
    try {
      const skillRoot = join(fixtureRoot, "skills", "html-to-pptx");
      fs.writeFileSync(
        join(skillRoot, "scripts", "validate-presentation-package.mjs"),
        "export const validatePresentationPackage = () => ({ status: 'passed' });\n"
      );
      const packageJson = JSON.parse(fs.readFileSync(join(skillRoot, "package.json"), "utf8"));
      packageJson.scripts.test = "node scripts/../../outside.mjs";
      fs.writeFileSync(join(skillRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

      const report = await checkV2SkillIndependence(fixtureRoot);
      expect(report.findings).toContainEqual(expect.objectContaining({
        skill: "html-to-pptx",
        code: "E_SKILL_PROTOCOL_VALIDATOR_DRIFT"
      }));
      expect(report.findings).toContainEqual(expect.objectContaining({
        skill: "html-to-pptx",
        code: "E_SKILL_SCRIPT_ESCAPE"
      }));
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
