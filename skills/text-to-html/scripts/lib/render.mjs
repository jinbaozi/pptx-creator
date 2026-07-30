import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { validatePlan } from "./plan.mjs";
import {
  assertRegularFileInside,
  assertSafeOutputDir,
  escapeHtml,
  mimeFromPath,
  readJson,
  sha256File,
  skillRoot,
  writeJson
} from "./utils.mjs";

const STATUS_LABELS = {
  inferred: "假设",
  unverified: "待核验",
  placeholder: "占位"
};

function componentAttrs(id, kind = "text", extra = "") {
  return `data-pptx-id="${escapeHtml(id)}" data-pptx-kind="${escapeHtml(kind)}"${extra ? ` ${extra}` : ""}`;
}

function claimText(claim) {
  const label = STATUS_LABELS[claim.factStatus];
  return `${label ? `<span class="status-label">${label}</span>` : ""}<span>${escapeHtml(claim.text)}</span>`;
}

function claimAttrs(claim) {
  return `data-fact-status="${escapeHtml(claim.factStatus)}" data-source-ids="${escapeHtml((claim.sourceRefs ?? []).join(" "))}"`;
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
        <div class="metric-value" data-layout-role="metric" ${componentAttrs(`${slide.id}-metric-value-${index + 1}`, "text", claimAttrs(metric.claim))}>${escapeHtml(metric.value)}</div>
        <div class="metric-label" ${componentAttrs(`${slide.id}-metric-label-${index + 1}`, "text")}>${escapeHtml(metric.label)}</div>
      </div>
      ${metric.detail ? `<p class="metric-detail" ${componentAttrs(`${slide.id}-metric-detail-${index + 1}`, "text")}>${escapeHtml(metric.detail)}</p>` : ""}
    </article>`).join("")}</div>`;
}

function processBody(slide) {
  const cards = slide.content.steps.map((step, index) => `
    <article class="card process-card" data-qa-box ${componentAttrs(`${slide.id}-step-${index + 1}`, "shape")}>
      <span class="process-index" ${componentAttrs(`${slide.id}-step-index-${index + 1}`, "text")}>${index + 1}</span>
      <h2 ${componentAttrs(`${slide.id}-step-label-${index + 1}`, "text")}>${escapeHtml(step.label)}</h2>
      <p class="fact-line" ${componentAttrs(`${slide.id}-step-copy-${index + 1}`, "text", claimAttrs(step.claim))}>${claimText(step.claim)}</p>
    </article>`).join("");
  const connectors = slide.content.steps.slice(0, -1).map((_, index) => `
      <path data-connector data-source-id="${slide.id}-step-${index + 1}" data-target-id="${slide.id}-step-${index + 2}"
        data-source-anchor="right" data-target-anchor="left" data-connector-route="orthogonal"
        ${componentAttrs(`${slide.id}-connector-${index + 1}`, "line")}
        fill="none" stroke="var(--color-primary)" stroke-width="4" marker-end="url(#arrow-${slide.id})"></path>`).join("");
  return `<div class="process-wrap">
    <div class="process-grid" style="--step-count:${slide.content.steps.length}">${cards}</div>
    <svg class="connector-layer" aria-hidden="true">
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
  return `<div class="image-layout">
    <figure class="card image-frame" data-qa-box ${componentAttrs(`${slide.id}-image-frame`, "shape")}>
      <img src="${escapeHtml(asset.outputPath)}" alt="${escapeHtml(asset.alt)}" data-object-fit="${escapeHtml(asset.objectFit ?? "contain")}" style="object-fit:${escapeHtml(asset.objectFit ?? "contain")}" ${componentAttrs(`${slide.id}-image`, "image")}>
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

function renderBody(plan, slide, assetById) {
  if (slide.type === "cover") return coverBody(plan, slide);
  if (slide.type === "statement") return statementBody(slide);
  if (slide.type === "bullets") return bulletsBody(slide);
  if (slide.type === "comparison") return comparisonBody(slide);
  if (slide.type === "metrics") return metricsBody(slide);
  if (slide.type === "process") return processBody(slide);
  if (slide.type === "timeline") return timelineBody(slide);
  if (slide.type === "quote") return quoteBody(slide);
  if (slide.type === "image") return imageBody(slide, assetById);
  if (slide.type === "closing") return closingBody(slide);
  return "";
}

function renderSlide(plan, slide, assetById) {
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
        ${renderBody(plan, slide, assetById)}
      </main>
      <footer class="slide-footer">
        <span class="source-list" ${componentAttrs(`${slide.id}-sources`, "text", 'data-layout-role="source"')}>${footer ? `来源：${footer}` : ""}</span>
        <span class="folio" ${componentAttrs(`${slide.id}-folio`, "text", 'data-layout-role="slide-number"')}>${slide.order} / ${plan.slides.length}</span>
      </footer>
      <aside class="speaker-notes" aria-hidden="true">${escapeHtml(slide.notes)}</aside>
    </div>
  </section>`;
}

function tokenCss(tokens) {
  return `:root {
  --font-display: ${tokens.fonts.display};
  --font-body: ${tokens.fonts.body};
  --color-bg: ${tokens.colors.background};
  --color-surface: ${tokens.colors.surface};
  --color-text: ${tokens.colors.text};
  --color-muted: ${tokens.colors.muted};
  --color-primary: ${tokens.colors.primary};
  --color-primary-soft: ${tokens.colors.primarySoft};
  --color-accent: ${tokens.colors.accent};
  --color-positive: ${tokens.colors.positive};
  --color-border: ${tokens.colors.border};
  --title-size: ${tokens.type.title}px;
  --section-size: ${tokens.type.section}px;
  --body-size: ${tokens.type.body}px;
  --label-size: ${tokens.type.label}px;
  --source-size: ${tokens.type.source}px;
  --canvas-x: ${tokens.space.canvasX}px;
  --canvas-y: ${tokens.space.canvasY}px;
  --gap: ${tokens.space.gap}px;
}
`;
}

function mergeTokens(base, overrides) {
  const merged = structuredClone(base);
  for (const [group, values] of Object.entries(overrides ?? {})) {
    if (!merged[group] || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(merged[group], key)) merged[group][key] = value;
    }
  }
  return merged;
}

function htmlDocument(plan, repairLevel, assetById) {
  const slides = plan.slides.map((slide) => renderSlide(plan, slide, assetById)).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(plan.deck.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="generator" content="@pptx-creator/text-to-html 1.0.0">
  <title>${escapeHtml(plan.deck.title)}</title>
  <link rel="stylesheet" href="assets/deck.css">
  <link rel="stylesheet" href="assets/design-tokens.css">
</head>
<body data-repair-level="${repairLevel}">
  <div class="deck-stage">
    <div class="pptx-deck" role="region" aria-label="${escapeHtml(plan.deck.title)}">
      ${slides}
    </div>
  </div>
  <aside class="mobile-reader" aria-label="移动端阅读模式">
    <h2 class="mobile-reader-heading"></h2>
    <div class="mobile-reader-content"></div>
  </aside>
  <nav class="deck-controls" aria-label="幻灯片导航">
    <button type="button" data-nav="previous" aria-label="上一页">←</button>
    <span class="deck-counter" aria-live="polite">1 / ${plan.slides.length}</span>
    <button type="button" data-nav="next" aria-label="下一页">→</button>
  </nav>
  <script src="assets/deck.js"></script>
</body>
</html>
`.replace(/[ \t]+\n/g, "\n");
}

function notesMarkdown(plan) {
  const lines = [`# ${plan.deck.title} 演讲者备注`, ""];
  for (const slide of plan.slides) {
    lines.push(`## ${slide.order}. ${slide.title}`, "", slide.notes, "", `过渡：${slide.transition}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
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

function pendingPackage(plan, assetRecords) {
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
      rights: asset.rights,
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
        "browser-geometry"
      ]
    }
  };
}

export async function buildDeck(plan, planPath, outputDir, options = {}) {
  const resolvedOutput = assertSafeOutputDir(outputDir);
  const planDirectory = dirname(resolve(planPath));
  await validatePlan(plan, { planDirectory });
  await mkdir(join(resolvedOutput, "assets", "media"), { recursive: true });
  await mkdir(join(resolvedOutput, "qa"), { recursive: true });

  const defaultTokens = await readJson(join(skillRoot, "assets", "design-tokens.default.json"));
  const tokens = mergeTokens(defaultTokens, plan.design?.tokenOverrides);
  const assetRecords = [];
  for (const [index, asset] of plan.assets.entries()) {
    const checked = await assertRegularFileInside(planDirectory, asset.path, `$.assets[${index}].path`);
    const suffix = extname(checked.normalized).toLowerCase();
    const outputPath = `assets/media/${asset.id}${suffix}`;
    await copyFile(checked.path, join(resolvedOutput, outputPath));
    assetRecords.push({
      id: asset.id,
      sourcePath: checked.normalized,
      outputPath,
      mime: asset.mime || mimeFromPath(checked.normalized),
      rights: asset.rights,
      alt: asset.alt,
      objectFit: asset.objectFit ?? "contain",
      ...(asset.sourceRef ? { sourceRef: asset.sourceRef } : {}),
      sha256: await sha256File(checked.path)
    });
  }
  const assetById = new Map(assetRecords.map((asset) => [asset.id, asset]));
  const portablePlan = structuredClone(plan);
  const outputPathByAsset = new Map(assetRecords.map((asset) => [asset.id, asset.outputPath]));
  for (const asset of portablePlan.assets) asset.path = outputPathByAsset.get(asset.id);
  await copyFile(join(skillRoot, "assets", "deck.css"), join(resolvedOutput, "assets", "deck.css"));
  await copyFile(join(skillRoot, "assets", "deck.js"), join(resolvedOutput, "assets", "deck.js"));
  await writeFile(join(resolvedOutput, "assets", "design-tokens.css"), tokenCss(tokens), "utf8");
  await writeFile(join(resolvedOutput, "index.html"), htmlDocument(plan, options.repairLevel ?? 0, assetById), "utf8");
  await writeFile(join(resolvedOutput, "speaker-notes.md"), notesMarkdown(plan), "utf8");
  await writeJson(join(resolvedOutput, "presentation-plan.source.json"), plan);
  await writeJson(join(resolvedOutput, "presentation-plan.json"), portablePlan);
  await writeJson(join(resolvedOutput, "design-tokens.json"), tokens);
  await writeJson(join(resolvedOutput, "sources.json"), sourceIndex(plan));
  await writeJson(join(resolvedOutput, "deck-manifest.json"), deckManifest(plan, assetRecords, options.repairLevel ?? 0));
  await writeJson(join(resolvedOutput, "presentation-package.json"), pendingPackage(plan, assetRecords));
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
    tokens
  };
}
