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
| LibreOffice | Preview skipped; PPTX still valid |
| Fonts | Warn in qa-report if non-system fonts referenced |

## Response template

Tell the user:

1. Output path to `final.pptx`.
2. Slide count and overall editability level.
3. What is editable vs rasterized.
4. Any dependency gaps (Playwright, OCR, preview).
5. Suggested next edits in PowerPoint/WPS.

## Anti-slop do's and don'ts

The 9th visual-critic dimension (`slopRisk`, 0-100; higher = more slop)
flags design choices that read as "AI-generated default." When `slopRisk`
exceeds the Cal-0 threshold (40 on most built-in systems), host agents
should treat the deck as a draft and revise against the rules below.

### Prohibitions (always flag)

1. **Font-family dedup** — never use more than 3 unique font families
   across a single slide. System fonts (`serif`, `sans-serif`) are free.
2. **Emoji as icon** — never substitute emoji code points for icon
   elements; use a real icon library or `type: "icon"` with a named glyph.
3. **CSS gradient in inline styles** — `linear-gradient`, `radial-gradient`,
   and `conic-gradient` are raster-slop; prefer solid `colors.*` tokens or
   a single accent color block.
4. **All-caps + stroke + shadow** — never stack all three on a single
   text element. Pick one (or none) to draw attention.
5. **English rhetoric on Chinese titles** — phrases like "the future of",
   "unlock the power of", "next-generation", "revolutionary", "leverage",
   "synergy", "paradigm shift" pasted onto a CJK title read as machine
   translation. Use idiomatic Chinese instead.

### Detection signals (re-design patterns)

6. **Rounded-token variance** — if every card on a slide resolves to the
   same `rounded.*` token (e.g. all `rounded.lg`), vary the radii. A mix
   of `rounded.md` for body cards and `rounded.lg` for hero cards is the
   healthy default.
7. **Icon-circle triad** — three or more circle-bulleted icons sharing
   the same y-coordinate is a design-template tell. Break the row with
   different shapes, sizes, or staggered y values.
8. **3-up KPI sandwich** — three metric cards in a horizontal row with
   identical padding and identical numbers is the default "AI pitch deck"
   pattern. Vary the count (2 or 4) or add a narrative card.
9. **Vertical-rhythm variance** — if the gap between every consecutive
   y-coordinate is identical across a slide, the layout feels mechanical.
   Use a 2- or 3-step rhythm (e.g. `0.5 / 1.0 / 0.5 / 1.5`).

The signals are intentionally disjoint from `density`, `variety`,
`hierarchy`, and `editability` (which are computed elsewhere in
`scripts/lib/visual-critic.mjs`).

