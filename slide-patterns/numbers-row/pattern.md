# numbers-row

A horizontal row of 4-6 hero metrics, each treated as a small stat-callout. Composes the [`stat-callout`](../stat-callout/) visual archetype 4-6 times across the slide width. Used when a single deck beat wants to show momentum without choosing one number over the others.

## Worked example

Slide index 5 of the "Q2 2026 Results" deck (12-slide deck), titled "Q2 at a glance":

- Five stat-callout tiles arranged in a 5-column row. Each tile reuses the stat-callout archetype's `metric` and `supportingText` slots, but uses a smaller hero font (56pt instead of the archetype's 64pt floor) because the pattern explicitly downscales to fit five metrics in one row.
- Each tile shares a thin vertical divider (an optional decoration drawn once across the slide, not per tile) and a single `footnote` at the bottom for the source line.

The slide's `type` is `numbers-row`, but its `archetypes` array cites `stat-callout` once (the pattern is a composition, not a new archetype).

## Visual archetypes used (in order)

1. `stat-callout` × 4-6 — one hero metric + supporting text per tile, side-by-side across the slide.

## Content slot table

| Slot             | Source archetype | Required | Floor / cap                                  | Notes                                                              |
| ---------------- | ---------------- | -------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `title`          | stat-callout     | yes      | `fontSize >= 24pt` (pattern override)        | Title names the row (e.g., "Q2 at a glance").                       |
| `metric[1..N]`   | stat-callout     | yes      | `fontSize >= 56pt` (pattern override), max 6 | Each metric is a separate text element with id `metric-1`, etc.      |
| `supportingText[1..N]` | stat-callout | yes      | `fontSize >= 11pt`, max 80 chars            | One short line below each metric.                                  |
| `footnote`       | stat-callout     | no       | `fontSize >= 10pt`                           | Single source line shared by all tiles (no per-tile footnote).       |

The pattern deliberately lowers the stat-callout archetype's hero floor (64pt → 56pt) and supporting-text floor (14pt → 11pt) because five side-by-side tiles cannot all reach the single-hero archetype's typography scale.

## Anti-patterns

- **Don't use stat-callout as a single-tile pattern.** If you have only one number, use the `stat-callout` archetype directly so it can dominate the slide.
- **Don't mix metrics that need different scales.** Revenue at $1.2B and conversion at 0.7% will fight for visual weight — choose one or the other, or split into two rows.
- **Don't omit the supporting line.** A metric without context reads as decoration. Every metric in the row needs at least one short sentence of context.
