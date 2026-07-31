import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintCatalogReferences } from "../scripts/lint-catalog-references.mjs";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("catalog Markdown references", () => {
  it("keeps packaged design-system and archetype references self-contained", async () => {
    const result = await lintCatalogReferences(skillRoot);

    expect(result.issues).toEqual([]);
    expect(result.documents).toContain("design-systems/business-neutral/DESIGN.md");
  });

  it("reports missing and escaping local reference targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "html-to-pptx-catalog-"));
    try {
      await mkdir(join(root, "design-systems", "business-neutral"), { recursive: true });
      await writeFile(
        join(root, "design-systems", "business-neutral", "DESIGN.md"),
        [
          "[missing](../_shared/missing.md)",
          "[escape](../../../outside.md)"
        ].join("\n")
      );

      const result = await lintCatalogReferences(root, ["design-systems"]);

      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "E_REFERENCE_MISSING",
          source: "design-systems/business-neutral/DESIGN.md",
          target: "../_shared/missing.md"
        }),
        expect.objectContaining({
          code: "E_REFERENCE_ESCAPE",
          source: "design-systems/business-neutral/DESIGN.md",
          target: "../../../outside.md"
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
