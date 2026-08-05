import { escapeHtml } from "./utils.mjs";

export function renderDeckShell(plan, repairLevel, slides, policy = {}) {
  return `<!doctype html>
<html lang="${escapeHtml(plan.deck.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="generator" content="@pptx-creator/text-to-html 2.0.0">
  <title>${escapeHtml(plan.deck.title)}</title>
  <link rel="stylesheet" href="assets/deck.css">
  <link rel="stylesheet" href="assets/design-tokens.css">
</head>
<body data-repair-level="${repairLevel}" data-density="${escapeHtml(policy.renderControls?.informationDensity ?? "balanced")}" data-motion="${escapeHtml(policy.renderControls?.dataMotion ?? "none")}" data-max-consecutive-family="${escapeHtml(policy.renderControls?.maxConsecutiveFamily ?? 2)}" data-design-policy-sha256="${escapeHtml(policy.sha256 ?? "")}">
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

export function renderSpeakerNotes(plan) {
  const lines = [`# ${plan.deck.title} 演讲者备注`, ""];
  for (const slide of plan.slides) {
    lines.push(`## ${slide.order}. ${slide.title}`, "", slide.notes, "", `过渡：${slide.transition}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}
