import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildFinalReviewPacket, evaluateCreativeVisualProof } from "../scripts/lib/creative-visual-proof.mjs";
import { runDeckPipeline } from "../scripts/run-deck-pipeline.mjs";

const roots = [];
const hash = (character) => `sha256:${character.repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pptx-proof-repair-"));
  roots.push(directory);
  const manifestPath = join(directory, "deck.manifest.json");
  const outputDir = join(directory, "output");
  const manifest = {
    version: "0.2.0",
    metadata: { mode: "creative", inputType: "text", qualityProfile: "creative" },
    designSystem: { source: join(process.cwd(), "design-systems/business-neutral/DESIGN.md"), name: "Business Neutral" },
    deck: { title: "Repair", language: "en-US", size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" } },
    assets: [],
    slides: [{
      id: "slide-001", type: "cover", title: "Repair", background: { type: "solid", color: "#FFFFFF" },
      elements: [
        { type: "text", id: "title", text: "Repair me", x: 0.8, y: 0.8, w: 6, h: 0.8, style: { fontSize: 18, color: "#111827" } },
        { type: "shape", id: "accent", shape: "rect", x: 0.8, y: 2, w: 2.4, h: 1.2, style: { fill: "#2563EB" } }
      ]
    }]
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, outputDir };
}

function seams() {
  const calls = { render: [], proof: [] };
  return {
    calls,
    reviewCreativeManifest(manifest) {
      const fontSize = manifest.slides[0].elements[0].style.fontSize;
      const repaired = fontSize === 24;
      return {
        deckScore: repaired ? 96 : 62,
        slopRisk: repaired ? 4 : 38,
        slides: [{
          id: "slide-001", score: repaired ? 94 : 58, scores: { slopRisk: repaired ? 4 : 38 },
          issues: repaired ? [] : [{ severity: "high", type: "aesthetic-hierarchy", message: "Hierarchy is weak.", target: "title" }],
          recommendedRepairs: repaired ? [] : [{ action: "updateStyle", target: "title", params: { fontSize: 24 } }]
        }]
      };
    },
    async renderCreativeArtifact({ manifest, manifestPath, pptxPath }) {
      const value = manifest ?? JSON.parse(await readFile(manifestPath, "utf8"));
      const fontSize = value.slides[0].elements[0].style.fontSize;
      calls.render.push(fontSize);
      await mkdir(dirname(pptxPath), { recursive: true });
      await writeFile(pptxPath, `pptx-${fontSize}`, "utf8");
      return { pptxPath, intermediate: { editabilityCounter: { text: 1, shape: 1, image: 0, croppedAsset: 0, table: 0 }, countersBySlide: [{ text: 1, shape: 1, image: 0, croppedAsset: 0, table: 0 }] } };
    },
    async buildCreativeProof({ evidenceDir, outputDir, manifest }) {
      const fontSize = manifest.slides[0].elements[0].style.fontSize;
      const repaired = fontSize === 24;
      calls.proof.push(fontSize);
      const proofDir = evidenceDir ?? join(outputDir, "creative-proof");
      await mkdir(join(proofDir, "slides"), { recursive: true });
      await writeFile(join(proofDir, "slides", "slide-1.png"), `png-${fontSize}`);
      await writeFile(join(proofDir, "slides", "contact-sheet.png"), `sheet-${fontSize}`);
      await writeFile(join(proofDir, "render-report.json"), "{}\n");
      const identity = {
        purpose: "final-deck",
        semanticIr: { path: "semantic-slide-ir.json", hash: hash("1") }, manifest: { path: "deck.manifest.json", hash: hash("2") },
        pptx: { path: "creative-proof/candidate/final.pptx", hash: hash("3") }, designTokens: { path: "design-system/DESIGN.md", hash: hash("4") },
        assetRegistry: { path: "assets/asset-registry.json", hash: hash("5") }, selection: null, refinement: null
      };
      const rendering = {
        status: "passed",
        environment: { renderer: "libreoffice", suite: "libreoffice", platform: "test", architecture: "test", libreOfficeVersion: "test", pythonVersion: "test", commandIdentity: "test-render", settings: { dpi: 96, colorMode: "RGB", timestampFree: true } },
        expectedPageCount: 1, renderedPageCount: 1,
        pages: [{ slideId: "slide-001", index: 0, path: "creative-proof/slides/slide-1.png", hash: hash("6"), width: 1280, height: 720 }],
        contactSheet: { path: "creative-proof/slides/contact-sheet.png", hash: hash("7"), width: 480, height: 304, slideIds: ["slide-001"], slideHashes: [hash("6")] },
        renderReport: { path: "creative-proof/render-report.json", hash: hash("8") }
      };
      const packet = buildFinalReviewPacket({ identity, rendering });
      return evaluateCreativeVisualProof({
        identity, rendering,
        tokenLedger: { version: "0.1.0", status: "passed", expectedSnapshotHash: hash("4"), actualSnapshotHash: hash("4"), designSystem: { name: "Business Neutral", source: "design-system/DESIGN.md" }, protectedTokens: [], drift: [], lineage: "snapshot-only" },
        assetLedger: { version: "0.1.0", status: "passed", assets: [], drift: [] },
        diagnostics: {
          thumbnailReadability: { status: "passed", checkedSlides: 1, failures: [] }, antiSlop: { status: repaired ? "passed" : "failed", risk: repaired ? 4 : 38, findings: [] },
          nativeCoverage: { status: "passed", editabilityLevel: 5, nativeObjects: 2, rasterObjects: 0 }, rhythm: { status: "passed", topologyRuns: [], densityRuns: [] },
          quality: { status: repaired ? "passed" : "failed", deckScore: repaired ? 96 : 62, slideFloor: repaired ? 94 : 58 }, visualCritic: { status: repaired ? "passed" : "failed", findings: [] }
        },
        hostReview: { packet, review: null }, selection: { status: "not-applicable", reason: "direction exploration did not occur" },
        suites: [{ suite: "libreoffice", required: true, status: "passed", environment: "test", artifacts: ["creative-proof/render-report.json"], reason: "test render" }],
        repair: { attempts: 0, stopReason: "not-run", history: [] }, refinement: { status: "not-applicable", plan: null, history: [] },
        findings: repaired ? [] : [{ severity: "P1", source: "visual-critic", type: "aesthetic-hierarchy", message: "Hierarchy is weak.", slideId: "slide-001", evidence: ["visual-review.json"] }],
        hardGateInputs: { schema: true, textFit: true, layoutSafety: true, editability: true, visualCritic: repaired }
      });
    }
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Creative Proof 0.2 repair boundary", () => {
  it("repairs deterministic defects but still requires a new Host final review", async () => {
    const { manifestPath, outputDir } = await fixture();
    const testSeams = seams();
    await expect(runDeckPipeline(manifestPath, outputDir, { mode: "creative", inputType: "text", maxRepairAttempts: 3, ...testSeams }))
      .rejects.toThrow(/host-final-visual-review/);
    expect(testSeams.calls.render).toEqual([18, 24]);
    expect(testSeams.calls.proof).toEqual([18, 24, 24]);
    const proof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(proof).toMatchObject({ version: "0.2.0", accepted: false, acceptance: { status: "awaiting-host-review" }, repair: { attempts: 1 } });
    expect(JSON.parse(await readFile(join(outputDir, "pipeline-blocked.json"), "utf8")).blockedBy).toBe("host-final-visual-review");
    expect(existsSync(join(outputDir, "creative-proof", "candidate", "final.pptx"))).toBe(false);
    for (const name of ["final.pptx", "run.json", "output-manifest.json"]) expect(existsSync(join(outputDir, name))).toBe(false);
    await expect(access(join(outputDir, "replica-evidence.json"))).rejects.toThrow();
  }, 60_000);

  it("never accepts a callback-supplied forged proof", async () => {
    const { manifestPath, outputDir } = await fixture();
    const testSeams = seams();
    await expect(runDeckPipeline(manifestPath, outputDir, {
      mode: "creative", inputType: "text", maxRepairAttempts: 1, ...testSeams,
      async runRepairAttempt({ artifact }) { return { proof: { version: "forged", accepted: true }, artifact: { manifest: artifact.manifest } }; }
    })).rejects.toThrow(/bounded-repair/);
    const proof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(proof.version).toBe("0.2.0");
    expect(proof.accepted).toBe(false);
  }, 60_000);
});
