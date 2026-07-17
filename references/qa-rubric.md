# QA Rubric

Host agents must self-review after `run-deck-pipeline.mjs` (or equivalent steps). Scripts write `qa-report.md` and `editable-report.md`; agents interpret and extend them.

## Validation (technical)

| Check | Pass criteria |
| --- | --- |
| Manifest schema | `validate-manifest.py` exit 0 |
| DESIGN.md | `validate-design-md.mjs` exit 0 for referenced source |
| Asset paths | All `assets[].src` and image `src` exist relative to manifest |
| PPTX render | `final.pptx` exists, size > 1 KB |
| PPTX geometry | No negative line extents; final object bounds pass occlusion and connector checks; object IDs/order match manifest lineage; manifest/PPTX hashes match |
| HTML-first Host review | Every slide passes all five packet-bound judgments, includes observations, and binds passed PowerPoint/WPS/LibreOffice evidence |
| Package output | `package-output.py` exit 0 and `output-manifest.json` hashes every indexed regular artifact |

## Content

- Covers user-requested topics and slide count.
- No invented facts, metrics, logos, or citations.
- One main idea per slide; no duplicate slides.
- Titles are specific, not generic placeholders.

## Visual

- Creative type floors after token expansion: title ≥28pt, card title ≥18pt,
  body/list ≥16pt, label/table header ≥11pt, source ≥9pt. Replica routes report
  source typography without restyling unless it causes actual clipping.
- No elements outside slide bounds (validator enforces).
- No rendered text crosses its intended frame or clipping container.
- Content remains at least 99% visible; unapproved decorations remain at least
  85% visible and do not cover content or one another.
- CJK body line-height is at least 1.20; layout-region gaps are balanced and
  intentional.
- Metrics intended as one atomic value remain on one line. Multi-line list
  items keep natural heights and never collide with their following item.
- Slide titles stay within declared `maxLines` (one by default). Content starts
  after the measured painted title bottom plus `0.12in`; critical text does not
  use viewer autofit.
- Children of rounded containers remain inside the declared/default `0.12in`
  safe inset, including axis labels and corner captions.
- Single-line table headers are vertically centered with line-height 1.0–1.4.
- Every displayed source URL is clickable; vendor claims and internal
  recommendations carry visible labels and evidence bindings.
- Every relationship connector visibly starts at its declared source and its
  target-facing arrowhead terminates at the declared target.
- Consistent design system tokens across slides.
- Reasonable whitespace; no unreadable density.

## Editability

| Level | Meaning | Default target |
| --- | --- | --- |
| 5 | All major objects native | Content decks |
| 4 | Text + main shapes native | Business decks |
| 3 | Text native, many visuals rasterized | HTML conversion |
| 2 | Large image regions | Image replica |
| 1 | Full-slide raster | Last resort only |

Report rasterized objects and why (complex icon, photo, gradient, OCR failure).

## Optional tooling

| Tool | Missing behavior |
| --- | --- |
| Playwright | HTML CSS measurement blocked; semantic HTML still works |
| Tesseract | OCR deferred; use host vision |
| LibreOffice | Deterministic CI rendering; Creative acceptance blocks when evidence is unavailable |
| PowerPoint | Release acceptance requires a bound open/render artifact; unavailable is not pass |
| WPS | Release acceptance requires a bound open/render artifact; unavailable is not pass |
| Fonts | Warn in qa-report if non-system fonts referenced |

## Response template

Tell the user:

1. Output path to `final.pptx`.
2. Slide count and overall editability level.
3. What is editable vs rasterized.
4. Any dependency gaps (Playwright, OCR, preview).
5. Suggested next edits in PowerPoint/WPS.

## Creative acceptance

A Creative run needs both deterministic evidence and mandatory Host visual
review. The Host inspects every full-size rendered slide, not only the contact
sheet; a contact sheet is navigation evidence, never the final acceptance
source. The Host submits a packet-bound sidecar. Safe refinement applies at most one
approved reversible operation per resume and shares the three-delta cap with
repair. See `references/creative-visual-proof.md` and
`references/creative-refinement.md`.

HTML-first uses its own `host-html-visual-review.schema.json`. The five required
per-slide judgments are `noOcclusion`, `textRhythm`, `whitespaceBalance`,
`connectorSemantics`, and `componentVisibility`, plus a non-empty observation
summary. The review also contains an exact three-entry suite ledger for
PowerPoint, WPS, and LibreOffice with environment, reason, and hashed evidence.
The generated template is intentionally invalid until every field is filled.
Missing or stale hashes, unavailable suites, P0/P1 findings, title reflow,
occlusion, rounded-safe-inset entry, cross-suite divergence, or any failed
judgment return to repair, and no top-level final deck is published before
acceptance.

Release-quality claims have a separate blind preference threshold: 24 briefs,
at least five reviewers per brief, overall win rate >=70%, Wilson 95% lower
bound >50%, every domain/language subgroup >=60%, and median >=4/5 in every
rating dimension. See `references/creative-benchmark.md`.

## Contextual anti-slop rules

The 9th visual-critic dimension (`slopRisk`, 0-100; higher = more slop)
flags design choices that read as an unexamined generated default. The gate is
`slopRisk <= 20`; every signal carries applicability, evidence, severity,
confidence, repair command, and contextual exemption data from `SLOP_RULES` in
`scripts/lib/slop-risk.mjs`.

The nine signals cover font-family proliferation, emoji used as iconography,
inline gradients, all-caps/stroke/shadow stacking, stock English rhetoric in a
Chinese title, mechanically repeated corner radii, circle-icon rows, peer KPI
rows, and mechanically identical vertical gaps. They are not universal style
bans. An approved brand font or gradient, literal emoji content, a display
treatment, a source quotation, a dashboard or government component system,
peer data comparison, or an intentional editorial grid can exempt the matching
rule when the closed context fields support it. Brand locks may override only
rules that explicitly allow that override; readability never can.

Calibration uses at least twelve paired positive/negative cases per rule. Each
rule must reach recall >=0.90, specificity >=0.95, and false-positive rate
<=0.05. Scored agreement additionally requires at least 80% within 20 points,
Spearman >=0.70, and MAE <=15. Local paired-fixture calibration proves formula
behavior only; agreement on external real-deck screenshots remains a separate
human evidence requirement.

The signals are intentionally disjoint from `density`, `variety`,
`hierarchy`, and `editability` (which are computed elsewhere in
`scripts/lib/visual-critic.mjs`).
