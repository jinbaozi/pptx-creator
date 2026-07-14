# Composition blocks

Composition blocks are a data-driven topology grammar for the Creative text
route. They give the host agent a bounded set of visually distinct page
structures without moving design judgment into deterministic scripts.

The host is the only component that selects a block. The only public plan knob
is the optional `slides[].compositionIntent.blockId`. Deterministic code does
not rank, recommend, infer, or silently add a block. When `blockId` is absent,
the existing eight family compilers and their geometry remain unchanged.

## Initial registry

The built-in registry contains exactly fifteen version `0.1.0` blocks:

1. `editorial-poster`
2. `asymmetric-split`
3. `full-bleed-media`
4. `anchored-sidebar`
5. `hero-number`
6. `evidence-first`
7. `chart-dominant`
8. `annotated-media`
9. `layered-depth`
10. `radial-system`
11. `timeline`
12. `matrix`
13. `masonry`
14. `bento-asymmetric`
15. `minimal-statement`

Each direct `composition-blocks/*.json` child is loaded in lexical filename
order. The filename stem must equal `id`. Duplicate IDs, invalid documents,
unknown fallback targets, and fallback cycles block registry loading.

## Closed block contract

`schemas/composition-block.schema.json` requires these fields and rejects
unknown properties:

```text
version, id, whenToUse, notFor, pageRoles, contentShape, dialRange,
assetRequirements, editability, pptSafeEffects, fallback, antiPatterns,
contentLimits, topology, fixtures
```

`contentShape` declares required and optional semantic slots from
`headline|primary|supporting|metric|media|accent`. Required and optional lists
are unique and disjoint. A declared required slot must occur exactly once in
the topology and in every fixture. Optional topology slots may be empty at
lowering time.

Block dial ranges are normalized `0..1`; deck-plan dials remain `0..100` and
are divided by 100 before comparison. Asset requirements declare accepted
kinds and a coherent minimum and maximum. Required or positive-minimum assets
must declare at least one kind; an empty kind list requires
`required=false,min=0,max=0`. A media fixture may declare one deterministic
`assetId` for localized fixture input. Editability is L4 or L5, requires
native text and a native visual, and always prohibits a full-slide raster.

## Coordinate-free topology

The root is always `safe-area`, leaves are `{ "slot": "..." }`, and the
closed grammar supports:

- `safe-area` with four `{spacing.*}` logical insets;
- horizontal or vertical `stack` with optional positive weights;
- two-child horizontal or vertical `split` with positive ratios;
- `grid` with one to four columns;
- ordered `overlay`;
- semantic `anchor` with `compact|medium|full` size.

Topology owns relationships and proportions only. It cannot contain manifest
coordinates, raw colors, typography, effects, renderer elements, or raw
spacing. Every gap and inset is a `{spacing.*}` reference resolved from the
selected `DESIGN.md`. Numeric spacing tokens use one conversion everywhere:
the token is interpreted as points and divided by 72 to obtain manifest
inches. Missing or non-positive tokens, malformed constraints, duplicate
slots, non-positive boxes, and out-of-bounds solutions fail closed. The public
solver runs the same closed topology validator first; validator-rejected fields
cannot be ignored during solving. The resolver likewise validates requested
and resolved block objects even when callers supply an arbitrary `Map`. At the
resolver requested/fallback and fixture direct/fallback boundaries, any object
using a built-in ID must match the immutable full-definition hash. This covers
every authored field, including optional slots, fixture content, editability,
content limits, guidance, and topology. The separate topology hash and static
page-role, dial, required-slot, asset, and fallback contract remain the smaller
self-contained Semantic IR trust surface. Custom non-built-in IDs remain
allowed extension points.

Blocks never own brand styling. Fixture text, native panels, borders, and
backgrounds resolve from the supplied design tokens. Switching design systems
therefore changes typography and color while preserving the topology and
geometry signature.

## Resolution and fallback

An explicit selection is validated against its page role, normalized global
dials, required semantic slots, and asset requirements. An unknown or
incompatible selection is a hard error. Deterministic fallback is intentionally
narrow: `full-bleed-media` and `annotated-media` fall back to
`minimal-statement` only when their required visual asset is missing. The IR
records `fallbackApplied: true` and `fallbackReason: "missing-assets"`.

`minimal-statement` has a `native-family` terminal fallback, requires one
headline/statement, and treats its primary supporting region as optional. A
quotation is classified as a statement headline, so this terminal topology is
usable for quote pages without inventing new content.

## Semantic IR snapshot

When a block is selected, the slide receives a closed `compositionBlock`
snapshot:

```json
{
  "requestedId": "full-bleed-media",
  "resolvedId": "minimal-statement",
  "version": "0.1.0",
  "definitionHash": "sha256:...",
  "fallbackApplied": true,
  "fallbackReason": "missing-assets",
  "topology": {}
}
```

The definition hash is canonical SHA-256 over exactly
`{version, id: resolvedId, topology}`. Validation requires both the supplied
hash and the recomputed hash to equal the immutable canonical hash for
`resolvedId`; changing an ID/topology pair and recomputing a self-consistent
hash therefore still fails. A second immutable fifteen-block contract map
replays the resolver boundary from IR data: requested page role/dials/asset
range, declared missing-assets fallback, then resolved page role/dials/required
slots. This keeps IR lowering self-contained without reopening registry files
while rejecting canonical-but-incompatible substitutions. Unknown IDs, a
requested-ID/plan mismatch, false fallback provenance, topology drift, or an
identity/compatibility mismatch blocks lowering.

This IR topology hash is intentionally unchanged by the stricter block-object
boundary. A second immutable SHA-256 map fingerprints each complete built-in
JSON definition. Resolver and fixture callers supplying block objects must
match that full-definition fingerprint; it is not serialized into IR.

## Native lowering boundary

Composition blocks do not replace family compilers and do not act as a second
renderer. Lowering first runs the existing family compiler and attaches stable
semantic IDs and lineage. Only then, for an explicitly selected slide, it:

1. classifies native element groups into semantic slots from node roles and
   `semanticParentId`;
2. solves the snapshotted topology against the selected design spacing;
3. translates and scales each group into its target box;
4. preserves element types, text, IDs, lineage, z-order, and connector
   membership;
5. resolves connector endpoints again and proves every element remains inside
   slide bounds.

The public apply API repeats its own identity boundary. Snapshot calls require
known requested/resolved IDs plus version, topology, and a supplied hash that
equals both the recomputed and canonical hash. Block-object calls validate the
block, require `block.id === resolvedId`, bind built-ins to their canonical
topology and full-definition hashes plus static contract, and take built-in
required slots from the trusted contract rather than caller overrides.

No selected slide becomes a single full-slide raster. Fixture asset lookup is
exact and deterministic: `assetSourceById` is a `Map` or object keyed by the
fixture's declared `assetId`. A supplied filesystem path must exist as a
regular file; it is normalized to an absolute path, emitted as a native image
with crop and alt text, records `requestedId === resolvedId`, and renders as an
editable PowerPoint object. URI schemes, protocol-relative sources, backslash
paths, missing paths, and directories fail before rendering. When a
required-media fixture has no local source, a registry is mandatory: the
compiler actually compiles the declared `minimal-statement` fixture and records
`fallbackReason=missing-assets`. Without that registry, compilation fails
closed rather than returning a placeholder that could be mistaken for a
declared fallback. Successful fixture modes retain native text/visuals and meet
Level 4 or better.

## APIs

`scripts/lib/composition-blocks.mjs` exports the registry loader, validator,
immutable topology-hash, full-definition-hash, and compatibility maps, explicit
resolver, deterministic topology solver, bounded native slide transform, and fixture compiler. Creative
plan compilation receives the registry once. Fixture compilation may also
receive it solely to execute a declared missing-assets fixture fallback.
IR-to-manifest compilation consumes the snapshot plus immutable trusted maps
and does not rescan registry files.
