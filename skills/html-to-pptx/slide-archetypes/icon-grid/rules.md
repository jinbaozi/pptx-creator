# Icon-grid archetype — role-aware rules

- **Title claim**: One clear title using `{typography.title}`; floor `fontSize >= 26pt`, `lineHeight >= 1.10`.
- **Tile count**: Exactly `4`-`8` tiles, organised in a `3x2`, `2x4`, or `2x2` grid. Below `4` or above `8` is rejected.
- **Tile icon**: One icon per tile using `{components.icon-circle}` or a simple SVG glyph; icon size `>= 32pt`. All icons must share the same weight, style, and stroke.
- **Tile label**: One short label per tile using `{typography.heading}`; floor `fontSize >= 14pt`. Maximum `32` characters per label.
- **Tile body**: Optional one-line sub-label using `{typography.caption}`; floor `fontSize >= 11pt`. Skip if the label alone is enough.
- **Tile spacing**: Inter-tile gap `>= {spacing.md}`; row gap `>= {spacing.md}`; page margins `>= {spacing.lg}`.
- **Whitespace**: Title to first row `>= {spacing.md}`; bottom margin reserved for footnote `>= {spacing.md}`.
- **Color discipline**: Icon uses `{colors.primary}`; labels use `{colors.text}`; sub-labels use `{colors.muted}`; total accents `<= 2`. No per-tile color cycling.
- **Font-family cap**: Distinct `font-family` count `<= 2`; tile labels must use the same family across all tiles.
- **Decorative density**: All tiles share the same shape (rounded rect or square) and same fill; no mixed tile shapes.
- **One tile, one idea**: No tile carries more than one icon or more than one sentence. Combine tiles rather than pack a single tile.
- **Editable target**: Native text boxes only; icons may use vector shapes; aim for Editability Ladder Level 4 (text + main shapes editable).
