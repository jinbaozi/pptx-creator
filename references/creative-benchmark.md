# Creative benchmark and blind preference acceptance

The benchmark tests whether the Creative Director Pipeline improves real deck
preference across content types; it does not replace the mandatory Host visual
review for an individual run. Its closed corpus is
`examples/creative-benchmark/corpus.json`: 24 briefs across six domains and two
languages, with four briefs per domain and twelve briefs per language.

## Lanes

Run the public command with an explicit lane and output directory:

```bash
npm run benchmark:creative -- --lane fast --output output/creative-benchmark-fast
npm run benchmark:creative -- --lane render --output output/creative-benchmark-render
npm run benchmark:creative -- --lane nightly --output output/creative-benchmark-nightly
npm run benchmark:creative -- --lane release --artifacts reference-artifacts.json --artifacts output/creative-benchmark-nightly/challenger-artifacts.json --seed <secret-seed> --prepare-review --output output/creative-benchmark-release
npm run benchmark:creative -- --lane release --artifacts reference-artifacts.json --artifacts output/creative-benchmark-nightly/challenger-artifacts.json --seed <same-secret-seed> --reviews reviewer-01.json --reviews reviewer-02.json --output output/creative-benchmark-release
```

- `fast` validates all 24 plan, IR, compiler, anti-slop, and no-op repair
  contracts without LibreOffice rendering.
- `render` compiles and renders eight bilingual briefs from four domains and
  requires PPTX, per-slide PNG, contact sheet, typography, and proof evidence.
- `nightly` applies the deterministic contracts to all 24 briefs.
- `release` requires exactly one reference and one challenger artifact for
  every brief, creates a blinded packet, keeps the answer key private, and
  evaluates independently supplied human reviews.

`render` and `nightly` write `challenger-artifacts.json` with portable paths,
artifact IDs, and identity attestations. A release command accepts repeated
`--artifacts` inputs, so a genuine frozen reference manifest can remain
separate from the current challenger output. Relative evidence paths resolve
against the directory containing each manifest. Do not manufacture the
reference side by duplicating the challenger; use the declared pre-upgrade
revision or another fixed comparator and record its provenance outside the
reviewer packet.

For this upgrade, the declared frozen comparator is the pre-upgrade repository
revision. Prepare an isolated checkout with its own dependencies, then run the
internal, revision-bound helper:

```bash
node scripts/render-creative-benchmark-reference.mjs --source-root <frozen-checkout> --revision <full-commit> --output output/creative-benchmark-reference
```

The helper refuses checkout/revision drift, imports the historical fixture and
compiler interfaces from that checkout, renders all 24 decks, and writes
`reference-artifacts.json` plus `reference-report.json`. It performs no network
or LLM work. This is preparation evidence, not a new public benchmark lane.

The path-routed CI, scheduled nightly lane, and manual release lane live in
`.github/workflows/ci.yml`. Synthetic ratings may test protocol mechanics, but
they are never release evidence.

## Blind-review protocol

Reviewer-facing names, paths, PPTX metadata, and proof receipts must not expose
reference/challenger or generator identity. The packet randomizes left/right
placement and binds public evidence to a private answer key. Each reviewer
selects left, right, or tie and independently rates both sides from 1 to 5 on
hierarchy, spacing, density, consistency, and originality. Duplicate
reviewer/pair records, incomplete dimensions, identity leaks, and unbound
packets fail closed.

Release is intentionally two-stage:

1. Run with `--prepare-review`, a fixed secret seed, and all artifact manifests.
   It writes `blind-review-packet.json`, materializes anonymized evidence, and
   creates the offline `reviewer/index.html`. The page shows the common brief,
   intent, and audience but never the generator identity. The successful
   preparation status is `awaiting-human-review`, never `passed`.
2. Distribute the review root without `private/`. Each independent reviewer
   opens the local HTML page, inspects both full-size slide sets, completes all
   ratings, and exports one `review-records.json` file.
3. Run release again with the same seed and artifact manifests, passing each
   returned file through a repeated `--reviews`. A changed packet, duplicate
   reviewer, missing pair, or insufficient review count remains `unproven`.

## Release acceptance

Release quality is proven only when all conditions pass:

- 24 briefs x at least five reviewers;
- overall challenger win rate >= 70%;
- Wilson 95% lower bound > 50%;
- every domain and language subgroup win rate >= 60%; and
- challenger median >= 4/5 for all five dimensions.

`scripts/lib/blind-preference.mjs` is the threshold authority. A missing or
insufficient human review set produces `status: "unproven"`; deterministic
tests, render success, or a synthetic preference report cannot upgrade it.
