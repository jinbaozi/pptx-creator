# Text route

## Trigger

Select for prose, outlines, Markdown, text documents, or an internal `deck.plan.json`. The host agent may change page count, titles, compression, and narrative order, but must not invent facts, metrics, or sources. Users should only need to ask for the final editable PPTX.

## Exclusions

Do not select when HTML, an image, or a PDF defines the visual layout, or when applying a repair patch.

## Public command

npm run pptx -- text <deck.plan.json|plan-directory> <output-dir>

## Inputs and outputs

The host agent converts raw text into an internal coordinate-free `deck.plan.json` version `0.1.0`; deterministic scripts compile it to a `0.2.0` manifest and editable PPTX. The plan records audience, narrative, five-part visual direction, contextual dials, page roles, composition strategies, content, and assets. HTML is optional only when genuinely necessary and is never a mandatory text intermediate. An authored manifest requires the explicit advanced flag `--direct`; `--creative` remains only as a deprecated compatibility alias.

Successful output contains `final.pptx`, `quality-report.json`, `quality-report.md`, `creative-proof.json`, rendered slide evidence with a contact sheet, and `preview/index.html`. Internal plan and manifest artifacts remain available for audit.

## Blocking conditions

Block on missing input/output, invalid internal artifacts, failed Creative gates, unavailable or incomplete LibreOffice slide evidence, any P0/P1 visual finding, or more than three repair attempts.

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
