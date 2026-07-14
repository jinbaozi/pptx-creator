# Evidence-led Creative refinement

Creative refinement is a persistent Host-approved resume protocol. It is not a
second automatic taste engine and it does not stack another three attempts on
top of legacy repair. Replica mode keeps bounded repair; Creative mode has one
shared maximum of three applied deltas.

## Resume protocol

1. A completed final Host review rejects an exact Proof 0.2 artifact. The
   pipeline writes closed `refinement-plan.json` with `dryRun: true`, removes
   deliverable markers, and blocks at `awaiting-refinement-approval`.
2. The Host copies the pending operation into an external protected
   `creative-refinement-state.json`, supplies the exact reversible delta (and
   any semantic replacement/concept), and explicitly approves it.
3. Resume with `--refinement-state`. The pipeline verifies the source proof,
   replays the entire approved chain from canonical input, applies exactly one
   new operation, increments the shared budget, renders a new packet, and
   blocks for a new `--host-final-review` because all prior screenshot judgment
   is stale.
4. Resume with the same refinement state plus the new review. The pipeline
   compares complete artifact-bound Proof 0.2 records. An accepted
   non-regressing candidate publishes atomically; an improved rejected
   candidate may produce the next dry-run plan; no improvement or budget 3
   stops with the best diagnostic state retained.

Generated state is diagnostic and never trusted as approval input. The state
sidecar must remain outside the output directory.

## Commands and layers

Supported commands are `typeset`, `layout`, `colorize`, `bolder`, `quieter`,
`distill`, `harden`, `polish`, and `overdrive`.

- IR: meaning, copy/data, semantic hierarchy, attention, story/order,
  topology/block, design intent/tokens/palette, density/rhythm, alt/provenance,
  `distill`, and `overdrive`.
- Manifest: only bounded meaning-preserving native-object geometry, measured
  font/line fit, localized crop/compatibility/contrast, and narrow polish.

Every operation carries evidence, reason, risk, expected delta, target layer,
exact delta, inverse rollback, provenance, and approval. The router may suggest
a command but leaves `delta: null`. Copy, data, and signature concepts must be
Host-authored.

Manifest deltas may change only allowlisted optical fields with exact
before/after/tolerance values. They cannot change text, IDs, element type/count,
assets, semantic lineage, z-order, membership, or editability class. IR deltas
cannot contain coordinates or raw elements and are recompiled through the
canonical Semantic Slide IR compiler.

## Comparison and stopping

Comparison is lexicographic: P0, P1, unresolved layout/text/render hard gates,
required-suite failures, token/asset drift, editability regression, slop risk,
then negative quality score. Earlier safety dimensions dominate later visual
gains; any editability regression is worse. Equal evidence becomes an
improvement only when the new artifact has a valid Host acceptance.

Stop on accepted proof, no improvement, three applied deltas, unsupported
evidence, stale/missing approval or review, or publication failure. Invalid
input consumes no attempt. `overdrive` may establish at most one Host-authored
signature moment per deck; an existing Host-identified signature suppresses it.

## Artifacts

- `schemas/refinement-plan.schema.json`: closed dry-run plan.
- `schemas/refinement-state.schema.json`: closed protected resume input.
- `refinement-plan.json`: normalized applied chain/history and the artifact
  identity hashed by Creative Proof 0.2.
- `.creative-refinement/best-proof.json`: non-authoritative diagnostic best
  evidence; its hash must match the protected sidecar before use.

`run.json.artifacts.refinementPlan` is null for unrefined runs and points to
`refinement-plan.json` only when Proof 0.2 binds the same canonical hash.
