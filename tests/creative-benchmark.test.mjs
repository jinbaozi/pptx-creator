import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { compileDeckPlanArtifacts, validateDeckPlan } from "../scripts/lib/deck-plan.mjs";
import { validateJsonSchema } from "../scripts/lib/schema-utils.mjs";
import {
  BENCHMARK_THRESHOLDS,
  buildBlindReviewHtml,
  createBlindedReviewBundle,
  evaluateBlindPreference,
  loadCreativeBenchmarkCorpus,
  portableArtifactManifest,
  selectLaneBriefs,
  validateBenchmarkCorpus,
  validateBlindReviewRecord,
  wilsonLowerBound
} from "../scripts/lib/blind-preference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = loadCreativeBenchmarkCorpus(root);
const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas/blind-preference.schema.json"), "utf8"));
const dimensions = ["hierarchy", "spacing", "density", "consistency", "originality"];

function artifactsFor(items = corpus.briefs) {
  return items.flatMap((brief) => ["reference", "challenger"].map((kind) => ({
    briefId: brief.id,
    kind,
    artifactId: `${brief.id}-${kind}`,
    identityAttestation: { status: "passed", scope: "generator-identity", reviewerFacingNamesNeutral: true },
    evidence: {
      pptx: `artifacts/${brief.id}/${kind}/deck.pptx`,
      slides: `artifacts/${brief.id}/${kind}/slides`,
      contactSheet: `artifacts/${brief.id}/${kind}/contact-sheet.png`,
      proof: `artifacts/${brief.id}/${kind}/creative-proof.json`
    }
  })));
}

function passingReviews(bundle) {
  return bundle.packet.pairs.flatMap((pair) => Array.from({ length: 5 }, (_, index) => {
    const reviewerId = `reviewer-${index + 1}`;
    const challengerSide = bundle.answerKey.pairs.find((item) => item.pairId === pair.pairId).challengerSide;
    const sideRatings = (value) => Object.fromEntries(dimensions.map((dimension) => [dimension, value]));
    return {
      version: "0.1.0",
      pairId: pair.pairId,
      reviewerId,
      selected: challengerSide,
      ratings: {
        left: sideRatings(challengerSide === "left" ? 4 : 3),
        right: sideRatings(challengerSide === "right" ? 4 : 3)
      },
      submittedAt: `2026-07-14T0${index}:00:00.000Z`
    };
  }));
}

describe("creative benchmark corpus", () => {
  it("contains 24 balanced bilingual briefs across all six target domains", () => {
    expect(validateBenchmarkCorpus(corpus)).toEqual({ valid: true, errors: [] });
    expect(corpus.briefs).toHaveLength(24);
    expect(new Set(corpus.briefs.map((brief) => brief.domain))).toEqual(new Set([
      "executive", "technical", "product-launch", "data-review", "public-sector", "editorial-education"
    ]));
    expect(corpus.briefs.filter((brief) => brief.language === "zh-CN")).toHaveLength(12);
    expect(corpus.briefs.filter((brief) => brief.language === "en-US")).toHaveLength(12);
    for (const domain of new Set(corpus.briefs.map((brief) => brief.domain))) {
      const domainBriefs = corpus.briefs.filter((brief) => brief.domain === domain);
      expect(domainBriefs, domain).toHaveLength(4);
      expect(domainBriefs.filter((brief) => brief.language === "zh-CN"), domain).toHaveLength(2);
      expect(domainBriefs.filter((brief) => brief.language === "en-US"), domain).toHaveLength(2);
    }
  });

  it("carries complete source evidence and compiles every brief through deck.plan 0.2", () => {
    for (const brief of corpus.briefs) {
      expect(brief.input.intent, brief.id).toBeTruthy();
      expect(brief.input.audience, brief.id).toBeTruthy();
      expect(brief.evidence.length, brief.id).toBeGreaterThanOrEqual(2);
      expect(brief.evidence.every((item) => item.id && item.claim && item.sourceRef && item.rights), brief.id).toBe(true);
      const plan = corpus.materializePlan(brief);
      expect(validateDeckPlan(plan), brief.id).toEqual({ valid: true, errors: [] });
      const { ir, manifest } = compileDeckPlanArtifacts(plan);
      expect(ir.slides, brief.id).toHaveLength(1);
      expect(manifest.slides, brief.id).toHaveLength(1);
    }
  });

  it("selects deterministic lane coverage without weakening the full corpus", () => {
    expect(selectLaneBriefs(corpus, "fast")).toHaveLength(24);
    const render = selectLaneBriefs(corpus, "render");
    expect(render.length).toBeGreaterThanOrEqual(8);
    expect(new Set(render.map((brief) => brief.domain)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(render.map((brief) => brief.language))).toEqual(new Set(["zh-CN", "en-US"]));
    expect(selectLaneBriefs(corpus, "nightly")).toHaveLength(24);
    expect(selectLaneBriefs(corpus, "release")).toHaveLength(24);
  });

  it("writes the brief language into editable text OOXML for CJK rendering", async () => {
    const brief = corpus.briefs.find((item) => item.language === "zh-CN");
    const plan = corpus.materializePlan(brief);
    const { manifest } = compileDeckPlanArtifacts(plan, {
      designTokens: { typography: { title: { fontFamily: "PingFang SC" }, body: { fontFamily: "PingFang SC" } } }
    });
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "creative-benchmark-lang-"));
    const manifestPath = path.join(output, "deck.manifest.json");
    const designPath = path.join(output, manifest.designSystem.source);
    fs.mkdirSync(path.dirname(designPath), { recursive: true });
    fs.copyFileSync(path.join(root, manifest.designSystem.source), designPath);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const pptxPath = path.join(output, "deck.pptx");
    execFileSync(process.execPath, [path.join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root, stdio: "pipe" });
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    expect(xml).toContain('lang="zh-CN"');
    expect(xml).toContain('<a:ea typeface="PingFang SC"');
  });
});

describe("blind preference protocol", () => {
  it("publishes portable challenger evidence and an offline reviewer handoff", () => {
    const outputRoot = path.join(os.tmpdir(), "creative-portable-output");
    const artifacts = artifactsFor(corpus.briefs.slice(0, 1)).filter((artifact) => artifact.kind === "challenger").map((artifact) => ({
      ...artifact,
      evidence: Object.fromEntries(Object.entries(artifact.evidence).map(([key, value]) => [key, path.join(outputRoot, value)]))
    }));
    const portable = portableArtifactManifest(artifacts, outputRoot);
    expect(portable).toHaveLength(1);
    expect(portable[0]).toMatchObject({
      briefId: corpus.briefs[0].id,
      kind: "challenger",
      artifactId: `${corpus.briefs[0].id}-challenger`,
      identityAttestation: { status: "passed", scope: "generator-identity", reviewerFacingNamesNeutral: true }
    });
    expect(Object.values(portable[0].evidence).every((value) => !path.isAbsolute(value))).toBe(true);

    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "creative-portable-real-"));
    const aliasRoot = `${realRoot}-alias`;
    fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(path.join(realRoot, "slides"));
    for (const target of ["deck.pptx", "contact-sheet.png", "creative-proof.json"]) fs.writeFileSync(path.join(realRoot, target), target);
    const aliasPortable = portableArtifactManifest([{ ...artifacts[0], evidence: {
      pptx: path.join(realRoot, "deck.pptx"), slides: path.join(realRoot, "slides"),
      contactSheet: path.join(realRoot, "contact-sheet.png"), proof: path.join(realRoot, "creative-proof.json")
    } }], aliasRoot);
    expect(aliasPortable[0].evidence.pptx).toBe("deck.pptx");

    const bundle = createBlindedReviewBundle({ corpus, artifacts: artifactsFor(), seed: "offline-review-handoff" });
    expect(bundle.packet.pairs[0].reviewContext).toEqual({
      brief: corpus.briefs[0].brief,
      intent: corpus.briefs[0].input.intent,
      audience: corpus.briefs[0].input.audience
    });
    const html = buildBlindReviewHtml(bundle.packet);
    expect(html).toContain(bundle.packet.packetHash);
    expect(bundle.packet.pairs.every((pair) => html.includes(pair.pairId))).toBe(true);
    expect(html).toContain(corpus.briefs[0].brief);
    expect(html).toContain("review-records.json");
    expect(html).not.toMatch(/baseline|candidate|challenger|reference|generator|model/i);
  });

  it("randomizes opaque sides and keeps the answer key outside the reviewer packet", () => {
    const first = createBlindedReviewBundle({ corpus, artifacts: artifactsFor(), seed: "release-2026-07" });
    const second = createBlindedReviewBundle({ corpus, artifacts: artifactsFor(), seed: "release-2026-07" });
    expect(first).toEqual(second);
    expect(first.packet.pairs).toHaveLength(24);
    expect(new Set(first.packet.pairs.map((pair) => pair.left.artifactId))).not.toHaveLength(1);
    const publicText = JSON.stringify(first.packet).toLowerCase();
    expect(publicText).not.toMatch(/baseline|candidate|challenger|generator|model|answerkey/);
    expect(first.answerKey.pairs).toHaveLength(24);
    expect(first.answerKey.packetHash).toBe(first.packet.packetHash);
  });

  it("rejects review records that leak generator identity or omit closed ratings", () => {
    const valid = {
      version: "0.1.0", pairId: "pair-001", reviewerId: "reviewer-1", selected: "left",
      ratings: {
        left: Object.fromEntries(dimensions.map((dimension) => [dimension, 4])),
        right: Object.fromEntries(dimensions.map((dimension) => [dimension, 3]))
      },
      submittedAt: "2026-07-14T00:00:00.000Z"
    };
    expect(validateBlindReviewRecord(valid)).toEqual({ valid: true, errors: [] });
    expect(validateBlindReviewRecord({ ...valid, generator: "candidate" }).valid).toBe(false);
    expect(validateBlindReviewRecord({ ...valid, reviewerId: "candidate-reviewer" }).valid).toBe(false);
    expect(validateBlindReviewRecord({ ...valid, ratings: { left: { hierarchy: 5 }, right: valid.ratings.right } }).valid).toBe(false);
  });

  it("calculates Wilson lower bounds and closed domain/language subgroup reports", () => {
    expect(wilsonLowerBound(70, 100)).toBeCloseTo(0.604, 3);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    const bundle = createBlindedReviewBundle({ corpus, artifacts: artifactsFor(), seed: "release-proof" });
    const report = evaluateBlindPreference({ corpus, bundle, reviews: passingReviews(bundle) });
    expect(report.status).toBe("passed");
    expect(report.sample.briefs).toBe(24);
    expect(report.sample.reviewersPerBrief.minimum).toBe(5);
    expect(report.overall.winRate).toBe(1);
    expect(report.overall.wilson95LowerBound).toBeGreaterThan(0.5);
    expect(Object.keys(report.subgroups.domain)).toHaveLength(6);
    expect(Object.keys(report.subgroups.language)).toEqual(["en-US", "zh-CN"]);
    expect(Object.values(report.medians)).toEqual([4, 4, 4, 4, 4]);
    expect(report.thresholds).toEqual(BENCHMARK_THRESHOLDS);
    expect(validateJsonSchema(report, schema)).toEqual({ valid: true, errors: [] });
  });

  it("fails closed when the five-reviewer release evidence is incomplete", () => {
    const bundle = createBlindedReviewBundle({ corpus, artifacts: artifactsFor(), seed: "incomplete" });
    const reviews = passingReviews(bundle).filter((review) => review.reviewerId !== "reviewer-5");
    const report = evaluateBlindPreference({ corpus, bundle, reviews });
    expect(report.status).toBe("unproven");
    expect(report.failures).toContain("reviewers-per-brief");
  });
});

describe("benchmark command contract", () => {
  it("exposes the four lanes and writes an offline fast-lane report", () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "creative-benchmark-"));
    execFileSync(process.execPath, [path.join(root, "scripts/run-creative-benchmark.mjs"), "--lane", "fast", "--output", output], {
      cwd: root,
      env: { ...process.env, PPTX_CREATOR_PYTHON: process.env.PPTX_CREATOR_PYTHON || "/opt/homebrew/bin/python3.12" },
      stdio: "pipe",
      timeout: 300_000
    });
    const report = JSON.parse(fs.readFileSync(path.join(output, "benchmark-report.json"), "utf8"));
    expect(report).toMatchObject({ version: "0.1.0", lane: "fast", status: "passed", networkUsed: false, llmUsed: false });
    expect(report.briefs).toHaveLength(24);
    expect(report.contracts).toEqual(expect.arrayContaining(["schema", "compiler", "anti-slop", "repair"]));
  }, 310_000);

  it("prepares an offline handoff before evaluating separate reviewer files", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "creative-release-contract-"));
    const source = path.join(workspace, "source");
    fs.mkdirSync(path.join(source, "slides"), { recursive: true });
    const plan = corpus.materializePlan(corpus.briefs[0]);
    const { manifest } = compileDeckPlanArtifacts(plan);
    const manifestPath = path.join(source, "deck.manifest.json");
    const designPath = path.join(source, manifest.designSystem.source);
    fs.mkdirSync(path.dirname(designPath), { recursive: true });
    fs.copyFileSync(path.join(root, manifest.designSystem.source), designPath);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const pptxPath = path.join(source, "deck.pptx");
    execFileSync(process.execPath, [path.join(root, "scripts/render-pptx.mjs"), manifestPath, pptxPath], { cwd: root, stdio: "pipe" });
    const png = path.join(root, "examples/image-input/business-slide.png");
    fs.copyFileSync(png, path.join(source, "slides/slide-1.png"));
    fs.copyFileSync(png, path.join(source, "contact-sheet.png"));
    fs.writeFileSync(path.join(source, "creative-proof.json"), JSON.stringify({ generator: "candidate-engine", status: "passed" }), "utf8");
    const alternate = path.join(workspace, "alternate");
    fs.mkdirSync(path.join(alternate, "slides"), { recursive: true });
    const alternateManifest = structuredClone(manifest);
    const alternateText = alternateManifest.slides[0].elements.find((element) => element.type === "text");
    alternateText.text = `${alternateText.text} — alternate fixture`;
    const alternateManifestPath = path.join(alternate, "deck.manifest.json");
    const alternateDesignPath = path.join(alternate, alternateManifest.designSystem.source);
    fs.mkdirSync(path.dirname(alternateDesignPath), { recursive: true });
    fs.copyFileSync(path.join(root, alternateManifest.designSystem.source), alternateDesignPath);
    fs.writeFileSync(alternateManifestPath, JSON.stringify(alternateManifest), "utf8");
    const alternatePptxPath = path.join(alternate, "deck.pptx");
    execFileSync(process.execPath, [path.join(root, "scripts/render-pptx.mjs"), alternateManifestPath, alternatePptxPath], { cwd: root, stdio: "pipe" });
    const alternatePng = path.join(root, "examples/image-input/replica-golden.png");
    fs.copyFileSync(alternatePng, path.join(alternate, "slides/slide-1.png"));
    fs.copyFileSync(alternatePng, path.join(alternate, "contact-sheet.png"));
    fs.writeFileSync(path.join(alternate, "creative-proof.json"), JSON.stringify({ generator: "alternate-engine", status: "passed" }), "utf8");
    const artifacts = artifactsFor().map((artifact) => ({
      ...artifact,
      ...(artifact.kind === "challenger" ? { artifactId: `${artifact.briefId}-alternate` } : {}),
      evidence: {
        pptx: artifact.kind === "challenger" ? alternatePptxPath : pptxPath,
        slides: path.join(artifact.kind === "challenger" ? alternate : source, "slides"),
        contactSheet: path.join(artifact.kind === "challenger" ? alternate : source, "contact-sheet.png"),
        proof: path.join(artifact.kind === "challenger" ? alternate : source, "creative-proof.json")
      }
    }));
    const seed = "synthetic-contract-only";
    const bundle = createBlindedReviewBundle({ corpus, artifacts, seed });
    const portable = artifacts.map((artifact) => ({
      ...artifact,
      evidence: Object.fromEntries(Object.entries(artifact.evidence).map(([key, value]) => [key, path.relative(workspace, value)]))
    }));
    const leftArtifactsPath = path.join(workspace, "left-artifacts.json");
    const rightArtifactsPath = path.join(workspace, "right-artifacts.json");
    fs.writeFileSync(leftArtifactsPath, JSON.stringify(portable.filter((artifact) => artifact.kind === "reference")), "utf8");
    fs.writeFileSync(rightArtifactsPath, JSON.stringify(portable.filter((artifact) => artifact.kind === "challenger")), "utf8");
    const prepareOutput = path.join(workspace, "prepare-output");
    execFileSync(process.execPath, [
      path.join(root, "scripts/run-creative-benchmark.mjs"), "--lane", "release", "--output", prepareOutput,
      "--artifacts", leftArtifactsPath, "--artifacts", rightArtifactsPath, "--seed", seed, "--prepare-review"
    ], { cwd: root, stdio: "pipe", timeout: 60_000 });
    const prepareReport = JSON.parse(fs.readFileSync(path.join(prepareOutput, "benchmark-report.json"), "utf8"));
    expect(prepareReport.status).toBe("awaiting-human-review");
    const preparedPacket = JSON.parse(fs.readFileSync(path.join(prepareOutput, "blind-review-packet.json"), "utf8"));
    expect(preparedPacket.packetHash).toBe(bundle.packet.packetHash);
    const reviewerHtml = fs.readFileSync(path.join(prepareOutput, "reviewer/index.html"), "utf8");
    expect(reviewerHtml).toContain(bundle.packet.pairs[0].pairId);
    expect(reviewerHtml).not.toMatch(/baseline|candidate|challenger|reference|generator|model/i);

    const reviewPaths = Array.from({ length: 5 }, (_, index) => {
      const target = path.join(workspace, `reviewer-${index + 1}.json`);
      fs.writeFileSync(target, JSON.stringify(passingReviews(bundle).filter((review) => review.reviewerId === `reviewer-${index + 1}`)), "utf8");
      return target;
    });
    const output = path.join(workspace, "evaluate-output");
    const evaluationArgs = [
      path.join(root, "scripts/run-creative-benchmark.mjs"), "--lane", "release", "--output", output,
      "--artifacts", leftArtifactsPath, "--artifacts", rightArtifactsPath, "--seed", seed
    ];
    for (const reviewPath of reviewPaths) evaluationArgs.push("--reviews", reviewPath);
    execFileSync(process.execPath, evaluationArgs, { cwd: root, stdio: "pipe", timeout: 60_000 });
    const report = JSON.parse(fs.readFileSync(path.join(output, "benchmark-report.json"), "utf8"));
    expect(report.status).toBe("passed");
    expect(report.evidence).not.toContain("private/answer-key.json");
    expect(fs.existsSync(path.join(output, "private/answer-key.json"))).toBe(true);
    const publicPacketText = fs.readFileSync(path.join(output, "blind-review-packet.json"), "utf8");
    expect(publicPacketText).not.toMatch(/baseline|candidate|challenger|reference|generator|model/i);
    expect(JSON.parse(publicPacketText).packetHash).toBe(preparedPacket.packetHash);
    const firstPair = bundle.packet.pairs[0];
    const publicPptx = path.join(output, firstPair.left.evidence.pptx);
    const publicZip = await JSZip.loadAsync(fs.readFileSync(publicPptx));
    const metadata = await Promise.all(Object.keys(publicZip.files).filter((name) => name.startsWith("docProps/") && name.endsWith(".xml")).map((name) => publicZip.file(name).async("string")));
    expect(metadata.join("\n").toLowerCase()).not.toMatch(/baseline|candidate|challenger|reference|generator|model/);
    const receipt = fs.readFileSync(path.join(output, firstPair.left.evidence.proof), "utf8").toLowerCase();
    expect(receipt).not.toMatch(/baseline|candidate|challenger|reference|generator|model/);
  }, 65_000);
});
