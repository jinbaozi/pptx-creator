import { describe, expect, it } from "vitest";
import {
  checkV2RepositoryGovernance,
  isAllowedV2TrackedPath,
  isIgnoredWorkspacePath
} from "../scripts/check-v2-repository-governance.mjs";

const requiredPaths = [
  "integration/protocol/presentation-package.schema.json",
  "integration/scripts/check-v2-repository-governance.mjs",
  "integration/scripts/check-v2-skill-independence.mjs",
  "integration/scripts/package-v2-skills.mjs",
  "integration/scripts/run-v2-composition-tests.mjs",
  "integration/scripts/validate-presentation-package.mjs",
  "integration/scripts/verify-v2-skills.mjs",
  "integration/scripts/lib/skill-package.mjs",
  "integration/tests/presentation-package-protocol.test.mjs",
  "integration/tests/v2-skill-independence.test.mjs",
  "integration/tests/v2-package-cli.test.mjs",
  "integration/tests/v2-skill-package.test.mjs",
  "integration/tests/v2-composition.test.mjs",
  "integration/tests/v2-repository-governance.test.mjs",
  "integration/vitest.config.mjs",
  "skills/text-to-html/SKILL.md",
  "skills/html-to-pptx/SKILL.md",
  "skills/image-to-pptx/SKILL.md"
];

describe("V2 repository governance", () => {
  it("allows only the V2 root surface", () => {
    expect(isAllowedV2TrackedPath("README.md")).toBe(true);
    expect(isAllowedV2TrackedPath(".github/workflows/ci.yml")).toBe(true);
    expect(isAllowedV2TrackedPath(".github/workflows/validate.yml")).toBe(false);
    expect(isAllowedV2TrackedPath("integration/scripts/package-v2-skills.mjs")).toBe(true);
    expect(isAllowedV2TrackedPath("skills/html-to-pptx/scripts/convert.mjs")).toBe(true);
    expect(isAllowedV2TrackedPath("SKILL.md")).toBe(false);
    expect(isAllowedV2TrackedPath("README.en.md")).toBe(false);
    expect(isAllowedV2TrackedPath("scripts/pptx.mjs")).toBe(false);
    expect(isAllowedV2TrackedPath("schemas/deck.schema.json")).toBe(false);
    expect(isAllowedV2TrackedPath("tests/legacy-runtime.test.mjs")).toBe(false);
    expect(isAllowedV2TrackedPath("skills/unapproved/SKILL.md")).toBe(false);
    expect(isIgnoredWorkspacePath("dist/v2/text-to-html.skill")).toBe(true);
  });

  it("fails closed for legacy root runtime paths and missing governance files", async () => {
    const report = await checkV2RepositoryGovernance("/fixture", {
      trackedFiles: [
        ".gitignore",
        "README.md",
        "package.json",
        "scripts/pptx.mjs",
        "schemas/deck.schema.json",
        "tests/legacy-runtime.test.mjs",
        "SKILL.md",
        "dist/v2/text-to-html.skill",
        "skills/text-to-html/SKILL.md"
      ]
    });

    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "E_V2_ROOT_SURFACE",
      path: "scripts/pptx.mjs"
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "E_V2_ROOT_SURFACE",
      path: "SKILL.md"
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "E_V2_REQUIRED_PATH",
      path: "integration/protocol/presentation-package.schema.json"
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "E_V2_REQUIRED_SKILL",
      path: "skills/html-to-pptx/SKILL.md"
    }));
  });

  it("accepts an exact tracked V2 surface without reading untracked workspace state", async () => {
    const report = await checkV2RepositoryGovernance("/fixture", {
      trackedFiles: [
        ".gitignore",
        "AGENTS.md",
        "LICENSE",
        "README.md",
        "package.json",
        "package-lock.json",
        ".github/workflows/ci.yml",
        ...requiredPaths
      ]
    });

    expect(report).toMatchObject({ status: "passed", findings: [] });
  });
});
