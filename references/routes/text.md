# Text route

## Trigger

Select for text, outlines, an authored manifest, or a creative `deck.plan.json`. Use `--creative` only for a deck plan; otherwise run the authored manifest directly.

## Exclusions

Do not select when HTML, an image, or a PDF defines the visual layout, or when applying a repair patch.

## Public command

npm run pptx -- text <deck.manifest.json|deck.plan.json> <output-dir> [--creative]

## Inputs and outputs

Direct input is a `0.2.0` manifest; creative input is a coordinate-free `deck.plan.json` version `0.1.0`. HTML generation is optional only when explicitly requested or necessary and is never a mandatory text intermediate.

Successful creative output contains `final.pptx`, `deck.manifest.json`, `deck.plan.json`, `quality-report.json`, `quality-report.md`, `output-manifest.json`, and `preview/index.html`.

## Blocking conditions

Block on missing input/output, invalid manifest metadata, an invalid deck plan, failed quality gates, or more than three repair attempts.

## Next references

1. `references/manifest-spec.md`
2. `references/design-first-workflow.md`
3. `references/qa-rubric.md`

## Migration from 0.1.1

| 0.1.1 | 0.2.0 |
|---|---|
| `version: "0.1.1"` | `version: "0.2.0"` |
| `designSystem.mode: balanced\|inspired` | `metadata.mode: creative` |
| `designSystem.mode: strict` with HTML/image/PDF | `metadata.mode: replica` |
| `designSystem.mode: strict` otherwise | Manually choose `metadata.mode: direct\|repair` |
| input implied by workflow | `metadata.inputType: text\|html\|image\|pdf\|manifest\|mixed` |
| quality implied by mode | `metadata.qualityProfile: light\|creative\|replica` |
| private `_...` provenance | `metadata.designIntent`, `metadata.replicaSource`, or `metadata.generator` |
| `designSystem.mode` | Removed; `designSystem` keeps theme source/name/tokens only |
