import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAssetLedger, buildTokenLedger } from "../scripts/lib/creative-proof-ledgers.mjs";
import { canonicalTokenSnapshotHash } from "../scripts/lib/semantic-slide-ir.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("Creative Proof 0.2 token ledger", () => {
  it("cryptographically binds the supplied design tokens without pretending style reverse-lineage", () => {
    const tokens = { colors: { primary: "#123456" }, typography: { title: { fontFamily: "Aptos", fontSize: 30 } } };
    const ir = {
      designSystem: { name: "Test", source: "design-system/DESIGN.md", tokenSnapshotHash: canonicalTokenSnapshotHash(tokens) },
      designIntent: { locks: { protectedTokens: ["colors.primary"] } }
    };
    const manifest = { designSystem: { name: "Test", source: "design-system/DESIGN.md" } };
    expect(buildTokenLedger({ ir, design: { name: "Test", source: "design-system/DESIGN.md", tokens }, manifest })).toEqual({
      version: "0.1.0",
      status: "passed",
      expectedSnapshotHash: canonicalTokenSnapshotHash(tokens),
      actualSnapshotHash: canonicalTokenSnapshotHash(tokens),
      designSystem: { name: "Test", source: "design-system/DESIGN.md" },
      protectedTokens: [{ name: "colors.primary", status: "snapshot-bound" }],
      drift: [],
      lineage: "snapshot-only"
    });
  });

  it("fails on missing input, token hash drift, or design identity drift", () => {
    const tokens = { colors: { primary: "#123456" } };
    const expected = canonicalTokenSnapshotHash(tokens);
    expect(buildTokenLedger({ ir: null, design: null, manifest: {} }).status).toBe("unavailable");
    const drifted = buildTokenLedger({
      ir: { designSystem: { name: "Expected", source: "design-system/DESIGN.md", tokenSnapshotHash: expected }, designIntent: { locks: { protectedTokens: [] } } },
      design: { name: "Actual", source: "other/DESIGN.md", tokens: { colors: { primary: "#abcdef" } } },
      manifest: { designSystem: { name: "Actual", source: "other/DESIGN.md" } }
    });
    expect(drifted.status).toBe("failed");
    expect(drifted.drift.map((entry) => entry.field)).toEqual(expect.arrayContaining(["tokenSnapshotHash", "designSystem.name", "designSystem.source"]));
  });
});

describe("Creative Proof 0.2 asset ledger", () => {
  it("binds registry, local bytes, usage, provenance, and accessibility", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-proof-assets-"));
    await mkdir(join(outputDir, "assets"));
    const bytes = Buffer.from("asset bytes");
    await writeFile(join(outputDir, "assets", "hero.png"), bytes);
    const provenance = { origin: "project", sourceRef: "source/hero.png", rights: { status: "allowed", license: "project-owned" } };
    const irAsset = { id: "hero", kind: "photo", role: "hero", description: "Hero", provenance, focalPoint: "center", cropPolicy: "contain", altText: "Hero image", fallback: { strategy: "placeholder", description: "Fallback" }, src: "assets/hero.png" };
    const ir = { assets: [irAsset], slides: [{ id: "slide-1", assetRefs: ["hero"] }] };
    const registry = { version: "0.2.0", assets: [{
      id: "hero", kind: "photo", source: { origin: "project", sourceRef: "source/hero.png" }, localPath: "assets/hero.png",
      contentHash: digest(bytes), rights: provenance.rights, altText: "Hero image", role: "hero", focalPoint: "center",
      cropPolicy: "contain", fallback: { strategy: "placeholder", description: "Fallback" }, usedInSlides: ["slide-1"], finalDeckUse: "embedded"
    }] };
    const manifest = {
      assets: [{ ...irAsset, origin: "project", sourceRef: "source/hero.png", rights: provenance.rights }],
      slides: [{ id: "slide-1", elements: [{ type: "image", id: "hero-image", assetId: "hero", src: "assets/hero.png", altText: "Hero image", focalPoint: "center", cropPolicy: "contain" }] }]
    };
    const ledger = await buildAssetLedger({ ir, registry, manifest, outputDir });
    expect(ledger.status).toBe("passed");
    expect(ledger.drift).toEqual([]);
    expect(ledger.assets[0]).toMatchObject({ id: "hero", expectedHash: digest(bytes), actualHash: digest(bytes), irUsage: ["slide-1"], manifestUsage: ["slide-1"] });
  });

  it("fails remote runtime paths, unknown embedded rights, byte drift, and usage/accessibility loss", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-proof-assets-drift-"));
    await mkdir(join(outputDir, "assets"));
    await writeFile(join(outputDir, "assets", "hero.png"), "actual bytes");
    const ir = {
      assets: [{ id: "hero", kind: "photo", role: "hero", provenance: { origin: "web", sourceRef: "hero", rights: { status: "unknown", license: "unknown" } }, focalPoint: "center", cropPolicy: "contain", altText: "Expected alt", fallback: { strategy: "placeholder", description: "Fallback" }, src: "assets/hero.png" }],
      slides: [{ id: "slide-1", assetRefs: ["hero"] }]
    };
    const registry = { version: "0.2.0", assets: [{ id: "hero", kind: "photo", source: { origin: "web", sourceRef: "hero" }, localPath: "https://example.com/hero.png", contentHash: digest(Buffer.from("expected")), rights: { status: "unknown", license: "unknown" }, altText: "Expected alt", role: "hero", focalPoint: "center", cropPolicy: "contain", fallback: { strategy: "placeholder", description: "Fallback" }, usedInSlides: ["slide-1"], finalDeckUse: "embedded" }] };
    const manifest = { assets: [], slides: [{ id: "slide-2", elements: [] }] };
    const ledger = await buildAssetLedger({ ir, registry, manifest, outputDir });
    expect(ledger.status).toBe("failed");
    expect(ledger.drift.map((entry) => entry.field)).toEqual(expect.arrayContaining(["localPath", "rights.status", "contentHash", "usage", "manifest.asset"]));
  });
});
