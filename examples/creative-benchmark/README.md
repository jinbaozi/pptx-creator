# Creative benchmark corpus

`corpus.json` contains 24 coordinate-free authoring briefs: six domains, four
briefs per domain, and an exact 12/12 split between `zh-CN` and `en-US`.

The corpus is deterministic and offline. It proves compiler and evidence
contracts; it is not an aesthetic oracle. Release quality additionally requires
the blinded review packet and at least five independent reviewers per brief.
Reference and challenger identities live only in the private answer key, never
in the reviewer packet or submitted review records.

Each review record contains only an opaque `pairId`, an opaque reviewer ID, a
`left|right|tie` preference, and independent 1–5 ratings for both sides on
hierarchy, spacing, density, consistency, and originality. See
`schemas/blind-preference.schema.json#/$defs/reviewRecord`. The evaluator joins
the private answer key only after collection, then reports challenger medians,
overall Wilson 95% lower bound, and domain/language subgroups.

`npm run benchmark:creative -- --lane nightly` renders all current decks and
writes a portable `challenger-artifacts.json`. Pair it with a genuine frozen
reference manifest; never duplicate the current artifacts onto both sides.
The internal `scripts/render-creative-benchmark-reference.mjs` helper can render
a revision-bound repository checkout into `reference-artifacts.json`; it fails
if the checkout HEAD does not equal the requested full commit.

Release has two resumable stages. First run `--lane release` with a fixed seed,
one or more repeated `--artifacts`, and `--prepare-review`. It writes the public
packet, anonymized decks/screenshots, and an offline `reviewer/index.html`, plus
the answer key under `private/`. Never distribute or upload that private
directory. After each reviewer exports a separate `review-records.json`, rerun
with the identical seed/artifacts and pass the files through repeated
`--reviews` options. Packet drift, duplicate identities, or missing coverage
fails closed.
