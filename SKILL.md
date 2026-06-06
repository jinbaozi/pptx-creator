---
name: pptx-creator
description: Create beautiful, mostly editable PPTX files from host-agent-generated manifests guided by DESIGN.md. Use when the user asks to generate, convert, recreate, redesign, or export content as PPTX, PowerPoint, slides, deck, or editable presentation.
license: MIT
compatibility: Cross-agent Agent Skill. Requires Node.js 20+ and Python 3.10+. Scripts do not call LLM APIs.
metadata:
  version: "0.3.1"
  output: "pptx"
  rendering-backend: "pptxgenjs"
  design-source: "DESIGN.md"
---

# PPTX Creator

Use this skill to render a host-agent-authored `deck.manifest.json` into a mostly editable PowerPoint file.

## Core rule

All reasoning is performed by the host agent. Scripts are deterministic helpers only. Do not call external LLM APIs from package scripts.

## Web search rule

The host agent may autonomously use web search at any point in the workflow when it improves:

- factual accuracy, terminology, dates, standards, or technical claims;
- content richness, examples, market context, or comparison framing;
- visual references, layout polish, icon/source material discovery, or asset quality.

Search is not mandatory. Skip it when the user forbids联网, the provided material is sufficient, or a strict 1:1 replica would be changed by outside references.

When search is used:

- Keep facts tied to source URLs; do not invent metrics, case studies, claims, or citations.
- Respect copyright, license, logo, trademark, and font restrictions.
- Localize remote image/material assets into the output folder before rendering, typically under `output/assets/`.
- Report important sources and caveats in the final answer or QA notes.

## DESIGN.md rule

Before generating any PPTX, find and read a `DESIGN.md` file.

Priority:

1. User-provided `DESIGN.md`.
2. Project-root `DESIGN.md`.
3. Input-adjacent `DESIGN.md`.
4. Built-in `design-systems/<name>/DESIGN.md`.
5. `design-systems/business-neutral/DESIGN.md`.

Use `DESIGN.md` as the source of truth for visual identity, design tokens, layout rules, component styles, and PPTX export rules.

Do not create arbitrary colors, fonts, gradients, or component styles unless the selected `DESIGN.md` allows creative expansion.

## Built-in design systems

Use these scenario systems when the user does not provide a custom `DESIGN.md`:

- `business-neutral`: default for enterprise briefings, technical proposals, and product summaries.
- `warm-editorial`: courses, whitepapers, research reports, and content-heavy decks.
- `paper-minimal`: Chinese handouts, academic material, and paper-like lecture decks.
- `dark-tech`: AI, cloud, security, infrastructure, and developer tools.
- `ai-infra`: model platforms, AI infrastructure, inference systems, and toolchain roadshows.
- `product-roadshow`: 产品发布、路演、商业计划书、销售材料。
- `developer-docs`: technical documentation, architecture explainers, API/platform decks.
- `dashboard-data`: analytics, observability, monitoring, and operations reviews.
- `premium-black`: premium covers, hard-tech launches, cinematic brand pages.
- `chinese-government`: 政务、公共部门、操作系统、正式汇报。

If the user's content clearly matches a scenario, choose that built-in system. Otherwise use `business-neutral`.

Never treat built-in systems as real-brand replicas. Do not add logos, trademarked assets, commercial fonts, or brand-specific claims.

## Default workflow

Read `AGENT.md` and `references/workflow.md` first. After authoring `deck.manifest.json`:

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

Then read `output/editable-report.md`, `output/qa-report.md`, and `references/qa-rubric.md` before responding.

Prompt templates: `references/prompt-library.md`.

## Agent adapters

For host-specific setup and reporting expectations, read the matching adapter:

- Codex: `adapters/codex.md`
- Claude Code: `adapters/claude-code.md`
- Cursor: `adapters/cursor.md`

If the host agent is not listed, follow `AGENT.md` and the default workflow.

## M1.1 workflow (manifest-first)

1. Read `references/design-md-for-pptx.md`.
2. Select a `DESIGN.md` using the priority rules and built-in heuristics.
3. Read the YAML frontmatter and body sections.
4. Create `deck.manifest.json` with `designSystem.source` and token references.
5. Run `node scripts/run-deck-pipeline.mjs output/deck.manifest.json output`.
6. Read reports before responding.

## M1.2 workflow (HTML input)

When the user provides HTML visual drafts:

1. Read `references/html-to-pptx.md`.
2. Structure HTML with `pptx-deck` / `pptx-slide` conventions (or let the host agent produce semantic HTML).
3. Convert:
   `node scripts/html-to-manifest.mjs input.html output/deck.manifest.json`
4. Validate and render using the M1.1 commands above.
5. Report editability level; complex CSS regions should be image assets, not full-slide raster fallback.

## M1.4 workflow (HTML CSS measurement)

When HTML uses CSS positioning without explicit inch coordinates:

1. Read `references/html-measurement.md`.
2. Mark measurable elements with `data-pptx-kind` and `data-pptx-id`.
3. Install Playwright browser once: `npx playwright install chromium`
4. Measure:
   `node scripts/measure-html.mjs input.html output/layout-measurements.json`
5. Convert with measurements:
   `node scripts/html-to-manifest.mjs input.html output/deck.manifest.json --measurements output/layout-measurements.json`
6. Validate and render using the M1.1 commands above.

## M1.3 workflow (image input)

When the user provides a slide screenshot or reference image:

1. Read `references/image-to-pptx.md`.
2. Install Python image helpers: `pip install -r requirements.txt`
3. Inspect:
   `python scripts/inspect-image.py reference.png`
   `python scripts/image-to-manifest-hints.py reference.png output/image-hints.json`
4. Inventory objects visually; use `layoutHints` and `manifestSkeleton` from hints JSON.
5. Replace placeholder text in the skeleton; assign editability per object.
6. Validate and render using the M1.1 commands above.
7. Report editability level (target Level 2–4 for image replication).

## M1.5 workflow (OCR, crop, preview)

Optional deterministic helpers:

```bash
pip install -r requirements.txt
python scripts/ocr-image.py reference.png -o output/ocr.json
python scripts/extract-palette.py reference.png output/palette.json
python scripts/crop-assets.py reference.png crops.json output/assets
python scripts/render-preview.py output/final.pptx output/preview
python scripts/compare-preview.py reference.png output/preview/slide.png -o output/preview-diff.json
```

Tesseract and LibreOffice are optional; report `status: deferred` in env-report when missing.

## Editability priority

Prefer native PowerPoint objects:

1. Text boxes.
2. Rectangles, rounded rectangles, circles, lines, and arrows.
3. Native tables.
4. Images only for photos, complex icons, shadows, textures, and fallback backgrounds.

Never describe a single full-slide raster image with zero editable text as an editable PPTX.

## Setup

Run once:

```bash
npm install
pip install -r requirements.txt
npx playwright install chromium
node scripts/setup.mjs
```

## Pipeline command

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```
