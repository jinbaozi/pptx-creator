# Creative text workflow

Text work is Creative by default and uses two coordinate-free authoring
contracts: `deck.plan.json` captures host intent, and the selected canonical
`semantic-slide-ir.json` is the normalized authoring truth. Deterministic code
lowers that IR into the manifest render truth, renders the editable deck,
renders every slide through LibreOffice, and applies the Creative visual proof
gate.

`deck.plan.json -> semantic-slide-ir.json -> deck.manifest.json -> PPTX`

## Artifacts

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

The plan is version `0.2.0` with exactly six required top-level keys: `version`, `context`, `designIntent`, `story`, `assets`, and `slides`.

- `context` records title, language, structured audience and environment, decision goal, tone, duration, memory anchors, brand references, requested quality profile, required office suites, editability floor, asset intensity, and visual ambition. LibreOffice must be present and required.
- `designIntent` records the design read; typography, palette, material, imagery, composition direction and `visibleGrid`; contextual composition/density/energy dials; and source/brand locks.
- `story` records narrative beats, ordered sections with slide references, and the decision path.
- `assets` records localized asset intent and provenance. Every asset has a non-empty `provenance.sourceRef`; empty asset lists remain valid.
- Every slide records `pageRole`, one message, a strict `contentModel`, an explicit `attentionTarget`, `compositionIntent`, `assetIds`, and a `routePolicy` whose preferred route is `native`, whose allowed routes include `native`, and whose `fullSlideRaster` is always `false`. The host may explicitly add `compositionIntent.blockId` from the built-in composition registry; it is the only public block-selection knob.

The current migration shell keeps eight strict native content families: `cover`, `architecture`, `comparison`, `process`, `dashboard`, `quote`, `matrix`, and `closing`. It is coordinate-free at every depth: coordinates, manifest geometry, and `elements` are invalid. `schemas/deck-plan.schema.json` is the only structural validator; runtime checks add only ID uniqueness, reference resolution, required route/suite membership, and composition ordering. Version `0.1.0` is retired and cannot compile.

Direction candidates are optional. Use them only when material ambiguity or high risk makes a single direction unsafe; candidate count, scoring, and recommendation are host-agent judgments, never fixed deterministic outputs.

Composition blocks are also host-selected, never ranked or inferred by scripts.
The Creative runner loads the closed built-in registry once and passes it only
to plan-to-IR compilation. A selected block is checked against page role,
normalized dials, semantic slots, and assets, then snapshotted into the
canonical IR. Without `blockId`, the IR and all eight family geometries remain
unchanged. IR validation binds the resolved ID to an immutable canonical hash
and replays the immutable requested/resolved compatibility contract without a
registry scan. Resolver and fixture block-object boundaries additionally bind
each built-in ID to a hash over its complete definition, rejecting schema-valid
fixture, editability, optional-slot, guidance, or limit drift without changing
the smaller IR topology-hash contract. Custom non-built-in IDs remain explicit
extension points. See `references/composition-blocks.md` for the exact grammar,
fallback, hashing, fixture, and native lowering contract.

The manifest remains the renderer's sole render truth. HTML is optional only
when explicitly requested or genuinely necessary for source-defined layout; it
is not a Creative authoring contract.

## Canonical publication

`compileDeckPlanArtifacts()` compiles the selected IR and manifest once. Only
the pre-package hook stages the exact pretty-printed IR as
`semantic-slide-ir.json`, then writes the real `run.json` artifact index.
`run.json.artifacts.semanticIr` points to the portable filename. Publication is
committed only by a successful package step. If the hook partially fails or
packaging fails, the common pipeline calls the route-provided compensating
rollback before writing `pipeline-blocked.json`; rollback failure is best-effort
and never replaces the primary failure. A successful run does not execute this
rollback. Candidate evidence must never overwrite the selected canonical file,
and the IR is never reconstructed from a fitted or repaired manifest.

## Design and asset resolution

The public creative route accepts `--design-system <path-or-name>`. Existing local files or directories resolve before built-in names. Without an option, the deterministic order is repository-root `DESIGN.md`, input-adjacent `DESIGN.md`, then built-in `business-neutral`. The selected file is parsed exactly once before compilation; its name is derived from frontmatter, resolved tokens are materialized into native element styling, and the packaged manifest keeps the portable source `design-system/DESIGN.md`. Selection provenance records the original request and resolved local file under `metadata.designIntent.designSystemSelection`.

Plan assets resolve relative to the plan directory unless already absolute. Remote or missing sources block before rendering. Local files are copied to deterministic content-hashed paths under `output/assets/`, the full asset contract remains in `manifest.assets`, and referenced visual assets become native image objects. `alt` is the canonical accessibility field used by deterministic analysis and PPT rendering; the authored `altText` remains as provenance. Non-visual data assets never become fake images.

Each slide may reference at most five visual assets and may not repeat an asset ID. Asset attention must point to a visual asset listed by that slide. One visual becomes the hero; up to four supporting visuals occupy a deterministic gapped grid inside the reserved media zone, without crossing native-content bounds. `emphasis: asset` requires at least one visual asset.

Starting a creative run immediately invalidates previously published PPTX,
canonical IR, manifest, run index, report, review, and preview artifacts while
preserving in-place plan, design, and source-asset inputs. Localized asset
ownership is recorded only after normal pipeline cleanup and only for files
created by the run; a later run removes those owned hashes without deleting
unrelated or in-place user assets. This initial stale-output invalidation is
separate from the compensating rollback for IR/run files written by the current
pre-package transaction.

For native containers, resolved `hero-card` and `content-card` component tokens provide the baseline. Page-role, attention, and compatibility adjustments are explicit overrides, so component resolution cannot erase semantic emphasis.

## Gate

Creative output currently passes only when deck score is at least 80, every slide is at least 70, slop risk is at most 20, P0/P1 findings are zero, deterministic text-fit evidence passes, and editability is at least Level 4. The plan's requested L4 or L5 `context.editabilityFloor` is preserved in the compiled manifest and design-intent provenance for the later quality-profile task; it does not yet raise this gate above Level 4. The proof must include a real LibreOffice render of every page and a complete contact sheet. Contextual checks come from the design read and dials. Explicit user brand and source locks override generic heuristics. Font compatibility is reported from real font preflight data, and visible background grids must match `metadata.designIntent.visibleGrid`.

Replica routes do not run this taste gate and must preserve source fidelity.
