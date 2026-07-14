import { access, chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as pipeline from "../scripts/run-deck-pipeline.mjs";
import * as setup from "../scripts/setup.mjs";
import { findPython } from "../scripts/lib/python-utils.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

describe("Task 2 public surface and deletion contract", () => {
  it("exposes no more than ten public npm scripts through the unified CLI", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(Object.keys(pkg.scripts)).toEqual([
      "pptx", "test", "test:unit", "test:browser", "test:visual", "test:py", "setup"
    ]);
    expect(pkg.scripts["test:unit"]).toMatch(/^PLAYWRIGHT_RUN=0 /);
  });

  it("removes explicitly retired product, test, docs, and UI files", async () => {
    const retired = [
      "scripts/run-design-artifact-pipeline.mjs",
      "scripts/lib/preview-artifact-generator.mjs",
      "schemas/preview-artifacts.schema.json",
      "tests/design-artifact-pipeline.test.mjs",
      "tests/artifact-manifest-compiler.test.mjs",
      "tests/preview-artifact-generator.test.mjs",
      "scripts/run-direction-exploration.mjs",
      "scripts/lib/direction-explorer.mjs",
      "schemas/direction-candidate.schema.json",
      "schemas/direction-scorecard.schema.json",
      "tests/direction-explorer.test.mjs",
      "scripts/run-vision-review.mjs",
      "scripts/lib/vision-review.mjs",
      "schemas/vision-review.schema.json",
      "tests/vision-review-cli.test.mjs",
      "tests/vision-review-provider.test.mjs",
      "tests/vision-review.test.mjs",
      "references/prompt-library.md",
      "slide-patterns/definition-list/pattern.md",
      "slide-patterns/image-feature/pattern.md",
      "slide-patterns/numbers-row/pattern.md",
      "workbench/app.js",
      "workbench/index.html",
      "workbench/styles.css",
      "tests/workbench.test.mjs",
      "scripts/image-to-manifest.mjs",
      "tests/image-to-manifest.test.mjs"
    ];
    for (const path of retired) {
      await expect(access(join(root, path))).rejects.toThrow();
    }
  });
});

describe("Task 2 single pipeline contract", () => {
  it("invalidates only published outputs at the safe preflight boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-public-invalidation-"));
    const planPath = join(dir, "deck.plan.json");
    const designPath = join(dir, "DESIGN.md");
    const assetPath = join(dir, "assets", "source.png");
    await mkdir(join(dir, "assets"));
    await writeFile(planPath, "{}\n", "utf8");
    await writeFile(designPath, "source design\n", "utf8");
    await writeFile(assetPath, "source asset\n", "utf8");
    for (const name of ["final.pptx", "output-manifest.json", "deck.manifest.json", "semantic-slide-ir.json", "quality-report.json", "visual-review.json"]) {
      await writeFile(join(dir, name), "stale-success", "utf8");
    }
    for (const directory of ["preview", "creative-proof"]) {
      await mkdir(join(dir, directory));
      await writeFile(join(dir, directory, "stale.txt"), "stale-success", "utf8");
    }

    expect(typeof pipeline.invalidatePublishedOutputs).toBe("function");
    await pipeline.invalidatePublishedOutputs(dir, [planPath, designPath, assetPath]);

    for (const name of ["final.pptx", "output-manifest.json", "deck.manifest.json", "semantic-slide-ir.json", "quality-report.json", "visual-review.json", "preview", "creative-proof"]) {
      await expect(access(join(dir, name)), name).rejects.toThrow();
    }
    for (const preserved of [planPath, designPath, assetPath]) await expect(access(preserved)).resolves.toBeUndefined();
  });

  it.each([
    ["published invalidation", pipeline.invalidatePublishedOutputs],
    ["consumable cleanup", pipeline.clearConsumableOutputs]
  ])("does not follow an assets symlink during %s", async (_label, cleanup) => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-assets-symlink-output-"));
    const victimDir = await mkdtemp(join(tmpdir(), "pptx-assets-symlink-victim-"));
    const victimRegistry = join(victimDir, "asset-registry.json");
    await writeFile(victimRegistry, "USER-OWNED\n", "utf8");
    await symlink(victimDir, join(outputDir, "assets"), "dir");

    await cleanup(outputDir);

    expect(await readFile(victimRegistry, "utf8")).toBe("USER-OWNED\n");
    expect((await lstat(join(outputDir, "assets"))).isSymbolicLink()).toBe(true);
  });

  it("preserves an ordinary empty assets directory during consumable cleanup", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-empty-assets-output-"));
    await mkdir(join(outputDir, "assets"));
    await pipeline.clearConsumableOutputs(outputDir);
    const entry = await lstat(join(outputDir, "assets"));
    expect(entry.isDirectory()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
  });

  it.each([
    ["published invalidation", pipeline.invalidatePublishedOutputs],
    ["consumable cleanup", pipeline.clearConsumableOutputs]
  ])("does not follow an output-root symlink during %s", async (_label, cleanup) => {
    const linkParent = await mkdtemp(join(tmpdir(), "pptx-root-symlink-parent-"));
    const victimDir = await mkdtemp(join(tmpdir(), "pptx-root-symlink-victim-"));
    const outputLink = join(linkParent, "output");
    const victim = join(victimDir, "final.pptx");
    await writeFile(victim, "USER-OWNED\n", "utf8");
    await symlink(victimDir, outputLink, "dir");

    await cleanup(outputLink);

    expect(await readFile(victim, "utf8")).toBe("USER-OWNED\n");
    expect((await lstat(outputLink)).isSymbolicLink()).toBe(true);
  });

  it.each([
    ["published invalidation", pipeline.invalidatePublishedOutputs],
    ["consumable cleanup", pipeline.clearConsumableOutputs]
  ])("does not follow an output ancestor symlink during exported %s", async (_label, cleanup) => {
    const anchor = await mkdtemp(join(tmpdir(), "pptx-cleanup-ancestor-anchor-"));
    const victimParent = await mkdtemp(join(tmpdir(), "pptx-cleanup-ancestor-victim-"));
    const outputDir = join(victimParent, "output");
    const alias = join(anchor, "alias-parent");
    const victim = join(outputDir, "final.pptx");
    await mkdir(outputDir);
    await writeFile(victim, "USER-OWNED\n", "utf8");
    await symlink(victimParent, alias, "dir");

    await cleanup(join(alias, "output"));

    expect(await readFile(victim, "utf8")).toBe("USER-OWNED\n");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it("fails the pipeline before writing when output root is a symlink", async () => {
    const linkParent = await mkdtemp(join(tmpdir(), "pptx-run-root-symlink-parent-"));
    const victimDir = await mkdtemp(join(tmpdir(), "pptx-run-root-symlink-victim-"));
    const inputDir = await mkdtemp(join(tmpdir(), "pptx-run-root-symlink-input-"));
    const outputLink = join(linkParent, "output");
    const manifestPath = join(inputDir, "invalid.manifest.json");
    const marker = join(victimDir, "user-owned.txt");
    await writeFile(manifestPath, "{\"invalid\":true}\n", "utf8");
    await writeFile(marker, "USER-OWNED\n", "utf8");
    await symlink(victimDir, outputLink, "dir");

    await expect(pipeline.runDeckPipeline(manifestPath, outputLink))
      .rejects.toThrow(/output.*real directory|symbolic link/i);
    expect(await readFile(marker, "utf8")).toBe("USER-OWNED\n");
    await expect(access(join(victimDir, "pipeline-blocked.json"))).rejects.toThrow();
    expect((await lstat(outputLink)).isSymbolicLink()).toBe(true);
  });

  it("fails the pipeline when a user-controlled ancestor below the temp anchor is a symlink", async () => {
    const anchor = await mkdtemp(join(tmpdir(), "pptx-run-ancestor-anchor-"));
    const victimParent = await mkdtemp(join(tmpdir(), "pptx-run-ancestor-victim-"));
    const inputDir = await mkdtemp(join(tmpdir(), "pptx-run-ancestor-input-"));
    const outputDir = join(victimParent, "output");
    const alias = join(anchor, "alias-parent");
    const manifestPath = join(inputDir, "invalid.manifest.json");
    await mkdir(outputDir);
    await symlink(victimParent, alias, "dir");
    await writeFile(manifestPath, "{\"invalid\":true}\n", "utf8");

    await expect(pipeline.runDeckPipeline(manifestPath, join(alias, "output")))
      .rejects.toThrow(/traverse a symbolic link|symlink/i);
    await expect(access(join(outputDir, "pipeline-blocked.json"))).rejects.toThrow();
  });

  it("publishes blocked state without following a replacement leaf symlink", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-blocked-link-output-"));
    const victimDir = await mkdtemp(join(tmpdir(), "pptx-blocked-link-victim-"));
    const victim = join(victimDir, "victim.txt");
    const blockedPath = join(outputDir, "pipeline-blocked.json");
    await writeFile(victim, "USER-OWNED\n", "utf8");

    await expect(pipeline.runDeckPipeline(
      join(root, "examples/text-input/deck.manifest.json"),
      outputDir,
      {
        beforePackage: async () => {
          await symlink(victim, blockedPath, "file");
          throw new Error("forced before-package failure");
        }
      }
    )).rejects.toThrow(/pipeline blocked at reports.*forced before-package failure/i);

    expect(await readFile(victim, "utf8")).toBe("USER-OWNED\n");
    const blockedEntry = await lstat(blockedPath);
    expect(blockedEntry.isFile()).toBe(true);
    expect(blockedEntry.isSymbolicLink()).toBe(false);
  }, 60000);

  it("does not let an untrusted private sidecar authorize user-asset deletion", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-private-sidecar-owner-"));
    await mkdir(join(outputDir, "assets"));
    const bytes = Buffer.from("user-owned matching hash bytes", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const userAsset = join(outputDir, "assets", `user-owned-${digest}.png`);
    await writeFile(userAsset, bytes);
    await writeFile(join(outputDir, ".pptx-generated-assets.json"), JSON.stringify({
      version: "0.1.0",
      owner: "attacker",
      files: [`assets/user-owned-${digest}.png`]
    }));

    await pipeline.clearConsumableOutputs(outputDir);

    expect(await readFile(userAsset)).toEqual(bytes);
  });

  it("ignores forged hashes, traversal, nested paths, and symlink entries in the private sidecar", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-private-sidecar-forged-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pptx-private-sidecar-outside-"));
    await mkdir(join(outputDir, "assets"));
    await mkdir(join(outputDir, "assets", "nested"));
    const forged = join(outputDir, "assets", "forged-000000000000.png");
    const nested = join(outputDir, "assets", "nested", "nested-000000000000.png");
    const outside = join(outsideDir, "outside-000000000000.png");
    const symlinkTarget = join(outsideDir, "symlink-target.png");
    const linked = join(outputDir, "assets", "linked-000000000000.png");
    await writeFile(forged, "forged", "utf8");
    await writeFile(nested, "nested", "utf8");
    await writeFile(outside, "outside", "utf8");
    await writeFile(symlinkTarget, "symlink target", "utf8");
    await symlink(symlinkTarget, linked, "file");
    await writeFile(join(outputDir, ".pptx-generated-assets.json"), JSON.stringify({
      version: "0.1.0",
      owner: "creative-deck-plan-assets",
      files: [
        "assets/forged-000000000000.png",
        "assets/nested/nested-000000000000.png",
        "../outside-000000000000.png",
        "assets/linked-000000000000.png"
      ]
    }));

    await pipeline.clearConsumableOutputs(outputDir);

    for (const candidate of [forged, nested, outside, symlinkTarget, linked]) {
      await expect(lstat(candidate), candidate).resolves.toBeDefined();
    }
  });

  it("cleans a verified HTML run directory without deleting unrelated user assets", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-html-owned-cleanup-"));
    const runName = ".pptx-run-123e4567-e89b-42d3-a456-426614174000";
    const runDir = join(outputDir, "assets", runName);
    const generated = join(runDir, "remote-source-001.png");
    const userAsset = join(outputDir, "assets", "user-owned.png");
    await mkdir(runDir, { recursive: true });
    await writeFile(generated, "generated", "utf8");
    await writeFile(userAsset, "USER-OWNED", "utf8");
    await writeFile(join(outputDir, ".pptx-generated-assets.json"), JSON.stringify({
      version: "0.1.0",
      files: [`assets/${runName}`],
      plannedFiles: [`assets/${runName}/remote-source-001.png`]
    }));

    await pipeline.clearConsumableOutputs(outputDir);

    await expect(access(runDir)).rejects.toThrow();
    expect(await readFile(userAsset, "utf8")).toBe("USER-OWNED");
    expect((await lstat(join(outputDir, "assets"))).isDirectory()).toBe(true);
  });

  it("cleans verified nested image-replica files without deleting unrelated user assets", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "pptx-image-owned-cleanup-"));
    const generatedRelative = "assets/crops/generated.png";
    const generated = join(outputDir, generatedRelative);
    const userAsset = join(outputDir, "assets", "user-owned.png");
    const bytes = Buffer.from("generated replica crop", "utf8");
    await mkdir(join(outputDir, "assets", "crops"), { recursive: true });
    await writeFile(generated, bytes);
    await writeFile(userAsset, "USER-OWNED", "utf8");
    await writeFile(join(outputDir, ".pptx-generated-assets.json"), JSON.stringify({
      version: "0.1.0",
      owner: "image-replica-compiler",
      files: [generatedRelative],
      digests: { [generatedRelative]: createHash("sha256").update(bytes).digest("hex") }
    }));

    await pipeline.clearConsumableOutputs(outputDir);

    await expect(access(generated)).rejects.toThrow();
    expect(await readFile(userAsset, "utf8")).toBe("USER-OWNED");
    expect((await lstat(join(outputDir, "assets"))).isDirectory()).toBe(true);
  });

  it("removes stale consumable outputs before a failing run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-stale-output-"));
    const manifest = join(dir, "invalid.manifest.json");
    await writeFile(manifest, JSON.stringify({ invalid: true }), "utf8");
    for (const name of ["final.pptx", "output-manifest.json", "semantic-slide-ir.json", "consistency-report.json", "qa-report.md"]) {
      await writeFile(join(dir, name), "stale-success", "utf8");
    }

    await expect(pipeline.runDeckPipeline(manifest, dir)).rejects.toThrow(/validate/);
    for (const name of ["final.pptx", "output-manifest.json", "semantic-slide-ir.json", "consistency-report.json", "qa-report.md"]) {
      await expect(access(join(dir, name))).rejects.toThrow();
    }
    await expect(access(join(dir, "pipeline-blocked.json"))).resolves.toBeUndefined();
  });

  it("supports a successful run when the input is already output/deck.manifest.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-in-place-manifest-"));
    const manifest = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    manifest.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    const manifestPath = join(dir, "deck.manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    for (const name of ["html-layout-report.json", "layout-measurements.json", "deck.localized-input.html"]) {
      await writeFile(join(dir, name), "stale-html", "utf8");
    }
    for (const name of [
      "inputHints.json", "image-hints.json", "image-replica-analysis.json", "replica-layer-plan.json",
      "visual-regression-report.json", "preview-diff-slide-001.json", "deck.manifest.skeleton.json",
      "semantic-slide-ir.json"
    ]) {
      await writeFile(join(dir, name), "stale-route", "utf8");
    }
    await mkdir(join(dir, "html-preview"));
    await writeFile(join(dir, "html-preview", "slide-001.png"), "stale-preview", "utf8");
    await mkdir(join(dir, "assets"));
    const staleGenerated = Buffer.from("stale-generated", "utf8");
    const staleDigest = createHash("sha256").update(staleGenerated).digest("hex").slice(0, 12);
    const staleGeneratedName = `remote-source-${staleDigest}.png`;
    await writeFile(join(dir, "assets", staleGeneratedName), staleGenerated);
    await writeFile(join(dir, "assets", "remote-source-user.png"), "keep-prefix", "utf8");
    await writeFile(join(dir, "assets", "user-owned.png"), "keep", "utf8");
    await writeFile(join(dir, ".pptx-generated-assets.json"), JSON.stringify({
      version: "0.1.0",
      owner: "creative-deck-plan-assets",
      files: [`assets/${staleGeneratedName}`]
    }), "utf8");

    const summary = await pipeline.runDeckPipeline(manifestPath, dir);
    expect(summary.status).toBe("passed");
    await expect(access(join(dir, "final.pptx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "output-manifest.json"))).resolves.toBeUndefined();
    expect(pipeline.shouldCopyManifest(manifestPath, dir)).toBe(false);
    const outputManifest = JSON.parse(await readFile(join(dir, "output-manifest.json"), "utf8"));
    for (const stale of [
      "html-layout-report.json", "layout-measurements.json", "deck.localized-input.html", "html-preview",
      "inputHints.json", "image-hints.json", "image-replica-analysis.json", "replica-layer-plan.json",
      "visual-regression-report.json", "preview-diff-slide-001.json", "deck.manifest.skeleton.json",
      "semantic-slide-ir.json"
    ]) {
      expect(outputManifest.files).not.toContain(stale);
      await expect(access(join(dir, stale))).rejects.toThrow();
    }
    await expect(access(join(dir, "assets", staleGeneratedName))).rejects.toThrow();
    await expect(access(join(dir, "assets", "remote-source-user.png"))).resolves.toBeUndefined();
    await expect(access(join(dir, "assets", "user-owned.png"))).resolves.toBeUndefined();
    expect(outputManifest.files).not.toContain(".pptx-generated-assets.json");
  }, 60000);

  it("preserves a protected manifest nested inside a recursively cleaned route directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-nested-protected-"));
    const previewDir = join(dir, "preview");
    await mkdir(previewDir);
    const manifest = JSON.parse(await readFile(join(root, "examples/text-input/deck.manifest.json"), "utf8"));
    manifest.designSystem.source = join(root, "design-systems/business-neutral/DESIGN.md");
    const manifestPath = join(previewDir, "deck.manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(join(previewDir, "stale.png"), "stale-preview", "utf8");

    const summary = await pipeline.runDeckPipeline(manifestPath, dir);
    expect(summary.status).toBe("passed");
    await expect(access(manifestPath)).resolves.toBeUndefined();
    await expect(access(join(previewDir, "stale.png"))).rejects.toThrow();
  }, 60000);

  it("rejects replica proof when the PPTX archive contains fewer native objects than source coverage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-truncated-proof-"));
    const pptxPath = join(dir, "truncated.pptx");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"p\"><p:cSld><p:spTree><p:sp/></p:spTree></p:cSld></p:sld>");
    await writeFile(pptxPath, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await pipeline.proveReplicaFidelity(
      pptxPath,
      { slides: [{ id: "slide-001" }] },
      { coverage: 1, coveredElements: 10, droppedElements: [], unsupportedEffects: [] },
      { countersBySlide: [{ shape: 10 }] },
      "html"
    );

    expect(result).toMatchObject({
      status: "failed",
      coveredElements: 10,
      renderedNativeObjects: 10,
      archiveObjectCount: 1
    });
  });

  it("routes every deck-producing command through one operational script", async () => {
    const { buildInvocation } = await import("../scripts/pptx.mjs");
    for (const argv of [
      ["text", "artifacts", "out"],
      ["text", "deck.json", "out", "--direct"],
      ["text", "artifacts", "out", "--creative"],
      ["html", "input.html", "out"],
      ["image", "input.png", "out"],
      ["pdf", "input.pdf", "out"]
    ]) expect(buildInvocation(argv).script).toBe("run-route-pipeline.mjs");
  });

  it("blocks strict pdf runs when fidelity proof capability is unavailable", async () => {
    await expect(execFileAsync(process.execPath, [join(root, "scripts/pptx.mjs"), "pdf", "input.pdf", "out"], { cwd: root }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/fidelity proof capability is unavailable/) });
  });

  it("grades route profiles without creative checks leaking into replica", () => {
    expect(typeof pipeline.buildPipelinePlan).toBe("function");
    expect(pipeline.buildPipelinePlan({ route: "text", mode: "direct" })).toEqual([
      "validate", "light-preflight", "render", "editability-proof", "bounded-repair", "package"
    ]);
    expect(pipeline.buildPipelinePlan({ route: "text", mode: "creative" })).toEqual([
      "validate", "creative-layout-taste-preflight", "render", "creative-proof", "bounded-repair", "package"
    ]);
    for (const route of ["html", "image", "pdf"]) {
      const plan = pipeline.buildPipelinePlan({ route, mode: "replica", proofAvailable: true });
      expect(plan).toEqual([
        "validate", "replica-preflight", "render", "fidelity-proof", "bounded-repair", "package"
      ]);
      expect(plan.join(" ")).not.toMatch(/taste|slop|creative/);
    }
  });

  it("fails fast and never executes later stages after a hard failure", async () => {
    expect(typeof pipeline.executePipelinePlan).toBe("function");
    const calls = [];
    await expect(pipeline.executePipelinePlan(
      ["validate", "replica-preflight", "render", "fidelity-proof", "bounded-repair", "package"],
      async (stage) => {
        calls.push(stage);
        return { ok: stage !== "replica-preflight" };
      }
    )).rejects.toThrow(/replica-preflight/);
    expect(calls).toEqual(["validate", "replica-preflight"]);
  });

  it("blocks strict replica when fidelity proof is unavailable and caps repairs at three", () => {
    expect(() => pipeline.buildPipelinePlan({ route: "html", mode: "replica", proofAvailable: false }))
      .toThrow(/fidelity proof.*unavailable/i);
    expect(pipeline.normalizeRepairLimit(99)).toBe(3);
    expect(pipeline.normalizeRepairLimit(-1)).toBe(0);
    expect(pipeline.hasCompleteReplicaProof({ coverage: 1, droppedElements: [], unsupportedEffects: [] })).toBe(true);
    expect(pipeline.hasCompleteReplicaProof({ coverage: 1, droppedElements: ["missing"], unsupportedEffects: [] })).toBe(false);
    expect(pipeline.hasCompleteReplicaProof({ coverage: 1, droppedElements: [], unsupportedEffects: ["backdrop-filter"] })).toBe(false);
  });
});

describe("Task 2 setup profiles and Python selection", () => {
  it("supports core|html|image|pdf and keeps core free of browser/OCR/PDF requirements", () => {
    expect(typeof setup.requirementsForProfile).toBe("function");
    expect(setup.requirementsForProfile("core")).toEqual(expect.not.arrayContaining(["chromium", "ocr", "pdf"]));
    expect(setup.requirementsForProfile("html")).toContain("chromium");
    expect(setup.requirementsForProfile("image")).toContain("ocr");
    expect(setup.requirementsForProfile("pdf")).toContain("pdf");
    expect(() => setup.requirementsForProfile("everything")).toThrow(/core\|html\|image\|pdf/);
  });

  it("ships isolated Python requirement files for setup profiles", async () => {
    const core = await readFile(join(root, "requirements-core.txt"), "utf8");
    const image = await readFile(join(root, "requirements-image.txt"), "utf8");
    const pdf = await readFile(join(root, "requirements-pdf.txt"), "utf8");
    expect(core).not.toMatch(/Pillow|pytesseract|PyMuPDF/i);
    expect(image).toMatch(/Pillow/);
    expect(image).toMatch(/pytesseract/);
    expect(image).not.toMatch(/PyMuPDF/i);
    expect(pdf).toMatch(/PyMuPDF/);
    expect(pdf).not.toMatch(/pytesseract/i);
  });

  it("rejects an explicit executable below Python 3.10", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-old-python-"));
    const executable = join(dir, "python-old");
    await writeFile(executable, "#!/bin/sh\necho 'Python 3.9.18'\n", "utf8");
    await chmod(executable, 0o755);
    const previous = process.env.PPTX_CREATOR_PYTHON;
    process.env.PPTX_CREATOR_PYTHON = executable;
    try {
      await expect(findPython()).rejects.toThrow(/Python 3\.10\+/);
    } finally {
      if (previous === undefined) delete process.env.PPTX_CREATOR_PYTHON;
      else process.env.PPTX_CREATOR_PYTHON = previous;
    }
  });

  it("honors a supported PPTX_CREATOR_PYTHON command resolved from PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-path-python-"));
    const executable = join(dir, "python-custom");
    await writeFile(executable, "#!/bin/sh\necho 'Python 3.11.9'\n", "utf8");
    await chmod(executable, 0o755);
    const previousPython = process.env.PPTX_CREATOR_PYTHON;
    const previousPath = process.env.PATH;
    process.env.PPTX_CREATOR_PYTHON = "python-custom";
    process.env.PATH = `${dir}:${previousPath}`;
    try {
      await expect(findPython()).resolves.toBe("python-custom");
    } finally {
      if (previousPython === undefined) delete process.env.PPTX_CREATOR_PYTHON;
      else process.env.PPTX_CREATOR_PYTHON = previousPython;
      process.env.PATH = previousPath;
    }
  });
});

describe("Task 2 packaging ownership", () => {
  it("never indexes output-manifest.json itself and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-package-"));
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(dir, name), name, "utf8");
    const command = [join(root, "scripts/package-output.py"), dir];
    await execFileAsync(process.env.PPTX_CREATOR_PYTHON || "python3", command, { cwd: root });
    const first = await readFile(join(dir, "output-manifest.json"), "utf8");
    await execFileAsync(process.env.PPTX_CREATOR_PYTHON || "python3", command, { cwd: root });
    const second = await readFile(join(dir, "output-manifest.json"), "utf8");
    expect(second).toBe(first);
    expect(JSON.parse(second).files).not.toContain("output-manifest.json");
  });

  it.each([
    "deck.plan.json",
    "semantic-slide-ir.json",
    "deck.manifest.json",
    "assets/asset-registry.json"
  ])("rejects Creative package publication when required evidence %s is missing", async (missingArtifact) => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-package-creative-evidence-"));
    await mkdir(join(dir, "assets"));
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(dir, name), name, "utf8");
    const evidence = new Map([
      ["deck.plan.json", "{}\n"],
      ["semantic-slide-ir.json", "{}\n"],
      ["deck.manifest.json", "{}\n"],
      ["assets/asset-registry.json", '{"version":"0.2.0","assets":[]}\n']
    ]);
    for (const [relative, content] of evidence) {
      if (relative !== missingArtifact) await writeFile(join(dir, relative), content, "utf8");
    }
    await writeFile(join(dir, "run.json"), `${JSON.stringify({
      mode: "creative",
      artifacts: {
        deckPlan: "deck.plan.json",
        semanticIr: "semantic-slide-ir.json",
        manifest: "deck.manifest.json",
        assetRegistry: "assets/asset-registry.json"
      }
    })}\n`, "utf8");

    await expect(execFileAsync(
      process.env.PPTX_CREATOR_PYTHON || "python3",
      [join(root, "scripts/package-output.py"), dir],
      { cwd: root }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/missing creative artifact|real regular file/i) });
    await expect(access(join(dir, "output-manifest.json"))).rejects.toThrow();
  });

  it.each([
    ["run.json is missing", null],
    ["run mode is downgraded", "direct"]
  ])("rejects Creative package publication when %s", async (_label, runMode) => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-package-creative-run-"));
    await mkdir(join(dir, "assets"));
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(dir, name), name, "utf8");
    await writeFile(join(dir, "deck.plan.json"), "{}\n", "utf8");
    await writeFile(join(dir, "semantic-slide-ir.json"), "{}\n", "utf8");
    await writeFile(join(dir, "deck.manifest.json"), "{}\n", "utf8");
    await writeFile(join(dir, "assets", "asset-registry.json"), '{"version":"0.2.0","assets":[]}\n', "utf8");
    if (runMode !== null) {
      await writeFile(join(dir, "run.json"), `${JSON.stringify({
        mode: runMode,
        artifacts: {
          deckPlan: "deck.plan.json",
          semanticIr: "semantic-slide-ir.json",
          manifest: "deck.manifest.json",
          assetRegistry: "assets/asset-registry.json"
        }
      })}\n`, "utf8");
    }

    await expect(execFileAsync(
      process.env.PPTX_CREATOR_PYTHON || "python3",
      [join(root, "scripts/package-output.py"), dir],
      { cwd: root }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/creative.*run|run.*creative/i) });
    await expect(access(join(dir, "output-manifest.json"))).rejects.toThrow();
  });

  it("rejects a Creative package when current localized bytes do not match the public registry hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-package-creative-hash-"));
    await mkdir(join(dir, "assets"));
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(dir, name), name, "utf8");
    await writeFile(join(dir, "deck.plan.json"), "{}\n", "utf8");
    await writeFile(join(dir, "semantic-slide-ir.json"), "{}\n", "utf8");
    await writeFile(join(dir, "deck.manifest.json"), "{}\n", "utf8");
    await writeFile(join(dir, "assets", "asset-photo.png"), "current localized bytes", "utf8");
    await writeFile(join(dir, "assets", "asset-registry.json"), `${JSON.stringify({
      version: "0.2.0",
      assets: [{
        id: "asset-photo",
        localPath: "assets/asset-photo.png",
        contentHash: `sha256:${"0".repeat(64)}`
      }]
    })}\n`, "utf8");
    await writeFile(join(dir, "run.json"), `${JSON.stringify({
      mode: "creative",
      artifacts: {
        deckPlan: "deck.plan.json",
        semanticIr: "semantic-slide-ir.json",
        manifest: "deck.manifest.json",
        assetRegistry: "assets/asset-registry.json"
      }
    })}\n`, "utf8");

    await expect(execFileAsync(
      process.env.PPTX_CREATOR_PYTHON || "python3",
      [join(root, "scripts/package-output.py"), dir],
      { cwd: root }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/creative asset content hash mismatch/i) });
    await expect(access(join(dir, "output-manifest.json"))).rejects.toThrow();
  });

  it("fails package publication without following an output-root symlink", async () => {
    const linkParent = await mkdtemp(join(tmpdir(), "pptx-package-root-link-parent-"));
    const victimDir = await mkdtemp(join(tmpdir(), "pptx-package-root-link-victim-"));
    const outputLink = join(linkParent, "output");
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(victimDir, name), name, "utf8");
    await symlink(victimDir, outputLink, "dir");

    await expect(execFileAsync(
      process.env.PPTX_CREATOR_PYTHON || "python3",
      [join(root, "scripts/package-output.py"), outputLink],
      { cwd: root }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/output.*real directory|symbolic link/i) });
    await expect(access(join(victimDir, "output-manifest.json"))).rejects.toThrow();
    expect((await lstat(outputLink)).isSymbolicLink()).toBe(true);
  });

  it("fails package publication through a symlink ancestor below the trusted temp anchor", async () => {
    const anchor = await mkdtemp(join(tmpdir(), "pptx-package-ancestor-anchor-"));
    const victimParent = await mkdtemp(join(tmpdir(), "pptx-package-ancestor-victim-"));
    const outputDir = join(victimParent, "output");
    const alias = join(anchor, "alias-parent");
    await mkdir(outputDir);
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(outputDir, name), name, "utf8");
    await symlink(victimParent, alias, "dir");

    await expect(execFileAsync(
      process.env.PPTX_CREATOR_PYTHON || "python3",
      [join(root, "scripts/package-output.py"), join(alias, "output")],
      { cwd: root }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/traverse a symbolic link|symlink/i) });
    await expect(access(join(outputDir, "output-manifest.json"))).rejects.toThrow();
  });

  it("does not index an asset registry through an assets symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-package-assets-link-"));
    const victimDir = await mkdtemp(join(tmpdir(), "pptx-package-assets-victim-"));
    for (const name of [
      "final.pptx", "editable-report.md", "qa-report.md", "compatibility-report.md",
      "consistency-report.json", "consistency-report.md"
    ]) await writeFile(join(dir, name), name, "utf8");
    await writeFile(join(victimDir, "asset-registry.json"), "USER-OWNED\n", "utf8");
    await symlink(victimDir, join(dir, "assets"), "dir");

    await execFileAsync(
      process.env.PPTX_CREATOR_PYTHON || "python3",
      [join(root, "scripts/package-output.py"), dir],
      { cwd: root }
    );
    const outputManifest = JSON.parse(await readFile(join(dir, "output-manifest.json"), "utf8"));
    expect(outputManifest.files).not.toContain("assets/asset-registry.json");
    expect(await readFile(join(victimDir, "asset-registry.json"), "utf8")).toBe("USER-OWNED\n");
  });

  it("keeps reports out of the renderer and removes wrapper package/review writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-render-owner-"));
    const manifest = join(root, "examples/text-input/deck.manifest.json");
    const pptx = join(dir, "final.pptx");
    await execFileAsync(process.execPath, [join(root, "scripts/render-pptx.mjs"), manifest, pptx], { cwd: root });
    expect((await stat(pptx)).size).toBeGreaterThan(1000);
    for (const report of ["editable-report.md", "qa-report.md", "compatibility-report.md"]) {
      await expect(access(join(dir, report))).rejects.toThrow();
    }
    const htmlWrapper = await readFile(join(root, "scripts/run-html-pipeline.mjs"), "utf8");
    const designWrapper = await readFile(join(root, "scripts/run-design-first-pipeline.mjs"), "utf8");
    expect(htmlWrapper).not.toContain("package-output.py");
    expect(htmlWrapper).not.toContain("repairHtmlLayout(");
    expect(htmlWrapper).toContain("prepareManifest:");
    expect(designWrapper).not.toContain("writeFileSync(path.join(outputDir, \"visual-review.json\")");
  }, 60000);

  it("documents only the unified CLI in public workflow guides", async () => {
    for (const relativePath of [
      "references/html-to-pptx.md",
      "references/html-measurement.md",
      "references/image-to-pptx.md",
      "references/pdf-to-pptx.md",
      "references/workflow.md",
      "examples/text-input/README.md",
      "examples/image-input/README.md"
    ]) {
      const content = await readFile(join(root, relativePath), "utf8");
      expect(content, relativePath).not.toMatch(/\bnode\s+scripts\//);
      expect(content, relativePath).not.toMatch(/\bpython(?:3)?\s+scripts\//);
      expect(content, relativePath).not.toMatch(/npm run (?!pptx|setup|test)/);
    }
  });
});
