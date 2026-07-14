# Text route

## Trigger

Select for prose, outlines, Markdown, text documents, or an internal `deck.plan.json`. The host agent may change page count, titles, compression, and narrative order, but must not invent facts, metrics, or sources. Users should only need to ask for the final editable PPTX.

## Exclusions

Do not select when HTML, an image, or a PDF defines the visual layout, or when applying a repair patch.

## Public command

npm run pptx -- text <deck.plan.json|plan-directory> <output-dir> [--creative] [--design-system <path-or-name>] [--creative-directions <json>] [--host-review <json>] [--host-final-review <json>] [--refinement-state <json>]

## Inputs and outputs

The host agent follows `references/design-first-workflow.md` to convert raw text into an internal coordinate-free `deck.plan.json` version `0.2.0`; deterministic scripts validate it against `schemas/deck-plan.schema.json`, compile the selected canonical `semantic-slide-ir.json`, lower that IR to a `0.2.0` manifest, and render an editable PPTX. Its exact top-level keys are `version`, `context`, `designIntent`, `story`, `assets`, and `slides`. Slides carry a semantic page role, strict native `contentModel`, explicit attention target, composition intent, asset IDs, and native-first route policy. The host may add one optional `compositionIntent.blockId`; scripts validate and lower that explicit choice but never rank or invent it. Plan assets require non-empty `provenance.sourceRef`, one closed `provenance.rights` authority, optional HTTP(S) `sourceUrl`, and generation evidence only when `origin` is `generated`. Coordinates, manifest geometry, `elements`, and full-slide raster output are prohibited.

The current migration shell supports the eight native content families `cover`, `architecture`, `comparison`, `process`, `dashboard`, `quote`, `matrix`, and `closing`. HTML is optional only when genuinely necessary and is never a mandatory text intermediate. An authored manifest requires the explicit advanced flag `--direct`; `--creative` remains only as a deprecated compatibility alias.

`--design-system` is available only on the creative text route. It accepts an existing local `DESIGN.md`, a directory containing one, or a built-in design-system name. Explicit paths win over names. With no option, resolution checks repository-root `DESIGN.md`, then input-adjacent `DESIGN.md`, then `design-systems/business-neutral/DESIGN.md`. The selected file is parsed before compilation, its declared name and tokens drive native element styling, and a portable copy is packaged as `design-system/DESIGN.md`. URL-like and unknown values fail closed.

Conditional Host-authored direction probes use the same command with
`--creative-directions`. Standard plans never explore, flagship plans always
require two to four directions, and premium plans require two to three only
when at least two documented material-risk signals are active. Stage 1 renders
at most three adaptive slides per candidate, atomically publishes anonymous
screenshots plus a hash-bound packet, and blocks for actual Host visual review.
Resume with the same direction request and `--host-review`; the runner
regenerates the identical packet, accepts complete pairwise preference only,
then recompiles and fully proves the one selected canonical direction. See
`references/creative-direction-probes.md` for the closed sidecar contracts,
trigger matrix, blind-review rules, and rollback behavior.

The selected full deck has a separate final-review boundary. Deterministic
render, quality, token, asset, editability, and suite evidence produces Creative
Proof 0.2 but cannot accept the deck. The first full run blocks at
`host-final-visual-review` and withholds the top-level deliverable PPTX, run
index, and output manifest. After inspecting every full-size slide PNG, the
Host writes a packet-bound review and resumes with `--host-final-review`.
Stale, incomplete, unavailable, duplicate, rejecting, or internally
inconsistent review evidence blocks. See
`references/creative-visual-proof.md`.

If that exact final review rejects the deck, Creative mode writes an
evidence-routed dry-run plan and waits for one explicitly approved operation in
an external `--refinement-state` sidecar. Applying a delta invalidates the old
review and consumes one shared repair/refinement attempt (maximum three). IR
changes recompile canonical Semantic Slide IR; manifest changes are restricted
to reversible optical corrections. See `references/creative-refinement.md`.

Asset `sourceRef` values resolve absolutely or relative to the plan directory. Scripts never fetch remote sources. Existing local files are copied to deterministic content-addressed paths under `output/assets/`; runtime paths must be normalized POSIX paths strictly below `assets/`, and publication re-reads the localized files to verify the complete SHA-256 digest. Plan, IR, and final manifest must preserve the same canonical asset contract. Native images must carry the same asset ID, same-slide membership, source, alt text, focal point, crop policy, and effective `contain`/`cover` sizing. Creative cropped assets and image backgrounds fail closed until the renderer can preserve those semantics. Missing, remote, anonymous, off-slide, or drifted sources block before public evidence is committed.

Per slide, `assetIds` must be unique and may include at most five visual assets. Asset attention must reference a visual asset in that slide; asset emphasis requires one. The compiler uses one hero plus a bounded support grid. Reusing an output directory invalidates stale canonical IR, public asset registry, run index, and other public deliverables before plan/design/asset preflight. Private generated-asset ownership cleanup accepts only verified direct content-addressed regular files and preserves unrelated user files and the normal `assets/` directory. Output-root and nested-assets symlinks are rejected or left untouched, never followed.

The pre-package transaction uses immutable snapshots of the validated plan, selected IR, and localized evidence. It reads the final `deck.manifest.json` render truth, rebuilds `assets/asset-registry.json` version `0.2.0` from final same-slide use and actual target bytes, then stages plan, IR, registry, and `run.json` in that order. Hook or package exception/non-OK status invokes best-effort reverse rollback before `pipeline-blocked.json` is written. The public registry is audit evidence; the manifest remains the renderer's sole render truth.

Successful Creative output contains `deck.plan.json`,
`semantic-slide-ir.json`, `deck.manifest.json`, `assets/asset-registry.json`,
`run.json`, `final.pptx`, `host-visual-review.json`, `creative-proof.json`,
quality/proof reports, rendered slide evidence with a contact sheet,
`preview/index.html`, and `output-manifest.json`. The run index uses
`artifacts.semanticIr` and `artifacts.assetRegistry` for the portable evidence
paths. The nested public registry is included in `output-manifest.json`. This
publication is committed only after packaging succeeds. Direct and replica
routes do not produce Semantic IR.

## Blocking conditions

Block on missing input/output, a symlink output root, invalid plan, Semantic IR,
manifest, public registry, or run artifacts, provenance/locality/hash drift,
failed Creative gates, unavailable or incomplete LibreOffice slide evidence,
any P0/P1 visual finding, more than three repair attempts, or an unproven
release benchmark when release quality is being claimed.
Perfect deterministic evidence without a completed final Host screenshot
review also blocks.

## Next references

1. `references/creative-intent.md`
2. `references/semantic-slide-ir.md`
3. `references/creative-visual-proof.md`

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
