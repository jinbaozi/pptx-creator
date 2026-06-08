import { describe, expect, it } from "vitest";
import { summarizeRegistry, validateAssetRegistry, validateSourceRegistry } from "../scripts/lib/registry.mjs";

describe("registry validation", () => {
  it("accepts primary fact sources and user-provided embedded assets", () => {
    const sources = {
      createdAt: "2026-06-08T10:00:00+08:00",
      items: [
        {
          id: "source-001",
          kind: "fact-source",
          title: "GNU Compiler Collection documentation",
          url: "https://gcc.gnu.org/onlinedocs/",
          accessedAt: "2026-06-08T10:00:00+08:00",
          usedFor: ["terminology"],
          trustLevel: "primary",
          notes: "General compiler terminology."
        }
      ]
    };
    const assets = {
      assets: [
        {
          id: "asset-001",
          kind: "image",
          localPath: "assets/reference.png",
          usedInSlides: ["slide-001"],
          usage: "replica-source",
          finalDeckUse: "embedded",
          license: { status: "user-provided", label: "User provided" }
        }
      ]
    };
    expect(validateSourceRegistry(sources).issues).toEqual([]);
    expect(validateAssetRegistry(assets).issues).toEqual([]);
  });

  it("accepts existing fixture source kind names", () => {
    const result = validateSourceRegistry({
      createdAt: "2026-06-08T10:00:00+08:00",
      items: [{ id: "source-001", kind: "fact", title: "Reference", url: "https://example.com" }]
    });
    expect(result.valid).toBe(true);
  });

  it("blocks embedded online assets with unclear license", () => {
    const assets = {
      assets: [
        {
          id: "asset-002",
          kind: "image",
          sourceUrl: "https://example.com/image.png",
          localPath: "assets/image.png",
          usedInSlides: ["slide-002"],
          usage: "embedded-asset",
          finalDeckUse: "embedded",
          license: { status: "unknown", label: "Unknown" }
        }
      ]
    };
    expect(validateAssetRegistry(assets).issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "asset-license-blocked" })
    );
  });

  it("summarizes source and asset counts", () => {
    const summary = summarizeRegistry({
      sources: { items: [{ id: "source-001" }] },
      assets: { assets: [{ id: "asset-001", finalDeckUse: "embedded" }] }
    });
    expect(summary).toEqual({ sourceCount: 1, assetCount: 1, embeddedAssetCount: 1 });
  });
});
