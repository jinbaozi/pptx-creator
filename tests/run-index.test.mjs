import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as runIndex from "../scripts/lib/run-index.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";

const root = resolve(import.meta.dirname, "..");

describe("run index generation", () => {
  it("derives stable run IDs from canonical content without mutating input", () => {
    expect(typeof runIndex.contentDerivedRunId).toBe("function");
    const input = { z: [{ b: 2, a: 1 }, "tail"], a: { y: 2, x: 1 } };
    const before = structuredClone(input);
    const reordered = { a: { x: 1, y: 2 }, z: [{ a: 1, b: 2 }, "tail"] };

    const first = runIndex.contentDerivedRunId(input);
    expect(first).toMatch(/^run-[a-f0-9]{24}$/);
    expect(runIndex.contentDerivedRunId(reordered)).toBe(first);
    expect(runIndex.contentDerivedRunId({ ...reordered, z: [...reordered.z].reverse() })).not.toBe(first);
    expect(input).toEqual(before);
  });

  it("discovers common artifacts without retired direction-explorer contracts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-run-index-"));
    await writeFile(join(dir, "deck.manifest.json"), "{}");
    await writeFile(join(dir, "deck.plan.json"), "{}");
    await writeFile(join(dir, "semantic-slide-ir.json"), "{}");
    await writeFile(join(dir, "final.pptx"), "");
    await writeFile(join(dir, "consistency-report.json"), "{}");
    await mkdir(join(dir, "previews"), { recursive: true });
    await writeFile(join(dir, "previews", "slide-001.png"), "");

    const run = await runIndex.buildRunIndex(dir, {
      runId: "run-001",
      mode: "creative",
      input: { type: "text", summary: "sample" }
    });

    expect(run.artifacts.manifest).toBe("deck.manifest.json");
    expect(run.artifacts.deckPlan).toBe("deck.plan.json");
    expect(run.artifacts.semanticIr).toBe("semantic-slide-ir.json");
    expect(run.artifacts.consistencyReport).toBe("consistency-report.json");
    expect(run.artifacts.previews).toEqual(["previews/slide-001.png"]);
    expect(run.status).toBe("ready-for-review");
    expect(run).not.toHaveProperty("directions");

    const schema = JSON.parse(await readFile(join(root, "schemas/run.schema.json"), "utf8"));
    expect(validateJsonSchema(run, schema)).toEqual({ valid: true, errors: [] });
    expect(Object.keys(run.artifacts)).toEqual([
      "deckPlan", "semanticIr", "manifest", "pptx", "previews", "reviews",
      "consistencyReport", "sources", "assetRegistry"
    ]);
  });

  it("keeps non-creative run indexes schema-valid with nullable semantic IR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-direct-run-index-"));
    const run = await runIndex.buildRunIndex(dir, {
      runId: "run-direct",
      mode: "direct",
      input: { type: "text", summary: "direct manifest" }
    });
    const schema = JSON.parse(await readFile(join(root, "schemas/run.schema.json"), "utf8"));

    expect(run.artifacts.semanticIr).toBeNull();
    expect(run.artifacts.consistencyReport).toBeNull();
    expect(validateJsonSchema(run, schema)).toEqual({ valid: true, errors: [] });

    const withUnknownArtifact = structuredClone(run);
    withUnknownArtifact.artifacts.unexpected = "unexpected.json";
    expect(validateJsonSchema(withUnknownArtifact, schema).valid).toBe(false);
  });
});
