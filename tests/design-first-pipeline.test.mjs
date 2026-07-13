import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import JSZip from "jszip";

describe("creative deck-plan pipeline", () => {
  it("preserves the creative plan when input and output directories are the same", () => {
    const dir = fs.mkdtempSync(path.join("/private/tmp", "pptx-design-first-in-place-"));
    fs.copyFileSync(path.join("examples/text-input/creative/deck.plan.json"), path.join(dir, "deck.plan.json"));

    execFileSync("node", ["scripts/pptx.mjs", "text", dir, dir], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });

    expect(fs.existsSync(path.join(dir, "deck.plan.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "final.pptx"))).toBe(true);
  }, 60000);

  it("compiles, renders, and writes quality evidence for a deck plan", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-first-pipeline-"));
    execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      "examples/text-input/creative/deck.plan.json",
      outputDir,
      "--design-system",
      "design-systems/product-roadshow/DESIGN.md",
      "--mode",
      "creative"
    ], { stdio: "pipe" });

    expect(fs.existsSync(path.join(outputDir, "deck.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "final.pptx"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "visual-review.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "quality-report.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "deck.plan.json"))).toBe(true);
    const review = JSON.parse(fs.readFileSync(path.join(outputDir, "visual-review.json"), "utf8"));
    expect(review.deckScore).toBeGreaterThan(0);
    const outputManifest = JSON.parse(fs.readFileSync(path.join(outputDir, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).toContain("deck.plan.json");
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "deck.manifest.json"), "utf8"));
    expect(manifest.designSystem).toMatchObject({ source: "design-system/DESIGN.md", name: "Product Roadshow" });
  });

  it("forwards a public built-in design selection and records portable provenance", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-public-design-"));
    execFileSync("node", [
      "scripts/pptx.mjs",
      "text",
      "examples/text-input/creative/deck.plan.json",
      outputDir,
      "--design-system",
      "dark-tech"
    ], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "deck.manifest.json"), "utf8"));
    expect(manifest.designSystem).toMatchObject({ source: "design-system/DESIGN.md", name: "Dark Tech" });
    expect(manifest.metadata.designIntent.designSystemSelection).toEqual({
      request: "dark-tech",
      resolvedSource: path.resolve("design-systems/dark-tech/DESIGN.md")
    });
    expect(manifest.slides[0].background.color).toBe("#020617");
  }, 60000);

  it("localizes visual assets, preserves provenance, and embeds media through the public CLI", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-public-assets-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-public-assets-output-"));
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    const assetFile = path.join(inputDir, "hero.png");
    fs.copyFileSync("examples/image-input/business-slide.png", assetFile);
    plan.assets.push({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      description: "A local evidence image",
      provenance: { origin: "project", sourceRef: "hero.png", license: "project-owned" },
      focalPoint: "top-right",
      cropPolicy: "cover",
      altText: "Business evidence slide",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    plan.slides[0].assetIds = ["asset-hero"];
    plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-hero" };
    plan.slides[0].compositionIntent.emphasis = "asset";
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "deck.manifest.json"), "utf8"));
    expect(manifest.assets[0]).toMatchObject({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      src: expect.stringMatching(/^assets\/asset-hero-[a-f0-9]{12}\.png$/),
      provenance: { origin: "project", sourceRef: "hero.png", license: "project-owned" }
    });
    expect(fs.existsSync(path.join(outputDir, manifest.assets[0].src))).toBe(true);
    expect(manifest.slides[0].elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", assetId: "asset-hero", src: manifest.assets[0].src, sizing: { type: "cover" } })
    ]));
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(outputDir, "final.pptx")));
    expect(Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/")).length).toBeGreaterThan(0);
    const slideXml = (await Promise.all(Object.entries(zip.files)
      .filter(([name]) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"))
      .map(([, entry]) => entry.async("string")))).join("\n");
    expect(slideXml).toContain('descr="Business evidence slide"');

    const firstLocalizedSource = manifest.assets[0].src;
    const userOwnedAsset = path.join(outputDir, "assets", "user-owned.png");
    fs.copyFileSync("examples/image-input/business-slide.png", userOwnedAsset);
    fs.copyFileSync("examples/image-input/replica-golden.png", assetFile);
    execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });
    const rerunManifest = JSON.parse(fs.readFileSync(path.join(outputDir, "deck.manifest.json"), "utf8"));
    expect(rerunManifest.assets[0].src).not.toBe(firstLocalizedSource);
    expect(fs.existsSync(path.join(outputDir, firstLocalizedSource))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, rerunManifest.assets[0].src))).toBe(true);
    expect(fs.existsSync(userOwnedAsset)).toBe(true);
  }, 120000);

  it("does not claim an in-place content-hash source as generated ownership", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-in-place-hash-asset-"));
    const bytes = fs.readFileSync("examples/image-input/business-slide.png");
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const relativeSource = path.posix.join("assets", `asset-hero-${digest}.png`);
    const sourcePath = path.join(dir, relativeSource);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, bytes);
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    plan.assets.push({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      description: "An in-place content-hash source",
      provenance: { origin: "user", sourceRef: relativeSource, license: "user-owned" },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "User-owned evidence image",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    plan.slides[0].assetIds = ["asset-hero"];
    plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-hero" };
    plan.slides[0].compositionIntent.emphasis = "asset";
    const planPath = path.join(dir, "deck.plan.json");
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    execFileSync("node", ["scripts/pptx.mjs", "text", dir, dir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });

    const registry = JSON.parse(fs.readFileSync(path.join(dir, ".pptx-generated-assets.json"), "utf8"));
    expect(registry).toMatchObject({ owner: "creative-deck-plan-assets", files: [] });
    expect(fs.existsSync(sourcePath)).toBe(true);
  }, 60000);

  it("rolls back earlier localized assets when a later content-hash target collides", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-transaction-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-transaction-output-"));
    const firstSource = path.join(inputDir, "first.png");
    const secondSource = path.join(inputDir, "second.png");
    fs.copyFileSync("examples/image-input/business-slide.png", firstSource);
    fs.copyFileSync("examples/image-input/replica-golden.png", secondSource);
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    plan.assets.push(
      {
        id: "asset-first",
        kind: "photo",
        role: "first evidence",
        description: "The first local evidence image",
        provenance: { origin: "project", sourceRef: "first.png", license: "project-owned" },
        focalPoint: "center",
        cropPolicy: "cover",
        altText: "First evidence image",
        fallback: { strategy: "placeholder", description: "Use a native placeholder" }
      },
      {
        id: "asset-second",
        kind: "photo",
        role: "second evidence",
        description: "The second local evidence image",
        provenance: { origin: "project", sourceRef: "second.png", license: "project-owned" },
        focalPoint: "center",
        cropPolicy: "cover",
        altText: "Second evidence image",
        fallback: { strategy: "placeholder", description: "Use a native placeholder" }
      }
    );
    plan.slides[0].assetIds = ["asset-first", "asset-second"];
    plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-first" };
    plan.slides[0].compositionIntent.emphasis = "asset";
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const firstBytes = fs.readFileSync(firstSource);
    const secondBytes = fs.readFileSync(secondSource);
    const firstDigest = createHash("sha256").update(firstBytes).digest("hex").slice(0, 12);
    const secondDigest = createHash("sha256").update(secondBytes).digest("hex").slice(0, 12);
    const firstTarget = path.join(outputDir, "assets", `asset-first-${firstDigest}.png`);
    const secondTarget = path.join(outputDir, "assets", `asset-second-${secondDigest}.png`);
    const userBytes = Buffer.from("pre-existing user-owned collision target", "utf8");
    fs.mkdirSync(path.dirname(secondTarget), { recursive: true });
    fs.writeFileSync(secondTarget, userBytes);

    expect(() => execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    })).toThrow();

    expect(fs.existsSync(firstTarget), "first generated target").toBe(false);
    expect(fs.readFileSync(secondTarget).equals(userBytes), "pre-existing collision target bytes").toBe(true);
    expect(fs.existsSync(path.join(outputDir, ".pptx-generated-assets.json")), "ownership registry").toBe(false);
  }, 60000);

  it("rolls back created targets when a later filesystem write fails", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-write-failure-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-write-failure-output-"));
    const firstSource = path.join(inputDir, "first.png");
    const secondSource = path.join(inputDir, "second.png");
    fs.copyFileSync("examples/image-input/business-slide.png", firstSource);
    fs.copyFileSync("examples/image-input/replica-golden.png", secondSource);
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    const failingAssetId = `asset-${"x".repeat(300)}`;
    plan.assets.push(
      {
        id: "asset-first",
        kind: "photo",
        role: "first evidence",
        description: "The first local evidence image",
        provenance: { origin: "project", sourceRef: "first.png", license: "project-owned" },
        focalPoint: "center",
        cropPolicy: "cover",
        altText: "First evidence image",
        fallback: { strategy: "placeholder", description: "Use a native placeholder" }
      },
      {
        id: failingAssetId,
        kind: "photo",
        role: "write failure evidence",
        description: "A valid asset whose generated basename exceeds filesystem limits",
        provenance: { origin: "project", sourceRef: "second.png", license: "project-owned" },
        focalPoint: "center",
        cropPolicy: "cover",
        altText: "Write failure evidence image",
        fallback: { strategy: "placeholder", description: "Use a native placeholder" }
      }
    );
    plan.slides[0].assetIds = ["asset-first", failingAssetId];
    plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-first" };
    plan.slides[0].compositionIntent.emphasis = "asset";
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const firstBytes = fs.readFileSync(firstSource);
    const firstDigest = createHash("sha256").update(firstBytes).digest("hex").slice(0, 12);
    const firstTarget = path.join(outputDir, "assets", `asset-first-${firstDigest}.png`);

    expect(() => execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    })).toThrow();

    expect(fs.existsSync(firstTarget), "first generated target after later write failure").toBe(false);
    expect(fs.existsSync(path.join(outputDir, ".pptx-generated-assets.json")), "ownership registry").toBe(false);
  }, 60000);

  it("fails closed when the creative assets root is a symlink", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-symlink-assets-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-symlink-assets-output-"));
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-symlink-assets-external-"));
    const sourcePath = path.join(inputDir, "hero.png");
    const sourceBytes = fs.readFileSync("examples/image-input/business-slide.png");
    fs.writeFileSync(sourcePath, sourceBytes);
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    plan.assets.push({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      description: "A normal local evidence image",
      provenance: { origin: "project", sourceRef: "hero.png", license: "project-owned" },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Local evidence image",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    plan.slides[0].assetIds = ["asset-hero"];
    plan.slides[0].attentionTarget = { kind: "asset", ref: "asset-hero" };
    plan.slides[0].compositionIntent.emphasis = "asset";
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const externalBytes = Buffer.from("external hash-valid user asset", "utf8");
    const externalDigest = createHash("sha256").update(externalBytes).digest("hex").slice(0, 12);
    const externalName = `asset-external-${externalDigest}.png`;
    const externalOwned = path.join(externalDir, externalName);
    fs.writeFileSync(externalOwned, externalBytes);
    fs.symlinkSync(externalDir, path.join(outputDir, "assets"), "dir");
    fs.writeFileSync(path.join(outputDir, ".pptx-generated-assets.json"), `${JSON.stringify({
      version: "0.1.0",
      owner: "creative-deck-plan-assets",
      files: [path.posix.join("assets", externalName)]
    }, null, 2)}\n`, "utf8");
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex").slice(0, 12);
    const externalLocalizedTarget = path.join(externalDir, `asset-hero-${sourceDigest}.png`);

    expect(() => execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    })).toThrow();

    expect(fs.existsSync(externalOwned), "external hash-valid user asset").toBe(true);
    expect(fs.existsSync(externalLocalizedTarget), "external localized target").toBe(false);
  }, 60000);

  it("ignores unsafe and non-file entries in the creative asset ownership registry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-unsafe-asset-registry-"));
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    plan.assets.push({
      id: "asset-remote",
      kind: "photo",
      role: "remote evidence",
      description: "An intentionally invalid remote image",
      provenance: { origin: "web", sourceRef: "https://example.com/remote.png" },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Remote evidence image",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    plan.slides[0].assetIds = ["asset-remote"];
    fs.writeFileSync(path.join(dir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const assetsDir = path.join(dir, "assets");
    const nestedDir = path.join(assetsDir, "nested");
    const userOwned = path.join(assetsDir, "user-owned.png");
    const nestedOwned = path.join(nestedDir, "nested-owned.png");
    const absoluteOwned = path.join(assetsDir, "absolute-owned.png");
    const forgedHashOwned = path.join(assetsDir, "asset-forged-000000000000.png");
    const outsideName = `${path.basename(dir)}-outside-owned.png`;
    const outsideOwned = path.resolve(dir, "..", outsideName);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(userOwned, "user-owned", "utf8");
    fs.writeFileSync(nestedOwned, "nested-owned", "utf8");
    fs.writeFileSync(absoluteOwned, "absolute-owned", "utf8");
    fs.writeFileSync(forgedHashOwned, "forged-hash-owned", "utf8");
    fs.writeFileSync(outsideOwned, "outside-owned", "utf8");
    fs.writeFileSync(path.join(dir, ".pptx-generated-assets.json"), `${JSON.stringify({
      version: "0.1.0",
      owner: "creative-deck-plan-assets",
      files: [
        "assets",
        "assets/user-owned.png",
        "assets/asset-forged-000000000000.png",
        `../${outsideName}`,
        "assets/nested/nested-owned.png",
        absoluteOwned
      ]
    }, null, 2)}\n`, "utf8");

    expect(() => execFileSync("node", ["scripts/pptx.mjs", "text", dir, dir], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    })).toThrow();

    expect(fs.existsSync(userOwned), "direct user-owned asset").toBe(true);
    expect(fs.existsSync(nestedOwned), "nested user-owned asset").toBe(true);
    expect(fs.existsSync(absoluteOwned), "absolute-path user-owned asset").toBe(true);
    expect(fs.existsSync(forgedHashOwned), "hash-mismatched user-owned asset").toBe(true);
    expect(fs.existsSync(outsideOwned), "out-of-bounds user-owned asset").toBe(true);
    expect(fs.existsSync(path.join(dir, ".pptx-generated-assets.json")), "stale registry").toBe(false);
    fs.rmSync(outsideOwned, { force: true });
  }, 60000);

  it.each([
    ["remote", "https://example.com/hero.png"],
    ["missing", "missing/hero.png"]
  ])("invalidates stale public output for a %s asset source while preserving in-place inputs", (_label, sourceRef) => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-invalid-assets-in-place-"));
    const outputDir = inputDir;
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    plan.assets.push({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      description: "An invalid evidence image",
      provenance: { origin: "web", sourceRef },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Evidence image",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    plan.slides[0].assetIds = ["asset-hero"];
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fs.copyFileSync("design-systems/business-neutral/DESIGN.md", path.join(inputDir, "DESIGN.md"));
    fs.mkdirSync(path.join(inputDir, "assets"), { recursive: true });
    fs.copyFileSync("examples/image-input/business-slide.png", path.join(inputDir, "assets", "user-source.png"));
    const staleOwnedBytes = fs.readFileSync("examples/image-input/business-slide.png");
    const staleOwnedDigest = createHash("sha256").update(staleOwnedBytes).digest("hex").slice(0, 12);
    const staleOwnedAsset = path.join(inputDir, "assets", `asset-old-${staleOwnedDigest}.png`);
    fs.writeFileSync(staleOwnedAsset, staleOwnedBytes);
    fs.writeFileSync(path.join(inputDir, ".pptx-generated-assets.json"), `${JSON.stringify({
      version: "0.1.0",
      owner: "creative-deck-plan-assets",
      files: [path.posix.join("assets", path.basename(staleOwnedAsset))]
    }, null, 2)}\n`, "utf8");

    const staleFiles = [
      "final.pptx", "output-manifest.json", "deck.manifest.json", "editable-report.md", "qa-report.md",
      "compatibility-report.md", "consistency-report.json", "consistency-report.md", "layout-safety-report.json",
      "text-fit-report.json", "quality-report.json", "quality-report.md", "creative-proof.json", "visual-review.json",
      "run.json", "pipeline-blocked.json"
    ];
    for (const name of staleFiles) fs.writeFileSync(path.join(outputDir, name), "stale-success", "utf8");
    for (const directory of ["preview", "creative-proof"]) {
      fs.mkdirSync(path.join(outputDir, directory), { recursive: true });
      fs.writeFileSync(path.join(outputDir, directory, "stale.txt"), "stale-success", "utf8");
    }

    expect(() => execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    })).toThrow();
    for (const name of staleFiles) expect(fs.existsSync(path.join(outputDir, name)), name).toBe(false);
    for (const directory of ["preview", "creative-proof"]) expect(fs.existsSync(path.join(outputDir, directory)), directory).toBe(false);
    expect(fs.existsSync(staleOwnedAsset), "stale owned asset").toBe(false);
    expect(fs.existsSync(path.join(inputDir, ".pptx-generated-assets.json")), "stale ownership registry").toBe(false);
    for (const preserved of ["deck.plan.json", "DESIGN.md", path.join("assets", "user-source.png")]) {
      expect(fs.existsSync(path.join(inputDir, preserved)), preserved).toBe(true);
    }
  }, 60000);
});
