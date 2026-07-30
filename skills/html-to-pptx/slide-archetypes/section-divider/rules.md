# Section-divider archetype — role-aware rules

- **Title claim**: One section title using `{typography.title}`; floor `fontSize >= 48pt`, `lineHeight >= 1.05`. Title is the section name only — no subtitle claim hidden inside.
- **Section number**: Optional large number using `{typography.metric}`; floor `fontSize >= 48pt`. Number sits above the title or to its left, never above the slide midpoint.
- **Subtitle (optional)**: One supporting line using `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.30`. Maximum `120` characters.
- **Whitespace**: Page margins `>= {spacing.xl}` (very generous); title sits biased slightly left of centre (35% from left) or fully centred; bottom margin reserved for footnote `>= {spacing.md}`.
- **Color discipline**: Title uses `{colors.text}` or `{colors.primary}`; section number uses muted token (`{colors.muted}` or `{colors.secondary}`); total accents `<= 1`.
- **Font-family cap**: Distinct `font-family` count `<= 2`; divider must share the cover's family for visual continuity.
- **Decorative density**: No icon-circle triad; a single thin horizontal rule under the title is permitted but optional; no background illustration.
- **Quiet by design**: Divider must be quieter than the cover; if it competes with the cover for attention, reduce font size or color saturation.
- **No body copy**: The archetype refuses paragraphs, bullets, or images. Divider is a breath, not a payload.
- **Editable target**: Native text boxes only; aim for Editability Ladder Level 5 (fully editable).
