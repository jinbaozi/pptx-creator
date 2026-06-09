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
| Multi-direction exploration | Generates candidate visual directions, scorecards, and run indexes so agents can choose a stronger direction before producing the full deck. |
| HTML to PPTX | Supports semantic HTML, CSS-positioned HTML, DOM measurement, remote image localization, and multi-slide conversion. |
| Image/PDF input | Provides image inspection, palette extraction, OCR, cropping, image replica analysis, layer planning, and PDF page hint helpers. |
| Editable rendering | Prefers native PowerPoint text, shapes, lines, tables, charts, icons, and semantic diagrams. |
| Charts and diagrams | Supports charts such as `bar`, `line`, `pie`, `stackedBar`, `horizontalBar`, `groupedBar`, `kpiGroup`, and `sparkline`, plus semantic diagrams such as `layeredArchitecture`, `compilerPipeline`, `capabilityStack`, `swimlane`, and `matrixMap`; all expand into editable PowerPoint primitives. |
| Design systems | `DESIGN.md` files define colors, typography, components, layout rules, and export rules. |
| Visual review and repair | Includes rule-based visual critic, visual review contracts, repair patches, bounded repair loops, and repair CLI support; it flags small text, bounds issues, dense chart labels, missing descriptions, empty diagram layers, and oversized empty decorative containers. |
| Screenshot-Level Vision Model Review | Provides a mock CLI, review merge logic, and stable output contract for future provider-backed screenshot-level vision review. |
| Quality checks | Manifest validation, editability reports, QA reports, WPS compatibility, accessibility, OpenXML inspection, visual regression, and screenshot-level vision review. |
| Registries | Source and asset registries track facts, materials, license status, and usage. |
| Metadata flow | Connects registry validation, run indexes, direction exploration, design-first pipeline flags, and generated reports for batch generation, auditability, and review. |
| Visual Workbench | A local visual workbench shell for browsing directions, reports, and generated artifacts. |

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

- Playwright Chromium for CSS-positioned HTML measurement and Workbench tests
- Tesseract OCR for local OCR
- LibreOffice for PPTX preview rendering and visual regression
- PyMuPDF for PDF page rendering

### Install Dependencies

```bash
npm install
pip install -r requirements.txt
npx playwright install chromium
node scripts/setup.mjs
```

To force a Python interpreter:

```powershell
$env:PPTX_CREATOR_PYTHON="C:\Path\To\python.exe"
npm run setup
```

## Quick Start

Run the built-in text example:

```bash
npm run pipeline -- examples/text-input/deck.manifest.json output
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

Step by step:

```bash
node scripts/validate-design-md.mjs design-systems/business-neutral/DESIGN.md
python scripts/validate-manifest.py examples/text-input/deck.manifest.json
node scripts/render-pptx.mjs examples/text-input/deck.manifest.json output/final.pptx
python scripts/package-output.py output
```

## Design-First Workflow

Use this for polished business, product, technical, roadshow, research, or training decks:

```bash
npm run design:first -- examples/design-first/compiler-roadshow output/design-first/deck.manifest.json
npm run pipeline:design-first -- examples/design-first/compiler-roadshow output/design-first --emit-run-index --validate-registry --run-id compiler-roadshow --input-summary "Compiler Roadshow"
```

Core design artifacts:

```text
deck.storyboard.json
deck.design-direction.json
slide-design-specs.json
deck.manifest.json
final.pptx
visual-review.json
run.json
```

Design artifacts (storyboard, design direction, slide design specs, UI component spec, preview artifacts) are written to disk under a JSON schema and compiled into a deterministic `deck.manifest.json`, which renders to an editable PPTX that remains editable in PowerPoint or WPS. preview artifacts are used to inspect design direction offline, and screenshot-level review defaults to a mock provider boundary that can later be swapped for a real vision-capable provider.

Explore multiple visual directions:

```bash
npm run explore:directions -- examples/design-first/compiler-roadshow/deck.storyboard.json output/directions
```

## HTML, Image, and PDF Inputs

Semantic HTML:

```bash
npm run html:manifest -- input.html output/deck.manifest.json
npm run pipeline -- output/deck.manifest.json output
```

CSS-positioned HTML:

```bash
npm run html:measure -- input.html output/layout-measurements.json
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json --measurements output/layout-measurements.json
npm run pipeline -- output/deck.manifest.json output
```

Image or screenshot:

```bash
npm run image:inspect -- reference.png
npm run image:hints -- reference.png output/image-hints.json
npm run image:replica:analyze -- reference.png output/image-replica-analysis.json
npm run image:replica:plan -- output/image-replica-analysis.json output/replica-layer-plan.json
npm run image:ocr -- reference.png -o output/ocr.json
npm run image:palette -- reference.png output/palette.json
npm run image:crop -- reference.png crops.json output/assets
```

PDF pages:

```bash
npm run pdf:hints -- source.pdf output/pdf-pages -o output/pdf-page-hints.json
```

PDF support is page-level hint generation. The final deck should still be rebuilt as editable text, shapes, tables, and charts rather than being rendered as full-slide images.

## Quality Checks and Repair

```bash
npm run accessibility:check -- output/deck.manifest.json output/accessibility-report.md
npm run openxml:repair -- output/final.pptx output/openxml-repair-report.json
npm run visual:critic -- output/deck.manifest.json output/visual-review.json --mode creative
npm run repair:apply -- output/deck.manifest.json output/repair-patch.json output/deck.repaired.json
npm run visual:regression -- output/deck.manifest.json output
npm run vision:review -- output --provider mock
npm run run:index -- output run-001 creative "deck summary"
```

`visual:critic` checks slide bounds, small text, dense chart labels, missing chart/diagram descriptions, empty diagram layers, and oversized empty decorative containers.

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
Design-first artifacts
  deck.storyboard.json
  deck.design-direction.json
  slide-design-specs.json
        |
        v
deck.manifest.json
  version, designSystem, deck, assets, slides, elements
        |
        v
Deterministic scripts
  validate-manifest.py
  compile-design-first.mjs
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
  vision-review.json
  visual-regression-report.json
        |
        v
final.pptx
```

## Repository Layout

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Agent Skill entry point. |
| `AGENT.md` | Host-agent operating contract. |
| `adapters/` | Codex, Claude Code, Cursor, and other host adapters. |
| `design-systems/` | Built-in generic design systems. |
| `layout-archetypes/` | Slide layout archetypes for design-first compilation. |
| `schemas/` | JSON Schemas for deck, storyboard, design direction, registry, repair, and review artifacts. |
| `scripts/` | Conversion, rendering, validation, repair, regression, and workbench scripts. |
| `scripts/lib/` | Reusable core logic. |
| `references/` | Workflow, manifest, HTML/image/PDF, QA, and prompt references. |
| `examples/` | Text, HTML, image, design-first, and visual-roadmap examples. |
| `workbench/` | Local visual workbench frontend. |
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
| `npm run setup` | Initialize examples and environment reports. |
| `npm run pipeline` | Validate manifest, render PPTX, and package output. |
| `npm run pipeline:design-first` | Run the design-first end-to-end flow. |
| `npm run explore:directions` | Generate multiple design direction candidates. |
| `npm run render` | Render PPTX from a manifest only. |
| `npm run html:manifest` | Convert HTML to manifest. |
| `npm run html:measure` | Measure CSS-positioned HTML. |
| `npm run image:hints` | Convert image input into reconstruction hints. |
| `npm run image:replica:analyze` | Emit image replica analysis JSON with layout regions, object candidates, detector status, and quality targets. |
| `npm run image:replica:plan` | Build a layer plan from replica analysis, separating reference, background repair, editable text/shapes, and cropped fallback layers. |
| `npm run pdf:hints` | Convert PDF pages into reconstruction hints. |
| `npm run visual:critic` | Run deterministic visual review. |
| `npm run vision:review` | Run mock screenshot-level vision review. |
| `npm run registry:validate` | Validate source and asset registries. |
| `npm run run:index` | Build a run index. |
| `npm test` | Run JavaScript tests. |
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
