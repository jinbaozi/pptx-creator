import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyCreativeDirection,
  buildDiagnosticEvidence,
  buildCreativeCandidateSet,
  buildBlindPacket,
  buildRequiredBlindPairs,
  candidateBudget,
  candidateSetHash,
  deriveExplorationId,
  filterProbeManifest,
  materializedCandidateSignature,
  planContentHash,
  probeSemanticContentHash,
  prepareBlindExploration,
  recordBlindSelection,
  selectProbeSlides,
  shouldExploreDirections,
  validateCreativeDirectionRequest,
  validateCandidateSetDocument,
  validateCreativeSelectionDocument,
  validateHostReview,
  validateSubstantiveDifferences
} from "../scripts/lib/creative-candidates.mjs";

const basePlan = JSON.parse(fs.readFileSync("examples/text-input/creative/deck.plan.json", "utf8"));
const clone = (value) => structuredClone(value);

function profilePlan(profile, overrides = {}) {
  const plan = clone(basePlan);
  plan.context.qualityProfile = profile;
  Object.assign(plan.context, overrides.context ?? {});
  Object.assign(plan.designIntent.dials, overrides.dials ?? {});
  Object.assign(plan.designIntent.locks, overrides.locks ?? {});
  if (overrides.assets) plan.assets = clone(overrides.assets);
  if (overrides.slides) plan.slides = clone(overrides.slides);
  return plan;
}

function direction(id, axes = ["layout-topology", "hierarchy"], projection = {}) {
  return {
    id,
    label: `${id} private label`,
    rationale: `${id} changes the visual system materially`,
    declaredAxes: axes,
    projection: {
      designSystem: "business-neutral",
      dials: { compositionVariance: 80 },
      slides: [{ slideId: "slide-cover", blockId: "editorial-poster" }],
      ...projection
    }
  };
}

function request(plan, directions = [direction("direction-a"), direction("direction-b", ["typography", "density"], {
  designSystem: "warm-editorial",
  dials: { visualDensity: 35 },
  slides: [{ slideId: "slide-cover", blockId: "minimal-statement" }]
})]) {
  return { version: "0.1.0", planHash: planContentHash(plan), directions };
}

function candidate(id, blindMaterial = {}) {
  return {
    id,
    baseIrHash: "sha256:" + "a".repeat(64),
    probeContentHash: "sha256:" + "b".repeat(64),
    editabilityLevel: 4,
    route: "native",
    observed: {
      "layout-topology": blindMaterial.layout ?? id,
      hierarchy: blindMaterial.hierarchy ?? id,
      typography: blindMaterial.typography ?? "shared-type",
      density: blindMaterial.density ?? 50,
      "color-material": blindMaterial.color ?? "shared-color",
      "asset-strategy": blindMaterial.assets ?? "shared-assets",
      "diagram-strategy": blindMaterial.diagram ?? "shared-diagram",
      "deck-rhythm": blindMaterial.rhythm ?? "shared-rhythm"
    }
  };
}

describe("Task 7 candidate budget and deterministic eligibility", () => {
  it("returns exact 1/3/4 caps and rejects unknown profiles", () => {
    expect(candidateBudget("standard")).toBe(1);
    expect(candidateBudget("premium")).toBe(3);
    expect(candidateBudget("flagship")).toBe(4);
    expect(() => candidateBudget("enterprise")).toThrow(/unknown quality profile/i);
  });

  it("never explores standard, always explores flagship, and returns every active signal", () => {
    const standard = shouldExploreDirections(profilePlan("standard", { context: { visualAmbition: 100 }, dials: { compositionVariance: 100 } }));
    expect(standard).toMatchObject({ explore: false, maxCandidates: 1 });
    const flagship = shouldExploreDirections(profilePlan("flagship"));
    expect(flagship).toMatchObject({ explore: true, maxCandidates: 4 });
    expect(flagship.reasons).toContain("flagship-profile");
    expect(Object.keys(flagship.signals).sort()).toEqual([
      "assetIntensity", "brand", "complexSlides", "compositionVariance", "visualAmbition"
    ]);
  });

  it("explores premium only at two material-risk signals without mutating input", () => {
    const low = profilePlan("premium", { context: { visualAmbition: 79, assetIntensity: 59 }, dials: { compositionVariance: 74 } });
    const snapshot = JSON.stringify(low);
    expect(shouldExploreDirections(low)).toMatchObject({ explore: false, maxCandidates: 3 });
    expect(JSON.stringify(low)).toBe(snapshot);

    const high = profilePlan("premium", { context: { visualAmbition: 80 }, dials: { compositionVariance: 75 } });
    const result = shouldExploreDirections(high);
    expect(result.explore).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining(["visual-ambition", "composition-variance"]));
  });

  it("counts brand, asset, and complex-family signals exactly once", () => {
    const plan = profilePlan("premium", {
      context: { visualAmbition: 10, assetIntensity: 60 },
      dials: { compositionVariance: 10 },
      locks: { brandLocked: true }
    });
    const result = shouldExploreDirections(plan);
    expect(result.explore).toBe(true);
    expect(result.signals).toMatchObject({ brand: true, assetIntensity: true });
  });
});

describe("adaptive semantic probe selection", () => {
  it("returns one- and two-slide decks exactly once", () => {
    expect(selectProbeSlides(profilePlan("flagship", { slides: basePlan.slides.slice(0, 1) }))).toEqual([basePlan.slides[0].id]);
    expect(selectProbeSlides(profilePlan("flagship", { slides: basePlan.slides.slice(0, 2) }))).toEqual(basePlan.slides.slice(0, 2).map((slide) => slide.id));
  });

  it("selects cover, modal-family representative, and highest-complexity remainder stably", () => {
    const plan = profilePlan("flagship");
    const snapshot = JSON.stringify(plan);
    const selected = selectProbeSlides(plan);
    expect(selected).toHaveLength(3);
    expect(selected[0]).toBe("slide-cover");
    expect(new Set(selected).size).toBe(selected.length);
    expect(JSON.stringify(plan)).toBe(snapshot);
    expect(selectProbeSlides(plan)).toEqual(selected);
  });

  it("falls back to the first slide when no pageRole cover exists", () => {
    const slides = clone(basePlan.slides.slice(1, 5));
    expect(selectProbeSlides(profilePlan("flagship", { slides }))[0]).toBe(slides[0].id);
  });

  it("hashes probe semantics independently from direction styling and filters only the manifest", () => {
    const plan = profilePlan("flagship");
    const ids = selectProbeSlides(plan);
    const projected = applyCreativeDirection(plan, direction("direction-a"));
    expect(probeSemanticContentHash(plan, ids)).toBe(probeSemanticContentHash(projected, ids));
    const manifest = { version: "0.2.0", slides: plan.slides.map((slide) => ({ id: slide.id, elements: [] })) };
    expect(filterProbeManifest(manifest, ids).slides.map((slide) => slide.id)).toEqual(ids);
    expect(manifest.slides).toHaveLength(plan.slides.length);
  });
});

describe("closed Host direction requests", () => {
  it("accepts a bounded coordinate-free request bound to the plan hash", () => {
    const plan = profilePlan("flagship");
    expect(validateCreativeDirectionRequest(request(plan), { plan, maxCandidates: 4 })).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ["stale plan hash", (value) => { value.planHash = "sha256:" + "0".repeat(64); }],
    ["raw coordinates", (value) => { value.directions[0].projection.slides[0].x = 1; }],
    ["raw colors", (value) => { value.directions[0].projection.color = "#ff0000"; }],
    ["remote design system", (value) => { value.directions[0].projection.designSystem = "https://example.com/design.md"; }],
    ["unknown slide", (value) => { value.directions[0].projection.slides[0].slideId = "slide-missing"; }],
    ["unknown block", (value) => { value.directions[0].projection.slides[0].blockId = "not-a-real-block"; }],
    ["raster canonical route", (value) => { value.directions[0].projection.route = "local-raster"; }],
    ["duplicate IDs", (value) => { value.directions[1].id = value.directions[0].id; }]
  ])("rejects %s", (_label, mutate) => {
    const plan = profilePlan("flagship");
    const value = request(plan);
    mutate(value);
    expect(validateCreativeDirectionRequest(value, { plan, maxCandidates: 4 }).valid).toBe(false);
  });

  it("enforces Host-selected count variability and the profile cap", () => {
    const plan = profilePlan("premium", { context: { visualAmbition: 80 }, dials: { compositionVariance: 75 } });
    expect(validateCreativeDirectionRequest(request(plan), { plan, maxCandidates: 3 }).valid).toBe(true);
    const over = request(plan, [direction("a"), direction("b"), direction("c"), direction("d")]);
    expect(validateCreativeDirectionRequest(over, { plan, maxCandidates: 3 }).errors.join(" ")).toMatch(/cap|at most/i);
  });

  it("applies projections to a clone and respects protected locks", () => {
    const plan = profilePlan("flagship");
    const snapshot = JSON.stringify(plan);
    const projected = applyCreativeDirection(plan, direction("direction-a"));
    expect(projected).not.toBe(plan);
    expect(projected.designIntent.dials.compositionVariance).toBe(80);
    expect(projected.slides[0].compositionIntent.blockId).toBe("editorial-poster");
    expect(JSON.stringify(plan)).toBe(snapshot);

    plan.designIntent.locks.sourceLocked = true;
    expect(validateCreativeDirectionRequest(request(plan), { plan, maxCandidates: 4 }).errors.join(" ")).toMatch(/locked plan directions/i);
    const lockedRequest = request(plan, [
      direction("direction-a", ["layout-topology", "hierarchy"], { designSystem: "warm-editorial" }),
      direction("direction-b", ["typography", "density"], { designSystem: "warm-editorial" })
    ]);
    expect(validateCreativeDirectionRequest(lockedRequest, {
      plan,
      maxCandidates: 4,
      lockedDesignSystem: "warm-editorial"
    })).toEqual({ valid: true, errors: [] });
    lockedRequest.directions[1].projection.designSystem = "paper-minimal";
    expect(validateCreativeDirectionRequest(lockedRequest, {
      plan,
      maxCandidates: 4,
      lockedDesignSystem: "warm-editorial"
    }).errors.join(" ")).toMatch(/violates the locked design system warm-editorial/i);
    plan.designIntent.locks.sourceLocked = false;
    plan.designIntent.locks.protectedTokens = ["designIntent.dials.compositionVariance"];
    expect(validateCreativeDirectionRequest(request(plan), { plan, maxCandidates: 4 }).errors.join(" ")).toMatch(/protected dial/i);
  });
});

describe("materialized candidate differences", () => {
  it("derives observed signatures from materialized plan/IR/manifest evidence", () => {
    const plan = profilePlan("flagship");
    const manifest = { assets: [], slides: [{ id: "slide-cover", elements: [{ type: "text", role: "title", fontFamily: "Inter", fontSize: 36, color: "#111111" }] }] };
    const ir = { slides: [{ id: "slide-cover", composition: { resolvedBlockId: "editorial-poster" } }] };
    const signature = materializedCandidateSignature({ plan, ir, manifest, designSystemName: "business-neutral" });
    expect(Object.keys(signature).sort()).toEqual([
      "asset-strategy", "color-material", "deck-rhythm", "density", "diagram-strategy", "hierarchy", "layout-topology", "typography"
    ]);
    expect(Object.values(signature).every((value) => /^sha256:[a-f0-9]{64}$/.test(value))).toBe(true);
  });

  it("computes fixed 100-point diagnostic weights while keeping slop separate", () => {
    const evidence = buildDiagnosticEvidence({
      manifest: { assets: [{ id: "a" }] },
      review: { deckScore: 90, slopRisk: 11, slides: [{ scores: { hierarchy: 80, alignment: 90, variety: 70, designSystemFit: 85, contrast: 75, density: 82, compatibility: 92 } }] }
    });
    expect(Object.values(evidence.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(evidence.weightedScore).toBeGreaterThan(0);
    expect(evidence.slopRisk).toBe(11);
  });

  it("requires two observed axes per pair and three across sets larger than two", () => {
    expect(validateSubstantiveDifferences([candidate("a"), candidate("b")]).valid).toBe(true);
    const onlyColor = [candidate("a", { layout: "same", hierarchy: "same", color: "blue" }), candidate("b", { layout: "same", hierarchy: "same", color: "red" })];
    expect(validateSubstantiveDifferences(onlyColor).valid).toBe(false);
    const three = [candidate("a"), candidate("b"), candidate("c", { typography: "new-type" })];
    expect(validateSubstantiveDifferences(three).valid).toBe(true);
  });

  it("rejects semantic drift, raster-only routes, and editability below floor", () => {
    const semanticDrift = [candidate("a"), { ...candidate("b"), probeContentHash: "sha256:" + "c".repeat(64) }];
    expect(validateSubstantiveDifferences(semanticDrift, { editabilityFloor: 4 }).valid).toBe(false);
    expect(validateSubstantiveDifferences([{ ...candidate("a"), route: "local-raster" }, candidate("b")], { editabilityFloor: 4 }).valid).toBe(false);
    expect(validateSubstantiveDifferences([{ ...candidate("a"), editabilityLevel: 3 }, candidate("b")], { editabilityFloor: 4 }).valid).toBe(false);
  });

  it("rejects a declared axis that never materializes in observed artifacts", () => {
    const left = { ...candidate("a"), declaredAxes: ["typography", "layout-topology"] };
    const right = { ...candidate("b"), declaredAxes: ["typography", "hierarchy"] };
    expect(validateSubstantiveDifferences([left, right]).errors.join(" ")).toMatch(/typography did not materialize/i);
  });
});

describe("blind packet and two-stage Host selection", () => {
  const candidates = [candidate("direction-a"), candidate("direction-b"), candidate("direction-c", { typography: "new-type" })];

  it("derives stable exploration and candidate-set hashes", () => {
    const plan = profilePlan("flagship");
    const directions = request(plan);
    expect(deriveExplorationId("sha256:" + "a".repeat(64), directions)).toMatch(/^explore-[a-f0-9]{24}$/);
    expect(candidateSetHash(candidates)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidateSetHash(candidates)).toBe(candidateSetHash(clone(candidates)));
  });

  it("publishes deterministic anonymous IDs, complete pairs, and no reveal data", () => {
    const packet = buildBlindPacket({
      explorationId: "explore-0123456789abcdef01234567",
      probeSlideIds: ["slide-cover", "slide-data"],
      candidates: candidates.map((entry) => ({
        ...entry,
        label: "PRIVATE",
        designSystem: "premium-black",
        screenshots: [{ path: `blind-source/${entry.id}.png`, hash: "sha256:" + "d".repeat(64) }]
      })),
      renderingEnvironment: { renderer: "libreoffice", version: "test" }
    });
    expect(packet.packetHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(packet.blindIds).toHaveLength(3);
    expect(packet.requiredPairs).toEqual(buildRequiredBlindPairs(packet.blindIds));
    const publicText = JSON.stringify(packet);
    expect(publicText).not.toMatch(/"direction-(?:a|b|c)"|PRIVATE|premium-black|reveal|weightedScore|slopRisk/i);
  });

  it("requires available, packet-bound, complete pairwise screenshot review", () => {
    const packet = buildBlindPacket({
      explorationId: "explore-0123456789abcdef01234567",
      probeSlideIds: ["slide-cover"],
      candidates: candidates.slice(0, 2).map((entry) => ({ ...entry, screenshots: [{ path: `${entry.id}.png`, hash: "sha256:" + "e".repeat(64) }] })),
      renderingEnvironment: { renderer: "test", version: "1" }
    });
    const [left, right] = packet.requiredPairs[0];
    const review = {
      version: "0.1.0",
      explorationId: packet.explorationId,
      packetHash: packet.packetHash,
      available: true,
      pairs: [{ left, right, leftScreenshotHash: packet.candidates.find((entry) => entry.blindId === left).screenshots[0].hash, rightScreenshotHash: packet.candidates.find((entry) => entry.blindId === right).screenshots[0].hash, preference: "left", reason: "Stronger hierarchy and clearer whitespace." }]
    };
    expect(validateHostReview(packet, review)).toEqual({ valid: true, errors: [] });
    expect(validateHostReview(packet, { ...review, available: false }).valid).toBe(false);
    expect(validateHostReview(packet, { ...review, packetHash: "sha256:" + "0".repeat(64) }).valid).toBe(false);
    expect(validateHostReview(packet, { ...review, pairs: [] }).valid).toBe(false);
    const leaked = structuredClone(review);
    leaked.pairs[0].reason = "direction-a had the better deterministic score";
    expect(validateHostReview(packet, leaked).errors.join(" ")).toMatch(/leaks a private candidate|score/i);
  });

  it("does not confuse short private IDs with ordinary review prose", () => {
    const packet = buildBlindPacket({
      explorationId: "explore-0123456789abcdef01234567",
      probeSlideIds: ["slide-cover"],
      candidates: ["a", "b"].map((id) => ({
        ...candidate(id),
        label: id.toUpperCase(),
        direction: { projection: { designSystem: id.toUpperCase() } },
        screenshots: [{ hash: "sha256:" + id.repeat(64) }]
      })),
      renderingEnvironment: { renderer: "test", version: "1" }
    });
    const [left, right] = packet.requiredPairs[0];
    const review = {
      version: "0.1.0",
      explorationId: packet.explorationId,
      packetHash: packet.packetHash,
      available: true,
      pairs: [{
        left,
        right,
        leftScreenshotHash: packet.candidates.find((entry) => entry.blindId === left).screenshots[0].hash,
        rightScreenshotHash: packet.candidates.find((entry) => entry.blindId === right).screenshots[0].hash,
        preference: "left",
        reason: "A clearer hierarchy and a more deliberate rhythm."
      }]
    };
    expect(validateHostReview(packet, review)).toEqual({ valid: true, errors: [] });
  });

  it("uses pairwise preference as primary and ignores diagnostic score inversion", () => {
    const packet = buildBlindPacket({
      explorationId: "explore-0123456789abcdef01234567",
      probeSlideIds: ["slide-cover"],
      candidates: candidates.slice(0, 2).map((entry) => ({ ...entry, screenshots: [{ path: `${entry.id}.png`, hash: "sha256:" + "f".repeat(64) }] })),
      renderingEnvironment: { renderer: "test", version: "1" }
    });
    const [left, right] = packet.requiredPairs[0];
    const review = {
      version: "0.1.0", explorationId: packet.explorationId, packetHash: packet.packetHash, available: true,
      pairs: [{ left, right, leftScreenshotHash: packet.candidates.find((entry) => entry.blindId === left).screenshots[0].hash, rightScreenshotHash: packet.candidates.find((entry) => entry.blindId === right).screenshots[0].hash, preference: "left", reason: "The left option establishes a materially clearer visual hierarchy." }]
    };
    const selection = recordBlindSelection({
      packet,
      review,
      candidateSet: { candidates },
      evidenceReview: Object.fromEntries(packet.blindIds.map((id) => [id, { weightedScore: id === right ? 100 : 1, slopRisk: id === right ? 0 : 20 }]))
    });
    expect(selection.selectedBlindId).toBe(left);
    expect(selection.selectedCandidateId).toBe(packet._privateReveal[left]);
  });

  it("requires explicit adjudication for ties or cycles", () => {
    const packet = buildBlindPacket({
      explorationId: "explore-0123456789abcdef01234567",
      probeSlideIds: ["slide-cover"],
      candidates: candidates.slice(0, 2).map((entry) => ({ ...entry, screenshots: [{ path: `${entry.id}.png`, hash: "sha256:" + "1".repeat(64) }] })),
      renderingEnvironment: { renderer: "test", version: "1" }
    });
    const [left, right] = packet.requiredPairs[0];
    const tieReview = {
      version: "0.1.0", explorationId: packet.explorationId, packetHash: packet.packetHash, available: true,
      pairs: [{ left, right, leftScreenshotHash: packet.candidates.find((entry) => entry.blindId === left).screenshots[0].hash, rightScreenshotHash: packet.candidates.find((entry) => entry.blindId === right).screenshots[0].hash, preference: "tie", reason: "Both are equally strong for different reasons." }]
    };
    expect(() => recordBlindSelection({ packet, review: tieReview, candidateSet: { candidates }, evidenceReview: {} })).toThrow(/adjudication/i);
    tieReview.adjudication = { blindId: right, reason: "Choose the clearer data rhythm after direct comparison." };
    expect(recordBlindSelection({ packet, review: tieReview, candidateSet: { candidates }, evidenceReview: {} }).selectedBlindId).toBe(right);
  });
});

describe("candidate materialization boundary", () => {
  it("recomputes hashes, differences, and diagnostics instead of trusting callback claims", async () => {
    const plan = profilePlan("flagship");
    const baseIr = { version: "0.1.0", slides: plan.slides.map((slide) => ({ id: slide.id })) };
    const materialized = await prepareBlindExploration({
      plan,
      baseIr,
      request: request(plan),
      materializeCandidate: async ({ direction: spec, projectedPlan, probeSlideIds }) => {
        const blockId = projectedPlan.slides[0].compositionIntent.blockId;
        const manifest = {
          assets: [],
          slides: projectedPlan.slides.map((slide, index) => ({
            id: slide.id,
            elements: [{ type: "text", role: index === 0 ? "title" : "body", fontFamily: spec.projection.designSystem, fontSize: blockId === "editorial-poster" ? 44 : 32, color: blockId === "editorial-poster" ? "#111" : "#222" }]
          }))
        };
        const ir = { slides: projectedPlan.slides.map((slide) => ({ id: slide.id, composition: { resolvedBlockId: slide.compositionIntent.blockId ?? "minimal-statement" } })) };
        return {
          ir,
          manifest,
          probeManifest: filterProbeManifest(manifest, probeSlideIds),
          designSystemName: spec.projection.designSystem,
          proof: { accepted: false, acceptance: { status: "evidence-ready", reasons: ["direction probe is evidence-only"] } },
          quality: { gate: { passed: true }, editabilityLevel: 5 },
          review: { deckScore: 88, slopRisk: 9, slides: [{ scores: { hierarchy: 85, alignment: 85, variety: 80, designSystemFit: 82, contrast: 82, density: 85, compatibility: 90 } }] },
          renderingEnvironment: { renderer: "libreoffice", status: "ok", contactSheet: { width: 100, height: 100, slideCount: probeSlideIds.length } },
          probePptxBytes: Buffer.from(`pptx-${spec.id}`),
          screenshots: [{ bytes: Buffer.from(`png-${spec.id}`) }],
          observed: { forged: true },
          diagnostic: { weightedScore: 1000 }
        };
      }
    });
    expect(materialized.candidates).toHaveLength(2);
    expect(materialized.candidates[0].observed).not.toHaveProperty("forged");
    expect(materialized.candidates[0].diagnostic.weightedScore).toBeLessThanOrEqual(100);
    expect(materialized.packet.packetHash).toMatch(/^sha256:/);
    expect(materialized.candidates.every((entry) => entry.probeContentHash === materialized.probeContentHash)).toBe(true);
    const candidateSet = buildCreativeCandidateSet(materialized);
    expect(candidateSet.candidateSetHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidateSet.candidates[0].artifacts.blindScreenshots[0]).toMatch(/^creative-direction-blind\/blind-/);
    expect(validateCandidateSetDocument(candidateSet)).toEqual({ valid: true, errors: [] });
    const forgedSet = structuredClone(candidateSet);
    forgedSet.candidates[0].observed.unexpected = "leak";
    expect(validateCandidateSetDocument(forgedSet).valid).toBe(false);
    const staleDifferences = structuredClone(candidateSet);
    staleDifferences.differenceEvidence.pairs[0].axes = ["layout-topology", "hierarchy"];
    delete staleDifferences.candidateSetHash;
    staleDifferences.candidateSetHash = candidateSetHash(staleDifferences);
    expect(validateCandidateSetDocument(staleDifferences).errors.join(" ")).toMatch(/difference axes are stale/i);
  });

  it("rejects forged mini-manifests and unavailable proof", async () => {
    const plan = profilePlan("flagship");
    const baseIr = { slides: plan.slides.map((slide) => ({ id: slide.id })) };
    await expect(prepareBlindExploration({
      plan,
      baseIr,
      request: request(plan),
      materializeCandidate: async ({ projectedPlan }) => ({
        ir: { slides: [] },
        manifest: { slides: projectedPlan.slides.map((slide) => ({ id: slide.id, elements: [] })) },
        probeManifest: { slides: [] },
        proof: { accepted: false },
        quality: { gate: { passed: false }, editabilityLevel: 5 },
        renderingEnvironment: { renderer: "libreoffice", status: "ok" },
        probePptxBytes: Buffer.from("pptx"),
        screenshots: [{ bytes: Buffer.from("png") }]
      })
    })).rejects.toThrow(/probe manifest|proof/i);
  });
});
