# Comparison-matrix archetype — role-aware rules

- **Headline claim**: One clear comparison statement using `{typography.title}`; floor `fontSize >= 22pt`, `lineHeight >= 1.10`.
- **Column header**: Each option/column header uses `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.20`.
- **Row body**: Cell text uses `{typography.body}`; floor `fontSize >= 11pt`, `lineHeight >= 1.35`.
- **Column count**: At most `4` comparison columns per slide; widen the slide or split before exceeding.
- **Card spacing**: Cell padding `>= {spacing.sm}`; row gap `>= {spacing.xs}`; column gap `>= {spacing.sm}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; headline to matrix `>= {spacing.md}`.
- **Color discipline**: Use `{colors.primary}` plus at most one accent (highlight / "winner" cell); total accents `<= 2`. No rainbow columns.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for headers, one for body) across the matrix.
- **Decorative density**: At most one rounded-token variance; `<= 1` icon-circle triad; cells stay clean rectangles.
- **Highlight rule**: At most one row or column may use the accent color; rest stay neutral.
- **Editable target**: Matrix is a native table or shape grid; aim for Editability Ladder Level 5.
