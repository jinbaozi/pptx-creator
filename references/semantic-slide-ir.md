# Semantic Slide IR

Semantic Slide IR is the coordinate-free authoring contract between a creative
`deck.plan.json` and the editable manifest compiler. In the creative text
route, version `0.1.0` of the selected canonical `semantic-slide-ir.json` is
authoring truth for normalized slide content, layout order, token references,
and semantic lineage. The lowered `deck.manifest.json` remains render truth.

The compatibility facade still returns a `deck.manifest.json`:

```js
const { ir, manifest } = compileDeckPlanArtifacts(plan, options);
const compatibleManifest = compileDeckPlan(plan, options);
```

`compileDeckPlan()` is implemented as `plan -> IR -> manifest`. The two APIs
produce the same manifest for the same inputs, but a pipeline that needs both
artifacts calls `compileDeckPlanArtifacts()` once and uses the returned `ir`
and `manifest`; it does not compile twice or reconstruct IR from later
manifest geometry.

## Canonical publication and run indexing

The creative route publishes the selected canonical artifact under the fixed
name `semantic-slide-ir.json`. Its public transformation contract is:

```text
deck.plan.json -> semantic-slide-ir.json -> deck.manifest.json -> PPTX
```

The design-first runner compiles once and snapshots the selected returned IR.
After the PPTX and reports have been created successfully, its pre-package
transaction reads the final manifest render truth, verifies it against the
snapshotted plan and IR, re-hashes localized target bytes, and builds the public
`assets/asset-registry.json` version `0.2.0`. It then stages canonical plan
bytes, the original selected IR as pretty JSON with exactly one trailing
newline, the registry, and `run.json`. The run index points to all four
canonical plan, IR, manifest, and registry evidence paths. Its ID
remains a content-derived SHA-256 identifier over the
full canonical IR, with object keys sorted recursively and array order
preserved. A fitted or repaired manifest may determine final asset-use evidence
but must never be used to reverse-engineer the IR.

At the start of a rerun, published-output invalidation removes stale canonical
IR, public registry, and run files from the previous run, including failures
that happen before compilation. Current publication is one compensating
transaction over plan, IR, public registry, and run. Hook or package failure
invokes route-provided best-effort reverse rollback before
`pipeline-blocked.json` is written, and rollback errors do not mask the primary
failure. Only package success commits the set; the successful path does not
invoke rollback. Direct and replica routes do not produce Semantic IR and keep
`artifacts.semanticIr` as `null` when they write a run index. Direction
candidates, if a later pipeline stage introduces them, are evidence for
selection and must never overwrite the selected canonical IR.

## Top-level contract

The canonical schema is `schemas/semantic-slide-ir.schema.json`. It is closed:
unknown properties fail validation.

```json
{
  "version": "0.1.0",
  "source": { "kind": "deck-plan", "version": "0.2.0" },
  "context": {},
  "designIntent": {},
  "story": {},
  "designSystem": {
    "name": "business-neutral",
    "source": "design-system/DESIGN.md",
    "selection": {
      "request": null,
      "resolvedSource": "design-system/DESIGN.md",
      "provided": false
    },
    "tokenSnapshotHash": "sha256:..."
  },
  "assets": [],
  "slides": []
}
```

`context`, `designIntent`, `story`, and asset provenance keep the strict deck
plan 0.2 contracts. Asset provenance has one closed `rights` authority;
generated origins require model and prompt-summary evidence, while other
origins reject generation evidence. Each IR asset additionally contains a
portable `src`. `compileDeckPlanToIr()` resolves that source from
`assetSourceById` when provided, otherwise from `provenance.sourceRef`; it never
rewrites provenance. The resolved runtime source must be a normalized POSIX path
strictly below `assets/`. URLs, absolute paths, traversal, backslashes, encoded
separators, and Unicode separator variants fail closed.

`designSystem.selection.provided` distinguishes compatibility history that
cannot be inferred from the other two values:

- `false`: the facade synthesized the default selection. Lowering does not add
  selection metadata that was absent in the legacy result.
- `true`: the caller explicitly supplied `designSystemSelection`, even if its
  values equal the default. Lowering preserves that metadata.

The token snapshot hash is SHA-256 over a recursively key-sorted token object.
Array order is preserved. IR stores token references rather than resolved
colors, font names, or spacing values. Compilation requires the same design
tokens and rejects a token hash mismatch.

## Slides and nodes

Each slide records its `family`, semantic role and message, attention and
composition intent, asset membership, native route policy, semantic `nodes`,
and a coordinate-free `layout`. Slide IDs and asset IDs are unique deck-wide;
node and layout IDs are unique within a slide. The stable node address is
`(slideId, nodeId)`.

When and only when the host writes `compositionIntent.blockId`, the slide also
contains a closed `compositionBlock` snapshot with requested/resolved IDs,
version, canonical topology-definition hash, fallback provenance, and
coordinate-free topology. The hash is recomputable from exactly
`{version, id: resolvedId, topology}`, so IR-to-manifest lowering never reopens
the registry. The supplied and recomputed hashes must also equal the immutable
canonical hash bound to `resolvedId`. Validation then replays the immutable
requested/resolved block compatibility contract from slide role, global dials,
same-slide asset kinds/cardinality, fallback provenance, and semantic slots.
Unknown IDs, intent mismatch, unsupported or false fallback provenance,
canonical identity substitution, incompatible roles/slots, or topology/hash
drift fail closed. A separate complete-definition hash protects built-in block
objects at resolver, fixture, and public apply boundaries; it is intentionally
not serialized into this smaller self-contained IR snapshot. See
`references/composition-blocks.md`.

Every node has these common fields:

```json
{
  "id": "headline",
  "kind": "text",
  "role": "headline",
  "tokenRefs": {
    "typography": "{typography.title}",
    "foreground": "{colors.text}"
  },
  "assetRefs": [],
  "payload": { "text": "One message" }
}
```

The eight supported families normalize to strict semantic roles:

| Family | Required authoring nodes |
|---|---|
| `cover` | `headline`, `subtitle`, `cover-accent` |
| `architecture` | `headline`, continuous `layer-N` nodes |
| `comparison` | `headline`, `left-panel`, `right-panel` |
| `process` | `headline`, continuous `step-N` and `connector-N` nodes |
| `dashboard` | `headline`, continuous `kpi-card-N` nodes |
| `quote` | `quote` |
| `matrix` | `headline`, `axis-x` matrix node |
| `closing` | `headline`, `call-to-action`, `closing-accent` |

The supported node kinds are `text`, `media`, `metric`, `chart`, `table`,
`diagram`, `quote`, and `divider`. Payloads are discriminated and closed.
Media has exactly one same-deck visual asset reference. A connector is a
`divider` payload whose endpoints resolve to nodes in the same slide.

IR also materializes deterministic semantic evidence that used to exist only
after geometry compilation:

- `role-marker` on every slide;
- `section-eyebrow` on the first slide of each declared section;
- `decision-marker` for each slide in the decision path;
- one `asset-<assetId>` media node for every referenced visual asset.

These nodes are authoritative. Missing, extra, or plan-inconsistent derived
nodes fail validation instead of being silently regenerated during lowering.

## Coordinate-free layout

Every slide layout starts with one `safe-area`. Descendants may be layout
objects or `{ "nodeRef": "..." }`. Exactly eleven primitives are supported:

1. `stack`
2. `grid`
3. `split`
4. `overlay`
5. `anchor`
6. `flow`
7. `align`
8. `distribute`
9. `aspect-ratio`
10. `fit-content`
11. `safe-area`

Spacing and inset values are `{spacing.*}` token references. Layout traversal
is authoritative for family order and z-order; `nodes[]` order is not. Every
non-connector node must appear exactly once as a `nodeRef`, and every connector
must appear exactly once in a `flow.links[].connectorRef`. Orphans, duplicate
placement, unresolved references, non-continuous family indexes, and invalid
connector endpoints fail closed.

Coordinates and manifest-shaped geometry are forbidden recursively. The keys
`x`, `y`, `w`, `h`, `left`, `top`, `right`, `bottom`, `width`, `height`, and
`elements` cannot appear anywhere in the IR.

## Lowering and lineage

`compileSemanticDeckIr()` validates the complete IR and token snapshot before
producing output. It reconstructs the legacy family input only from semantic
nodes and layout traversal, then applies the proven native geometry compilers.
The lowering order remains:

```text
family geometry
-> composition strategy
-> resolved design tokens
-> semantic role / attention / story treatment
-> media-zone layout
-> bounds
-> connector resolution
-> manifest assembly
-> optional selected composition-block group transform
-> connector re-resolution and bounds proof
```

The primary manifest element for a semantic node keeps the node ID. When a
semantic node expands to multiple native elements, derived elements keep stable
IDs and set `semanticParentId` to the source node. For example, a process
`step-2` can own `step-label-2`. Reordering unrelated siblings does not change
this lineage. Connector route, anchors, and arrow configuration are copied from
the connector node before final connector geometry resolution.

The manifest schema permits these optional semantic fields without requiring
them for direct or replica routes: slide intent fields, `semanticParentId`,
asset/accessibility metadata, focal point and crop policy, and sizing evidence.

## API and validation

```js
compileDeckPlanToIr(plan, options)        // plan 0.2 -> SemanticDeckIR
validateSemanticDeckIr(ir, { design })   // { valid, errors }
compileSemanticDeckIr(ir, { design })    // SemanticDeckIR -> DeckManifest
canonicalTokenSnapshotHash(tokens)       // stable sha256 token fingerprint
```

Validation combines JSON Schema enforcement with semantic checks for ID and
reference integrity, provenance/generation consistency, safe runtime locality,
family authority, derived-node authority, route and same-slide asset membership,
token resolution, layout ownership, connector topology, canonical composition
identity, and trusted requested-to-resolved compatibility replay. Publication
additionally requires exact ordered plan/IR/manifest slide and asset identity,
canonical asset-field equality, and final localized byte hashes. Callers must
treat any error as a hard preflight failure; no manifest is emitted from an
invalid IR.

## Current boundary

This version publishes the selected canonical IR together with a public asset
registry and indexes all four canonical evidence paths in `run.json`. The manifest remains the sole render
truth; the registry is provenance, locality, hash, usage, and final-deck-use
audit evidence. It provides an explicitly host-selected fifteen-block
composition registry but does not generate, rank, score, or persist visual
concept candidates. A block is a bounded post-family topology transform, not a
replacement generic renderer. The eight existing family geometry compilers
remain the default and stay byte/geometry compatible when no
`compositionIntent.blockId` is present.
