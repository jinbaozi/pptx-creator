import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lintReferences } from "../../scripts/lint-references.mjs";
import { skillRoot } from "../helpers.mjs";

function reference({ title = "Reference", purpose = "Explain the reference.", trigger = "Use for a focused task.", prereqs = "A complete input.", next = "Continue with the local workflow.", contract = "Keep package-local evidence.", body = "" } = {}) {
  return `# ${title}\n\n> **Purpose:** ${purpose}\n>\n> **Trigger:** ${trigger}\n>\n> **Prereqs:** ${prereqs}\n>\n> **Next:** ${next}\n>\n> **Contract:** ${contract}\n\n## Details\n\n${body}`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "text-to-html-reference-lint-"));
  const skill = join(root, "text-to-html");
  const references = join(skill, "references");
  await mkdir(references, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { skill, references };
}

test("bundled references have complete metadata and package-local links", async () => {
  const report = await lintReferences({ skillRoot });
  assert.equal(report.status, "passed", JSON.stringify(report.findings, null, 2));
  assert.ok(report.checkedFiles >= 10);
});

test("reports missing metadata, broken local links, and package-external paths", async (t) => {
  const { skill, references } = await fixture(t);
  await writeFile(join(references, "valid.md"), reference({
    next: "[Next](next.md)"
  }));
  await writeFile(join(references, "next.md"), reference({ title: "Next" }));
  await writeFile(join(references, "invalid.md"), reference({
    contract: "",
    body: "[Missing](missing.md)\n\n[Escape](../../outside.md)\n\n[Absolute](/tmp/outside.md)\n\n[File URL](file:///tmp/outside.md)"
  }));

  const report = await lintReferences({ skillRoot: skill, referenceDirectory: references });
  assert.equal(report.status, "failed");
  assert.ok(report.findings.some((finding) => finding.code === "E_REFERENCE_METADATA" && finding.file === "references/invalid.md"));
  assert.ok(report.findings.some((finding) => finding.code === "E_REFERENCE_LINK_MISSING" && finding.file === "references/invalid.md"));
  assert.equal(report.findings.filter((finding) => finding.code === "E_REFERENCE_PATH_EXTERNAL" && finding.file === "references/invalid.md").length, 3);
});
