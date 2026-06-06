# DESIGN.md for PPTX Creator

`DESIGN.md` is the source of truth for visual identity, design tokens, layout rules, component styles, and PPTX export rules.

Lookup priority:

1. User-provided `DESIGN.md`.
2. Project-root `DESIGN.md`.
3. Input-adjacent `DESIGN.md`.
4. Built-in `design-systems/<name>/DESIGN.md`.
5. `design-systems/business-neutral/DESIGN.md`.

`deck.manifest.json` should reference the selected design system:

```json
{
  "designSystem": {
    "source": "design-systems/business-neutral/DESIGN.md",
    "name": "Business Neutral",
    "mode": "balanced"
  }
}
```

Use token references in element styles:

```json
{
  "style": {
    "typography": "{typography.title}",
    "color": "{colors.primary}"
  }
}
```

The renderer expands token references before calling the PPTX backend.
