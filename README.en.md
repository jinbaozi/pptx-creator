# pptx-creator

[中文](README.md) | **English**

## English

`pptx-creator` is an agent-oriented toolkit for generating editable PPTX files. A host agent or large language model handles understanding, planning, writing, design, and optional web research. This project handles deterministic validation, conversion, rendering, packaging, and quality checks, producing `.pptx` files that remain editable in PowerPoint or WPS.

> **V2.0 architecture:** the core is now split into three independently
> installable standard Skills:
> [`text-to-html`](skills/text-to-html/),
> [`html-to-pptx`](skills/html-to-pptx/), and
> [`image-to-pptx`](skills/image-to-pptx/).
> Text-to-PPTX explicitly composes the first two Skills; the root router remains
> only as a migration compatibility layer. Start with
> [`v2/USER_GUIDE.md`](v2/USER_GUIDE.md), then see
> [`v2/ARCHITECTURE.md`](v2/ARCHITECTURE.md) and
> [`v2/MIGRATION.md`](v2/MIGRATION.md). Final test evidence and known
> limitations are in [`v2/VALIDATION_REPORT.md`](v2/VALIDATION_REPORT.md).

V2 principle: `text-to-html` delivers a verified HTML package. When PPTX is
needed, `html-to-pptx` produces a manifest and renders it deterministically.
The old Semantic Slide IR remains only as a root compatibility route. Package
scripts do not call LLM APIs and do not invent content.

## Use Cases

- Generate business roadshows, technical briefings, product decks, training decks, and research reports from text or Markdown.
- Convert semantic HTML or CSS-positioned HTML into editable PPTX.
- Rebuild screenshots, image-only slides, and PDF pages into mostly editable PowerPoint files.
- Let agents combine design systems, web research, source registries, and quality checks into a reliable deck generation workflow.
- Batch-generate PPTX files and produce editability, compatibility, accessibility, visual review, and regression reports.

## Core Capabilities

| Capability | Description |
| --- | --- |
| Text to HTML | `text-to-html` turns text, Markdown, long-form source, or an outline into an offline HTML presentation package with sources, notes, design tokens, and browser QA. |
| HTML to PPTX | `html-to-pptx` accepts ordinary local HTML or a compatible protocol package, prefers native editable objects, and verifies fidelity through a rendered-PPTX comparison. |
| Image to PPTX | `image-to-pptx` performs OCR, structure/style recognition, confidence tracking, and native reconstruction; low-confidence content and local raster regions remain explicit. |
| Text to PPTX composition | Explicitly run `text-to-html → html-to-pptx`; the old `text_to_pptx` concept is no longer a V2 core capability. |
| Historical compatibility | Root `text --native` / `--direct` and Semantic Slide IR routes remain for migration, not as a runtime boundary of the three V2 Skills. |
| Layout archetypes and compilation | Built-in layout archetypes, design system parsing, and manifest compilation turn design specs into deterministic PPTX manifests. |
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

Run the built-in HTML-first text example:

```bash
npm run pptx -- text examples/text-input/html-first/deck.html output
```

Successful output:

```text
output/
  final.pptx
  deck.source.html
  deck.repaired.html
  deck.manifest.json
  replica-evidence.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json
```

## Default Creative HTML-first Workflow

Use this for polished business, product, technical, roadshow, research, or training decks:

```bash
npm run pptx -- text examples/text-input/html-first/deck.html output/creative
```

The Host first defines the narrative and Creative Direction, authors and
visually verifies 1280x720 HTML, then the deterministic compiler recreates the
accepted source as native PowerPoint objects and validates semantic module
connectors plus source-to-PPTX fidelity.

The former `deck.plan.json` workflow is retained only as explicit `--native`
compatibility mode:

```bash
npm run pptx -- text examples/text-input/creative/deck.plan.json output/native --native
```

A successfully packaged Creative run publishes the plan, selected canonical
Semantic Slide IR, render manifest, and real run index:

```text
deck.plan.json
semantic-slide-ir.json
deck.manifest.json
run.json
final.pptx
quality-report.json
quality-report.md
preview/index.html
output-manifest.json
```

In `--native` mode, the plan records the design read, three contextual dials, audience, narrative beats, slide messages, layout families, and content/asset references. `compileDeckPlanArtifacts()` produces the selected canonical IR and manifest in one compilation; `run.json` indexes that IR through `artifacts.semanticIr`. IR/run publication commits only after packaging succeeds. If the pre-package hook or package step fails, the pipeline attempts compensating rollback before writing blocked state, without allowing a rollback error to mask the primary failure. Candidate evidence never overwrites the canonical file, and direct/replica routes do not produce Semantic IR.

## HTML, Image, and PDF Inputs

Semantic or CSS-positioned HTML:

```bash
npm run pptx -- html input.html output/html
```

Use `npm run pptx -- image reference.png output/image` for strict image reconstruction. The pipeline performs real OCR plus color and geometry detection, emits native text/shapes/lines, and limits raster use to localized photographic or high-complexity regions. It then renders the PPTX back to pixels and verifies SSIM, OCR CER, text-box IoU, CIEDE2000 color distance, OOXML native objects, and every raster reference. Full-slide or undeclared rasters block delivery.

PDF pages:

The strict PDF route is `npm run pptx -- pdf source.pdf output/pdf`; it blocks explicitly until a fidelity-proof compiler exists.

PDF support is page-level hint generation. The final deck should still be rebuilt as editable text, shapes, tables, and charts rather than being rendered as full-slide images.

## Quality Checks and Repair

The unified pipeline owns layout, taste/fidelity proof, editability, compatibility, and consistency reports. Automatic repair is capped at three attempts, stops on no improvement, preserves the best candidate, and never packages after a hard failure.

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
Creative authoring contracts
  deck.plan.json
        |
        v
  semantic-slide-ir.json
  selected canonical authoring truth
        |
        v
deck.manifest.json
  render truth: version, designSystem, deck, assets, slides, elements
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
  run.json artifact index
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
| `schemas/` | JSON Schemas for deck, deck plan, registry, repair, and review artifacts. |
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
