# Architecture-layered archetype — role-aware rules

- **Headline claim**: One clear architectural thesis using `{typography.title}`; floor `fontSize >= 22pt`, `lineHeight >= 1.10`.
- **Layer label**: Each layer name uses `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.20`.
- **Layer body**: Each layer's description / roles uses `{typography.body}`; floor `fontSize >= 11pt`, `lineHeight >= 1.35`.
- **Layer count**: At most `5` stacked layers per slide; deeper stacks must collapse inner layers.
- **Card spacing**: Vertical gap between layers `>= {spacing.sm}`; horizontal gap between sibling layers `>= {spacing.md}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; headline to top layer `>= {spacing.md}`.
- **Color discipline**: Use `{colors.primary}` for layer fills plus at most one accent for the focal layer; total accents `<= 2`.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for labels, one for descriptions) across the stack.
- **Decorative density**: At most one rounded-token variance; `<= 1` icon-circle triad (typically for the focal layer only).
- **Flow direction**: Arrows / connectors are native line shapes, never rasterized; one direction (top-down or left-right) per slide.
- **Editable target**: Each layer is a native shape + text; aim for Editability Ladder Level 5.
