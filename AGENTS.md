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
pip install -r requirements-core.txt
npx playwright install chromium
npm run setup -- core                  # writes env-report.json

# Tests
npm test                               # vitest (JS, 120s timeout)
npm run test:browser                   # Playwright-backed HTML checks
npm run test:visual                    # visual pipeline tests
npm run test:py                        # python unittest in tests/

# Quick run on a built-in text example
npm run pptx -- text examples/text-input/deck.manifest.json output

# Design-first end-to-end
npm run pptx -- text examples/design-first/compiler-roadshow output/design-first --creative

# Replica routes (image/PDF block until a fidelity-proof compiler exists)
npm run pptx -- html input.html output/html
npm run pptx -- image reference.png output/image
npm run pptx -- pdf source.pdf output/pdf
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

### 2. Creative text pipeline

For creative text-to-PPTX, roadshows, and briefings, follow `references/design-first-workflow.md` and write one coordinate-free `deck.plan.json` version `0.1.0`. It carries the design read, contextual dials, audience, narrative beats, slide messages, selected layout families, and content/asset references.

`scripts/lib/deck-plan.mjs` validates each advertised archetype and compiles materially distinct native geometry into `deck.manifest.json`. Direction candidates are optional only for material ambiguity or high risk. HTML is optional only when explicitly requested or necessary; it is not a required text intermediate.

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
- (creative) `visual-review.json`

Editability ladder (`references/qa-rubric.md`): Level 5 = fully native objects, Level 4 = text + main shapes editable, Level 3 = text editable, Levels 1-2 = replica/screenshot. **Never** package a single full-slide raster as "editable PPTX".

The visual critic (`scripts/lib/visual-critic.mjs` + `scripts/run-visual-critic.mjs`) flags overflow, tiny fonts, dense charts, empty diagram layers, oversized decorative containers. The bounded repair loop applies at most three automatic patches before asking the user (per `SKILL.md`).

## Repository layout

| Path | Purpose |
|---|---|
| `SKILL.md` | Universal skill entry, host-agent contract, and progressive routing |
| `agents/openai.yaml` | Optional Codex/OpenAI interface metadata |
| `schemas/` | JSON Schemas (deck, storyboard, design-direction, slide-spec, registry, repair, review) |
| `scripts/` | Entry scripts; heavy logic in `scripts/lib/` |
| `scripts/lib/` | Reusable JS/Python cores (`deck-plan.mjs`, `chart-renderer.mjs`, `diagram-compiler.mjs`, `visual-critic.mjs`, `run-index.mjs`, `registry.mjs`, `python-utils.mjs`, `*_core.py`) |
| `design-systems/<name>/DESIGN.md` | Built-in visual systems |
| `layout-archetypes/` | Page layout primitives consumed by `lib/archetype-resolver.mjs` |
| `references/` | Workflows, manifest spec, and QA rubric |
| `examples/{text-input,html-input,image-input,design-first,visual-roadmap-next}/` | Reference inputs |
| `tests/` | Vitest + Python unittest suites |

## Conventions specific to this codebase

- All JS scripts are ESM (`"type": "module"`). Run with `node`, not via build step.
- Python helpers must be invoked through `scripts/run-python.mjs` so interpreter selection (`PPTX_CREATOR_PYTHON`) is consistent.
- Web search is permitted inside the host agent (you) but **prohibited** inside scripts. Remote assets found by search must be localized under `output/assets/` before being referenced from the manifest.
- Strict replica mode (1:1 HTML/image/PDF) must not run creative design-direction exploration on top of the source — preserve original layout, color, typography, tone.
- Never treat a full-slide raster as an editable PPTX. If the host agent cannot achieve Level 3+, report the gap honestly.
- Do not commit `node_modules/`, `output/`, `.pptx-creator/`, or `docs/` (per `.gitignore`).
- `package.json` is private (`"private": true`); do not publish.
