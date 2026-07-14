# Creative Visual Proof 0.2

Creative Proof 0.2 is the final acceptance contract for a Creative text deck.
It separates three authorities:

1. deterministic scripts collect render, token, asset, text-fit, layout,
   editability, suite, and critic evidence;
2. the Host inspects the real full-deck screenshots and records visual
   judgment;
3. `evaluateCreativeVisualProof()` derives acceptance. Neither a caller nor a
   script may force `accepted: true`.

`visual-review.json` remains the deterministic manifest critic. It is not the
Host review and cannot substitute for one.

## Final-review resume protocol

Run the Creative text route normally:

```bash
npm run pptx -- text deck.plan.json output/deck
```

After deterministic evidence passes, the command intentionally exits blocked
at `host-final-visual-review`. The reviewable state contains:

```text
creative-proof.json
creative-proof/final-review-packet.json
creative-proof/candidate/final.pptx
creative-proof/slides/slide-*.png
creative-proof/slides/contact-sheet.png
creative-proof/render-report.json
creative-proof/token-ledger.json
creative-proof/asset-ledger.json
pipeline-blocked.json
```

At this stage there is no top-level deliverable `final.pptx`, successful
`run.json`, or `output-manifest.json`. Inspect every slide PNG at full size and
use the contact sheet only for deck rhythm. Write a local
`creative-final-review.json` satisfying
`schemas/host-visual-review.schema.json`, then resume:

```bash
npm run pptx -- text deck.plan.json output/deck \
  --host-final-review /absolute/path/creative-final-review.json
```

The review must repeat the packet hash and artifact hashes, cover every
rendered slide exactly once, and bind each judgment to its screenshot path and
hash. A stale, duplicate, incomplete, unavailable, or internally inconsistent
review blocks. Any render, IR, manifest, design-token, asset, direction
selection, repair, refinement, or screenshot delta requires a new review.

Task 7 direction-probe review is separate: `--host-review` chooses among
anonymous probe directions, while `--host-final-review` accepts or rejects the
selected full deck. Probe proof is always `evidence-ready`, never accepted.

## Closed proof document

`creative-proof.json` version `0.2.0` requires exactly:

```text
version, identity, rendering, hardGates, tokenLedger, assetLedger,
diagnostics, hostVisualReview, selection, suites, repair, refinement,
findings, acceptance, accepted
```

Identity binds the canonical Semantic IR, render manifest, normalized PPTX ZIP
content, design-token snapshot, asset registry, optional direction selection,
and optional refinement record. PPTX normalization removes only Office core
created/modified timestamps; packaging additionally requires the candidate and
published PPTX raw bytes to be identical.

Rendering evidence records the real LibreOffice/Python/platform environment,
command identity, expected and rendered page counts, every PNG hash and
dimension, contact-sheet membership and hashes, and the render-report hash.
Missing, duplicated, zero-sized, reordered, or stale evidence is a hard
failure.

Required gates include schema, render completeness, contact sheet, text fit,
layout safety, token drift, asset drift, native editability, required suites,
selection validity, deterministic visual critic, and final Host review.
Optional PowerPoint or WPS evidence may be unavailable without blocking; a
suite declared `required: true` must have real passing adapter evidence.

The token ledger proves equality between the token snapshot frozen in Semantic
IR and the supplied design tokens. It deliberately does not claim reverse
lineage from every rendered style back to a token. The asset ledger binds IR,
registry, manifest usage, local bytes, provenance, rights, accessibility,
crop/focal/fallback metadata, and runtime paths. Remote runtime paths, unknown
embedded-use rights, missing bytes, or any drift block.

Deterministic diagnostics are measurable signals, not aesthetic verdicts.
They may report thumbnail readability, anti-slop risk, native coverage,
topology/density rhythm, quality scores, and critic findings. Only the Host
review judges focus, hierarchy, attention alignment, deck rhythm,
consistency, and signature-moment restraint from screenshots.

## Acceptance and publication

Acceptance requires every deterministic required gate to pass, zero P0/P1
findings, passing token and asset ledgers, all required suites, valid or
explicitly not-applicable direction selection, and one complete accepting Host
review bound to the current packet. Host `accept` is invalid when any slide
hard judgment fails, deck rhythm is broken/inconsistent/overused, or a Host
P0/P1 exists.

Only accepted proof publishes the top-level `host-visual-review.json`,
`final.pptx`, `run.json` with status `accepted`, and `output-manifest.json`.
`package-output.py` rehashes the complete evidence graph and fails closed on
tampering. A repaired or refined candidate always needs a newly bound Host
review before publication.
