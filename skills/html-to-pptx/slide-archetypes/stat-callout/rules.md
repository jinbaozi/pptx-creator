# Stat-callout archetype — role-aware rules

- **Hero metric**: One number or short phrase using `{typography.metric}`; floor `fontSize >= 64pt`, `lineHeight >= 1.0`. Use tabular figures if available; never break across lines.
- **Unit**: Unit (%, ms, $, etc.) shares the same row as the number; same family, slightly smaller (`>= 0.6 * heroSize`).
- **Supporting text**: One supporting sentence using `{typography.body}`; floor `fontSize >= 14pt`, `lineHeight >= 1.45`. Maximum `180` characters; longer copy must be moved to a bullets-list.
- **Title (optional)**: A short label above the metric using `{typography.subtitle}`; floor `fontSize >= 16pt`. Optional because the metric often speaks for itself.
- **Whitespace**: Page margins `>= {spacing.lg}`; hero sits centred or biased slightly left (35% from left); bottom margin reserved for footnote `>= {spacing.md}`.
- **Color discipline**: Hero uses `{colors.primary}` or `{colors.text}`; supporting text uses muted token (`{colors.muted}` or `{colors.secondary}`); total accents `<= 2`. No gradient fills behind the number.
- **Font-family cap**: Distinct `font-family` count `<= 2`; if the metric uses a display family, body must use the design system's body family.
- **Decorative density**: No icon-circle triad; at most one subtle accent shape (a thin underline or dot) is permitted; no background illustration.
- **One slide, one number**: The archetype refuses multi-metric rows. For two or more metrics, switch to the numbers-row content pattern.
- **Verifiability**: Every metric must carry a source (footnote, footnote citation, or in-context label). Unverified numbers are flagged.
- **Editable target**: Native text boxes only; aim for Editability Ladder Level 5 (fully editable).
