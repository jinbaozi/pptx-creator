# Visual Critic Rubric

Creative mode target:

- deck score >= 82
- every slide score >= 72
- editable level >= 4

Scoring dimensions:

- hierarchy
- alignment
- density
- contrast
- variety
- editability
- designSystemFit
- faithfulness for Replica mode

Rule-based critic runs before optional model review. It should never change content by itself; it only reports issues and recommended repair actions.

## Deterministic Design-Quality Rules

The critic borrows the useful, localizable parts of Taste Skill and Impeccable without depending on either repository at runtime:

- Contrast: text with explicit hex color is checked against the overlapping shape/card fill first, then the solid slide background, using WCAG thresholds.
- Layout repetition: three or more similarly sized card shapes on one slide are flagged so the agent can add hierarchy, rhythm, or visual variation.
- Creative anti-defaults: explicit default web fonts (`Inter`, `Arial`, `Helvetica`, `system-ui`), neutral gray text on chromatic backgrounds, heavy pure-black shadows on light backgrounds, and card-in-card framing are flagged so creative decks can choose a more intentional type/material direction.
- Template-stack layout: four or more editable text/shape layers sharing the same slide center and nearly the same width are flagged in creative mode so the agent can add Taste-style compositional variance instead of centered boilerplate stacking.
- Fake-perfect metrics: template-like numbers such as `99.99%`, isolated `50%`, repeated digits, and `1,234,567` are flagged in creative mode so the agent uses real measured data or clearly marks illustrative values.
- Replica fidelity: browser-only effects captured during HTML measurement are reported as `replica-unsupported-effect` instead of being silently dropped; simple outer `box-shadow` and single `filter: drop-shadow(...)` effects are approximated as native PPT shadow first.
- Replica coverage: measured HTML nodes that cannot be represented as native PPT layers are counted in `_replicaCoverage` and reported as `replica-coverage` when coverage is below `1.0`.

Creative-mode findings can feed repair patches. Replica-mode findings must preserve the source design; creative anti-default rules are skipped, and fixes should approximate native PPT equivalents first or use local raster layers only for unsupported effects.
