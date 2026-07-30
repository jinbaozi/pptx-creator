# Quote archetype — role-aware rules

- **Quote claim**: One quoted statement using `{typography.quote}` or `{typography.title}`; floor `fontSize >= 32pt`, `lineHeight >= 1.15`. Maximum `240` characters; longer quotes must be split or paraphrased.
- **Attribution**: Speaker name uses `{typography.subtitle}`; floor `fontSize >= 14pt`, `lineHeight >= 1.30`. Role / affiliation uses `{typography.caption}`; floor `fontSize >= 11pt`.
- **Attribution separator**: Attribution sits below the quote with `>= {spacing.lg}` gap; a short em-dash or line break separates name from role.
- **Whitespace**: Page margins `>= {spacing.xl}` (generous); quote sits centred or biased 30% from top; bottom margin reserved for attribution `>= {spacing.md}`.
- **Color discipline**: Quote text uses `{colors.text}` or `{colors.primary}`; attribution uses muted token (`{colors.muted}` or `{colors.secondary}`); total accents `<= 2`.
- **Font-family cap**: Distinct `font-family` count `<= 2`; the quote may use a serif display family only if the design system explicitly permits it.
- **Decorative density**: At most one large open-quote glyph (`"`) as decoration; no icon-circle triad; no background illustration.
- **No body copy**: The archetype refuses paragraphs beside the quote — one quote per slide.
- **Verifiability**: Attribution must be a real, identifiable source. Anonymous quotes are rejected unless explicitly flagged as illustrative.
- **Editable target**: Native text boxes only; aim for Editability Ladder Level 5 (fully editable).
