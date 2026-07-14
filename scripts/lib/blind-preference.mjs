import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPlanFromBriefFixture } from "./deck-plan.mjs";

const TARGET_DOMAINS = Object.freeze([
  "executive", "technical", "product-launch", "data-review", "public-sector", "editorial-education"
]);
const LANGUAGES = Object.freeze(["en-US", "zh-CN"]);
const DIMENSIONS = Object.freeze(["hierarchy", "spacing", "density", "consistency", "originality"]);
const REVIEW_KEYS = Object.freeze(["version", "pairId", "reviewerId", "selected", "ratings", "submittedAt"]);
const IDENTITY_LEAK = /baseline|candidate|challenger|reference|generator|model/i;

export const BENCHMARK_THRESHOLDS = Object.freeze({
  briefs: 24,
  reviewersPerBrief: 5,
  totalWinRate: 0.7,
  wilson95LowerBound: 0.5,
  subgroupWinRate: 0.6,
  medianRating: 4
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function opaqueId(prefix, ...parts) {
  return `${prefix}-${digest(parts).slice(7, 19)}`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function loadCreativeBenchmarkCorpus(repoRoot = process.cwd()) {
  const sourcePath = path.join(repoRoot, "examples/creative-benchmark/corpus.json");
  const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const evidence = new Map(raw.evidenceCatalog.map((item) => [item.id, item]));
  const briefs = raw.briefs.map((brief) => ({
    ...brief,
    evidence: brief.evidenceRefs.map((id) => evidence.get(id)).filter(Boolean)
  }));
  return {
    ...raw,
    briefs,
    sourcePath,
    materializePlan(brief) {
      return buildPlanFromBriefFixture({
        id: brief.id,
        domain: brief.compilerDomain,
        language: brief.language,
        brief: brief.brief,
        input: brief.input
      });
    }
  };
}

export function validateBenchmarkCorpus(corpus) {
  const errors = [];
  if (corpus?.version !== "0.1.0") errors.push("version must be 0.1.0");
  if (!Array.isArray(corpus?.briefs) || corpus.briefs.length !== BENCHMARK_THRESHOLDS.briefs) {
    errors.push(`corpus must contain exactly ${BENCHMARK_THRESHOLDS.briefs} briefs`);
  }
  const ids = new Set();
  for (const brief of corpus?.briefs ?? []) {
    if (!brief?.id || ids.has(brief.id)) errors.push(`brief id must be non-empty and unique: ${brief?.id ?? "(missing)"}`);
    ids.add(brief?.id);
    if (!TARGET_DOMAINS.includes(brief.domain)) errors.push(`${brief.id}: unsupported domain`);
    if (!LANGUAGES.includes(brief.language)) errors.push(`${brief.id}: unsupported language`);
    if (!brief.brief || !brief.input?.intent || !brief.input?.audience) errors.push(`${brief.id}: incomplete brief input`);
    if (!Array.isArray(brief.evidence) || brief.evidence.length < 2) errors.push(`${brief.id}: at least two evidence records required`);
    for (const item of brief.evidence ?? []) {
      if (!item?.id || !item?.claim || !item?.sourceRef || !item?.rights) errors.push(`${brief.id}: incomplete evidence ${item?.id ?? "(missing)"}`);
    }
  }
  for (const domain of TARGET_DOMAINS) {
    const domainBriefs = (corpus?.briefs ?? []).filter((brief) => brief.domain === domain);
    if (domainBriefs.length !== 4) errors.push(`${domain}: exactly four briefs required`);
    for (const language of LANGUAGES) {
      if (domainBriefs.filter((brief) => brief.language === language).length !== 2) {
        errors.push(`${domain}/${language}: exactly two briefs required`);
      }
    }
  }
  for (const language of LANGUAGES) {
    if ((corpus?.briefs ?? []).filter((brief) => brief.language === language).length !== 12) {
      errors.push(`${language}: exactly twelve briefs required`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function selectLaneBriefs(corpus, lane) {
  if (!new Set(["fast", "render", "nightly", "release"]).has(lane)) throw new Error(`unsupported benchmark lane: ${lane}`);
  if (lane !== "render") return [...corpus.briefs];
  return TARGET_DOMAINS.slice(0, 4).flatMap((domain) => LANGUAGES.map((language) =>
    corpus.briefs.find((brief) => brief.domain === domain && brief.language === language)
  ));
}

function reviewerEvidence(pairId, side) {
  const base = `review/${pairId}/${side}`;
  return {
    pptx: `${base}/deck.pptx`,
    slides: `${base}/slides`,
    contactSheet: `${base}/contact-sheet.png`,
    proof: `${base}/creative-proof.json`
  };
}

export function createBlindedReviewBundle({ corpus, artifacts, seed }) {
  const corpusValidation = validateBenchmarkCorpus(corpus);
  if (!corpusValidation.valid) throw new Error(`invalid benchmark corpus: ${corpusValidation.errors.join("; ")}`);
  if (typeof seed !== "string" || seed.length < 3) throw new Error("blind review seed must be a non-trivial string");
  const byBrief = new Map();
  const artifactIds = new Set();
  for (const artifact of artifacts ?? []) {
    if (!artifact?.artifactId || artifactIds.has(artifact.artifactId)) throw new Error("artifactId values must be non-empty and globally unique");
    artifactIds.add(artifact.artifactId);
    if (!byBrief.has(artifact.briefId)) byBrief.set(artifact.briefId, []);
    byBrief.get(artifact.briefId).push(artifact);
  }
  const pairs = [];
  const keys = [];
  for (const brief of corpus.briefs) {
    const entries = byBrief.get(brief.id) ?? [];
    const references = entries.filter((entry) => entry.kind === "reference");
    const challengers = entries.filter((entry) => entry.kind === "challenger");
    if (entries.length !== 2 || references.length !== 1 || challengers.length !== 1) throw new Error(`${brief.id}: exactly one reference and challenger artifact are required`);
    const [reference] = references;
    const [challenger] = challengers;
    for (const entry of [reference, challenger]) {
      if (entry.identityAttestation?.status !== "passed" || entry.identityAttestation?.scope !== "generator-identity" || entry.identityAttestation?.reviewerFacingNamesNeutral !== true) {
        throw new Error(`${brief.id}/${entry.kind}: passed generator-identity attestation is required`);
      }
      for (const key of ["pptx", "slides", "contactSheet", "proof"]) {
        if (!entry.evidence?.[key]) throw new Error(`${brief.id}/${entry.kind}: missing ${key} evidence`);
      }
    }
    const pairId = opaqueId("pair", seed, brief.id);
    const challengerSide = parseInt(digest([seed, brief.id]).slice(-2), 16) % 2 === 0 ? "left" : "right";
    const referenceSide = challengerSide === "left" ? "right" : "left";
    const publicSide = (side, entry) => ({
      artifactId: opaqueId("artifact", seed, brief.id, side, entry.artifactId),
      evidence: reviewerEvidence(pairId, side)
    });
    pairs.push({
      pairId,
      briefId: brief.id,
      domain: brief.domain,
      language: brief.language,
      left: publicSide("left", challengerSide === "left" ? challenger : reference),
      right: publicSide("right", challengerSide === "right" ? challenger : reference)
    });
    keys.push({
      pairId,
      challengerSide,
      referenceSide,
      sourceArtifacts: { reference: reference.artifactId, challenger: challenger.artifactId }
    });
  }
  const packetBody = { version: "0.1.0", seedHash: digest(seed), pairs };
  const packetHash = digest(packetBody);
  return {
    packet: { ...packetBody, packetHash },
    answerKey: { version: "0.1.0", packetHash, pairs: keys }
  };
}

export function validateBlindReviewRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return { valid: false, errors: ["review must be an object"] };
  for (const key of Object.keys(record)) if (!REVIEW_KEYS.includes(key)) errors.push(`unexpected property ${key}`);
  for (const key of REVIEW_KEYS) if (!Object.hasOwn(record, key)) errors.push(`missing property ${key}`);
  if (record.version !== "0.1.0") errors.push("version must be 0.1.0");
  if (typeof record.pairId !== "string" || !record.pairId) errors.push("pairId required");
  if (typeof record.reviewerId !== "string" || !record.reviewerId) errors.push("reviewerId required");
  if (IDENTITY_LEAK.test(String(record.pairId)) || IDENTITY_LEAK.test(String(record.reviewerId))) errors.push("review identity fields must not contain generator labels");
  if (!["left", "right", "tie"].includes(record.selected)) errors.push("selected must be left, right, or tie");
  if (!record.ratings || typeof record.ratings !== "object" || Array.isArray(record.ratings)) errors.push("ratings object required");
  else {
    const sideKeys = Object.keys(record.ratings);
    if (sideKeys.length !== 2 || !["left", "right"].every((side) => sideKeys.includes(side))) errors.push("ratings must contain exactly left and right");
    for (const side of ["left", "right"]) {
      const sideRatings = record.ratings[side];
      if (!sideRatings || typeof sideRatings !== "object" || Array.isArray(sideRatings)) {
        errors.push(`${side} ratings object required`);
        continue;
      }
      const ratingKeys = Object.keys(sideRatings);
      if (ratingKeys.length !== DIMENSIONS.length || !DIMENSIONS.every((key) => ratingKeys.includes(key))) errors.push(`${side}: all five closed ratings required`);
      for (const key of ratingKeys) if (!DIMENSIONS.includes(key)) errors.push(`${side}: unexpected rating ${key}`);
      for (const key of DIMENSIONS) if (!Number.isInteger(sideRatings[key]) || sideRatings[key] < 1 || sideRatings[key] > 5) errors.push(`${side}/${key} must be an integer from 1 to 5`);
    }
  }
  if (typeof record.submittedAt !== "string" || Number.isNaN(Date.parse(record.submittedAt))) errors.push("submittedAt must be a date-time");
  return { valid: errors.length === 0, errors };
}

export function wilsonLowerBound(successes, total, z = 1.96) {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || successes < 0 || successes > total) return 0;
  const proportion = successes / total;
  const z2 = z * z;
  const center = proportion + z2 / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total);
  return Math.max(0, (center - margin) / (1 + z2 / total));
}

function summarizeGroup(reviews, pairIds, keyByPair) {
  const selected = reviews.filter((review) => pairIds.has(review.pairId));
  const wins = selected.filter((review) => review.selected === keyByPair.get(review.pairId)?.challengerSide).length;
  return { reviews: selected.length, wins, winRate: selected.length ? wins / selected.length : 0 };
}

export function evaluateBlindPreference({ corpus, bundle, reviews }) {
  const failures = [];
  const validation = validateBenchmarkCorpus(corpus);
  if (!validation.valid) failures.push("corpus");
  const expectedPacketHash = digest({ version: bundle?.packet?.version, seedHash: bundle?.packet?.seedHash, pairs: bundle?.packet?.pairs });
  if (!bundle?.packet?.packetHash || expectedPacketHash !== bundle.packet.packetHash || bundle?.answerKey?.packetHash !== bundle.packet.packetHash) failures.push("packet-binding");
  const pairById = new Map((bundle?.packet?.pairs ?? []).map((pair) => [pair.pairId, pair]));
  const keyByPair = new Map((bundle?.answerKey?.pairs ?? []).map((pair) => [pair.pairId, pair]));
  if (pairById.size !== BENCHMARK_THRESHOLDS.briefs || keyByPair.size !== pairById.size) failures.push("pair-coverage");
  const accepted = [];
  const seen = new Set();
  for (const review of reviews ?? []) {
    const reviewValidation = validateBlindReviewRecord(review);
    const identity = `${review?.pairId}\u0000${review?.reviewerId}`;
    if (!reviewValidation.valid || !pairById.has(review?.pairId) || seen.has(identity)) {
      failures.push("invalid-review-record");
      continue;
    }
    seen.add(identity);
    accepted.push(review);
  }
  const reviewerCounts = [...pairById.keys()].map((pairId) => new Set(accepted.filter((review) => review.pairId === pairId).map((review) => review.reviewerId)).size);
  const minimumReviewers = reviewerCounts.length ? Math.min(...reviewerCounts) : 0;
  if (minimumReviewers < BENCHMARK_THRESHOLDS.reviewersPerBrief) failures.push("reviewers-per-brief");
  const wins = accepted.filter((review) => review.selected === keyByPair.get(review.pairId)?.challengerSide).length;
  const total = accepted.length;
  const winRate = total ? wins / total : 0;
  const lower = wilsonLowerBound(wins, total);
  if (winRate < BENCHMARK_THRESHOLDS.totalWinRate) failures.push("total-win-rate");
  if (lower <= BENCHMARK_THRESHOLDS.wilson95LowerBound) failures.push("wilson-lower-bound");

  const domain = {};
  for (const name of TARGET_DOMAINS) {
    const ids = new Set((bundle?.packet?.pairs ?? []).filter((pair) => pair.domain === name).map((pair) => pair.pairId));
    domain[name] = summarizeGroup(accepted, ids, keyByPair);
    if (domain[name].winRate < BENCHMARK_THRESHOLDS.subgroupWinRate) failures.push(`domain:${name}`);
  }
  const language = {};
  for (const name of LANGUAGES) {
    const ids = new Set((bundle?.packet?.pairs ?? []).filter((pair) => pair.language === name).map((pair) => pair.pairId));
    language[name] = summarizeGroup(accepted, ids, keyByPair);
    if (language[name].winRate < BENCHMARK_THRESHOLDS.subgroupWinRate) failures.push(`language:${name}`);
  }
  const medians = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, median(accepted.map((review) => {
    const challengerSide = keyByPair.get(review.pairId)?.challengerSide;
    return review.ratings[challengerSide]?.[dimension];
  }).filter(Number.isFinite))]));
  for (const [dimension, value] of Object.entries(medians)) if (value < BENCHMARK_THRESHOLDS.medianRating) failures.push(`median:${dimension}`);

  return {
    version: "0.1.0",
    status: failures.length ? "unproven" : "passed",
    packetHash: bundle?.packet?.packetHash ?? "sha256:missing",
    sample: {
      briefs: pairById.size,
      reviews: total,
      reviewersPerBrief: { minimum: minimumReviewers, required: BENCHMARK_THRESHOLDS.reviewersPerBrief }
    },
    overall: { wins, reviews: total, winRate, wilson95LowerBound: lower },
    subgroups: { domain, language },
    medians,
    thresholds: { ...BENCHMARK_THRESHOLDS },
    failures: [...new Set(failures)]
  };
}

export const __test__ = Object.freeze({ TARGET_DOMAINS, LANGUAGES, DIMENSIONS, digest });
