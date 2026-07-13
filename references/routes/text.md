# Text route

## Trigger

Select for prose, outlines, Markdown, text documents, or an internal `deck.plan.json`. The host agent may change page count, titles, compression, and narrative order, but must not invent facts, metrics, or sources. Users should only need to ask for the final editable PPTX.

## Exclusions

Do not select when HTML, an image, or a PDF defines the visual layout, or when applying a repair patch.

## Public command

npm run pptx -- text <deck.plan.json|plan-directory> <output-dir> [--creative] [--design-system <path-or-name>]

## Inputs and outputs

The host agent converts raw text into an internal coordinate-free `deck.plan.json` version `0.2.0`; deterministic scripts validate it against `schemas/deck-plan.schema.json`, compile it to a `0.2.0` manifest, and render an editable PPTX. Its exact top-level keys are `version`, `context`, `designIntent`, `story`, `assets`, and `slides`. Slides carry a semantic page role, strict native `contentModel`, explicit attention target, composition intent, asset IDs, and native-first route policy. Plan assets require non-empty provenance `sourceRef` values. Coordinates, manifest geometry, `elements`, and full-slide raster output are prohibited.

The current migration shell supports the eight native content families `cover`, `architecture`, `comparison`, `process`, `dashboard`, `quote`, `matrix`, and `closing`. HTML is optional only when genuinely necessary and is never a mandatory text intermediate. An authored manifest requires the explicit advanced flag `--direct`; `--creative` remains only as a deprecated compatibility alias. `deck.plan` `0.1.0` is retired and fails closed before final, manifest, or quality artifacts are written.

`--design-system` is available only on the creative text route. It accepts an existing local `DESIGN.md`, a directory containing one, or a built-in design-system name. Explicit paths win over names. With no option, resolution checks repository-root `DESIGN.md`, then input-adjacent `DESIGN.md`, then `design-systems/business-neutral/DESIGN.md`. The selected file is parsed before compilation, its declared name and tokens drive native element styling, and a portable copy is packaged as `design-system/DESIGN.md`. URL-like and unknown values fail closed.

Asset `sourceRef` values resolve absolutely or relative to the plan directory. Scripts never fetch remote sources. Existing local files are copied to deterministic content-hashed paths under `output/assets/`; visual asset kinds become native image objects with declared alt text and `contain`/`cover` sizing, while chart-data and diagram-source assets remain non-visual inputs. Missing or remote sources block before `final.pptx` is published.

Per slide, `assetIds` must be unique and may include at most five visual assets. Asset attention must reference a visual asset in that slide; asset emphasis requires one. The compiler uses one hero plus a bounded support grid. Reusing an output directory invalidates stale public deliverables before plan/design/asset preflight, and generated-asset ownership cleanup preserves unrelated user files.

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
