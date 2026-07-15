# Creative direction probes (`--native` compatibility)

This deterministic probe protocol is retained for the explicit Semantic Slide
IR route. Default flagship HTML-first work explores materially different
directions in the Host and compares representative multi-page browser renders
before the selected full deck is frozen.

Creative direction exploration is a conditional, two-stage extension of the
normal text route. The Host authors every direction and judges anonymized
rendered evidence. Deterministic scripts only validate, project, render,
anonymize, bind hashes, and record the Host's choice. They never invent a
direction, infer a visual preference, or let a numeric score select a winner.

## Eligibility and candidate cap

| Quality profile | Eligibility | Candidate cap |
|---|---|---:|
| `standard` | never | 1 (therefore no exploration) |
| `premium` | at least two active material-risk signals | 3 |
| `flagship` | always | 4 |

The premium signals are `visualAmbition >= 80`, `compositionVariance >= 75`,
brand references or `brandLocked`, `assetIntensity >= 60` or at least two
visual assets, and at least three `architecture|process|dashboard|matrix`
slides. A cap is not a fixed count: the Host supplies any two through the cap.
An eligible run without directions blocks before compilation. An ineligible
run with directions also blocks, so no option is silently ignored.

## Stage 1: materialize anonymous probes

Write a local `creative-directions.json` version `0.1.0`. Bind it to the exact
validated plan with `planHash`, give each direction a private label and
rationale, declare at least two material axes, and use only coordinate-free
projection fields:

```json
{
  "version": "0.1.0",
  "planHash": "sha256:...",
  "directions": [
    {
      "id": "editorial-contrast",
      "label": "Editorial contrast",
      "rationale": "A stronger poster opening and more varied hierarchy",
      "declaredAxes": ["layout-topology", "hierarchy"],
      "projection": {
        "designSystem": "warm-editorial",
        "dials": { "compositionVariance": 82 },
        "slides": [
          { "slideId": "slide-cover", "blockId": "editorial-poster" }
        ]
      }
    }
  ]
}
```

The complete closed contract is
`schemas/creative-direction-request.schema.json`. Design systems must be
built-in names or local paths. Projections may select a design system, change
the three bounded dials, and assign registered composition blocks by slide ID.
Coordinates, elements, raw colors/fonts/effects, remote paths, unknown
slides/blocks, protected-token changes, and non-native canonical routes fail
closed. A source- or brand-locked plan must keep its resolved design system.

Run the normal public command:

```bash
npm run pptx -- text deck.plan.json output --native \
  --creative-directions creative-directions.json
```

Every direction is compiled as a full plan and full Semantic Slide IR, then
only a stable semantic probe set is filtered from the resulting manifest. The
probe set contains at most three slides: cover, the earliest representative of
the modal content family, and the highest-complexity remaining slide. One- and
two-slide decks use every slide once. Complexity is derived from metrics,
diagram structures, visual assets, semantic item count, and complex family;
ties preserve plan order.

Each probe independently passes text fit, native editability Level 4 or higher,
real rendering, and the current Creative proof gate. Candidates must share the
same base-IR and probe-content hashes. Every pair must differ on at least two
observed material axes; sets larger than two must span at least three. Labels,
declared-only changes, color-only changes, and callback-provided claims do not
count as materialized evidence.

The command intentionally exits blocked after atomically publishing only:

```text
creative-direction-blind/blind-packet.json
creative-direction-blind/blind-NN/*.png
pipeline-blocked.json        # blockedBy: host-visual-review
```

It publishes no `final.pptx`, canonical IR, `run.json`, reveal mapping,
candidate labels, design-system names, diagnostic scores, or default winner.
The packet binds anonymous screenshot paths and byte hashes, required unordered
pairs, probe slide IDs, and the shared rendering environment.

## Host review sidecar

Inspect the actual anonymous images and write a local
`creative-host-review.json` bound to the exact `explorationId` and
`packetHash`. Include exactly one review for every `requiredPairs` entry:

```json
{
  "version": "0.1.0",
  "explorationId": "explore-...",
  "packetHash": "sha256:...",
  "available": true,
  "pairs": [
    {
      "left": "blind-01",
      "right": "blind-02",
      "leftScreenshotHash": "sha256:...",
      "rightScreenshotHash": "sha256:...",
      "preference": "left",
      "reason": "Clearer opening hierarchy and more deliberate whitespace rhythm."
    }
  ]
}
```

`preference` is `left`, `right`, or `tie`. A tied highest win count or cycle
requires `adjudication: { "blindId": "blind-NN", "reason": "..." }` naming
one tied leader. Missing pairs, stale packet or screenshot hashes,
`available:false`, private candidate identifiers/labels/design systems, and
weighted/slop score references fail closed. Pairwise visual preference is the
only primary winner rule; diagnostic evidence never breaks a tie or overturns
the Host choice.

## Stage 2: regenerate, reveal, and prove the winner

Resume with the same plan and direction request:

```bash
npm run pptx -- text deck.plan.json output --native \
  --creative-directions creative-directions.json \
  --host-review creative-host-review.json
```

The runner regenerates every candidate and requires the anonymous packet to be
byte-equivalent before accepting the review. Only then does it reveal the
winner, compile that direction as the full canonical plan/IR/manifest, and run
the normal full-deck render, proof, repair, and package path. Probe success
never substitutes for full-deck proof.

A successful explored run adds `creative-candidates.json` and
`creative-selection.json`. The former contains private directions,
materialized signatures, difference evidence, diagnostics, and artifact
hashes; the latter records the reveal, complete Host pairwise review, selected
candidate, and diagnostic evidence. `run.json` binds both documents and the
blind packet through artifact pointers and immutable exploration metadata.
Its `runId` is still derived only from the selected canonical Semantic Slide
IR; `explorationId` is separate.

Candidate and selection publication is part of the existing authoring
transaction. Package or hook failure rolls back reveal data, candidate data,
canonical plan/IR/registry, and `run.json` in reverse order. Stale winner state
is invalidated at the next run, while local plan, design, asset, direction, and
review inputs remain protected.
