# Problem-solution archetype — role-aware rules

- **Headline claim**: One framing statement using `{typography.title}`; floor `fontSize >= 24pt`, `lineHeight >= 1.10`.
- **Panel header**: "Problem" and "Solution" panel headers use `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.20`.
- **Panel body**: Each panel's body text uses `{typography.body}`; floor `fontSize >= 11pt`, `lineHeight >= 1.35`.
- **Panel balance**: Visual weight of the solution panel should not exceed `1.6x` the problem panel; never let one side dwarf the other.
- **Card spacing**: Inter-panel gap `>= {spacing.md}`; intra-panel padding `>= {spacing.sm}`; bullet gap `>= {spacing.xs}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; headline to panels `>= {spacing.md}`.
- **Color discipline**: Problem side uses a muted/neutral surface; solution side uses `{colors.primary}` plus at most one accent; total accents `<= 2`.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for headers, one for body) across both panels.
- **Decorative density**: At most one rounded-token variance; `<= 1` icon-circle triad (split between the two panels, not stacked on one side).
- **Bridge rule**: An optional arrow or "→" between panels is allowed but must be a single line shape, not a decorative animation.
- **Editable target**: Each panel is a native shape + text group; aim for Editability Ladder Level 5.
