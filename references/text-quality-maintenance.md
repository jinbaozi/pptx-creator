# Text quality maintenance

Automated checks use the stable bilingual fixture corpus in `examples/text-input/bilingual-briefs.json`. Update expected structure or taste bands only with an explained behavioral change.

## Blind pairwise evaluation

For release calibration, render the same randomized briefs with the candidate and current baseline. Hide generator identity and order, then ask reviewers to choose the stronger deck and score both decks independently. Direction candidates may be explored only for material ambiguity or high risk; never prescribe a fixed candidate count, constant score, or deterministic recommendation.

Release targets:

- Candidate win rate: at least 70%.
- Median hierarchy: at least 4/5.
- Median spacing: at least 4/5.
- Median density: at least 4/5.
- Median consistency: at least 4/5.
- Median originality: at least 4/5.

Record reviewer count, brief IDs, randomized order, raw pairwise choices, per-dimension scores, and exclusions. Automated gates remain deterministic; human pairwise results are maintenance evidence and are not fabricated by scripts.
