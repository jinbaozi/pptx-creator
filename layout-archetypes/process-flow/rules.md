# Process-flow archetype — role-aware rules

- **Headline claim**: One clear process statement using `{typography.title}`; floor `fontSize >= 22pt`, `lineHeight >= 1.10`.
- **Step title**: Each step title uses `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.20`.
- **Step body**: Each step's description uses `{typography.body}`; floor `fontSize >= 11pt`, `lineHeight >= 1.35`.
- **Step count**: At most `8` steps per slide; longer flows must wrap to a "Phase 2" continuation slide.
- **Card spacing**: Inter-step gap `>= {spacing.md}`; intra-step padding `>= {spacing.sm}`; arrow gap `>= {spacing.xs}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; headline to first step `>= {spacing.md}`.
- **Color discipline**: Use `{colors.primary}` for the active step plus at most one accent for highlights; total accents `<= 2`.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for step titles, one for body) across the flow.
- **Decorative density**: At most one rounded-token variance; `<= 1` icon-circle triad (typically the first, middle, and last step).
- **Connector rule**: Arrows between steps are native line shapes, single direction; never rasterized or animated.
- **Editable target**: Each step is a native shape + text; aim for Editability Ladder Level 5.
