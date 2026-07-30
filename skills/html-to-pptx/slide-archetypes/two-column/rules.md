# Two-column archetype — role-aware rules

- **Title claim**: One clear title using `{typography.title}`; floor `fontSize >= 26pt`, `lineHeight >= 1.10`. Title must describe both columns (e.g., "Before vs. After", "Pros vs. Cons").
- **Column headings**: Optional column headings use `{typography.heading}`; floor `fontSize >= 16pt`. Headings sit on the same baseline across both columns.
- **Column body**: Body text in each column uses `{typography.body}`; floor `fontSize >= 13pt`, `lineHeight >= 1.45`. Per-column item count `>= 2`; below `2` is rejected.
- **Column width**: Columns must be equal width; total content width `== 2 * columnWidth + gap`. Inter-column gap `>= {spacing.xl}`.
- **Column balance**: Per-column line count should be within `2` lines of each other; imbalance is rejected.
- **Whitespace**: Page margins `>= {spacing.lg}`; title to first row `>= {spacing.md}`; bottom margin reserved for footnote `>= {spacing.md}`.
- **Color discipline**: One accent color (`{colors.primary}`) used at most for one column heading; the other column heading uses `{colors.text}`; total accents `<= 2`. No per-row color cycling.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for title/headings, one for body).
- **Decorative density**: No icon-circle triad; a single thin divider line between columns is permitted but optional.
- **No three columns**: If a third column would be added, switch to icon-grid or bullets-list. Two-column refuses triples.
- **Editable target**: Native text boxes only; aim for Editability Ladder Level 5 (fully editable).
