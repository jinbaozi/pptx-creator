# QA Rubric

Host agents must self-review after `run-deck-pipeline.mjs` (or equivalent steps). Scripts write `qa-report.md` and `editable-report.md`; agents interpret and extend them.

## Validation (technical)

| Check | Pass criteria |
| --- | --- |
| Manifest schema | `validate-manifest.py` exit 0 |
| DESIGN.md | `validate-design-md.mjs` exit 0 for referenced source |
| Asset paths | All `assets[].src` and image `src` exist relative to manifest |
| PPTX render | `final.pptx` exists, size > 1 KB |
| Package output | `package-output.py` exit 0 |

## Content

- Covers user-requested topics and slide count.
- No invented facts, metrics, logos, or citations.
- One main idea per slide; no duplicate slides.
- Titles are specific, not generic placeholders.

## Visual

- Minimum body font ≥ 11pt after token expansion.
- No elements outside slide bounds (validator enforces).
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
| LibreOffice | Creative acceptance blocks; direct/replica routes report unavailable preview evidence |
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
sheet, and submits a packet-bound sidecar. Safe refinement applies at most one
approved reversible operation per resume and shares the three-delta cap with
repair. See `references/creative-visual-proof.md` and
`references/creative-refinement.md`.

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
