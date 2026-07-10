import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunIndex } from "../scripts/lib/run-index.mjs";

describe("run index generation", () => {
  it("discovers common artifacts without retired direction-explorer contracts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-run-index-"));
    await writeFile(join(dir, "deck.manifest.json"), "{}");
    await writeFile(join(dir, "deck.plan.json"), "{}");
    await writeFile(join(dir, "final.pptx"), "");
    await mkdir(join(dir, "previews"), { recursive: true });
    await writeFile(join(dir, "previews", "slide-001.png"), "");

    const run = await buildRunIndex(dir, {
      runId: "run-001",
      mode: "creative",
      input: { type: "text", summary: "sample" }
    });

    expect(run.artifacts.manifest).toBe("deck.manifest.json");
    expect(run.artifacts.deckPlan).toBe("deck.plan.json");
    expect(run.artifacts.previews).toEqual(["previews/slide-001.png"]);
    expect(run).not.toHaveProperty("directions");
  });
});
