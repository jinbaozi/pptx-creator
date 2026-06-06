# Text Input Example

## Input

- `deck.manifest.json` — tokenized manifest referencing `design-systems/business-neutral/DESIGN.md`.

## End-to-end (PowerShell)

```powershell
cd pptx-creator
node scripts/run-deck-pipeline.mjs examples/text-input/deck.manifest.json output/text-example
```

## Expected outputs

- `output/text-example/final.pptx`
- `output/text-example/editable-report.md`
- `output/text-example/qa-report.md`
- `output/text-example/deck.manifest.json`

## Host agent flow

1. Read user Markdown or bullet content.
2. Choose built-in `DESIGN.md` (see `references/built-in-design-systems.md`).
3. Author manifest with token references.
4. Run pipeline and review `references/qa-rubric.md`.
