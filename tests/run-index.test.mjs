import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunIndex } from "../scripts/lib/run-index.mjs";

describe("run index generation", () => {
  it("discovers common artifacts and approved directions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-run-index-"));
    await writeFile(join(dir, "deck.manifest.json"), "{}");
    await writeFile(join(dir, "final.pptx"), "");
    await mkdir(join(dir, "previews"), { recursive: true });
    await writeFile(join(dir, "previews", "slide-001.png"), "");
    await mkdir(join(dir, "directions", "direction-001"), { recursive: true });
    await writeFile(join(dir, "directions", "direction-001", "scorecard.json"), JSON.stringify({ directionId: "direction-001", total: 88, recommendation: "approve" }));

    const run = await buildRunIndex(dir, {
      runId: "run-001",
      mode: "creative",
      input: { type: "text", summary: "sample" }
    });

    expect(run.artifacts.manifest).toBe("deck.manifest.json");
    expect(run.artifacts.previews).toEqual(["previews/slide-001.png"]);
    expect(run.directions[0]).toMatchObject({ id: "direction-001", score: 88, status: "approved" });
  });
});
