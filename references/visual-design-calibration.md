# Visual Design Calibration (slopRisk)

This artifact records the per-deck slopRisk calibration used to lock the
agreement threshold consumed by `scripts/lib/slop-risk.mjs` (slopRisk scorer)
and the `tests/visual-design-calibration.test.mjs` CI gate. Per R4 in the
visual-design-quality plan, the locked target is **reviewer-vs-formula agreement
≥ 80% within ±20 points**.

Fixtures live under `examples/slopRisk-corpus/`:

- `internal/` — 6 decks symlinked from `examples/{text-input,html-input,design-first,image-input}/`.
- `external/` — 9 sidecar JSON files citing MIT / Apache-licensed source URLs
  (PNG files must be manually downloaded into this directory before the
  agreement-phase test can run end-to-end; see `examples/slopRisk-corpus/external/README.md`).

Each fixture has a sidecar `*.expected.json` recording one reviewer's
0–100 slopRisk annotation. The aggregate annotations live in
`examples/slopRisk-corpus/annotations.csv`.

## Distribution table

| Deck ID                                   | Source                                                  | Expected slopRisk | Within ±20 of formula |
|-------------------------------------------|---------------------------------------------------------|-------------------|-----------------------|
| internal-001-text-input                   | examples/text-input/deck.manifest.json                  | 42                | (pending U3)          |
| internal-002-html-input-one-page          | examples/html-input/one-page-dashboard.html             | 55                | (pending U3)          |
| internal-003-html-input-css-positioned    | examples/html-input/css-positioned-dashboard.html      | 60                | (pending U3)          |
| internal-004-html-input                   | examples/html-input/deck.manifest.json                  | 50                | (pending U3)          |
| internal-005-design-first                 | examples/design-first/compiler-roadshow/deck.storyboard.json | 65           | (pending U3)          |
| internal-006-image-input                  | examples/image-input/deck.manifest.skeleton.json        | 38                | (pending U3)          |
| external-001-html-ppt-skill-modern-minimalist | lewislulu/html-ppt-skill                              | 88                | (pending U3 + PNG)    |
| external-002-html-ppt-skill-dark-tech     | lewislulu/html-ppt-skill                                | 85                | (pending U3 + PNG)    |
| external-003-html-ppt-skill-editorial     | lewislulu/html-ppt-skill                                | 82                | (pending U3 + PNG)    |
| external-004-html-ppt-skill-cyberpunk     | lewislulu/html-ppt-skill                                | 72                | (pending U3 + PNG)    |
| external-005-ppt-master-compiler-roadshow | hugohe3/ppt-master                                      | 80                | (pending U3 + PNG)    |
| external-006-ppt-master-startup-pitch     | hugohe3/ppt-master                                      | 78                | (pending U3 + PNG)    |
| external-007-ppt-master-product-roadshow | hugohe3/ppt-master                                      | 75                | (pending U3 + PNG)    |
| external-008-marp-theme-default           | marp-team/marp-core                                     | 70                | (pending U3 + PNG)    |
| external-009-reveal-js-template           | hakimel/reveal.js                                       | 65                | (pending U3 + PNG)    |

**Aggregate (annotations only):** 15 / 15 decks labeled → **100% coverage**.
**Aggregate (agreement):** to be filled after U3 ships the `scoreSlopRisk`
scorer. Target: **≥ 80% within ±20 points**.

- **Threshold default:** reviewer-vs-formula agreement ≥ 80% within ±20 points
  (locked per R4 / R2a in the plan)
- **Clearance target:** ≥ 80% (CI gate; below this, the slopRisk scorer
  cannot ship per R2 in the plan)
- **Corpus size:** 15 decks (6 internal + 9 external) — Cal-0
- **Verdict (structure phase, U2):** artifact + corpus + sidecar structure
  complete; agreement rate pending U3 scorer.

## Reviewer protocol

Per R2a in the origin brainstorm, Cal-0 is annotated by **1 reviewer** for v1.
Multi-reviewer consensus is allowed if a second reviewer is available — in that
case, the sidecar `expectedSlopRisk` records the consensus value, and the
`reviewer` field records the handle that produced the final label (comma-separated
if multiple).

When a second reviewer is added:

1. Both reviewers annotate independently.
2. The mean (rounded to nearest integer) becomes the canonical `expectedSlopRisk`.
3. If the two annotations differ by > 30 points, escalate to a third reviewer.
4. Update the sidecar + CSV in the same commit that records the consensus.

## How distributions are derived

The 6 internal decks are symlinks to existing `examples/` inputs so the corpus
inherits the project's single source of truth (no copy drift). The 9 external
decks reference publicly-inspectable MIT / Apache-licensed source URLs (see
`examples/slopRisk-corpus/external/README.md`); the screenshot PNGs must be
manually downloaded before the agreement-phase test can score them.

Per-deck slopRisk annotations are recorded in two places:

- The sidecar `*.expected.json` (rich: includes `notes`, `annotatedAt`, etc.).
- `examples/slopRisk-corpus/annotations.csv` (flat: 5 columns, easy to diff
  in code review).

The agreement-phase test (`tests/visual-design-calibration.test.mjs`, shipped
as part of U3) reads the CSV + invokes `scoreSlopRisk(deck)` per deck + counts
hits within ±20 points. The hit rate must reach ≥ 80% for CI to pass.

## Pending population (ship-time state)

The "Within ±20 of formula" column is intentionally **blank** at U2 ship time.
Once U3 ships `scoreSlopRisk`, this table is populated by running:

```bash
node scripts/run-deck-pipeline.mjs examples/slopRisk-corpus/ \
  output/slopRisk-calibration \
  --emit-run-index --run-id slopRisk-cal-0 \
  --input-summary "slopRisk Cal-0 run"
```

The pipeline output's `visual-review.json` (per-deck) and
`examples/slopRisk-corpus/annotations.csv` are diff'd to fill the column.
A maintainer commits the populated table back to this artifact.

## Manifest dependency

The agreement-phase test (shipped in U3) reads:

- This artifact (`references/visual-design-calibration.md`) — for the locked
  threshold + clearance target.
- `examples/slopRisk-corpus/annotations.csv` — for reviewer annotations.
- `scripts/lib/slop-risk.mjs` `scoreSlopRisk(deck)` (U3) — for the formula score.

The structure-phase test (shipped in U2) does **not** call `scoreSlopRisk` —
that function does not exist yet. Structure-phase assertions only verify the
artifacts exist + corpus is complete + sidecar fields are present.

## Regeneration rules

After a corpus change (new deck, removed deck, relabel):

1. Edit `examples/slopRisk-corpus/annotations.csv` (single source of truth).
2. Re-run the agreement-phase test: `npx vitest run tests/visual-design-calibration.test.mjs`.
3. The aggregate agreement rate must remain ≥ 0.8; otherwise the test fails
   (CI gate, intentional per KTD-3).
4. If agreement drops below 0.8, either:
   - Re-annotate the offending decks (update `expectedSlopRisk` + CSV).
   - Tune `scoreSlopRisk`'s formula weights (U3) to better match the corpus.
   - Add or remove fixtures to broaden the distribution.
5. Commit the updated CSV + sidecars + artifact table in the same change.

After a formula change (e.g., new signal added in U3, weight tuned):

1. Re-run the agreement-phase test against the existing corpus.
2. If agreement drops, prefer re-tuning the formula over re-labeling the corpus
   (corpus is the ground truth; formula is the approximation).
3. Document the formula change in this artifact's "Regeneration rules" section
   so future maintainers understand the lock-in history.