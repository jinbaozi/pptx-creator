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
npm run benchmark:creative -- --lane release --artifacts artifacts.json --reviews reviews.json --seed <secret-seed> --output output/creative-benchmark-release
```

- `fast` validates all 24 plan, IR, compiler, anti-slop, and no-op repair
  contracts without LibreOffice rendering.
- `render` compiles and renders eight bilingual briefs from four domains and
  requires PPTX, per-slide PNG, contact sheet, typography, and proof evidence.
- `nightly` applies the deterministic contracts to all 24 briefs.
- `release` requires exactly one reference and one challenger artifact for
  every brief, creates a blinded packet, keeps the answer key private, and
  evaluates independently supplied human reviews.

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
