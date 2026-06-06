# PPTX Creator Workflow

Host agents perform all reasoning. Scripts validate, convert, measure, and render deterministically.

## Web research and asset discovery

The host agent may use web search throughout the workflow when it can improve accuracy, content depth,
material quality, or visual polish. The agent decides case by case.

Search is recommended when:

- facts, dates, standards, market context, product information, or technical claims may be current or uncertain;
- a deck needs stronger visual references, diagrams, icon directions, image素材, or layout inspiration;
- the user explicitly permits or asks for联网搜索相关内容、素材、案例、竞品、术语或视觉风格;
- external documentation can improve the correctness of architecture, process, business value, or comparison slides.

Search should be skipped or limited when:

- the user forbids联网;
- the provided source material is enough;
- the task is a strict 1:1 HTML/image/PDF replica and outside references would alter the original design.

Rules for searched material:

- Do not fabricate facts, metrics, source names, case studies, or citations.
- Keep important source URLs in the final response, QA notes, or a companion source list when they affect slide claims or assets.
- Respect copyright, license, trademark, logo, brand, and commercial font restrictions.
- Localize remote assets before rendering. Save them under the output folder, usually `output/assets/`, and reference local relative paths in `deck.manifest.json`.
- For strict replicas, search may help identify missing fonts/assets, but must not change the original background, typography, layout, color, tone, effects, or content.

## Output contract

Every completed run should produce:

```text
output/
  final.pptx
  deck.manifest.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json   # via package-output.py
```

Optional when dependencies exist:

```text
output/preview/          # render-preview.py
output/layout-measurements.json
output/image-hints.json
output/pdf-page-hints.json
output/ocr.json
output/preview-diff.json
output/visual-regression-report.json
output/accessibility-report.md
output/openxml-repair-report.json
output/template-summary.json
```

## Quick pipeline (any input type)

After the host agent authors `deck.manifest.json`:

```powershell
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

Batch mode:

```powershell
node scripts/run-batch-pipeline.mjs batch.json output/batch
```

`batch.json` format:

```json
{
  "jobs": [
    { "id": "deck-1", "manifest": "deck-1/deck.manifest.json", "outputDir": "output/deck-1" }
  ]
}
```

Or step by step:

```powershell
python scripts/validate-manifest.py output/deck.manifest.json
node scripts/render-pptx.mjs output/deck.manifest.json output/final.pptx
python scripts/package-output.py output
```

## Text / Markdown input

```text
User content
  -> host agent optionally searches for facts, terminology, examples, visuals, and素材
  -> host agent selects DESIGN.md
  -> host agent builds slide outline + deck.manifest.json
  -> run-deck-pipeline.mjs
  -> host agent reads editable-report.md + qa-report.md
```

See `examples/text-input/README.md` and `references/prompt-library.md`.

## HTML input

### Semantic auto-layout (M1.2)

```powershell
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

Semantic card grids auto-paginate by default when a single slide contains too many `.card` elements. Use `--no-auto-paginate` for exact single-slide conversion.

### CSS-positioned layout (M1.4)

```powershell
node scripts/measure-html.mjs input.html output/layout-measurements.json
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json --measurements output/layout-measurements.json
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

See `references/html-to-pptx.md` and `references/html-measurement.md`.

## Image / screenshot input

```powershell
python scripts/inspect-image.py reference.png
python scripts/image-to-manifest-hints.py reference.png output/image-hints.json
python scripts/ocr-image.py reference.png -o output/ocr.json          # optional
python scripts/extract-palette.py reference.png output/palette.json
# host agent inventories objects, refines manifest from manifestSkeleton
python scripts/crop-assets.py reference.png crops.json output/assets    # optional
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
python scripts/render-preview.py output/final.pptx output/preview       # optional
python scripts/compare-preview.py reference.png output/preview/slide.png -o output/preview-diff.json
```

See `references/image-to-pptx.md`.

## PDF page input

PDF pages are first rendered to PNG references, then analyzed with the same image-to-PPTX hint pipeline.
This is page-level support: the host agent still rebuilds editable text, shapes, tables, and charts from the
page hints instead of rasterizing the final slide.

```powershell
node scripts/run-python.mjs scripts/pdf-to-page-hints.py source.pdf output/pdf-pages -o output/pdf-page-hints.json
# host agent converts each pages[].hints.manifestSkeleton into editable manifest slides
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

If PyMuPDF is not installed, the script writes `status: deferred` and exits successfully so the host agent can report the dependency gap.

## Visual regression

```powershell
node scripts/run-visual-regression.mjs output/deck.manifest.json output
node scripts/run-visual-regression.mjs output/deck.manifest.json output --reference-dir baselines
```

The first command runs the pipeline and tries to render PPTX previews. If LibreOffice is missing, the report
is `status: deferred`. With `--reference-dir`, rendered previews are compared to baseline PNG/JPEG images and
`visual-regression-report.json` records close/moderate/divergent verdicts.

## Template import

```powershell
node scripts/import-template.mjs template.pptx output/template-summary.json
```

This extracts a deterministic summary: slide/layout/master/theme counts and theme colors. It does not clone
branded assets; the host agent uses the summary as design constraints.

## Accessibility and OpenXML checks

```powershell
node scripts/analyze-accessibility.mjs output/deck.manifest.json output/accessibility-report.md
node scripts/openxml-repair.mjs output/final.pptx output/openxml-repair-report.json
```

Accessibility checks are manifest-level heuristics for missing image alt text, missing slide titles, small text,
and chart descriptions. OpenXML repair currently performs structural inspection and reports re-render/repair
actions when required parts are missing.

## Mixed input (style + content)

```text
Reference image -> palette + layout density hints
User content   -> slide outline + copy
Web research   -> optional facts, sources, visual references, and localizable assets
Host agent     -> choose DESIGN.md, merge style tokens into manifest
Pipeline       -> validate + render + reports
```

Do not rasterize the full reference slide unless the user explicitly accepts low editability.

## Repair loop

1. Read validator stderr or qa-report.md risks.
2. Fix manifest fields (coordinates, assets, duplicate ids).
3. Re-run pipeline (max 3 auto-fix attempts before asking the user).
4. Never silently skip missing assets or out-of-bounds elements.

## QA before responding

Read `references/qa-rubric.md` and confirm slide count, editability level, and dependency gaps are reported to the user.
Also read `compatibility-report.md` when WPS or cross-suite portability matters.
