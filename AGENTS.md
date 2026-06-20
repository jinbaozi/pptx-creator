# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this project is

`pptx-creator` is an Agent-oriented tool that produces **mostly editable** PowerPoint files. The architecture splits work in two:

- **Host agent** (you, or another LLM) does all reasoning: classifying input, picking a design system, authoring a `deck.manifest.json`, picking assets, judging QA output.
- **Deterministic scripts** (Node.js + Python) validate, compile, render, package, and report — they **never** call LLM APIs and never invent content.

Core invariant: the **manifest is the single source of truth**. Scripts render exactly what the manifest says.

## Common commands

```bash
# One-time setup
npm install
pip install -r requirements.txt
npx playwright install chromium
npm run setup                          # writes env-report.json

# Tests
npm test                               # vitest (JS, 120s timeout)
npm run test:py                        # python unittest in tests/
npm run workbench:test                 # workbench tests only

# Quick run on a built-in text example
npm run pipeline -- examples/text-input/deck.manifest.json output

# Render-only path (no validation, no packaging)
npm run render -- output/deck.manifest.json output/final.pptx

# Design-first end-to-end
npm run design:first -- examples/design-first/compiler-roadshow output/design-first/deck.manifest.json
npm run pipeline:design-first -- examples/design-first/compiler-roadshow output/design-first --emit-run-index --run-id compiler-roadshow --input-summary "Compiler Roadshow"

# Explore multiple design directions before committing
npm run explore:directions -- examples/design-first/compiler-roadshow/deck.storyboard.json output/directions

# Quality + repair
npm run visual:critic -- output/deck.manifest.json output/visual-review.json --mode creative
npm run repair:apply -- output/deck.manifest.json output/repair-patch.json output/deck.repaired.json
npm run accessibility:check -- output/deck.manifest.json output/accessibility-report.md
npm run openxml:repair -- output/final.pptx output/openxml-repair-report.json
npm run vision:review -- output --provider mock   # mock provider; swap to real later
npm run registry:validate                          # sources.json + asset-registry.json
npm run run:index -- output run-001 creative "deck summary"

# Input-specific helpers
npm run html:manifest -- input.html output/deck.manifest.json
npm run html:measure  -- input.html output/layout-measurements.json
npm run image:hints   -- reference.png output/image-hints.json
npm run image:replica:analyze -- reference.png output/image-replica-analysis.json
npm run image:replica:plan    -- output/image-replica-analysis.json output/replica-layer-plan.json
npm run pdf:hints    -- source.pdf output/pdf-pages -o output/pdf-page-hints.json
```

All Python helpers are invoked through `node scripts/run-python.mjs` (honors `PPTX_CREATOR_PYTHON` env var for interpreter selection). The pipeline runner (`run-deck-pipeline.mjs`) chains: `validate-manifest.py` → `render-pptx.mjs` → `package-output.py`.

## High-level architecture

The data flow has five stages. Reading order matters when debugging:

```
input (text / HTML / image / PDF / mixed)
    │
    ▼
Host agent reasoning ──► DESIGN.md selection ──► design artifacts (optional)
    │                                                │
    │                                                ▼
    └────────────────────────────► deck.manifest.json
                                          │
                                          ▼
                   Deterministic scripts (validate / compile / render)
                                          │
                                          ▼
                              final.pptx + reports
```

### 1. Inputs → design system

`SKILL.md` is the universal entry point. Load only the input-specific file routed from its progressive-disclosure table. `DESIGN.md` priority: user-provided → project-root → input-adjacent → built-in (`design-systems/<name>/`) → `business-neutral` fallback. Built-in systems are **safe baselines, not brand templates** — never add logos, trademarks, or commercial fonts to them.

Built-in design systems: `business-neutral`, `warm-editorial`, `paper-minimal`, `dark-tech`, `ai-infra`, `product-roadshow`, `developer-docs`, `dashboard-data`, `premium-black`, `chinese-government`, `enterprise-blueprint`, `executive-crimson`, `finance-boardroom`.

### 2. Design-first pipeline (creative decks)

For creative text-to-PPTX, roadshows, and briefings, follow `references/design-first-workflow.md` and write three artifacts before touching the manifest:

```
deck.storyboard.json       (Planner role: audience, narrative arc, slide beats)
deck.design-direction.json (Art Director role: visual direction, motion, tone)
slide-design-specs.json    (Slide Designer role: per-slide layout, components, content)
```

These are compiled by `scripts/compile-design-first.mjs` (logic in `scripts/lib/manifest-compiler.mjs`) into the same `deck.manifest.json` shape the renderer expects. Diagram and chart kinds (`layeredArchitecture`, `compilerPipeline`, `capabilityStack`, `swimlane`, `matrixMap`, `stackedBar`, `kpiGroup`, `sparkline`, etc.) expand into native text/shape/line primitives at compile time, so the renderer stays PPTX-only.

### 3. Manifest → PPTX (manifest-first)

`references/manifest-spec.md` is the canonical contract. Required top-level: `version`, `designSystem.source`, `designSystem.mode`, `deck.size`, `slides[]`. Coordinates are inches. Element style values can reference DESIGN.md tokens (`{colors.primary}`, `{typography.title}`, `{components.hero-card}`).

Element types: `text`, `shape`, `image`, `table`, `line`, `icon` (v0.2), `chart` (v0.2), `diagram` (visual roadmap). Schemas live in `schemas/`.

The renderer is `scripts/render-pptx.mjs` using `pptxgenjs`. `scripts/lib/chart-renderer.mjs` and `scripts/lib/diagram-compiler.mjs` expand higher-level elements to native PPT objects before render.

### 4. Reports and QA gates

Every pipeline run writes to `output/`:

- `final.pptx` — the deliverable
- `deck.manifest.json` — copy of the input manifest
- `editable-report.md`, `qa-report.md`, `compatibility-report.md` — quality dimensions
- `output-manifest.json` — packaged output index
- (design-first) `visual-review.json`, `vision-review.json`, `run.json`, `preview/`

Editability ladder (`references/qa-rubric.md`): Level 5 = fully native objects, Level 4 = text + main shapes editable, Level 3 = text editable, Levels 1-2 = replica/screenshot. **Never** package a single full-slide raster as "editable PPTX".

The visual critic (`scripts/lib/visual-critic.mjs` + `scripts/run-visual-critic.mjs`) flags overflow, tiny fonts, dense charts, empty diagram layers, oversized decorative containers. The bounded repair loop applies at most three automatic patches before asking the user (per `SKILL.md`).

### 5. Workbench (browse, do not render)

`workbench/` is a static browser shell (`index.html`, `app.js`, `styles.css`) that browses design artifacts and reports under `output/`. It does not render — the deterministic pipeline still owns rendering. Vision-review outputs sit alongside other reports and never bypass the render step.

## Repository layout

| Path | Purpose |
|---|---|
| `SKILL.md` | Universal skill entry, host-agent contract, and progressive routing |
| `agents/openai.yaml` | Optional Codex/OpenAI interface metadata |
| `schemas/` | JSON Schemas (deck, storyboard, design-direction, slide-spec, registry, repair, review) |
| `scripts/` | Entry scripts; heavy logic in `scripts/lib/` |
| `scripts/lib/` | Reusable JS/Python cores (`manifest-compiler.mjs`, `chart-renderer.mjs`, `diagram-compiler.mjs`, `visual-critic.mjs`, `run-index.mjs`, `registry.mjs`, `python-utils.mjs`, `*_core.py`) |
| `design-systems/<name>/DESIGN.md` | Built-in visual systems |
| `layout-archetypes/` | Page layout primitives consumed by `lib/archetype-resolver.mjs` |
| `references/` | Workflows, manifest spec, QA rubric, prompt library |
| `examples/{text-input,html-input,image-input,design-first,visual-roadmap-next}/` | Reference inputs |
| `workbench/` | Static visual browser |
| `tests/` | Vitest + Python unittest suites |

## Conventions specific to this codebase

- All JS scripts are ESM (`"type": "module"`). Run with `node`, not via build step.
- Python helpers must be invoked through `scripts/run-python.mjs` so interpreter selection (`PPTX_CREATOR_PYTHON`) is consistent.
- Web search is permitted inside the host agent (you) but **prohibited** inside scripts. Remote assets found by search must be localized under `output/assets/` before being referenced from the manifest.
- Strict replica mode (1:1 HTML/image/PDF) must not run creative design-direction exploration on top of the source — preserve original layout, color, typography, tone.
- Never treat a full-slide raster as an editable PPTX. If the host agent cannot achieve Level 3+, report the gap honestly.
- Do not commit `node_modules/`, `output/`, `.pptx-creator/`, or `docs/` (per `.gitignore`).
- `package.json` is private (`"private": true`); do not publish.
