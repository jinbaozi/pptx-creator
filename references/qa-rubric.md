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
