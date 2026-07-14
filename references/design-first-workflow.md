# Creative Director Pipeline: Creative text workflow

Text work is Creative by default and uses two coordinate-free authoring
contracts: `deck.plan.json` captures host intent as authoring contract, and the selected canonical
`semantic-slide-ir.json` is the normalized authoring truth. Deterministic code
lowers that IR into the manifest render truth, renders the editable deck,
renders every slide through LibreOffice, and applies the Creative visual proof
gate.

Load focused contracts progressively: intent in
`references/creative-intent.md`, conditional direction probes in
`references/creative-direction-probes.md`, canonical IR in
`references/semantic-slide-ir.md`, mandatory proof in
`references/creative-visual-proof.md`, safe refinement in
`references/creative-refinement.md`, release acceptance in
`references/creative-benchmark.md`, and pinned external adaptations in
`references/external-design-provenance.md`.

Final acceptance is a resumable Host boundary. A deterministic pass writes
Creative Proof 0.2 evidence and blocks at `host-final-visual-review`; it does
not publish a deliverable PPTX or successful run. After inspecting every
full-size PNG, resume with `--host-final-review <creative-final-review.json>`.
See `references/creative-visual-proof.md` for the closed review, hash binding,
acceptance, and publication contract.

A completed rejection enters the separate evidence-led protocol in
`references/creative-refinement.md`. The pipeline emits a dry-run plan, waits
for one protected Host-approved `--refinement-state`, invalidates the old
review after applying it, and requires a new screenshot-bound final review.
Creative repair and refinement share one maximum of three applied deltas.

`deck.plan.json -> semantic-slide-ir.json -> deck.manifest.json -> PPTX`

## Artifacts

```text
deck.plan.json
semantic-slide-ir.json
deck.manifest.json
assets/asset-registry.json
run.json
final.pptx
host-visual-review.json
creative-proof.json
creative-proof/
quality-report.json
quality-report.md
preview/index.html
output-manifest.json
```

The authoring input is deck.plan.json version `0.2.0` with exactly six required top-level keys: `version`, `context`, `designIntent`, `story`, `assets`, and `slides`.

- `context` records title, language, structured audience and environment, decision goal, tone, duration, memory anchors, brand references, requested quality profile, required office suites, editability floor, asset intensity, and visual ambition. LibreOffice must be present and required.
- `designIntent` records the design read; typography, palette, material, imagery, composition direction and `visibleGrid`; contextual composition/density/energy dials; and source/brand locks.
- `story` records narrative beats, ordered sections with slide references, and the decision path.
- `assets` records localized asset intent and provenance. Every asset has a non-empty `provenance.sourceRef` and one closed `provenance.rights` object; `sourceUrl` is optional HTTP(S)-only provenance. `origin: generated` additionally requires non-empty model and prompt-summary evidence, while non-generated assets must not claim generation evidence. Empty asset lists remain valid.
- Every slide records `pageRole`, one message, a strict `contentModel`, an explicit `attentionTarget`, `compositionIntent`, `assetIds`, and a `routePolicy` whose preferred route is `native`, whose allowed routes include `native`, and whose `fullSlideRaster` is always `false`. The host may explicitly add `compositionIntent.blockId` from the built-in composition registry; it is the only public block-selection knob.

The current migration shell keeps eight strict native content families: `cover`, `architecture`, `comparison`, `process`, `dashboard`, `quote`, `matrix`, and `closing`. It is coordinate-free at every depth: coordinates, manifest geometry, and `elements` are invalid. `schemas/deck-plan.schema.json` is the structural validator; runtime checks add provenance/generation cross-field rules, ID uniqueness, reference resolution, required route/suite membership, and composition ordering.

Direction probes are conditional and always Host-authored. Standard plans stay
on the compile-once path; flagship plans always require a bounded direction
request; premium plans explore only at two or more frozen material-risk
signals. The Host supplies two through the profile cap, inspects real anonymous
rendered probes, and records complete pairwise preference before reveal.
Deterministic diagnostics cannot select or overturn the winner. See
`references/creative-direction-probes.md` for the two-stage resume protocol.

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

`compileDeckPlanArtifacts()` compiles the selected IR and manifest once. The
Creative transaction snapshots the already-validated plan, selected IR, and
localized byte evidence before packaging; caller or source-file mutation cannot
change those snapshots. Immediately before packaging, it reads the final
`deck.manifest.json` render truth, verifies exact ordered slide/asset membership
and canonical asset metadata across plan, IR, and manifest, re-reads every
localized target, and builds `assets/asset-registry.json` version `0.2.0` from
that final evidence. It then stages canonical `deck.plan.json`,
`semantic-slide-ir.json`, the public registry, and finally `run.json`.

`run.json.artifacts.semanticIr` and `run.json.artifacts.assetRegistry` point to
portable filenames. Empty asset lists publish deterministic registry bytes and
remain valid. Publication is committed only by a successful package step. If
the hook partially fails or packaging fails, the common pipeline invokes
best-effort reverse rollback before writing `pipeline-blocked.json`; rollback
failure never replaces the primary failure. A successful run does not execute
this rollback. Candidate evidence never overwrites the selected canonical IR,
and the IR is never reconstructed from fitted or repaired geometry. In an
explored run, `creative-candidates.json` and `creative-selection.json` join the
same pre-package transaction before plan, IR, registry, and run publication.
`run.json` binds them to the anonymized packet through a separate
content-derived `explorationId`; its `runId` remains derived only from the
selected full canonical IR. Failed packaging rolls candidate and reveal data
back together with the canonical evidence.

## Design and asset resolution

The public creative route accepts `--design-system <path-or-name>`. Existing local files or directories resolve before built-in names. Without an option, the deterministic order is repository-root `DESIGN.md`, input-adjacent `DESIGN.md`, then built-in `business-neutral`. The selected file is parsed exactly once before compilation; its name is derived from frontmatter, resolved tokens are materialized into native element styling, and the packaged manifest keeps the portable source `design-system/DESIGN.md`. Selection provenance records the original request and resolved local file under `metadata.designIntent.designSystemSelection`.

Plan assets resolve relative to the plan directory unless already absolute. Remote or missing sources block before rendering. Local files are copied to deterministic content-addressed paths under `output/assets/`; runtime `src` values must be normalized POSIX paths strictly below `assets/` and may never be URLs, absolute paths, traversal, backslash paths, or encoded separator variants. The complete SHA-256 digest is verified from the localized bytes. The full asset contract remains identical across plan, IR, and `manifest.assets`, and referenced visual assets become native image objects. Image `alt`/`altText`, focal point, crop policy, and effective `contain`/`cover` sizing must agree with that contract. Creative cropped-asset or image-background routes fail closed because the current renderer cannot preserve the same crop semantics. Non-visual data assets never become fake images.

The public `assets/asset-registry.json` is audit evidence, not render truth. In plan order, each record carries canonical source, rights, optional generation evidence, verified local path and full byte hash, same-slide usage, and `finalDeckUse`. `embedded` requires a same-slide tracked native image; `recreated-locally` is limited to same-slide `chart-data -> chart` or `diagram-source -> diagram` references; otherwise the value is `not-embedded`. The private `.pptx-generated-assets.json` is only a cleanup-ownership sidecar and cannot substitute for the public registry.

Each slide may reference at most five visual assets and may not repeat an asset ID. Asset attention must point to a visual asset listed by that slide. One visual becomes the hero; up to four supporting visuals occupy a deterministic gapped grid inside the reserved media zone, without crossing native-content bounds. `emphasis: asset` requires at least one visual asset.

Starting a creative run immediately invalidates previously published PPTX,
canonical IR, public asset registry, manifest, run index, report, review, and
preview artifacts while preserving in-place plan, design, source-asset inputs,
and an ordinary empty `assets/` directory. Localized ownership is accepted only
from the exact private owner/version contract and only for direct, regular,
non-symlink content-addressed files whose bytes match the filename hash; forged,
nested, traversal, and symlink entries cannot authorize deletion. Design-first,
the common runner, and packaging reject a symlink output root, and nested assets
symlinks are never followed. Initial stale invalidation remains separate from
reverse rollback of the current pre-package evidence transaction.

For native containers, resolved `hero-card` and `content-card` component tokens provide the baseline. Page-role, attention, and compatibility adjustments are explicit overrides, so component resolution cannot erase semantic emphasis.

## Gate

Creative output currently passes only when deck score is at least 80, every slide is at least 70, slop risk is at most 20, P0/P1 findings are zero, deterministic text-fit evidence passes, and editability is at least Level 4. The plan's requested L4 or L5 `context.editabilityFloor` is preserved in the compiled manifest and design-intent provenance for the later quality-profile task; it does not yet raise this gate above Level 4. The proof must include a real LibreOffice render of every page and a complete contact sheet. Contextual checks come from the design read and dials. Explicit user brand and source locks override generic heuristics. Font compatibility is reported from real font preflight data, and visible background grids must match `metadata.designIntent.visibleGrid`.

Replica routes do not run this taste gate and must preserve source fidelity.

Release claims additionally require the blind preference acceptance in
`references/creative-benchmark.md`. A deterministic pass, a successful render,
or synthetic ratings do not prove release quality.
