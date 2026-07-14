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

const ARTIFACT_EVIDENCE_KEYS = Object.freeze(["pptx", "slides", "contactSheet", "proof"]);

export function portableArtifactManifest(artifacts, outputRoot) {
  const canonicalPath = (value) => {
    try { return fs.realpathSync.native(path.resolve(value)); }
    catch { return path.resolve(value); }
  };
  const root = canonicalPath(outputRoot);
  return (artifacts ?? []).map((artifact) => {
    const evidence = {};
    for (const key of ARTIFACT_EVIDENCE_KEYS) {
      const source = artifact?.evidence?.[key];
      if (typeof source !== "string" || !source.trim()) throw new Error(`${artifact?.briefId ?? "artifact"}: missing ${key} evidence`);
      const absolute = canonicalPath(source);
      const relative = path.relative(root, absolute);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${artifact?.briefId ?? "artifact"}: ${key} evidence must be below the benchmark output root`);
      }
      evidence[key] = relative.split(path.sep).join("/");
    }
    return {
      briefId: artifact.briefId,
      kind: artifact.kind,
      artifactId: artifact.artifactId,
      identityAttestation: structuredClone(artifact.identityAttestation),
      ...(artifact.provenance ? { provenance: structuredClone(artifact.provenance) } : {}),
      evidence
    };
  });
}

function htmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function buildBlindReviewHtml(packet) {
  if (!packet?.packetHash || !Array.isArray(packet?.pairs) || packet.pairs.length === 0) throw new Error("a bound blind packet is required");
  const pairMarkup = packet.pairs.map((pair, index) => {
    const side = (name) => {
      const evidence = pair[name]?.evidence ?? {};
      const ratings = DIMENSIONS.map((dimension) => `
        <label>${htmlEscape(dimension)}
          <select required data-rating="${htmlEscape(name)}" data-dimension="${htmlEscape(dimension)}">
            <option value="">-</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option>
          </select>
        </label>`).join("");
      return `<article class="side">
        <h3>${name === "left" ? "Left" : "Right"}</h3>
        <a href="../${htmlEscape(evidence.pptx)}">Open editable deck</a>
        <a href="../${htmlEscape(evidence.slides)}">Open full-size slides</a>
        <img src="../${htmlEscape(evidence.contactSheet)}" alt="${name === "left" ? "Left" : "Right"} contact sheet">
        <fieldset><legend>Independent ratings</legend>${ratings}</fieldset>
      </article>`;
    };
    return `<section class="pair" data-pair-id="${htmlEscape(pair.pairId)}">
      <header><span>Pair ${index + 1} of ${packet.pairs.length}</span><span>${htmlEscape(pair.domain)} · ${htmlEscape(pair.language)}</span></header>
      <p class="context"><strong>${htmlEscape(pair.reviewContext?.brief ?? "")}</strong><br>
        Intent: ${htmlEscape(pair.reviewContext?.intent ?? "")} · Audience: ${htmlEscape(pair.reviewContext?.audience ?? "")}</p>
      <div class="sides">${side("left")}${side("right")}</div>
      <fieldset class="choice"><legend>Which deck is stronger overall?</legend>
        <label><input required type="radio" name="choice-${htmlEscape(pair.pairId)}" value="left">Left</label>
        <label><input required type="radio" name="choice-${htmlEscape(pair.pairId)}" value="right">Right</label>
        <label><input required type="radio" name="choice-${htmlEscape(pair.pairId)}" value="tie">Tie</label>
      </fieldset>
    </section>`;
  }).join("\n");
  const packetHash = htmlEscape(packet.packetHash);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blind deck review</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#f4f6f8;color:#17202a}main{max-width:1180px;margin:auto;padding:28px}h1{margin:0 0 8px}.note{color:#52606d}.pair{background:white;border:1px solid #d9e1e8;border-radius:14px;margin:24px 0;padding:20px}.pair>header{display:flex;justify-content:space-between;font-weight:700}.context{background:#f4f6f8;border-radius:8px;padding:10px 12px}.sides{display:grid;grid-template-columns:1fr 1fr;gap:18px}.side{min-width:0}.side>a{display:inline-block;margin:0 12px 10px 0}.side img{display:block;width:100%;border:1px solid #ccd5dd}.side fieldset{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:12px}.side label{display:grid;gap:4px;font-size:12px}.choice{display:flex;gap:22px;margin-top:18px}.actions{position:sticky;bottom:0;background:#17202a;color:white;padding:14px;border-radius:12px;display:flex;align-items:center;gap:12px}.actions input{padding:8px;min-width:220px}.actions button{padding:9px 16px;font-weight:700}@media(max-width:800px){.sides{grid-template-columns:1fr}.side fieldset{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main>
<h1>Blind deck review</h1><p class="note">Inspect both full-size slide sets before choosing. Rate each side independently. Packet <code>${packetHash}</code>.</p>
<form id="review-form">${pairMarkup}<div class="actions"><label>Opaque reviewer ID <input id="reviewer-id" required autocomplete="off"></label><button type="submit">Export review-records.json</button><span id="status"></span></div></form>
</main><script>
const dimensions=${JSON.stringify(DIMENSIONS)};
const packetHash=${JSON.stringify(packet.packetHash)};
document.getElementById("review-form").addEventListener("submit",event=>{
  event.preventDefault();const reviewerId=document.getElementById("reviewer-id").value.trim();const status=document.getElementById("status");
  if(!reviewerId){status.textContent="Use a neutral opaque reviewer ID.";return;}
  const submittedAt=new Date().toISOString();const records=[];
  for(const section of document.querySelectorAll(".pair")){
    const pairId=section.dataset.pairId;const selected=section.querySelector("input[type=radio]:checked")?.value;if(!selected){status.textContent="Complete every overall choice.";return;}
    const ratings={left:{},right:{}};
    for(const side of ["left","right"])for(const dimension of dimensions){const input=section.querySelector('[data-rating="'+side+'"][data-dimension="'+dimension+'"]');const value=Number(input.value);if(!Number.isInteger(value)||value<1||value>5){status.textContent="Complete every 1-5 rating.";return;}ratings[side][dimension]=value;}
    records.push({version:"0.1.0",pairId,reviewerId,selected,ratings,submittedAt});
  }
  const blob=new Blob([JSON.stringify(records,null,2)+"\\n"],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="review-records.json";link.click();URL.revokeObjectURL(url);status.textContent="Exported "+records.length+" records for "+packetHash.slice(0,18)+"…";
});
</script></body></html>\n`;
}

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
      reviewContext: {
        brief: brief.brief,
        intent: brief.input.intent,
        audience: brief.input.audience
      },
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
