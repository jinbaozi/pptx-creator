import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
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
  it("removes stale consumable outputs before a failing run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-stale-output-"));
    const manifest = join(dir, "invalid.manifest.json");
    await writeFile(manifest, JSON.stringify({ invalid: true }), "utf8");
    for (const name of ["final.pptx", "output-manifest.json", "consistency-report.json", "qa-report.md"]) {
      await writeFile(join(dir, name), "stale-success", "utf8");
    }

    await expect(pipeline.runDeckPipeline(manifest, dir)).rejects.toThrow(/validate/);
    for (const name of ["final.pptx", "output-manifest.json", "consistency-report.json", "qa-report.md"]) {
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
      "visual-regression-report.json", "preview-diff-slide-001.json", "deck.manifest.skeleton.json"
    ]) {
      await writeFile(join(dir, name), "stale-route", "utf8");
    }
    await mkdir(join(dir, "html-preview"));
    await writeFile(join(dir, "html-preview", "slide-001.png"), "stale-preview", "utf8");
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "remote-source-001.png"), "stale-generated", "utf8");
    await writeFile(join(dir, "assets", "remote-source-user.png"), "keep-prefix", "utf8");
    await writeFile(join(dir, "assets", "user-owned.png"), "keep", "utf8");
    await writeFile(join(dir, ".pptx-generated-assets.json"), JSON.stringify({
      version: "0.1.0",
      files: ["assets/remote-source-001.png"]
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
      "visual-regression-report.json", "preview-diff-slide-001.json", "deck.manifest.skeleton.json"
    ]) {
      expect(outputManifest.files).not.toContain(stale);
      await expect(access(join(dir, stale))).rejects.toThrow();
    }
    await expect(access(join(dir, "assets", "remote-source-001.png"))).rejects.toThrow();
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
      ["text", "deck.json", "out"],
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
