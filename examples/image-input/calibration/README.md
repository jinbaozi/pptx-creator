# Calibration fixtures

Three small PNGs used by `references/calibration.md` to lock the
`--ocr-confidence` default (0.7) consumed by `scripts/image-replica-plan.py`.

## Files

| File             | Size      | Purpose                                         |
|------------------|-----------|-------------------------------------------------|
| text-heavy.png   | 200x200   | Many short high-confidence text blocks.         |
| mixed.png        | 200x200   | Heading + body text + caption + footnote mix.   |
| sparse.png       | 160x160   | Title + subtitle, low-density layout.          |

## Regenerate

```bash
python3 scripts/generate-calibration-fixtures.py
```

Outputs `text-heavy.png`, `mixed.png`, `sparse.png`, and `calibration.json`
next to this README.

## Per-block confidences

See `calibration.json` (regenerated atomically alongside the PNGs).
`references/calibration.md` summarizes the per-block distribution and the
aggregate clearance against the 0.7 threshold.