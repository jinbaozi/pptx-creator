# pptx-creator

[中文](README.md) | **English**

## English

`pptx-creator` is an agent-oriented toolkit for generating editable PPTX files. A host agent or large language model handles understanding, planning, writing, design, and optional web research. This project handles deterministic validation, conversion, rendering, packaging, and quality checks, producing `.pptx` files that remain editable in PowerPoint or WPS.

Core principle: **author a structured manifest first, then render PPTX deterministically**. Package scripts do not call LLM APIs and do not invent content.

## Use Cases

- Generate business roadshows, technical briefings, product decks, training decks, and research reports from text or Markdown.
- Convert semantic HTML or CSS-positioned HTML into editable PPTX.
- Rebuild screenshots, image-only slides, and PDF pages into mostly editable PowerPoint files.
- Let agents combine design systems, web research, source registries, and quality checks into a reliable deck generation workflow.
- Batch-generate PPTX files and produce editability, compatibility, accessibility, visual review, and regression reports.

## Core Capabilities

| Capability | Description |
| --- | --- |
| Text to PPTX | The host agent turns raw content into an outline, slide plan, copy, and `deck.manifest.json`; the pipeline renders the deck. |
| Design-first creation | Uses `storyboard -> design direction -> slide design specs -> deck manifest -> PPTX` so story, visual direction, and slide design can be reviewed before rendering. |
| Layout archetypes and compilation | Built-in layout archetypes, design system parsing, and manifest compilation turn design specs into deterministic PPTX manifests. |
| HTML to PPTX | Supports semantic HTML, CSS-positioned HTML, DOM measurement, remote image localization, and multi-slide conversion. |
| Image/PDF input | Provides image inspection, palette extraction, OCR, cropping, image replica analysis, layer planning, and PDF page hint helpers. |
| Editable rendering | Prefers native PowerPoint text, shapes, lines, tables, charts, icons, and semantic diagrams. |
| Charts and diagrams | Supports charts such as `bar`, `line`, `pie`, `stackedBar`, `horizontalBar`, `groupedBar`, `kpiGroup`, and `sparkline`, plus semantic diagrams such as `layeredArchitecture`, `compilerPipeline`, `capabilityStack`, `swimlane`, and `matrixMap`; all expand into editable PowerPoint primitives. |
| Design systems | `DESIGN.md` files define colors, typography, components, layout rules, and export rules. |
| Visual review and repair | Includes rule-based visual critic, visual review contracts, repair patches, bounded repair loops, and repair CLI support; it flags small text, bounds issues, dense chart labels, missing descriptions, empty diagram layers, and oversized empty decorative containers. |
| Quality checks | Manifest validation, editability reports, QA reports, WPS compatibility, accessibility, OpenXML inspection, and visual regression. |
| Registries | Source and asset registries track facts, materials, license status, and usage. |
| Metadata flow | Connects registry validation, run indexes, design-first pipeline flags, and generated reports for batch generation, auditability, and review. |

## Installation

### Requirements

Required:

- Node.js 20+
- npm
- Python 3.10+

Recommended:

- PowerPoint or WPS for manual final inspection
- Windows PowerShell, macOS Terminal, or Linux shell

Optional:

- Playwright Chromium for CSS-positioned HTML measurement
- Tesseract OCR for local OCR
- LibreOffice for PPTX preview rendering and visual regression
- PyMuPDF for PDF page rendering

### Install Dependencies

```bash
npm install
pip install -r requirements-core.txt
npx playwright install chromium
npm run setup -- core
```

To force a Python interpreter:

```powershell
$env:PPTX_CREATOR_PYTHON="C:\Path\To\python.exe"
npm run setup -- core
```

## Quick Start

Install Python dependencies by profile: core has no third-party Python
packages; image uses `pip install -r requirements-image.txt`; pdf uses
`pip install -r requirements-pdf.txt`. The HTML browser dependency is provided
by Node/Playwright.

Run the built-in text example:

```bash
npm run pptx -- text examples/text-input/deck.manifest.json output
```

Successful output:

```text
output/
  final.pptx
  deck.manifest.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json
```

## Creative Deck Plan Workflow

Use this for polished business, product, technical, roadshow, research, or training decks:

```bash
npm run pptx -- text examples/text-input/creative/deck.plan.json output/creative --creative
```

The single coordinate-free creative intermediate is `deck.plan.json`:

```text
deck.plan.json
deck.manifest.json
final.pptx
quality-report.json
quality-report.md
preview/index.html
```

The plan records the design read, three contextual dials, audience, narrative beats, slide messages, layout families, and content/asset references. Family-specific compilers turn it into a deterministic `deck.manifest.json`. Direction candidates are optional only for material ambiguity or high risk; HTML is not a mandatory text intermediate.

## HTML, Image, and PDF Inputs

Semantic or CSS-positioned HTML:

```bash
npm run pptx -- html input.html output/html
```

The strict image route is `npm run pptx -- image reference.png output/image`; it blocks explicitly until a fidelity-proof compiler exists.

PDF pages:

The strict PDF route is `npm run pptx -- pdf source.pdf output/pdf`; it blocks explicitly until a fidelity-proof compiler exists.

PDF support is page-level hint generation. The final deck should still be rebuilt as editable text, shapes, tables, and charts rather than being rendered as full-slide images.

## Quality Checks and Repair

The unified pipeline owns layout, taste/fidelity proof, editability, compatibility, and consistency reports, and stops later stages on hard failure.

## Architecture

```text
User input
  text / markdown / HTML / image / PDF / mixed references
        |
        v
Host Agent
  Planner      -> audience, outline, storyline
  Writer       -> claims, copy, tables, chart data, speaker notes
  Designer     -> DESIGN.md, layouts, components, visual direction
  Researcher   -> optional web search, sources, asset discovery
  Critic       -> review, repair patch, quality gates
        |
        v
Creative intermediate
  deck.plan.json
        |
        v
deck.manifest.json
  version, designSystem, deck, assets, slides, elements
        |
        v
Deterministic scripts
  validate-manifest.py
  deck-plan.mjs
  html-to-manifest.mjs
  measure-html.mjs
  image/pdf hint scripts
  registry/run-index/visual review helpers
        |
        v
Renderer
  render-pptx.mjs + PptxGenJS
        |
        v
Reports and QA
  editable-report.md
  qa-report.md
  compatibility-report.md
  accessibility-report.md
  visual-review.json
  visual-regression-report.json
        |
        v
final.pptx
```

## Repository Layout

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Universal Agent Skill entry point, core contract, and on-demand routing. |
| `agents/openai.yaml` | Codex/OpenAI interface metadata; not runtime logic. |
| `references/` | Detailed workflows loaded progressively by input type and task stage. |
| `design-systems/` | Built-in generic design systems. |
| `layout-archetypes/` | Slide layout archetypes for design-first compilation. |
| `schemas/` | JSON Schemas for deck, storyboard, design direction, registry, repair, and review artifacts. |
| `scripts/` | Conversion, rendering, validation, repair, and regression scripts. |
| `scripts/lib/` | Reusable core logic. |
| `references/` | Workflow, manifest, HTML/image/PDF, and QA references. |
| `examples/` | Text, HTML, image, design-first, and visual-roadmap examples. |
| `tests/` | JavaScript and Python regression tests. |

## Built-in Design Systems

Common built-ins:

- `business-neutral`
- `warm-editorial`
- `paper-minimal`
- `dark-tech`
- `ai-infra`
- `product-roadshow`
- `developer-docs`
- `dashboard-data`
- `premium-black`
- `chinese-government`
- `enterprise-blueprint`
- `executive-crimson`
- `finance-boardroom`

User-provided `DESIGN.md` files have the highest priority. Built-ins are safe generic baselines, not brand templates; do not add real logos, trademarked materials, or commercial fonts to them.

## Common npm Scripts

| Command | Description |
| --- | --- |
| `npm run pptx -- ...` | Only public operational entry. |
| `npm run setup -- core\|html\|image\|pdf` | Check one environment profile. |
| `npm test` / `npm run test:unit` | Run JavaScript unit tests. |
| `npm run test:browser` | Run browser integration tests. |
| `npm run test:visual` | Run visual pipeline tests. |
| `npm run test:py` | Run Python tests. |

## Tests

```bash
npm test
npm run test:py
```

## Editability

The default target is Level 4 or Level 5:

- Level 5: major objects are native PowerPoint objects.
- Level 4: text and primary visual structures are editable; complex photos or textures may be images.
- Level 3: text is editable, but more visual objects are rasterized.
- Level 1-2: reserved for strict screenshot replicas or explicitly accepted low-editability outputs.

This project should not wrap a full-slide screenshot and call it an editable PPTX.

## Web Research and Asset Policy

The host agent may decide to use web research when it improves factual accuracy, terminology, visual references, asset quality, or source tracking. When using external material:

- Do not fabricate facts, metrics, examples, or citations.
- Respect copyright, licenses, trademarks, logos, and font restrictions.
- Localize remote assets into the output directory before writing them into the manifest.
- Keep important sources in the final response, QA notes, or registries.

## License

MIT
