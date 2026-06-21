# TOC archetype — role-aware rules

- **Title claim**: One clear title using `{typography.title}`; floor `fontSize >= 30pt`, `lineHeight >= 1.10`. Title should match the deck title or carry the explicit label "Agenda" / "Contents" / "目录".
- **Entry count**: At most `9` entries; below `3` is rejected. Entry text uses `{typography.body}`; floor `fontSize >= 14pt`, `lineHeight >= 1.40`.
- **Entry spacing**: Gap between entries `>= {spacing.md}`; if page numbers are shown, they sit on the same baseline and use `{typography.caption}` (floor `fontSize >= 11pt`).
- **Page anchor**: Optional page numbers align right and use a muted token (`{colors.muted}` or `{colors.secondary}`); never bolder than the entry text.
- **Whitespace**: Page margins `>= {spacing.lg}`; title to first entry `>= {spacing.lg}`; bottom margin reserved for optional footnote `>= {spacing.md}`.
- **Card spacing**: No cards. If two columns are used (entry count `>= 7`), inter-column gap `>= {spacing.xl}`.
- **Color discipline**: Use `{colors.primary}` for the title; entries inherit `{colors.text}` or `{typography.body}` color; total accents `<= 1`. No per-entry color cycling.
- **Font-family cap**: Distinct `font-family` count `<= 2` (one for title, one for entries); no icon fonts.
- **Decorative density**: No icon-circle triad; at most one decorative rule (thin horizontal line under the title); no background illustration.
- **Consistency with cover**: TOC title style must echo the cover headline style (same family, same weight) — the deck must read as one document.
- **Editable target**: Native text boxes only; aim for Editability Ladder Level 5 (fully editable).
