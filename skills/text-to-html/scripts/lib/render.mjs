import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { localizeAssets } from "./assets.mjs";
import { claimAttrs, claimText, componentAttrs, STATUS_LABELS } from "./component-metadata.mjs";
import { renderDeckShell, renderSpeakerNotes } from "./deck-shell.mjs";
import { analyzeNarrative } from "./narrative.mjs";
import { analyzePagination } from "./pagination.mjs";
import { canonicalPlanInputSha256, compilePlanForRender, validatePlan } from "./plan.mjs";
import {
  validateDesignIntent,
  validateProvenanceRecord,
  validateReviewReport,
  validateVisualScorecard
} from "./report-validation.mjs";
import { buildProvenanceRecord } from "./review.mjs";
import { buildVisualScorecard } from "./scorecard.mjs";
import { renderSlotBody } from "./slot-renderers.mjs";
import { compileTokenCss } from "./token-compiler.mjs";
import {
  assertSafeOutputDir,
  escapeHtml,
  sha256File,
  skillRoot,
  writeJson
} from "./utils.mjs";
import { loadTheme, materializeThemeTokens, themeFingerprints } from "./themes.mjs";

const TEXT_TO_HTML_EXTENSION = "pptx-creator.text-to-html/v2";

const DEFAULT_PROCESS_GAP = 42;
const DEFAULT_CANVAS_X = 72;

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function svgNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function processConnectorGeometry(stepCount, layout) {
  const count = Math.max(2, Math.floor(finiteNumber(stepCount, 2)));
  const width = Math.max(1, finiteNumber(layout?.width, 1));
  const height = Math.max(1, finiteNumber(layout?.height, 1));
  const gap = DEFAULT_PROCESS_GAP;
  const cardWidth = (width - gap * (count - 1)) / count;
  const centerY = height / 2;
  return Array.from({ length: count - 1 }, (_, index) => {
    const startX = (index + 1) * cardWidth + index * gap;
    const endX = startX + gap;
    const bendX = startX + (endX - startX) / 2;
    return {
      viewBox: `0 0 ${svgNumber(width)} ${svgNumber(height)}`,
      d: `M ${svgNumber(startX)} ${svgNumber(centerY)} L ${svgNumber(bendX)} ${svgNumber(centerY)} L ${svgNumber(bendX)} ${svgNumber(centerY)} L ${svgNumber(endX)} ${svgNumber(centerY)}`
    };
  });
}

function processLayout(plan, tokens) {
  const canvasWidth = finiteNumber(plan.deck.size.width, 1280);
  const canvasHeight = finiteNumber(plan.deck.size.height, 720);
  const canvasX = finiteNumber(tokens?.space?.canvasX, DEFAULT_CANVAS_X);
  return {
    width: Math.max(1, canvasWidth - canvasX * 2),
    height: Math.max(1, canvasHeight)
  };
}

function sourceFooter(plan, slide) {
  const byId = new Map(plan.sources.map((source) => [source.id, source]));
  return slide.sourceRefs
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((source) => escapeHtml(source.label))
    .join(" · ");
}

function slideHeader(slide) {
  return `
    <header>
      <div class="eyebrow">${escapeHtml(slide.type)}</div>
      <h1 class="slide-title" ${componentAttrs(`${slide.id}-title`, "text", 'data-max-lines="2"')}>${escapeHtml(slide.title)}</h1>
      <p class="slide-kicker" ${componentAttrs(`${slide.id}-message`, "text")}>${escapeHtml(slide.coreMessage)}</p>
    </header>`;
}

function coverBody(plan, slide) {
  const subtitle = slide.content.subtitle ?? plan.positioning.statement;
  return `
    <div class="eyebrow">${escapeHtml(plan.positioning.goal)}</div>
    <h1 class="slide-title" ${componentAttrs(`${slide.id}-title`, "text", 'data-max-lines="2"')}>${escapeHtml(slide.title)}</h1>
    <p class="slide-kicker" ${componentAttrs(`${slide.id}-subtitle`, "text")}>${escapeHtml(subtitle)}</p>
    <div class="cover-meta" data-qa-box ${componentAttrs(`${slide.id}-meta`, "shape")}>
      <span class="meta-pill" ${componentAttrs(`${slide.id}-audience`, "text")}>${escapeHtml(plan.positioning.audience)}</span>
      <span class="meta-pill" ${componentAttrs(`${slide.id}-duration`, "text")}>${escapeHtml(`${plan.positioning.durationMinutes} 分钟`)}</span>
      <span class="meta-pill" ${componentAttrs(`${slide.id}-mode`, "text")}>${escapeHtml(plan.positioning.deliveryMode)}</span>
    </div>`;
}

function statementBody(slide) {
  const claim = slide.content.statement;
  return `
    <article class="card statement-panel" data-qa-box ${componentAttrs(`${slide.id}-statement-card`, "shape")}>
      <p class="statement-text fact-line" ${componentAttrs(`${slide.id}-statement`, "text", claimAttrs(claim))}>${claimText(claim)}</p>
    </article>`;
}

function bulletsBody(slide) {
  return `<ol class="bullet-list">${slide.content.points.map((claim, index) => `
    <li class="bullet-item" data-qa-box ${componentAttrs(`${slide.id}-point-card-${index + 1}`, "shape")}>
      <span class="bullet-number" ${componentAttrs(`${slide.id}-point-number-${index + 1}`, "text")}>${index + 1}</span>
      <p class="fact-line" ${componentAttrs(`${slide.id}-point-${index + 1}`, "text", claimAttrs(claim))}>${claimText(claim)}</p>
    </li>`).join("")}</ol>`;
}

function comparisonGroup(slide, side, group, highlight) {
  return `
    <article class="card comparison-card${highlight ? " is-highlight" : ""}" data-qa-box ${componentAttrs(`${slide.id}-${side}-card`, "shape")}>
      <h2 ${componentAttrs(`${slide.id}-${side}-label`, "text")}>${escapeHtml(group.label)}</h2>
      <ul class="compact-list">${group.points.map((claim, index) => `
        <li class="fact-line" ${componentAttrs(`${slide.id}-${side}-point-${index + 1}`, "text", claimAttrs(claim))}>${claimText(claim)}</li>`).join("")}
      </ul>
    </article>`;
}

function comparisonBody(slide) {
  return `<div class="cards-grid cols-2">
    ${comparisonGroup(slide, "left", slide.content.left, false)}
    ${comparisonGroup(slide, "right", slide.content.right, true)}
  </div>`;
}

function metricsBody(slide) {
  const count = slide.content.metrics.length;
  return `<div class="cards-grid ${count === 2 ? "cols-2" : "cols-3"} metrics-grid">${slide.content.metrics.map((metric, index) => `
    <article class="card metric-card" data-qa-box ${componentAttrs(`${slide.id}-metric-card-${index + 1}`, "shape")}>
      <div>
        <div class="metric-value" data-layout-role="metric" ${componentAttrs(`${slide.id}-metric-value-${index + 1}`, "text", claimAttrs(metric.claim))}>${claimText(metric.claim, metric.value)}</div>
        <div class="metric-label" ${componentAttrs(`${slide.id}-metric-label-${index + 1}`, "text")}>${escapeHtml(metric.label)}</div>
      </div>
      ${metric.detail ? `<p class="metric-detail" ${componentAttrs(`${slide.id}-metric-detail-${index + 1}`, "text")}>${escapeHtml(metric.detail)}</p>` : ""}
    </article>`).join("")}</div>`;
}

function processBody(slide, layout) {
  const cards = slide.content.steps.map((step, index) => `
    <article class="card process-card" data-qa-box ${componentAttrs(`${slide.id}-step-${index + 1}`, "shape")}>
      <span class="process-index" ${componentAttrs(`${slide.id}-step-index-${index + 1}`, "text")}>${index + 1}</span>
      <h2 ${componentAttrs(`${slide.id}-step-label-${index + 1}`, "text")}>${escapeHtml(step.label)}</h2>
      <p class="fact-line" ${componentAttrs(`${slide.id}-step-copy-${index + 1}`, "text", claimAttrs(step.claim))}>${claimText(step.claim)}</p>
    </article>`).join("");
  const connectorGeometry = processConnectorGeometry(slide.content.steps.length, layout);
  const connectors = slide.content.steps.slice(0, -1).map((_, index) => {
    const geometry = connectorGeometry[index];
    return `
      <path data-connector data-source-id="${slide.id}-step-${index + 1}" data-target-id="${slide.id}-step-${index + 2}"
        data-source-anchor="right" data-target-anchor="left" data-connector-route="orthogonal"
        ${componentAttrs(`${slide.id}-connector-${index + 1}`, "line")}
        d="${geometry.d}" fill="none" stroke="var(--color-primary)" stroke-width="4" vector-effect="non-scaling-stroke" marker-end="url(#arrow-${slide.id})"></path>`;
  }).join("");
  const viewBox = connectorGeometry[0]?.viewBox ?? `0 0 ${svgNumber(layout.width)} ${svgNumber(layout.height)}`;
  return `<div class="process-wrap">
    <div class="process-grid" style="--step-count:${slide.content.steps.length}">${cards}</div>
    <svg class="connector-layer" viewBox="${viewBox}" preserveAspectRatio="none" aria-hidden="true">
      <defs><marker id="arrow-${slide.id}" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--color-primary)"></path></marker></defs>
      ${connectors}
    </svg>
  </div>`;
}

function timelineBody(slide) {
  return `<div class="timeline" style="--milestone-count:${slide.content.milestones.length}">${slide.content.milestones.map((milestone, index) => `
    <article class="milestone" data-qa-box ${componentAttrs(`${slide.id}-milestone-${index + 1}`, "shape")}>
      <span class="milestone-dot" ${componentAttrs(`${slide.id}-milestone-dot-${index + 1}`, "shape")}></span>
      <div class="milestone-label" ${componentAttrs(`${slide.id}-milestone-when-${index + 1}`, "text")}>${escapeHtml(milestone.when)}</div>
      <h3 ${componentAttrs(`${slide.id}-milestone-label-${index + 1}`, "text")}>${escapeHtml(milestone.label)}</h3>
      <p class="fact-line" ${componentAttrs(`${slide.id}-milestone-copy-${index + 1}`, "text", claimAttrs(milestone.claim))}>${claimText(milestone.claim)}</p>
    </article>`).join("")}</div>`;
}

function quoteBody(slide) {
  return `<blockquote class="card quote-card" data-qa-box ${componentAttrs(`${slide.id}-quote-card`, "shape")}>
    <span class="quote-mark" aria-hidden="true">“</span>
    <p class="quote-text fact-line" ${componentAttrs(`${slide.id}-quote`, "text", claimAttrs(slide.content.quote))}>${claimText(slide.content.quote)}</p>
    <footer class="quote-attribution" ${componentAttrs(`${slide.id}-attribution`, "text")}>— ${escapeHtml(slide.content.attribution)}</footer>
  </blockquote>`;
}

function imageBody(slide, assetById) {
  const asset = assetById.get(slide.content.assetId);
  const objectPosition = asset.focalPoint
    ? `${Math.round(asset.focalPoint.x * 100)}% ${Math.round(asset.focalPoint.y * 100)}%`
    : "50% 50%";
  return `<div class="image-layout">
    <figure class="card image-frame" data-qa-box ${componentAttrs(`${slide.id}-image-frame`, "shape")}>
      <img src="${escapeHtml(asset.outputPath)}" alt="${escapeHtml(asset.alt)}" data-object-fit="${escapeHtml(asset.objectFit ?? "contain")}" data-object-position="${escapeHtml(objectPosition)}" style="object-fit:${escapeHtml(asset.objectFit ?? "contain")};object-position:${escapeHtml(objectPosition)}" ${componentAttrs(`${slide.id}-image`, "image")}>
    </figure>
    <article class="card caption-card" data-qa-box ${componentAttrs(`${slide.id}-caption-card`, "shape")}>
      <h2 ${componentAttrs(`${slide.id}-caption-title`, "text")}>观察要点</h2>
      <p class="fact-line" ${componentAttrs(`${slide.id}-caption`, "text", claimAttrs(slide.content.caption))}>${claimText(slide.content.caption)}</p>
    </article>
  </div>`;
}

function closingBody(slide) {
  return `<div class="closing-action fact-line" ${componentAttrs(`${slide.id}-action`, "text", claimAttrs(slide.content.action))}>${claimText(slide.content.action)}</div>
    ${slide.content.summary?.length ? `<ul class="compact-list" style="margin-top:30px">${slide.content.summary.map((claim, index) => `
      <li class="fact-line" ${componentAttrs(`${slide.id}-summary-${index + 1}`, "text", claimAttrs(claim))}>${claimText(claim)}</li>`).join("")}</ul>` : ""}`;
}

function renderBody(plan, slide, assetById, layout) {
  return renderSlotBody(slide, {
    cover: () => coverBody(plan, slide),
    statement: () => statementBody(slide),
    bullets: () => bulletsBody(slide),
    comparison: () => comparisonBody(slide),
    metrics: () => metricsBody(slide),
    process: () => processBody(slide, layout),
    timeline: () => timelineBody(slide),
    quote: () => quoteBody(slide),
    image: () => imageBody(slide, assetById),
    closing: () => closingBody(slide)
  });
}

function renderSlide(plan, slide, assetById, layout) {
  const className = `${slide.type}-slide`;
  const footer = sourceFooter(plan, slide);
  const header = slide.type === "cover" ? "" : slideHeader(slide);
  const decorations = [
    `<div class="slide-decoration slide-decor-orb" ${componentAttrs(`${slide.id}-decor-orb`, "shape", 'data-layout-role="decoration" aria-hidden="true"')}></div>`,
    ...(slide.type === "cover"
      ? [`<div class="slide-decoration slide-decor-rule" ${componentAttrs(`${slide.id}-decor-rule`, "shape", 'data-layout-role="decoration" aria-hidden="true"')}></div>`]
      : []),
    ...(slide.type === "closing"
      ? [`<div class="slide-decoration slide-decor-band" ${componentAttrs(`${slide.id}-decor-band`, "shape", 'data-layout-role="decoration" aria-hidden="true"')}></div>`]
      : [])
  ].join("\n    ");
  return `
  <section class="pptx-slide ${className}" id="${escapeHtml(slide.id)}" data-slide-id="${escapeHtml(slide.id)}" data-slide-order="${slide.order}" data-slide-type="${escapeHtml(slide.type)}" aria-hidden="${slide.order === 1 ? "false" : "true"}">
    ${decorations}
    <div class="slide-shell">
      ${header}
      <main class="${slide.type === "cover" ? "" : "slide-body"}">
        ${renderBody(plan, slide, assetById, layout)}
      </main>
      <footer class="slide-footer">
        <span class="source-list" ${componentAttrs(`${slide.id}-sources`, "text", 'data-layout-role="source"')}>${footer ? `来源：${footer}` : ""}</span>
        <span class="folio" ${componentAttrs(`${slide.id}-folio`, "text", 'data-layout-role="slide-number"')}>${slide.order} / ${plan.slides.length}</span>
      </footer>
      <aside class="speaker-notes" aria-hidden="true">${escapeHtml(slide.notes)}</aside>
    </div>
  </section>`;
}

function contentBudgetReport(pagination) {
  const entries = pagination.pages.map((page) => ({
    slideId: page.slideId,
    maxWords: page.maxWords,
    estimatedUnits: page.contentUnits,
    maxPrimarySupports: page.maxPrimarySupports,
    primarySupports: page.primarySupports,
    timeSeconds: page.timeSeconds,
    ...(page.continuationOf ? { continuationOf: page.continuationOf } : {}),
    ...(page.semanticBreak ? { semanticBreak: page.semanticBreak } : {}),
    withinBudget: page.withinBudget
  }));
  return {
    version: "2.0.0",
    kind: "text-to-html.content-budget-report",
    status: pagination.status,
    briefSeconds: pagination.duration.briefSeconds,
    plannedSeconds: pagination.duration.plannedSeconds,
    deltaSeconds: pagination.duration.deltaSeconds,
    continuations: pagination.continuations,
    pages: entries,
    errors: pagination.errors,
    warnings: pagination.warnings
  };
}

function licenseReport(assetRecords, theme) {
  return {
    version: "2.0.0",
    status: "reported",
    notice: "NOTICE",
    theme: {
      id: theme.id,
      manifest: theme.paths.manifest,
      notice: theme.paths.notice,
      fingerprints: themeFingerprints(theme)
    },
    assets: assetRecords.map((asset) => ({
      id: asset.id,
      path: asset.outputPath,
      sha256: asset.sha256,
      rights: structuredClone(asset.rights),
      ...(asset.sourceRef ? { sourceRef: asset.sourceRef } : {})
    }))
  };
}

async function combinedNotice(assetNotice, theme) {
  const themeNotice = await readFile(join(skillRoot, theme.paths.notice), "utf8");
  return `${assetNotice.trimEnd()}\n\nTheme: ${theme.id}\nTheme manifest: ${theme.paths.manifest}\nTheme notice: ${theme.paths.notice}\n${themeNotice.trimEnd()}\n`;
}

function reviewAndProvenance(plan) {
  const provenance = buildProvenanceRecord({
    inputPlan: plan,
    designIntent: plan.designIntent,
    review: plan.review,
    assetLedger: plan.assets,
    renderer: plan.designIntent.lock.rendererVersion
  });
  return {
    provenance,
    review: {
      version: "2.0.0",
      status: provenance.review.status,
      hashes: provenance.hashes,
      approvals: provenance.review.approvals,
      blockers: provenance.review.blockers,
      invalidations: provenance.review.invalidations
    }
  };
}

async function extensionRecord(outputDir, plan, review) {
  const paths = {
    sourcePlan: "presentation-plan.source.json",
    canonicalPlan: "presentation-plan.json",
    designIntent: "design-intent.json",
    contentBudget: "content-budget-report.json",
    narrative: "narrative-report.json",
    review: "review-report.json",
    assetLedger: "asset-ledger.json",
    license: "license-report.json",
    provenance: "provenance.json",
    visualScorecard: "visual-scorecard.json",
    notice: "NOTICE"
  };
  const reports = {};
  for (const [name, path] of Object.entries(paths)) {
    reports[name] = { path, sha256: await sha256File(join(outputDir, path)) };
  }
  return {
    version: "2.0.0",
    plan: {
      version: plan.version,
      canonicalInputSha256: canonicalPlanInputSha256(plan),
      reviewStatus: review.status
    },
    reports
  };
}

function htmlDocument(plan, repairLevel, assetById, tokens) {
  const layout = processLayout(plan, tokens);
  const slides = plan.slides.map((slide) => renderSlide(plan, slide, assetById, layout)).join("\n");
  return renderDeckShell(plan, repairLevel, slides);
}

function sourceIndex(plan) {
  return {
    version: "1.0.0",
    policy: {
      providedIsNotVerified: true,
      uncertaintyLabels: STATUS_LABELS,
      fabricatedFactsAllowed: false
    },
    assumptions: plan.assumptions,
    sources: plan.sources,
    mappings: plan.slides.map((slide) => ({
      slideId: slide.id,
      sourceRefs: slide.sourceRefs
    }))
  };
}

function deckManifest(plan, assetRecords, repairLevel) {
  return {
    version: "1.0.0",
    generator: { skill: "text-to-html", version: "1.0.0", deterministic: true },
    deck: plan.deck,
    positioning: plan.positioning,
    narrative: plan.narrative,
    repairLevel,
    slides: plan.slides.map((slide) => ({
      id: slide.id,
      order: slide.order,
      type: slide.type,
      title: slide.title,
      coreMessage: slide.coreMessage,
      sourceRefs: slide.sourceRefs,
      notes: slide.notes
    })),
    assets: assetRecords,
    files: {
      entrypoint: "index.html",
      designTokens: "design-tokens.json",
      notes: "speaker-notes.md",
      sources: "sources.json",
      qa: "qa-report.json",
      presentationPackage: "presentation-package.json"
    }
  };
}

function pendingPackage(plan, assetRecords, extension) {
  return {
    protocol: "pptx-creator.presentation-package",
    version: "1.0.0",
    kind: "html-presentation",
    producer: { skill: "text-to-html", version: "1.0.0" },
    entrypoint: "index.html",
    deck: {
      id: plan.deck.id,
      title: plan.deck.title,
      language: plan.deck.language,
      size: plan.deck.size,
      slides: plan.slides.map((slide) => ({
        id: slide.id,
        order: slide.order,
        title: slide.title,
        coreMessage: slide.coreMessage,
        notes: slide.notes,
        sourceRefs: slide.sourceRefs,
        components: []
      }))
    },
    designTokens: "design-tokens.json",
    assets: assetRecords.map((asset) => ({
      id: asset.id,
      path: asset.outputPath,
      mime: asset.mime,
      sha256: asset.sha256,
      rights: asset.rights.status,
      ...(asset.sourceRef ? { sourceRef: asset.sourceRef } : {})
    })),
    sources: plan.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      ...(source.locator ? { locator: source.locator } : {}),
      ...(source.sha256 ? { sha256: source.sha256 } : {}),
      factStatus: source.factStatus
    })),
    validation: { status: "pending", reports: ["qa-report.json"] },
    degradations: [],
    compatibility: {
      minReaderVersion: "1.0.0",
      features: [
        "html-offline",
        "keyboard-navigation",
        "print-css",
        "speaker-notes",
        "source-traceability",
        "browser-geometry",
        "text-to-html-plan-v2",
        "asset-provenance",
        "review-hash-binding",
        "visual-scorecard"
      ]
    },
    extensions: {
      [TEXT_TO_HTML_EXTENSION]: extension
    }
  };
}

export async function buildDeck(plan, planPath, outputDir, options = {}) {
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const planDirectory = dirname(resolve(planPath));
  await validatePlan(plan, { planDirectory, allowUnreviewed: options.allowUnreviewed === true });
  const renderPlan = compilePlanForRender(plan);
  await mkdir(join(resolvedOutput, "assets"), { recursive: true });
  await mkdir(join(resolvedOutput, "qa"), { recursive: true });

  const theme = loadTheme(plan.designIntent.themeId);
  const tokens = materializeThemeTokens(theme, plan.designIntent.tokenOverrides);
  const localized = await localizeAssets({
    assets: plan.assets,
    sourceRoot: planDirectory,
    outputDir: resolvedOutput,
    networkPolicy: plan.brief.networkPolicy,
    fetchAsset: options.fetchAsset
  });
  const assetRecords = localized.assetRecords;
  const assetById = new Map(assetRecords.map((asset) => [asset.id, asset]));
  const narrativeDiagnostics = analyzeNarrative(plan);
  const paginationDiagnostics = analyzePagination(plan);
  const contentBudget = contentBudgetReport(paginationDiagnostics);
  const reviewArtifacts = reviewAndProvenance(plan);
  validateDesignIntent(plan.designIntent);
  validateReviewReport(reviewArtifacts.review);
  validateProvenanceRecord(reviewArtifacts.provenance);
  const pendingScorecard = buildVisualScorecard({
    qa: { status: "pending", findings: [], viewports: [] },
    narrative: narrativeDiagnostics,
    pagination: contentBudget,
    provenance: reviewArtifacts.provenance
  });
  validateVisualScorecard(pendingScorecard);
  await copyFile(join(skillRoot, "assets", "deck.css"), join(resolvedOutput, "assets", "deck.css"));
  await copyFile(join(skillRoot, "assets", "deck.js"), join(resolvedOutput, "assets", "deck.js"));
  await writeFile(join(resolvedOutput, "assets", "design-tokens.css"), compileTokenCss(tokens), "utf8");
  await writeFile(join(resolvedOutput, "index.html"), htmlDocument(renderPlan, options.repairLevel ?? 0, assetById, tokens), "utf8");
  await writeFile(join(resolvedOutput, "speaker-notes.md"), renderSpeakerNotes(renderPlan), "utf8");
  await copyFile(resolve(planPath), join(resolvedOutput, "presentation-plan.source.json"));
  await writeJson(join(resolvedOutput, "presentation-plan.json"), plan);
  await writeJson(join(resolvedOutput, "design-tokens.json"), tokens);
  await writeJson(join(resolvedOutput, "sources.json"), sourceIndex(renderPlan));
  await writeJson(join(resolvedOutput, "deck-manifest.json"), deckManifest(renderPlan, assetRecords, options.repairLevel ?? 0));
  await writeJson(join(resolvedOutput, "design-intent.json"), plan.designIntent);
  await writeJson(join(resolvedOutput, "content-budget-report.json"), contentBudget);
  await writeJson(join(resolvedOutput, "narrative-report.json"), narrativeDiagnostics);
  await writeJson(join(resolvedOutput, "review-report.json"), reviewArtifacts.review);
  await writeJson(join(resolvedOutput, "asset-ledger.json"), { version: "2.0.0", assets: localized.provenanceLedger });
  await writeJson(join(resolvedOutput, "license-report.json"), licenseReport(assetRecords, theme));
  await writeJson(join(resolvedOutput, "provenance.json"), reviewArtifacts.provenance);
  await writeJson(join(resolvedOutput, "visual-scorecard.json"), pendingScorecard);
  await writeFile(join(resolvedOutput, "NOTICE"), await combinedNotice(localized.notice, theme), "utf8");
  const extension = await extensionRecord(resolvedOutput, plan, reviewArtifacts.review);
  await writeJson(join(resolvedOutput, "presentation-package.json"), pendingPackage(renderPlan, assetRecords, extension));
  await writeJson(join(resolvedOutput, "qa-report.json"), {
    version: "1.0.0",
    status: "pending",
    attempts: [],
    findings: [],
    message: "Browser quality gate has not run."
  });
  return {
    outputDir: resolvedOutput,
    indexPath: join(resolvedOutput, "index.html"),
    assetRecords,
    tokens,
    planVersion: plan.version
  };
}
