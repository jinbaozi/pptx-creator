import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyContextualTaste } from "../scripts/lib/contextual-taste.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import { runDeckPipeline } from "../scripts/run-deck-pipeline.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots = [];

async function temporaryDeck() {
  const directory = await mkdtemp(join(tmpdir(), "pptx-creative-repair-"));
  temporaryRoots.push(directory);
  const manifestPath = join(directory, "deck.manifest.json");
  const outputDir = join(directory, "output");
  const manifest = {
    version: "0.2.0",
    metadata: { mode: "creative", inputType: "text", qualityProfile: "creative" },
    designSystem: {
      source: join(root, "design-systems/business-neutral/DESIGN.md"),
      name: "Business Neutral"
    },
    deck: {
      title: "Initial creative state",
      language: "en-US",
      size: { preset: "wide", width: 13.333, height: 7.5, unit: "in" }
    },
    assets: [],
    slides: [{
      id: "slide-001",
      type: "cover",
      title: "Repair loop",
      background: { type: "solid", color: "#FFFFFF" },
      elements: [
        { type: "text", id: "title", text: "Repair me", x: 0.8, y: 0.8, w: 6, h: 0.8, style: { fontSize: 18, color: "#111827" } },
        { type: "shape", id: "accent", shape: "rect", x: 0.8, y: 2, w: 2.4, h: 1.2, style: { fill: "#2563EB" } }
      ]
    }]
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { directory, manifestPath, outputDir, manifest };
}

function proofBase({ accepted, manifest, review, textFit, evidenceMarker }) {
  return {
    version: "0.1.0",
    mode: "creative",
    accepted,
    expectedSlides: manifest.slides.length,
    renderedSlides: manifest.slides.length,
    decorativeBackgroundLines: 0,
    previews: ["slide-1.png"],
    contactSheet: { path: "contact-sheet.png", slideCount: manifest.slides.length, width: 640, height: 360 },
    textFit: { status: textFit.status, source: textFit.source, summary: textFit.summary },
    p0: [],
    p1: accepted ? [] : [{ type: "aesthetic-hierarchy", message: `Candidate ${evidenceMarker} still needs repair`, slideId: review.slides[0].id }],
    p2: []
  };
}

function deterministicSeams() {
  const calls = { render: [], renderSources: [], proof: [], proofQuality: [], review: [] };
  return {
    calls,
    reviewCreativeManifest(manifest) {
      const fontSize = manifest.slides[0].elements.find((element) => element.id === "title")?.style?.fontSize;
      const repaired = fontSize === 24;
      calls.review.push({ fontSize, repaired });
      return {
        deckScore: repaired ? 96 : 62,
        slopRisk: repaired ? 4 : 38,
        slides: [{
          id: "slide-001",
          score: repaired ? 94 : 58,
          scores: { slopRisk: repaired ? 4 : 38 },
          issues: repaired ? [] : [{ severity: "high", type: "aesthetic-hierarchy", message: "Hierarchy is visually weak.", target: "title" }],
          recommendedRepairs: repaired ? [] : [{ action: "updateStyle", target: "title", params: { fontSize: 24 } }]
        }]
      };
    },
    async renderCreativeArtifact({ manifest, manifestPath, pptxPath }) {
      const value = manifest ?? JSON.parse(await readFile(manifestPath, "utf8"));
      const fontSize = value.slides[0].elements.find((element) => element.id === "title")?.style?.fontSize;
      calls.render.push(fontSize);
      calls.renderSources.push(value.designSystem?.source);
      await mkdir(dirname(pptxPath), { recursive: true });
      await writeFile(pptxPath, `pptx-font-size=${fontSize}\n`, "utf8");
      const elements = value.slides.flatMap((slide) => slide.elements ?? []);
      const counter = {
        text: elements.filter((element) => element.type === "text").length,
        shape: elements.filter((element) => ["shape", "line", "icon", "chart", "diagram"].includes(element.type)).length,
        image: elements.filter((element) => element.type === "image").length,
        croppedAsset: elements.filter((element) => element.type === "cropped-asset").length,
        table: elements.filter((element) => element.type === "table").length
      };
      return { pptxPath, intermediate: { editabilityCounter: counter, countersBySlide: [counter] } };
    },
    async buildCreativeProof({ evidenceDir, outputDir, manifest, review, textFit, quality }) {
      const proofDir = evidenceDir ?? join(outputDir, "creative-proof");
      const slidesDir = join(proofDir, "slides");
      await mkdir(slidesDir, { recursive: true });
      const fontSize = manifest.slides[0].elements.find((element) => element.id === "title")?.style?.fontSize;
      const marker = `proof-font-size=${fontSize}`;
      calls.proof.push({ fontSize, proofDir });
      calls.proofQuality.push(quality);
      await writeFile(join(slidesDir, "slide-1.png"), marker, "utf8");
      await writeFile(join(slidesDir, "contact-sheet.png"), marker, "utf8");
      await writeFile(join(proofDir, "render-report.json"), `${JSON.stringify({ status: "ok", marker })}\n`, "utf8");
      return proofBase({ accepted: fontSize === 24, manifest, review, textFit, evidenceMarker: fontSize });
    }
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("creative pipeline repair", () => {
  it("renders before aesthetic acceptance, applies a safe repair, and publishes one accepted state", async () => {
    const { manifestPath, outputDir } = await temporaryDeck();
    const seams = deterministicSeams();

    const summary = await runDeckPipeline(manifestPath, outputDir, {
      mode: "creative",
      inputType: "text",
      maxRepairAttempts: 3,
      ...seams
    });

    expect(summary.status).toBe("passed");
    expect(seams.calls.render).toEqual([18, 24]);
    expect(seams.calls.proof.map(({ fontSize }) => fontSize)).toEqual([18, 24]);
    expect(summary.steps.find((step) => step.label === "creative-proof")).toMatchObject({ ok: true });
    expect(summary.steps.find((step) => step.label === "bounded-repair")).toMatchObject({ ok: true, attempts: 1 });

    const publishedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const packagedManifest = JSON.parse(await readFile(join(outputDir, "deck.manifest.json"), "utf8"));
    expect(publishedManifest.slides[0].elements.find((element) => element.id === "title").style.fontSize).toBe(24);
    expect(packagedManifest).toEqual(publishedManifest);
    expect(await readFile(join(outputDir, "final.pptx"), "utf8")).toContain("pptx-font-size=24");

    const proof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    const review = JSON.parse(await readFile(join(outputDir, "visual-review.json"), "utf8"));
    const quality = JSON.parse(await readFile(join(outputDir, "quality-report.json"), "utf8"));
    const textFit = JSON.parse(await readFile(join(outputDir, "text-fit-report.json"), "utf8"));
    const acceptedAttemptTextFit = JSON.parse(await readFile(join(outputDir, "creative-proof", "attempts", "1", "text-fit-report.json"), "utf8"));
    const consistency = JSON.parse(await readFile(join(outputDir, "consistency-report.json"), "utf8"));
    const outputManifest = JSON.parse(await readFile(join(outputDir, "output-manifest.json"), "utf8"));
    const proofSchema = JSON.parse(await readFile(join(root, "schemas/creative-proof.schema.json"), "utf8"));

    expect(proof).toMatchObject({
      accepted: true,
      quality: { deckScore: 94, slideFloor: 94, slopRisk: 4, criticalFindings: 0, editabilityLevel: 5, gate: { passed: true, reasons: [] } },
      repair: { attempts: 1, stopReason: "accepted", history: [{ iteration: 1, outcome: "accepted", comparison: 1 }] }
    });
    expect(proof.previews).toEqual(["creative-proof/slides/slide-1.png"]);
    expect(proof.contactSheet.path).toBe("creative-proof/slides/contact-sheet.png");
    expect(validateJsonSchema(proof, proofSchema)).toEqual({ valid: true, errors: [] });
    expect(review).toMatchObject({ deckScore: 94, slopRisk: 4, slides: [{ score: 94, issues: [], recommendedRepairs: [] }] });
    expect(quality).toMatchObject({ deckScore: 94, slopRisk: 4, editabilityLevel: 5, gate: { passed: true } });
    expect(textFit).toEqual(acceptedAttemptTextFit);
    expect(textFit.slides[0].elements[0].fontSize).toBe(24);
    expect(consistency.feedback.retryCount).toBe(1);
    expect(await readFile(join(outputDir, "creative-proof", "slides", "contact-sheet.png"), "utf8")).toBe("proof-font-size=24");
    expect(await readFile(join(outputDir, "creative-proof", "attempts", "1", "slides", "contact-sheet.png"), "utf8")).toBe("proof-font-size=24");
    expect(await readFile(join(outputDir, "preview", "index.html"), "utf8")).toContain("Creative quality: PASS");
    expect(outputManifest.files).toEqual(expect.arrayContaining(["creative-proof", "creative-proof.json", "quality-report.json", "visual-review.json"]));
    await expect(access(join(outputDir, "replica-evidence.json"))).rejects.toThrow();

    const second = deterministicSeams();
    const rerun = await runDeckPipeline(manifestPath, outputDir, { mode: "creative", inputType: "text", ...second });
    const rerunProof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    const rerunConsistency = JSON.parse(await readFile(join(outputDir, "consistency-report.json"), "utf8"));
    expect(rerun.steps.find((step) => step.label === "bounded-repair")).toMatchObject({ ok: true, attempts: 0 });
    expect(second.calls.render).toEqual([24]);
    expect(rerunProof.repair).toEqual({ attempts: 0, stopReason: "initial-proof-passed", history: [] });
    expect(rerunProof.previews).toEqual(["creative-proof/slides/slide-1.png"]);
    expect(rerunProof.contactSheet.path).toBe("creative-proof/slides/contact-sheet.png");
    expect(rerunConsistency.feedback.retryCount).toBe(0);
  }, 60000);

  it("ignores callback-supplied proof and independently re-proves the candidate artifact", async () => {
    const { manifestPath, outputDir } = await temporaryDeck();
    const seams = deterministicSeams();
    let proofReceivedByCallback = null;

    await expect(runDeckPipeline(manifestPath, outputDir, {
      mode: "creative",
      inputType: "text",
      maxRepairAttempts: 1,
      ...seams,
      async runRepairAttempt({ proof, artifact }) {
        proofReceivedByCallback = proof;
        return {
          proof: { version: "forged", accepted: true, p0: [], p1: [] },
          artifact: { manifest: artifact.manifest }
        };
      }
    })).rejects.toThrow(/bounded-repair/);

    expect(proofReceivedByCallback).toMatchObject({ version: "0.1.0", mode: "creative", accepted: false, quality: { deckScore: 58 } });
    expect(seams.calls.proof.map(({ fontSize }) => fontSize)).toEqual([18, 18]);
    const blocked = JSON.parse(await readFile(join(outputDir, "pipeline-blocked.json"), "utf8"));
    expect(blocked).toMatchObject({ blockedBy: "bounded-repair", steps: expect.arrayContaining([expect.objectContaining({ label: "bounded-repair", attempts: 1, stopReason: "no-improvement" })]) });
    const persisted = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(persisted.version).toBe("0.1.0");
    expect(persisted.accepted).toBe(false);
    expect(persisted.version).not.toBe("forged");
    expect(persisted.previews).toEqual(["creative-proof/slides/slide-1.png"]);
    expect(persisted.contactSheet.path).toBe("creative-proof/slides/contact-sheet.png");
    expect(await readFile(join(outputDir, "creative-proof", "slides", "contact-sheet.png"), "utf8")).toBe("proof-font-size=18");
    const attemptProof = JSON.parse(await readFile(join(outputDir, "creative-proof", "attempts", "1", "creative-proof.json"), "utf8"));
    expect(attemptProof.previews).toEqual(["creative-proof/attempts/1/slides/slide-1.png"]);
    expect(attemptProof.contactSheet.path).toBe("creative-proof/attempts/1/slides/contact-sheet.png");
    await expect(access(join(outputDir, "replica-evidence.json"))).rejects.toThrow();
  }, 60000);

  it("rolls back manifest, PPTX, and public evidence when accepted evidence cannot be staged", async () => {
    const { manifestPath, outputDir } = await temporaryDeck();
    const seams = deterministicSeams();
    const buildProofWithMissingAcceptedEvidence = seams.buildCreativeProof;
    seams.buildCreativeProof = async (args) => {
      const fontSize = args.manifest.slides[0].elements.find((element) => element.id === "title")?.style?.fontSize;
      if (fontSize !== 24) return buildProofWithMissingAcceptedEvidence(args);
      seams.calls.proof.push({ fontSize, proofDir: args.evidenceDir });
      seams.calls.proofQuality.push(args.quality);
      return proofBase({ accepted: true, manifest: args.manifest, review: args.review, textFit: args.textFit, evidenceMarker: fontSize });
    };

    await expect(runDeckPipeline(manifestPath, outputDir, {
      mode: "creative",
      inputType: "text",
      ...seams
    })).rejects.toThrow(/publication|creative-proof|slides/i);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const proof = JSON.parse(await readFile(join(outputDir, "creative-proof.json"), "utf8"));
    expect(manifest.slides[0].elements.find((element) => element.id === "title").style.fontSize).toBe(18);
    expect(await readFile(join(outputDir, "final.pptx"), "utf8")).toBe("pptx-font-size=18\n");
    expect(await readFile(join(outputDir, "creative-proof", "slides", "contact-sheet.png"), "utf8")).toBe("proof-font-size=18");
    expect(proof).toMatchObject({ accepted: false, repair: { attempts: 1, stopReason: "publication-failed" } });
    expect(proof.previews).toEqual(["creative-proof/slides/slide-1.png"]);
    await expect(access(join(outputDir, "visual-review.json"))).rejects.toThrow();
    await expect(access(join(outputDir, "quality-report.json"))).rejects.toThrow();
  }, 60000);

  it("ignores callback design and font state and independently resolves the candidate manifest", async () => {
    const { directory, manifestPath, outputDir } = await temporaryDeck();
    const seams = deterministicSeams();
    const declaredDesign = join(root, "design-systems/business-neutral/DESIGN.md");

    const summary = await runDeckPipeline(manifestPath, outputDir, {
      mode: "creative",
      inputType: "text",
      maxRepairAttempts: 1,
      ...seams,
      async runRepairAttempt({ artifact }) {
        const candidate = structuredClone(artifact.manifest);
        const title = candidate.slides[0].elements.find((element) => element.id === "title");
        title.style.fontSize = 24;
        title.style.fontFamily = "DefinitelyMissingReviewFont";
        return {
          proof: { accepted: true },
          artifact: {
            manifest: candidate,
            design: { source: join(directory, "forged-design.md"), tokens: { typography: { body: { fontSize: 99 } } } },
            fontPreflight: { source: "forged", fallback: [] },
            intermediate: { editabilityCounter: { text: 99 } }
          }
        };
      }
    });

    expect(summary.status).toBe("passed");
    expect(seams.calls.renderSources).toEqual([declaredDesign, declaredDesign]);
    expect(seams.calls.proofQuality[1].compatibility.source).not.toBe("forged");
    expect(seams.calls.proofQuality[1].compatibility.fallback).toEqual(expect.arrayContaining([
      expect.objectContaining({ requested: "DefinitelyMissingReviewFont" })
    ]));
    const published = JSON.parse(await readFile(manifestPath, "utf8"));
    const independentlyAssessed = JSON.parse(await readFile(join(outputDir, ".creative-repair", "attempt-1", "deck.manifest.json"), "utf8"));
    expect(published).toEqual(independentlyAssessed);
    const publishedDesign = published.designSystem.source.startsWith("/")
      ? published.designSystem.source
      : join(dirname(manifestPath), published.designSystem.source);
    await expect(access(publishedDesign)).resolves.toBeUndefined();
    expect(published.slides[0].elements.find((element) => element.id === "title").style.fontFamily).toBe("DefinitelyMissingReviewFont");
  }, 60000);

  it("rejects an invalid callback candidate before candidate render or proof", async () => {
    const { manifestPath, outputDir } = await temporaryDeck();
    const seams = deterministicSeams();

    await expect(runDeckPipeline(manifestPath, outputDir, {
      mode: "creative",
      inputType: "text",
      maxRepairAttempts: 1,
      ...seams,
      async runRepairAttempt({ artifact }) {
        const candidate = structuredClone(artifact.manifest);
        delete candidate.deck;
        candidate.slides[0].elements.find((element) => element.id === "title").style.fontSize = 24;
        return { artifact: { manifest: candidate } };
      }
    })).rejects.toThrow(/bounded-repair|candidate manifest/i);

    expect(seams.calls.render).toEqual([18]);
    expect(seams.calls.proof.map(({ fontSize }) => fontSize)).toEqual([18]);
    const failure = JSON.parse(await readFile(join(outputDir, ".creative-repair", "attempt-1", "materialization-failure.json"), "utf8"));
    expect(failure.reason).toMatch(/deck|required/i);
    const published = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(published.deck.title).toBe("Initial creative state");
  }, 60000);

  it("blocks missing creative editability prerequisites before rendering", async () => {
    const { manifestPath, outputDir, manifest } = await temporaryDeck();
    manifest.slides[0].elements = manifest.slides[0].elements.filter((element) => element.type === "text");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const seams = deterministicSeams();

    await expect(runDeckPipeline(manifestPath, outputDir, {
      mode: "creative",
      inputType: "text",
      ...seams
    })).rejects.toThrow(/creative-layout-taste-preflight.*editability prerequisites/i);

    expect(seams.calls.render).toEqual([]);
  });

  it("drops recommendations whose exact target has no retained issue after brand filtering", () => {
    const review = {
      deckScore: 70,
      slopRisk: 8,
      slides: [{
        id: "slide-001",
        score: 70,
        issues: [
          { severity: "medium", type: "layout-repetition", target: "accent" },
          { severity: "high", type: "text-contrast", target: "title" }
        ],
        recommendedRepairs: [
          { action: "removeElement", target: "accent", params: {} },
          { action: "updateStyle", target: "title", params: { fontSize: 24 } },
          { action: "updateStyle", target: "missing", params: { fontSize: 24 } }
        ]
      }]
    };
    const manifest = { slides: [{ id: "slide-001", type: "cover", elements: [] }] };
    const plan = { designRead: "Brand locked", dials: { compositionVariance: 0, visualDensity: 50, visualEnergy: 50 }, intentOverride: { brandLocked: true } };

    const filtered = applyContextualTaste(review, manifest, plan);

    expect(filtered.slides[0].issues.map((issue) => issue.target)).toEqual(["title"]);
    expect(filtered.slides[0].recommendedRepairs).toEqual([
      { action: "updateStyle", target: "title", params: { fontSize: 24 } }
    ]);
  });
});
