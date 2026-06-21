# External slopRisk Calibration Corpus

This directory holds sidecar JSON files referencing provenance URLs from
MIT / Apache-licensed sources. Each `*.expected.json` records a single
reviewer's 0–100 slopRisk annotation for one external deck screenshot.

## Why no PNGs ship in v1

The plan (`docs/plans/2026-06-21-001-feat-visual-design-quality-layer-plan.md`,
U2) explicitly requires **not** to fabricate PNG files. Instead, each external
deck's screenshot is cited by URL in a sidecar JSON file, and a maintainer
must manually download the PNGs into this directory (one per sidecar) before
Cal-0 can run end-to-end against real screenshots.

The agreement-phase test (U3) reads this sidecar JSON to compute the
reviewer-vs-formula agreement rate. Without PNGs, the agreement-phase test
only runs against the 6 internal decks (`examples/slopRisk-corpus/internal/`).

## Sources (MIT / Apache only)

| Source                              | License | Deck IDs |
|-------------------------------------|---------|----------|
| github.com/lewislulu/html-ppt-skill | MIT     | external-001 through external-004 |
| github.com/hugohe3/ppt-master       | MIT     | external-005 through external-007 |
| github.com/marp-team/marp-core      | MIT     | external-008 |
| github.com/hakimel/reveal.js        | MIT     | external-009 |

Per scoping call-out (KTD-9), Claude Design screenshots are excluded
(Anthropic Labs commercial product, redistribution terms TBD).

## Manual download procedure

To enable full Cal-0 against all 15 decks (not just the 6 internal ones):

1. For each sidecar `*.expected.json`, fetch the file at the `provenanceUrl`.
2. Save it as `<deckId>.png` in this directory.
3. Verify each sidecar's `deckId` matches its companion PNG filename.

Example:

```bash
curl -L \
  https://github.com/lewislulu/html-ppt-skill/blob/main/assets/themes/modern-minimalist/preview.png \
  -o external-001-html-ppt-skill-modern-minimalist.png
```

After PNGs are in place, U3's agreement-phase test can be re-run.

## Sidecar schema

Each `*.expected.json` follows:

```json
{
  "deckId": "<unique id>",
  "provenanceUrl": "<source URL>",
  "sourceLicense": "MIT" | "Apache-2.0",
  "expectedSlopRisk": <0-100>,
  "reviewer": "<reviewer handle>",
  "annotatedAt": "<YYYY-MM-DD>",
  "notes": "<free-form annotation context>"
}
```