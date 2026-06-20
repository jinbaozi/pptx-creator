# Common Workflow

Use this reference for text, Markdown, mixed inputs, batch jobs, common output rules, or advanced pipeline checks. For HTML, image, or PDF conversion, return to `SKILL.md` and load the matching input-specific reference instead.

## Contents

- [Operating contract](#operating-contract)
- [Text and mixed inputs](#text-and-mixed-inputs)
- [Output contract](#output-contract)
- [Research and assets](#research-and-assets)
- [Pipeline commands](#pipeline-commands)
- [Optional checks](#optional-checks)
- [Failure handling](#failure-handling)

## Operating contract

- Perform audience, narrative, writing, design, and repair decisions in the host agent.
- Keep `deck.manifest.json` as the single source of truth.
- Select and read one `DESIGN.md` before authoring the manifest.
- Keep scripts deterministic and free of LLM API calls.
- Prefer native PowerPoint objects and disclose all rasterized regions.
- Keep generated files under the requested output directory.

## Text and mixed inputs

For a straightforward content deck:

1. Define the audience, objective, narrative arc, and slide count.
2. Select a design system.
3. Read `references/manifest-spec.md` only while authoring the manifest.
4. Write one main idea per slide with specific titles and bounded content density.
5. Localize any external assets under `output/assets/`.
6. Run the pipeline and inspect reports.

For a creative roadshow, product launch, briefing, or narrative deck, use `references/design-first-workflow.md` before compiling the manifest.

For mixed inputs, use each source for a declared purpose:

- content source for claims and copy;
- visual reference for palette, density, and composition;
- `DESIGN.md` for final tokens and component rules.

Do not silently copy visual-source content into the final deck.

## Output contract

A successful run produces:

```text
output/
  final.pptx
  deck.manifest.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json
```

Design-first runs may also produce storyboard, design direction, slide specifications, visual review, vision review, run index, registry, and preview artifacts. These remain intermediate evidence; they never replace `deck.manifest.json` or `final.pptx`.

## Research and assets

Use web research when facts may have changed, terminology is uncertain, or licensed visual material materially improves the deck. Skip it when the user forbids it, supplied material is sufficient, or outside references would alter a strict replica.

When research is used:

- verify claims against source URLs;
- do not invent facts, metrics, cases, or citations;
- respect copyright, license, trademark, logo, brand, and font restrictions;
- download permitted assets to the output directory before manifest use;
- record material sources and caveats in notes or the final response.

## Pipeline commands

Run the standard pipeline after authoring the manifest:

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

Run individual stages only for diagnosis:

```bash
node scripts/run-python.mjs scripts/validate-manifest.py output/deck.manifest.json
node scripts/render-pptx.mjs output/deck.manifest.json output/final.pptx
node scripts/run-python.mjs scripts/package-output.py output
```

Run batch jobs with a manifest of jobs:

```bash
node scripts/run-batch-pipeline.mjs batch.json output/batch
```

```json
{
  "jobs": [
    { "id": "deck-1", "manifest": "deck-1/deck.manifest.json", "outputDir": "output/deck-1" }
  ]
}
```

## Optional checks

Run only checks relevant to the requested deliverable:

```bash
node scripts/run-visual-critic.mjs output/deck.manifest.json output/visual-review.json --mode creative
node scripts/analyze-accessibility.mjs output/deck.manifest.json output/accessibility-report.md
node scripts/openxml-repair.mjs output/final.pptx output/openxml-repair-report.json
node scripts/run-visual-regression.mjs output/deck.manifest.json output
node scripts/run-vision-review.mjs output --provider mock
```

Use `--mode replica` for strict reconstruction. Treat mock vision review as contract validation, not visual judgment.

## Failure handling

1. Identify the first failing stage and preserve its stderr or report.
2. Fix the manifest or missing local asset rather than patching the rendered PPTX.
3. Rerun the smallest failing check, then rerun the full pipeline.
4. Stop after three bounded repair attempts.
5. Report missing optional dependencies as deferred; do not claim their checks passed.
