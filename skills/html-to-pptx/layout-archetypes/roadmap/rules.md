# Roadmap archetype — role-aware rules

- **Headline claim**: One clear roadmap thesis using `{typography.title}`; floor `fontSize >= 22pt`, `lineHeight >= 1.10`.
- **Phase title**: Each phase label uses `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.20`.
- **Phase body**: Each phase's deliverables use `{typography.body}`; floor `fontSize >= 11pt`, `lineHeight >= 1.35`.
- **Phase count**: At most `5` phases per slide; longer horizons must collapse to "now / next / later" or split.
- **Card spacing**: Inter-phase gap `>= {spacing.md}`; intra-phase padding `>= {spacing.sm}`; deliverable bullet gap `>= {spacing.xs}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; headline to timeline `>= {spacing.md}`.
- **Color discipline**: Use `{colors.primary}` for the current phase plus at most one accent for "shipped" or "next"; total accents `<= 2`.
- **Font-family cap**: Distinct `font-family` count `<= 3` (one for phase labels, one for body, optional one for status chips) across the roadmap.
- **Decorative density**: At most one rounded-token variance; `<= 1` icon-circle triad (typically "shipped" milestones only).
- **Timeline rule**: The horizontal/vertical timeline is a single native line; phase blocks sit on it without overlapping the line.
- **Editable target**: Each phase is a native shape + text; aim for Editability Ladder Level 5.
