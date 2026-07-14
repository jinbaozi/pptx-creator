import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import * as runIndex from "../scripts/lib/run-index.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import {
  buildCanonicalAssetRegistry,
  createCreativeAuthoringTransaction
} from "../scripts/run-design-first-pipeline.mjs";

function writeEmptyFinalManifest(outputDir) {
  fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), "{\"assets\":[],\"slides\":[]}\n", "utf8");
}

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
    const secondOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-first-pipeline-repeat-"));
    const args = [
      "scripts/run-design-first-pipeline.mjs",
      "examples/text-input/creative/deck.plan.json",
      outputDir,
      "--design-system",
      "design-systems/product-roadshow/DESIGN.md",
      "--mode",
      "creative"
    ];
    execFileSync("node", args, { stdio: "pipe" });

    expect(fs.existsSync(path.join(outputDir, "deck.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "semantic-slide-ir.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "assets", "asset-registry.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "final.pptx"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "visual-review.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "quality-report.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "deck.plan.json"))).toBe(true);
    const review = JSON.parse(fs.readFileSync(path.join(outputDir, "visual-review.json"), "utf8"));
    expect(review.deckScore).toBeGreaterThan(0);
    const outputManifest = JSON.parse(fs.readFileSync(path.join(outputDir, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).toEqual(expect.arrayContaining([
      "deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"
    ]));
    const assetRegistry = JSON.parse(fs.readFileSync(path.join(outputDir, "assets", "asset-registry.json"), "utf8"));
    expect(assetRegistry).toEqual({ version: "0.2.0", assets: [] });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "deck.manifest.json"), "utf8"));
    expect(manifest.designSystem).toMatchObject({ source: "design-system/DESIGN.md", name: "Product Roadshow" });

    const irText = fs.readFileSync(path.join(outputDir, "semantic-slide-ir.json"), "utf8");
    const ir = JSON.parse(irText);
    expect(irText).toBe(`${JSON.stringify(ir, null, 2)}\n`);
    const irSchema = JSON.parse(fs.readFileSync("schemas/semantic-slide-ir.schema.json", "utf8"));
    expect(validateJsonSchema(ir, irSchema)).toEqual({ valid: true, errors: [] });

    const run = JSON.parse(fs.readFileSync(path.join(outputDir, "run.json"), "utf8"));
    const runSchema = JSON.parse(fs.readFileSync("schemas/run.schema.json", "utf8"));
    expect(run).toMatchObject({
      runId: runIndex.contentDerivedRunId(ir),
      mode: "creative",
      status: "ready-for-review",
      input: { type: "text", summary: "From Brief to Editable Deck" },
      artifacts: {
        deckPlan: "deck.plan.json",
        semanticIr: "semantic-slide-ir.json",
        assetRegistry: "assets/asset-registry.json",
        manifest: "deck.manifest.json",
        pptx: "final.pptx",
        consistencyReport: "consistency-report.json"
      }
    });
    expect(validateJsonSchema(run, runSchema)).toEqual({ valid: true, errors: [] });
    for (const artifact of Object.values(run.artifacts).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean)) {
      expect(path.isAbsolute(artifact), artifact).toBe(false);
      expect(artifact, artifact).not.toContain("\\");
    }

    const repeatArgs = [...args];
    repeatArgs[2] = secondOutputDir;
    execFileSync("node", repeatArgs, { stdio: "pipe" });
    const repeatedRun = JSON.parse(fs.readFileSync(path.join(secondOutputDir, "run.json"), "utf8"));
    expect(repeatedRun.runId).toBe(run.runId);
    expect(fs.readFileSync(path.join(secondOutputDir, "semantic-slide-ir.json"), "utf8")).toBe(irText);
  }, 120000);

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
      provenance: {
        origin: "project",
        sourceRef: "hero.png",
        sourceUrl: "https://example.com/project/hero",
        rights: { status: "allowed", license: "project-owned" }
      },
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
    const semanticIr = JSON.parse(fs.readFileSync(path.join(outputDir, "semantic-slide-ir.json"), "utf8"));
    expect(manifest.assets[0]).toMatchObject({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      src: expect.stringMatching(/^assets\/asset-hero-[a-f0-9]{12}\.png$/),
      provenance: {
        origin: "project",
        sourceRef: "hero.png",
        sourceUrl: "https://example.com/project/hero",
        rights: { status: "allowed", license: "project-owned" }
      }
    });
    expect(fs.existsSync(path.join(outputDir, manifest.assets[0].src))).toBe(true);
    expect(semanticIr.assets[0].src).toBe(manifest.assets[0].src);
    const publicRegistry = JSON.parse(fs.readFileSync(path.join(outputDir, "assets", "asset-registry.json"), "utf8"));
    const localizedBytes = fs.readFileSync(path.join(outputDir, manifest.assets[0].src));
    expect(publicRegistry).toEqual({
      version: "0.2.0",
      assets: [expect.objectContaining({
        id: "asset-hero",
        kind: "photo",
        source: {
          origin: "project",
          sourceRef: "hero.png",
          sourceUrl: "https://example.com/project/hero"
        },
        localPath: manifest.assets[0].src,
        contentHash: `sha256:${createHash("sha256").update(localizedBytes).digest("hex")}`,
        rights: { status: "allowed", license: "project-owned" },
        altText: "Business evidence slide",
        role: "hero evidence",
        focalPoint: "top-right",
        cropPolicy: "cover",
        fallback: { strategy: "placeholder", description: "Use a native placeholder" },
        usedInSlides: ["slide-cover"],
        finalDeckUse: "embedded"
      })]
    });
    const publicRun = JSON.parse(fs.readFileSync(path.join(outputDir, "run.json"), "utf8"));
    expect(publicRun.artifacts.assetRegistry).toBe("assets/asset-registry.json");
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

  it("preserves generated asset evidence through plan, IR, manifest, registry, and PPTX", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-generated-assets-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-generated-assets-output-"));
    fs.copyFileSync("examples/image-input/business-slide.png", path.join(inputDir, "generated-hero.png"));
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    const asset = {
      id: "asset-generated-hero",
      kind: "illustration",
      role: "generated hero evidence",
      description: "A generated editorial illustration",
      provenance: {
        origin: "generated",
        sourceRef: "generated-hero.png",
        sourceUrl: "https://provider.example/generations/job-42",
        rights: { status: "allowed", license: "Provider output terms" },
        generation: { model: "image-model-2", promptSummary: "Editorial infrastructure illustration" }
      },
      focalPoint: "bottom-left",
      cropPolicy: "smart-crop",
      altText: "Generated editorial illustration of a presentation workflow",
      fallback: { strategy: "native-diagram", description: "Use a native workflow diagram" }
    };
    plan.assets.push(asset);
    plan.slides[0].assetIds = [asset.id];
    plan.slides[0].attentionTarget = { kind: "asset", ref: asset.id };
    plan.slides[0].compositionIntent.emphasis = "asset";
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir, "--design-system", "business-neutral"], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });

    const ir = JSON.parse(fs.readFileSync(path.join(outputDir, "semantic-slide-ir.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "deck.manifest.json"), "utf8"));
    const registry = JSON.parse(fs.readFileSync(path.join(outputDir, "assets", "asset-registry.json"), "utf8"));
    for (const carried of [ir.assets[0], manifest.assets[0]]) {
      expect(carried).toMatchObject({
        role: asset.role,
        focalPoint: asset.focalPoint,
        cropPolicy: asset.cropPolicy,
        altText: asset.altText,
        fallback: asset.fallback,
        provenance: asset.provenance
      });
    }
    expect(registry.assets[0]).toMatchObject({
      source: {
        origin: "generated",
        sourceRef: "generated-hero.png",
        sourceUrl: asset.provenance.sourceUrl
      },
      rights: asset.provenance.rights,
      altText: asset.altText,
      role: asset.role,
      focalPoint: asset.focalPoint,
      cropPolicy: asset.cropPolicy,
      fallback: asset.fallback,
      generation: asset.provenance.generation,
      finalDeckUse: "embedded"
    });
    const image = manifest.slides[0].elements.find((element) => element.assetId === asset.id);
    expect(image).toMatchObject({ alt: asset.altText, altText: asset.altText, focalPoint: asset.focalPoint, cropPolicy: asset.cropPolicy });
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(outputDir, "final.pptx")));
    const slideXml = (await zip.file("ppt/slides/slide1.xml").async("string"));
    expect(slideXml).toContain(`descr="${asset.altText}"`);
  }, 60000);

  it("rejects a declared content hash that does not match localized bytes", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-hash-mismatch-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-hash-mismatch-output-"));
    fs.copyFileSync("examples/image-input/business-slide.png", path.join(inputDir, "hero.png"));
    const plan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
    plan.assets.push({
      id: "asset-hero",
      kind: "photo",
      role: "hero evidence",
      description: "A hash-mismatched evidence image",
      provenance: {
        origin: "project",
        sourceRef: "hero.png",
        rights: { status: "allowed", license: "project-owned" },
        contentHash: `sha256:${"0".repeat(64)}`
      },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Evidence image",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    });
    fs.writeFileSync(path.join(inputDir, "deck.plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    expect(() => execFileSync("node", ["scripts/pptx.mjs", "text", inputDir, outputDir], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    })).toThrow(/contentHash|localized bytes/i);
    expect(fs.existsSync(path.join(outputDir, "assets", "asset-registry.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, ".pptx-generated-assets.json"))).toBe(false);
  }, 60000);

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
      provenance: {
        origin: "user",
        sourceRef: relativeSource,
        rights: { status: "user-provided", license: "user-owned" }
      },
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
        provenance: { origin: "project", sourceRef: "first.png", rights: { status: "allowed", license: "project-owned" } },
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
        provenance: { origin: "project", sourceRef: "second.png", rights: { status: "allowed", license: "project-owned" } },
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
        provenance: { origin: "project", sourceRef: "first.png", rights: { status: "allowed", license: "project-owned" } },
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
        provenance: { origin: "project", sourceRef: "second.png", rights: { status: "allowed", license: "project-owned" } },
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
      provenance: { origin: "project", sourceRef: "hero.png", rights: { status: "allowed", license: "project-owned" } },
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
      provenance: { origin: "web", sourceRef: "https://example.com/remote.png", rights: { status: "unknown", license: "Unknown" } },
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
    ["data URI", "data:image/png;base64,AAAA"],
    ["file URI", "file:///tmp/hero.png"],
    ["Windows drive", "C:/assets/hero.png"],
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
      provenance: { origin: "web", sourceRef, rights: { status: "unknown", license: "Unknown" } },
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
    fs.writeFileSync(path.join(inputDir, "assets", "asset-registry.json"), "stale-public-registry", "utf8");
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
      "semantic-slide-ir.json", "run.json", "pipeline-blocked.json"
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
    expect(fs.existsSync(path.join(outputDir, "assets", "asset-registry.json")), "stale public registry").toBe(false);
    expect(fs.existsSync(staleOwnedAsset), "stale owned asset").toBe(false);
    expect(fs.existsSync(path.join(inputDir, ".pptx-generated-assets.json")), "stale ownership registry").toBe(false);
    for (const preserved of ["deck.plan.json", "DESIGN.md", path.join("assets", "user-source.png")]) {
      expect(fs.existsSync(path.join(inputDir, preserved)), preserved).toBe(true);
    }
  }, 60000);

  it("derives final-deck use only from same-slide native manifest evidence", () => {
    const bytes = Buffer.from("canonical asset bytes", "utf8");
    const baseAsset = (id, kind) => ({
      id,
      kind,
      role: `${kind} evidence`,
      description: `${kind} source`,
      provenance: { origin: "project", sourceRef: `${id}.bin`, rights: { status: "allowed", license: "project-owned" } },
      focalPoint: "center",
      cropPolicy: "contain",
      altText: `${kind} source`,
      fallback: { strategy: "placeholder", description: "Use native fallback" }
    });
    const assets = [
      baseAsset("asset-photo", "photo"),
      baseAsset("asset-chart", "chart-data"),
      baseAsset("asset-diagram", "diagram-source"),
      baseAsset("asset-unused", "photo")
    ];
    const sourceById = {
      "asset-photo": "assets/asset-photo.png",
      "asset-chart": "assets/asset-chart.json",
      "asset-diagram": "assets/asset-diagram.json",
      "asset-unused": "assets/asset-unused.png"
    };
    const localizedAssets = {
      records: assets.map((asset) => ({ asset, relativePath: sourceById[asset.id], bytes }))
    };
    const plan = {
      assets,
      slides: [
        { id: "slide-01", assetIds: ["asset-photo", "asset-chart"] },
        { id: "slide-02", assetIds: ["asset-diagram"] }
      ]
    };
    const manifest = {
      assets: assets.map((asset) => ({
        ...structuredClone(asset),
        src: sourceById[asset.id],
        ...structuredClone(asset.provenance)
      })),
      slides: [
        { id: "slide-01", elements: [
          {
            type: "image",
            assetId: "asset-photo",
            src: "assets/asset-photo.png",
            altText: assets[0].altText,
            focalPoint: assets[0].focalPoint,
            cropPolicy: assets[0].cropPolicy,
            sizing: { type: ["contain", "none"].includes(assets[0].cropPolicy) ? "contain" : "cover" }
          },
          { type: "chart", assetId: "asset-chart" }
        ] },
        { id: "slide-02", elements: [{ type: "chart", assetId: "asset-diagram" }] }
      ]
    };
    const registry = buildCanonicalAssetRegistry(plan, localizedAssets, manifest);
    expect(Object.fromEntries(registry.assets.map((asset) => [asset.id, asset.finalDeckUse]))).toEqual({
      "asset-photo": "embedded",
      "asset-chart": "recreated-locally",
      "asset-diagram": "not-embedded",
      "asset-unused": "not-embedded"
    });

    const offSlideEmbed = structuredClone(manifest);
    offSlideEmbed.slides[1].elements.push({
      type: "image", assetId: "asset-photo", src: "assets/asset-photo.png"
    });
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, offSlideEmbed))
      .toThrow(/same-slide.*membership|outside.*membership/i);

    const offSlideRecreation = structuredClone(manifest);
    offSlideRecreation.slides[1].elements.push({ type: "chart", assetId: "asset-chart" });
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, offSlideRecreation))
      .toThrow(/same-slide.*membership|outside.*membership/i);

    const forgedImageSource = structuredClone(manifest);
    forgedImageSource.slides[0].elements[0].src = "assets/forged-photo.png";
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, forgedImageSource))
      .toThrow(/image src.*canonical|localized evidence/i);
  });

  it("requires exact ordered unique creative slides and fully tracked image-class render sources", () => {
    const bytes = Buffer.from("canonical image bytes", "utf8");
    const asset = {
      id: "asset-photo",
      kind: "photo",
      role: "hero evidence",
      description: "A local evidence photo",
      provenance: {
        origin: "project",
        sourceRef: "photo.png",
        rights: { status: "allowed", license: "project-owned" }
      },
      focalPoint: "top-right",
      cropPolicy: "cover",
      altText: "Evidence photo",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    };
    const plan = {
      assets: [asset],
      slides: [
        { id: "slide-01", assetIds: [asset.id] },
        { id: "slide-02", assetIds: [] }
      ]
    };
    const localizedAssets = {
      records: [{ asset, relativePath: "assets/asset-photo.png", bytes }]
    };
    const manifestAsset = {
      ...structuredClone(asset),
      src: "assets/asset-photo.png",
      ...structuredClone(asset.provenance)
    };
    const manifest = {
      assets: [manifestAsset],
      slides: [
        {
          id: "slide-01",
          background: { type: "solid", color: "#FFFFFF" },
          elements: [{
            id: "hero",
            type: "image",
            assetId: asset.id,
            src: "assets/asset-photo.png",
            altText: asset.altText,
            focalPoint: asset.focalPoint,
            cropPolicy: asset.cropPolicy,
            sizing: { type: "cover" }
          }]
        },
        { id: "slide-02", background: { type: "solid", color: "#FFFFFF" }, elements: [] }
      ]
    };

    expect(buildCanonicalAssetRegistry(plan, localizedAssets, manifest).assets[0].finalDeckUse)
      .toBe("embedded");

    const reordered = structuredClone(manifest);
    reordered.slides.reverse();
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, reordered))
      .toThrow(/manifest slide order\/membership|ordered unique/i);

    const duplicate = structuredClone(manifest);
    duplicate.slides[1].id = "slide-01";
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, duplicate))
      .toThrow(/manifest slide.*unique|duplicate/i);

    for (const type of ["image", "cropped-asset"]) {
      const anonymous = structuredClone(manifest);
      delete anonymous.slides[0].elements[0].assetId;
      anonymous.slides[0].elements[0].type = type;
      expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, anonymous), type)
        .toThrow(/image.*assetId|tracked.*asset/i);
    }

    const anonymousBackground = structuredClone(manifest);
    anonymousBackground.slides[0].elements = [];
    anonymousBackground.slides[0].background = { type: "image", src: "assets/asset-photo.png" };
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, anonymousBackground))
      .toThrow(/background.*assetId|tracked.*asset/i);

    const trackedBackground = structuredClone(manifest);
    trackedBackground.slides[0].elements = [];
    trackedBackground.slides[0].background = {
      type: "image",
      assetId: asset.id,
      src: "assets/asset-photo.png",
      altText: asset.altText,
      focalPoint: asset.focalPoint,
      cropPolicy: asset.cropPolicy
    };
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, trackedBackground))
      .toThrow(/background image.*unsupported|cannot preserve.*crop/i);

    const offSlideBackground = structuredClone(trackedBackground);
    offSlideBackground.slides[0].background = { type: "solid", color: "#FFFFFF" };
    offSlideBackground.slides[1].background = trackedBackground.slides[0].background;
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, offSlideBackground))
      .toThrow(/same-slide.*membership|outside.*membership/i);

    const forgedBackgroundSource = structuredClone(trackedBackground);
    forgedBackgroundSource.slides[0].background.src = "assets/forged.png";
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, forgedBackgroundSource))
      .toThrow(/image src.*canonical|localized evidence/i);

    const trackedCrop = structuredClone(manifest);
    trackedCrop.slides[0].elements[0].type = "cropped-asset";
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, trackedCrop))
      .toThrow(/cropped-asset.*unsupported|cannot preserve.*crop/i);

    const legacyBackgroundImage = structuredClone(manifest);
    legacyBackgroundImage.slides[0].backgroundImage = "assets/asset-photo.png";
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, legacyBackgroundImage))
      .toThrow(/backgroundImage.*tracked|unsupported.*background/i);
  });

  it("rejects canonical asset or image-contract drift across plan, localized evidence, IR, and manifest", () => {
    const bytes = Buffer.from("generated canonical bytes", "utf8");
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const asset = {
      id: "asset-generated",
      kind: "illustration",
      role: "generated hero evidence",
      description: "A generated workflow illustration",
      provenance: {
        origin: "generated",
        sourceRef: "generated.png",
        sourceUrl: "https://provider.example/jobs/42",
        contentHash,
        rights: {
          status: "allowed",
          license: "Provider output terms",
          attribution: "Generated for the project"
        },
        generation: {
          model: "image-model-2",
          promptSummary: "Editorial workflow illustration"
        }
      },
      focalPoint: "bottom-left",
      cropPolicy: "smart-crop",
      altText: "Generated presentation workflow illustration",
      fallback: { strategy: "native-diagram", description: "Use a native workflow diagram" }
    };
    const plan = { assets: [asset], slides: [{ id: "slide-01", assetIds: [asset.id] }] };
    const localizedAssets = {
      records: [{
        asset: structuredClone(asset),
        relativePath: "assets/asset-generated.png",
        bytes,
        contentHash
      }]
    };
    const ir = {
      assets: [{ ...structuredClone(asset), src: "assets/asset-generated.png" }],
      slides: [{ id: "slide-01", assetRefs: [asset.id] }]
    };
    const manifest = {
      assets: [{
        ...structuredClone(asset),
        src: "assets/asset-generated.png",
        ...structuredClone(asset.provenance)
      }],
      slides: [{
        id: "slide-01",
        elements: [{
          id: "hero",
          type: "image",
          assetId: asset.id,
          src: "assets/asset-generated.png",
          altText: asset.altText,
          focalPoint: asset.focalPoint,
          cropPolicy: asset.cropPolicy,
          sizing: { type: "cover" }
        }]
      }]
    };
    expect(buildCanonicalAssetRegistry(plan, localizedAssets, manifest, ir).assets[0])
      .toMatchObject({ contentHash, finalDeckUse: "embedded" });

    const mutations = [
      ["localized role", (state) => { state.localized.records[0].asset.role = "forged role"; }],
      ["IR kind", (state) => { state.ir.assets[0].kind = "photo"; }],
      ["IR role", (state) => { state.ir.assets[0].role = "forged role"; }],
      ["IR description", (state) => { state.ir.assets[0].description = "forged description"; }],
      ["IR sourceRef", (state) => { state.ir.assets[0].provenance.sourceRef = "forged.png"; }],
      ["IR sourceUrl", (state) => { state.ir.assets[0].provenance.sourceUrl = "https://attacker.example/asset"; }],
      ["IR contentHash", (state) => { state.ir.assets[0].provenance.contentHash = `sha256:${"0".repeat(64)}`; }],
      ["IR rights", (state) => { state.ir.assets[0].provenance.rights.license = "forged"; }],
      ["IR generation", (state) => { state.ir.assets[0].provenance.generation.model = "forged-model"; }],
      ["IR focal point", (state) => { state.ir.assets[0].focalPoint = "center"; }],
      ["IR crop policy", (state) => { state.ir.assets[0].cropPolicy = "contain"; }],
      ["IR alt text", (state) => { state.ir.assets[0].altText = "forged alt"; }],
      ["IR fallback", (state) => { state.ir.assets[0].fallback.description = "forged fallback"; }],
      ["manifest nested provenance", (state) => { state.manifest.assets[0].provenance.rights.license = "forged"; }],
      ["manifest flattened provenance", (state) => { state.manifest.assets[0].rights.license = "forged"; }],
      ["manifest legacy license authority", (state) => { state.manifest.assets[0].license = "forged"; }],
      ["image alt text", (state) => { state.manifest.slides[0].elements[0].altText = "forged alt"; }],
      ["image focal point", (state) => { state.manifest.slides[0].elements[0].focalPoint = "center"; }],
      ["image crop policy", (state) => { state.manifest.slides[0].elements[0].cropPolicy = "contain"; }],
      ["image effective sizing", (state) => { state.manifest.slides[0].elements[0].sizing = { type: "contain" }; }]
    ];
    for (const [label, mutate] of mutations) {
      const state = {
        localized: structuredClone(localizedAssets),
        ir: structuredClone(ir),
        manifest: structuredClone(manifest)
      };
      mutate(state);
      expect(
        () => buildCanonicalAssetRegistry(plan, state.localized, state.manifest, state.ir),
        label
      ).toThrow(/canonical asset|asset contract|localized evidence|provenance|canonical crop/i);
    }
  });

  it("rehashes the publication target and rejects bytes that drift after localization", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-asset-publication-drift-"));
    const targetPath = path.join(dir, "asset-photo.png");
    const originalBytes = Buffer.from("original localized bytes", "utf8");
    fs.writeFileSync(targetPath, originalBytes);
    const asset = {
      id: "asset-photo",
      kind: "photo",
      role: "hero evidence",
      description: "A local photo",
      provenance: { origin: "project", sourceRef: "photo.png", rights: { status: "allowed", license: "project-owned" } },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Photo evidence",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    };
    const plan = { assets: [asset], slides: [{ id: "slide-01", assetIds: [asset.id] }] };
    const localizedAssets = {
      records: [{ asset, relativePath: "assets/asset-photo.png", targetPath, bytes: originalBytes }]
    };
    const manifest = {
      assets: [{
        ...structuredClone(asset),
        src: "assets/asset-photo.png",
        ...structuredClone(asset.provenance)
      }],
      slides: [{ id: "slide-01", elements: [{
        type: "image",
        assetId: asset.id,
        src: "assets/asset-photo.png",
        altText: asset.altText,
        focalPoint: asset.focalPoint,
        cropPolicy: asset.cropPolicy,
        sizing: { type: "cover" }
      }] }]
    };
    expect(buildCanonicalAssetRegistry(plan, localizedAssets, manifest).assets[0].contentHash)
      .toBe(`sha256:${createHash("sha256").update(originalBytes).digest("hex")}`);

    const forgedAsset = structuredClone(asset);
    forgedAsset.provenance.contentHash = `sha256:${"0".repeat(64)}`;
    const forgedPlan = { assets: [forgedAsset], slides: [{ id: "slide-01", assetIds: [forgedAsset.id] }] };
    const forgedLocalized = {
      records: [{
        asset: forgedAsset,
        relativePath: "assets/asset-photo.png",
        targetPath,
        bytes: originalBytes
      }]
    };
    const forgedManifest = {
      assets: [{
        ...structuredClone(forgedAsset),
        src: "assets/asset-photo.png",
        ...structuredClone(forgedAsset.provenance)
      }],
      slides: structuredClone(manifest.slides)
    };
    expect(() => buildCanonicalAssetRegistry(forgedPlan, forgedLocalized, forgedManifest))
      .toThrow(/declared content hash.*publication bytes/i);

    fs.writeFileSync(targetPath, "drifted bytes", "utf8");
    expect(() => buildCanonicalAssetRegistry(plan, localizedAssets, manifest))
      .toThrow(/bytes drifted|publication.*drift/i);
  });

  it("rebuilds the public registry from the final manifest at publication time", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-final-registry-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-final-registry-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const targetPath = path.join(outputDir, "assets", "asset-photo.png");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const bytes = Buffer.from("final registry bytes", "utf8");
    fs.writeFileSync(targetPath, bytes);
    const asset = {
      id: "asset-photo",
      kind: "photo",
      role: "hero evidence",
      description: "A local photo",
      provenance: { origin: "project", sourceRef: "photo.png", rights: { status: "allowed", license: "project-owned" } },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Photo evidence",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    };
    const plan = {
      version: "0.2.0",
      context: { title: "Final manifest truth" },
      assets: [asset],
      slides: [{ id: "slide-01", assetIds: [asset.id] }]
    };
    const ir = {
      version: "0.1.0",
      assets: [{ ...structuredClone(asset), src: "assets/asset-photo.png" }],
      slides: [{ id: "slide-01", assetRefs: [asset.id] }]
    };
    const localizedAssets = {
      records: [{ asset, relativePath: "assets/asset-photo.png", targetPath, bytes }]
    };
    const embeddedManifest = {
      assets: [{ ...structuredClone(asset), src: "assets/asset-photo.png", ...structuredClone(asset.provenance) }],
      slides: [{ id: "slide-01", elements: [{
        id: "hero",
        type: "image",
        assetId: asset.id,
        src: "assets/asset-photo.png",
        alt: asset.altText,
        altText: asset.altText,
        focalPoint: asset.focalPoint,
        cropPolicy: asset.cropPolicy,
        sizing: { type: "cover" }
      }] }]
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), `${JSON.stringify(embeddedManifest, null, 2)}\n`, "utf8");
    const staleRegistry = buildCanonicalAssetRegistry(plan, localizedAssets, embeddedManifest, ir);
    expect(staleRegistry.assets[0].finalDeckUse).toBe("embedded");
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan,
      ir,
      localizedAssets
    });
    localizedAssets.records[0].relativePath = "assets/caller-mutated.png";

    const finalManifest = structuredClone(embeddedManifest);
    finalManifest.slides[0].elements = [];
    fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");
    await transaction.beforePackage();
    const published = JSON.parse(fs.readFileSync(path.join(outputDir, "assets", "asset-registry.json"), "utf8"));
    expect(published.assets[0].finalDeckUse).toBe("not-embedded");
    await expect(transaction.beforePackageCommit()).resolves.toBeUndefined();

    fs.writeFileSync(targetPath, "post-publication byte drift", "utf8");
    await expect(transaction.beforePackageCommit()).rejects.toThrow(/bytes drifted|content hash|byte evidence/i);
    fs.writeFileSync(targetPath, bytes);
    fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), `${JSON.stringify(embeddedManifest, null, 2)}\n`, "utf8");
    await expect(transaction.beforePackageCommit()).rejects.toThrow(/registry.*final manifest|final manifest.*registry/i);
    fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");
    await expect(transaction.beforePackageCommit()).resolves.toBeUndefined();
    await transaction.beforePackageRollback({ blockedBy: "test", error: "cleanup" });
  });

  it("rechecks localized target bytes inside beforePackage before publishing authoring evidence", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-final-bytes-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-final-bytes-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const targetPath = path.join(outputDir, "assets", "asset-photo.png");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const bytes = Buffer.from("localized original", "utf8");
    fs.writeFileSync(targetPath, bytes);
    const asset = {
      id: "asset-photo",
      kind: "photo",
      role: "hero evidence",
      description: "A local photo",
      provenance: { origin: "project", sourceRef: "photo.png", rights: { status: "allowed", license: "project-owned" } },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Photo evidence",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    };
    const plan = { context: { title: "Byte truth" }, assets: [asset], slides: [{ id: "slide-01", assetIds: [asset.id] }] };
    const ir = {
      assets: [{ ...structuredClone(asset), src: "assets/asset-photo.png" }],
      slides: [{ id: "slide-01", assetRefs: [asset.id] }]
    };
    const localizedAssets = { records: [{ asset, relativePath: "assets/asset-photo.png", targetPath, bytes }] };
    const manifest = {
      assets: [{ ...structuredClone(asset), src: "assets/asset-photo.png", ...structuredClone(asset.provenance) }],
      slides: [{ id: "slide-01", elements: [] }]
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expect(buildCanonicalAssetRegistry(plan, localizedAssets, manifest, ir).assets[0].finalDeckUse)
      .toBe("not-embedded");
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan,
      ir,
      localizedAssets
    });
    fs.writeFileSync(targetPath, "mutated after builder", "utf8");

    await expect(transaction.beforePackage()).rejects.toThrow(/bytes drifted|publication.*drift/i);
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it("rejects localized byte drift injected immediately after publishing deck.plan.json", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-after-plan-drift-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-after-plan-drift-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const targetPath = path.join(outputDir, "assets", "asset-photo.png");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const bytes = Buffer.from("localized original", "utf8");
    fs.writeFileSync(targetPath, bytes);
    const asset = {
      id: "asset-photo",
      kind: "photo",
      role: "hero evidence",
      description: "A local photo",
      provenance: { origin: "project", sourceRef: "photo.png", rights: { status: "allowed", license: "project-owned" } },
      focalPoint: "center",
      cropPolicy: "cover",
      altText: "Photo evidence",
      fallback: { strategy: "placeholder", description: "Use a native placeholder" }
    };
    const plan = { context: { title: "After-publish drift" }, assets: [asset], slides: [{ id: "slide-01", assetIds: [asset.id] }] };
    const ir = {
      assets: [{ ...structuredClone(asset), src: "assets/asset-photo.png" }],
      slides: [{ id: "slide-01", assetRefs: [asset.id] }]
    };
    const localizedAssets = { records: [{ asset, relativePath: "assets/asset-photo.png", targetPath, bytes }] };
    const manifest = {
      assets: [{ ...structuredClone(asset), src: "assets/asset-photo.png", ...structuredClone(asset.provenance) }],
      slides: [{ id: "slide-01", elements: [] }]
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(outputDir, "deck.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan,
      ir,
      localizedAssets,
      afterPublish: (relativePath) => {
        if (relativePath === "deck.plan.json") fs.writeFileSync(targetPath, "injected byte drift", "utf8");
      }
    });

    await expect(transaction.beforePackage()).rejects.toThrow(/bytes drifted|publication.*drift|content hash/i);
    await transaction.beforePackageRollback({ blockedBy: "asset-provenance", error: "primary" });
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it("publishes immutable validated plan and IR snapshots even when source and caller objects mutate", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-plan-snapshot-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-plan-snapshot-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const plan = { version: "0.2.0", context: { title: "Original title" }, assets: [], slides: [] };
    const ir = { version: "0.1.0", marker: "original", assets: [], slides: [] };
    const expectedPlanBytes = `${JSON.stringify(plan, null, 2)}\n`;
    fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan,
      ir,
      localizedAssets: { records: [] }
    });

    fs.writeFileSync(planPath, "{\"version\":\"0.2.0\",\"context\":{\"title\":\"Source drift\"},\"assets\":[],\"slides\":[]}\n", "utf8");
    plan.context.title = "Caller drift";
    ir.marker = "caller drift";
    await transaction.beforePackage();

    expect(fs.readFileSync(path.join(outputDir, "deck.plan.json"), "utf8")).toBe(expectedPlanBytes);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "semantic-slide-ir.json"), "utf8")).marker).toBe("original");
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "run.json"), "utf8")).input.summary).toBe("Original title");
    await transaction.beforePackageRollback({ blockedBy: "test", error: "cleanup" });
  });

  it("rejects a transaction whose source plan never matched the supplied validated plan", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-plan-snapshot-mismatch-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-plan-snapshot-mismatch-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{\"context\":{\"title\":\"File\"}}\n", "utf8");
    expect(() => createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: { context: { title: "Memory" } },
      ir: {},
      localizedAssets: { records: [] }
    })).toThrow(/source plan.*validated snapshot|does not match/i);
  });

  it("rejects an output-root symlink in both design-first entry and authoring transaction", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-root-link-input-"));
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-root-link-parent-"));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-root-link-victim-"));
    const outputLink = path.join(linkParent, "output");
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    fs.writeFileSync(path.join(victimDir, "user-owned.txt"), "USER-OWNED\n", "utf8");
    fs.symlinkSync(victimDir, outputLink, "dir");

    expect(() => createCreativeAuthoringTransaction({
      outputDir: outputLink,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] }
    })).toThrow(/output.*real directory|symbolic link/i);
    expect(() => execFileSync("node", ["scripts/run-design-first-pipeline.mjs", planPath, outputLink], { stdio: "pipe" }))
      .toThrow(/output.*real directory|symbolic link/i);
    expect(fs.readFileSync(path.join(victimDir, "user-owned.txt"), "utf8")).toBe("USER-OWNED\n");
    expect(fs.lstatSync(outputLink).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlink ancestor below the trusted temp anchor", () => {
    const anchor = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-ancestor-anchor-"));
    const victimParent = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-ancestor-victim-"));
    const outputDir = path.join(victimParent, "output");
    const alias = path.join(anchor, "alias-parent");
    const planPath = path.join(anchor, "deck.plan.json");
    fs.mkdirSync(outputDir);
    fs.symlinkSync(victimParent, alias, "dir");
    fs.writeFileSync(planPath, "{}\n", "utf8");

    expect(() => createCreativeAuthoringTransaction({
      outputDir: path.join(alias, "output"),
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] }
    })).toThrow(/traverse a symbolic link|symlink/i);
    expect(() => execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      planPath,
      path.join(alias, "output")
    ], { stdio: "pipe" })).toThrow(/traverse a symbolic link|symlink/i);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it("does not follow a precreated predictable transaction stage symlink", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-stage-link-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-stage-link-output-"));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-stage-link-victim-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const victim = path.join(victimDir, "victim.txt");
    const plan = { version: "0.2.0", context: { title: "Safe stage" }, assets: [], slides: [] };
    fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    fs.writeFileSync(victim, "USER-OWNED\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const predictableStage = path.join(outputDir, `deck.plan.json.creative-stage-${process.pid}-1`);
    fs.symlinkSync(victim, predictableStage, "file");
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan,
      ir: { version: "0.1.0", assets: [], slides: [] },
      localizedAssets: { records: [] }
    });

    await transaction.beforePackage();
    expect(fs.readFileSync(victim, "utf8")).toBe("USER-OWNED\n");
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      const entry = fs.lstatSync(path.join(outputDir, relative));
      expect(entry.isFile(), relative).toBe(true);
      expect(entry.isSymbolicLink(), relative).toBe(false);
    }
    await transaction.beforePackageRollback({ blockedBy: "test", error: "cleanup" });
    expect(fs.readFileSync(victim, "utf8")).toBe("USER-OWNED\n");
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
    expect(fs.lstatSync(predictableStage).isSymbolicLink()).toBe(true);
  });

  it("fails before run publication when an afterPublish callback removes the semantic IR", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-run-pointer-gap-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-run-pointer-gap-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] },
      afterPublish: (relativePath) => {
        if (relativePath === "semantic-slide-ir.json") {
          fs.rmSync(path.join(outputDir, relativePath), { force: true });
        }
      }
    });

    await expect(transaction.beforePackage()).rejects.toThrow(/required artifact.*semantic-slide-ir|semantic-slide-ir.*missing/i);
    await transaction.beforePackageRollback({ blockedBy: "reports", error: "primary" });
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it.each([
    "deck.plan.json",
    "semantic-slide-ir.json",
    "deck.manifest.json",
    "assets/asset-registry.json"
  ])("blocks package precommit when required Creative artifact %s is removed", async (removedArtifact) => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-precommit-artifact-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-precommit-artifact-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] }
    });
    await transaction.beforePackage();
    fs.rmSync(path.join(outputDir, removedArtifact), { force: true });

    await expect(transaction.beforePackageCommit()).rejects.toThrow(/required artifact|missing|real regular file/i);
    await transaction.beforePackageRollback({ blockedBy: "package", error: "primary" });
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it("blocks package precommit when run mode is downgraded after publication", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-precommit-mode-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-precommit-mode-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] }
    });
    await transaction.beforePackage();
    const runPath = path.join(outputDir, "run.json");
    const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
    run.mode = "direct";
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

    await expect(transaction.beforePackageCommit()).rejects.toThrow(/run mode|creative/i);
    await transaction.beforePackageRollback({ blockedBy: "package", error: "primary" });
  });

  it("fails before copying DESIGN.md through a precreated design-system symlink", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-copy-link-output-"));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-design-copy-link-victim-"));
    const victimDesign = path.join(victimDir, "DESIGN.md");
    fs.writeFileSync(victimDesign, "USER-OWNED DESIGN\n", "utf8");
    fs.symlinkSync(victimDir, path.join(outputDir, "design-system"), "dir");

    expect(() => execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      "examples/text-input/creative/deck.plan.json",
      outputDir,
      "--design-system",
      "business-neutral"
    ], { stdio: "pipe" })).toThrow(/design-system|symbolic link|symlink/i);
    expect(fs.readFileSync(victimDesign, "utf8")).toBe("USER-OWNED DESIGN\n");
    expect(fs.existsSync(path.join(outputDir, "final.pptx"))).toBe(false);
    expect(fs.lstatSync(path.join(outputDir, "design-system")).isSymbolicLink()).toBe(true);
  });

  it("rejects a deck-plan input collision with the reserved manifest path without following its symlink", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-manifest-input-link-output-"));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-manifest-input-link-victim-"));
    const victimPlan = path.join(victimDir, "deck.plan.json");
    const manifestPath = path.join(outputDir, "deck.manifest.json");
    fs.copyFileSync("examples/text-input/creative/deck.plan.json", victimPlan);
    const originalBytes = fs.readFileSync(victimPlan);
    fs.symlinkSync(victimPlan, manifestPath, "file");

    expect(() => execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      manifestPath,
      outputDir,
      "--design-system",
      "business-neutral"
    ], { stdio: "pipe" })).toThrow(/reserved.*manifest|input.*collision|deck\.manifest/i);
    expect(fs.readFileSync(victimPlan)).toEqual(originalBytes);
    expect(fs.lstatSync(manifestPath).isSymbolicLink()).toBe(true);
  });

  it("preserves an explicit in-place design source after successful cleanup", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-in-place-design-input-"));
    const designDir = path.join(outputDir, "design-system");
    const customDesign = path.join(designDir, "custom.md");
    fs.mkdirSync(designDir);
    fs.copyFileSync("design-systems/business-neutral/DESIGN.md", customDesign);
    const originalBytes = fs.readFileSync(customDesign);

    execFileSync("node", [
      "scripts/run-design-first-pipeline.mjs",
      "examples/text-input/creative/deck.plan.json",
      outputDir,
      "--design-system",
      customDesign
    ], {
      stdio: "pipe",
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" }
    });

    expect(fs.readFileSync(customDesign)).toEqual(originalBytes);
    expect(fs.existsSync(path.join(designDir, "DESIGN.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "final.pptx"))).toBe(true);
  }, 60000);

  it("publishes plan, IR, registry, then run and rolls the public transaction back in reverse", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-authoring-transaction-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-authoring-transaction-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const plan = { version: "0.2.0", context: { title: "Transaction" } };
    const ir = { version: "0.1.0", source: { kind: "deck-plan", version: "0.2.0" } };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    writeEmptyFinalManifest(outputDir);
    const events = [];
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan,
      ir,
      localizedAssets: { records: [] },
      mode: "creative",
      afterPublish: (relativePath) => { events.push(`write:${relativePath}`); },
      afterRollback: (relativePath) => { events.push(`remove:${relativePath}`); }
    });
    await transaction.beforePackage();
    expect(events.slice(0, 4)).toEqual([
      "write:deck.plan.json",
      "write:semantic-slide-ir.json",
      "write:assets/asset-registry.json",
      "write:run.json"
    ]);
    const run = JSON.parse(fs.readFileSync(path.join(outputDir, "run.json"), "utf8"));
    expect(run.artifacts.assetRegistry).toBe("assets/asset-registry.json");
    await transaction.beforePackageRollback({ blockedBy: "package", error: new Error("package non-ok") });
    expect(events.slice(4)).toEqual([
      "remove:run.json",
      "remove:assets/asset-registry.json",
      "remove:semantic-slide-ir.json",
      "remove:deck.plan.json"
    ]);
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it.each([
    "deck.plan.json",
    "semantic-slide-ir.json",
    "assets/asset-registry.json",
    "run.json"
  ])("removes every completed authoring write when %s publication throws", async (failurePoint) => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-authoring-fault-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-authoring-fault-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] },
      afterPublish: (relativePath) => {
        if (relativePath === failurePoint) throw new Error(`injected ${failurePoint} publication failure`);
      }
    });
    await expect(transaction.beforePackage()).rejects.toThrow(/injected .* publication failure/);
    await transaction.beforePackageRollback({ blockedBy: "reports", error: "primary" });
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it("rolls back every completed write after beforePackage failure and preserves an in-place plan", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-authoring-in-place-"));
    const planPath = path.join(outputDir, "deck.plan.json");
    const planBytes = "{\"version\":\"0.2.0\",\"userOwned\":true}\n";
    fs.writeFileSync(planPath, planBytes, "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: JSON.parse(planBytes),
      ir: { version: "0.1.0" },
      localizedAssets: { records: [] },
      mode: "creative",
      afterPublish: (relativePath) => {
        if (relativePath === "assets/asset-registry.json") throw new Error("injected beforePackage failure");
      }
    });
    await expect(transaction.beforePackage()).rejects.toThrow(/injected beforePackage failure/);
    await transaction.beforePackageRollback({ blockedBy: "reports", error: new Error("primary") });
    expect(fs.readFileSync(planPath, "utf8")).toBe(planBytes);
    expect(fs.existsSync(path.join(outputDir, "semantic-slide-ir.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "assets", "asset-registry.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "run.json"))).toBe(false);
  });

  it("restores an in-place plan without following a replacement leaf symlink", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-plan-link-output-"));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-plan-link-victim-"));
    const planPath = path.join(outputDir, "deck.plan.json");
    const victimPath = path.join(victimDir, "victim.txt");
    const planBytes = "{\"version\":\"0.2.0\",\"userOwned\":true}\n";
    fs.writeFileSync(planPath, planBytes, "utf8");
    fs.writeFileSync(victimPath, "USER-OWNED\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: JSON.parse(planBytes),
      ir: {},
      localizedAssets: { records: [] }
    });
    await transaction.beforePackage();
    fs.rmSync(planPath);
    fs.symlinkSync(victimPath, planPath, "file");

    await expect(transaction.beforePackageRollback({ blockedBy: "package", error: "primary" })).resolves.toBeUndefined();
    expect(fs.readFileSync(victimPath, "utf8")).toBe("USER-OWNED\n");
    expect(fs.lstatSync(planPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(planPath, "utf8")).toBe(planBytes);
  });

  it("does not follow a replacement assets parent symlink during rollback", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-parent-link-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-parent-link-output-"));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-parent-link-victim-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    const victimRegistry = path.join(victimDir, "asset-registry.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    fs.writeFileSync(victimRegistry, "USER-OWNED\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] }
    });
    await transaction.beforePackage();
    fs.renameSync(path.join(outputDir, "assets"), path.join(outputDir, "assets-real"));
    fs.symlinkSync(victimDir, path.join(outputDir, "assets"), "dir");

    await expect(transaction.beforePackageRollback({ blockedBy: "package", error: "primary" })).resolves.toBeUndefined();
    expect(fs.readFileSync(victimRegistry, "utf8")).toBe("USER-OWNED\n");
    expect(fs.lstatSync(path.join(outputDir, "assets")).isSymbolicLink()).toBe(true);
  });

  it.each(["package-non-ok", "package-exception"])("does not retain public authoring state after %s", async (kind) => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), `pptx-${kind}-input-`));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `pptx-${kind}-output-`));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] },
      mode: "creative"
    });
    await transaction.beforePackage();
    await expect(transaction.beforePackageRollback({ blockedBy: "package", error: kind })).resolves.toBeUndefined();
    for (const relative of ["deck.plan.json", "semantic-slide-ir.json", "assets/asset-registry.json", "run.json"]) {
      expect(fs.existsSync(path.join(outputDir, relative)), relative).toBe(false);
    }
  });

  it("keeps rollback best-effort so cleanup errors cannot replace the primary package failure", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-best-effort-input-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-rollback-best-effort-output-"));
    const planPath = path.join(inputDir, "deck.plan.json");
    fs.writeFileSync(planPath, "{}\n", "utf8");
    writeEmptyFinalManifest(outputDir);
    const transaction = createCreativeAuthoringTransaction({
      outputDir,
      planPath,
      plan: {},
      ir: {},
      localizedAssets: { records: [] },
      afterRollback: () => { throw new Error("injected rollback callback failure"); }
    });
    await transaction.beforePackage();
    await expect(transaction.beforePackageRollback({
      blockedBy: "package",
      error: new Error("primary package failure")
    })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, "run.json"))).toBe(false);
  });
});
