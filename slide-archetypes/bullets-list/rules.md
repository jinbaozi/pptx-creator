# Bullets-list archetype — role-aware rules

- **Title claim**: One clear title using `{typography.title}`; floor `fontSize >= 26pt`, `lineHeight >= 1.10`.
- **Bullet count**: Exactly `4`-`7` primary bullets. Below `4` is rejected; above `7` is rejected (split into two slides).
- **Bullet body**: Each bullet uses `{typography.body}`; floor `fontSize >= 14pt`, `lineHeight >= 1.45`.
- **Bullet prefix**: Bullets use a single shared marker (•, —, or numbered 1./2./3.); mixing markers is rejected.
- **Bullet spacing**: Gap between bullets `>= {spacing.md}`; group separator (if used) `>= {spacing.lg}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; title to first bullet `>= {spacing.md}`; bottom margin reserved for footnote `>= {spacing.md}`.
- **Color discipline**: Bullets inherit `{colors.text}`; at most one bullet may carry an emphasis color (`{colors.primary}`); total accents `<= 2`. No per-bullet color cycling.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for title, one for bullets).
- **Decorative density**: No icon-circle triad; no decorative rules; bullets carry weight from content, not ornament.
- **One page, one claim**: All bullets must support a single title-level claim; if a second thesis emerges, split the slide.
- **Editable target**: Native text boxes only; aim for Editability Ladder Level 5 (fully editable).
