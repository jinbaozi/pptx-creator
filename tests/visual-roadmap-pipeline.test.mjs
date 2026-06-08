import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunIndex } from "../scripts/lib/run-index.mjs";
import { validateAssetRegistry, validateSourceRegistry } from "../scripts/lib/registry.mjs";
import { reviewManifest } from "../scripts/lib/visual-critic.mjs";

describe("visual roadmap pipeline metadata", () => {
  it("can validate registries and build a run index for a generated package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-roadmap-pipeline-"));
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "deck.manifest.json"), "{}");
    await writeFile(join(dir, "sources.json"), JSON.stringify({ createdAt: "2026-06-08T10:00:00+08:00", items: [] }));
    await writeFile(join(dir, "assets", "asset-registry.json"), JSON.stringify({ assets: [] }));

    const sources = JSON.parse(await readFile(join(dir, "sources.json"), "utf8"));
    const assets = JSON.parse(await readFile(join(dir, "assets", "asset-registry.json"), "utf8"));
    expect(validateSourceRegistry(sources).valid).toBe(true);
    expect(validateAssetRegistry(assets).valid).toBe(true);

    const run = await buildRunIndex(dir, { runId: "run-001", mode: "creative", input: { type: "text", summary: "sample" } });
    expect(run.artifacts.sources).toBe("sources.json");
    expect(run.artifacts.assetRegistry).toBe("assets/asset-registry.json");
  });

  it("flags dense charts and incomplete diagrams", () => {
    const review = reviewManifest({
      deck: { size: { width: 13.333, height: 7.5 } },
      slides: [
        {
          id: "slide-001",
          elements: [
            { type: "text", id: "title", x: 0.5, y: 0.4, w: 5, h: 0.5, style: { fontSize: 18 } },
            {
              type: "chart",
              id: "chart-dense",
              kind: "bar",
              x: 1,
              y: 1,
              w: 1,
              h: 2,
              data: [{ label: "A", value: 1 }, { label: "B", value: 2 }, { label: "C", value: 3 }]
            },
            { type: "diagram", id: "diagram-empty", kind: "layeredArchitecture", x: 1, y: 3.2, w: 4, h: 2, layers: [] }
          ]
        }
      ]
    });
    const issueTypes = review.slides[0].issues.map((issue) => issue.type);
    expect(issueTypes).toContain("chart-label-density");
    expect(issueTypes).toContain("diagram-empty-layers");
  });
});
