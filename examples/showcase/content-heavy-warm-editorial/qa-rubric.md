# QA Rubric — content-heavy-warm-editorial

> Qualitative review of the content-heavy-warm-editorial showcase.
> This rubric deliberately avoids numeric scores (per R17 / U9 update):
> every claim is grounded in observable design intent, render
> tradeoffs, and known limitations. Use the workbench Visual Quality
> tab to inspect the traffic-light readouts; use this document to
> understand the *why* behind the readouts.

## Design rationale

This showcase is the warm-editorial v1 demo for content-heavy long-form
text: a single-author whitepaper imagined as a printed report, then
re-cast for screen reading. The deck intentionally avoids the
"headline-and-bullets" rhythm of corporate decks; it leans into the
paper / parchment feel of the warm-editorial design system (cream
background, brown primary, orange accent, Georgia titles, generous
line-height). Each slide is a chapter beat, not a sales pitch.

The slide beats are:

1. **Cover** — title, subtitle, author band on a soft hero surface.
2. **Agenda** — eight numbered sections set as a single ordered list.
3. **Chapter essay** (x3: 缘起, 工艺, 展望) — multi-paragraph long-form
   text. The renderer lets these flow across the slide; warm-editorial
   typography (Microsoft YaHei body, 16 pt, line-height 1.65) keeps
   them readable.
4. **Three-card principles** — the only "grid" beat; it uses a 3-col
   content-card row to break the otherwise single-column rhythm.
5. **Pipeline / mapping / retrieval / risks / organization** —
   structural chapters that mix one or two short lists with prose.
6. **Closing** — brief outro + copyright / license line.

The deck's job is to demonstrate that `warm-editorial` can carry
academic / whitepaper content (which is the v1 showcase the planning
doc was missing) without forcing the content into a corporate layout.

## Tradeoffs

- **No diagrams.** This showcase deliberately skips diagrams,
  timelines, and tables. Diagrams would have been the easy way to
  inflate the slide count, but content-heavy decks are a stress test
  for typography and rhythm — adding chart layers would have hidden
  the typography tradeoffs the showcase exists to surface.
- **Auto-pagination accepted.** The HTML contains several long
  paragraphs; the html-to-manifest pipeline may auto-paginate them
  to keep the layout within bounds. We treat that as the desired
  behavior (long-form decks usually *want* flowing text), not a
  pipeline bug. The manifest flag `autoPaginate: true` documents
  this.
- **No font fallback target.** Warm-editorial's typography relies on
  Georgia (titles) and Microsoft YaHei (body). On hosts without
  YaHei the preflight may record a fallback to a generic CJK font;
  the deck still renders, but the body line-height ratio is tuned
  to YaHei's metrics.
- **Single design system.** All chapters use `warm-editorial`; we
  intentionally do not switch to a contrast design system for the
  closing slide, because the "one voice" feel is part of the
  editorial contract.
- **No images / icons.** Decorative imagery would have shifted the
  tone toward "product marketing." Empty images is a deliberate
  editability pressure test: every visible element is text or
  shape, and `editabilityLevel` should be high.

## Known limitations

- **Color contrast on muted text.** Warm-editorial's `textMuted`
  (#78716C) sits close to its surface tones, which is faithful to
  the printed-report feel but means the workbench contrast-fail
  check will *occasionally* flag a low-severity contrast issue on
  secondary paragraphs. That is a *known* and accepted outcome; the
  design system is documented to prioritize warmth over maximum
  contrast.
- **Layout-safety sensitivity on long paragraphs.** The
  `text-overflow` and `line-height-too-tight` checks may fire on
  chapters with particularly long Chinese paragraphs once the
  renderer has produced the PPTX. We have not patched this in the
  showcase; the workbench Visual Quality tab is the right place to
  read the resulting tone grid and decide whether a per-deck
  repair patch is needed.
- **Auto-pagination may split paragraphs across two slides.** This
  is consistent with the `autoPaginate: true` manifest flag, but it
  means a "chapter" visually becomes two PPTX slides. The narrative
  is unbroken; the deck is just slightly longer than 11 slides.
- **No calibration sidecar.** This showcase is qualitative (R17
  update); it does not ship a numeric `*-calibration.json` file.
  The v1 content-heavy showcase is for reading, not for measuring.
- **No brand-inspired library.** The R20 v1 scope defers the three
  `*-inspired` showcases to v2; this content-heavy showcase is the
  only newly authored v1 example.

## How to inspect

1. Run `npm run pipeline -- examples/showcase/content-heavy-warm-editorial/deck.manifest.json output/showcase-content-heavy`.
2. Open `workbench/index.html` and switch to the **Visual Quality** tab.
3. The tab fetches `output/showcase-content-heavy/visual-review.json`
   and `output/showcase-content-heavy/layout-safety-report.json` in
   parallel and renders two side-by-side traffic-light grids using
   the same cell shape as the Consistency report.
4. Use the traffic lights (pass / warn / fail) as a *signal*, not a
   verdict; this rubric is the place where design intent and known
   tradeoffs are recorded.
