# Manifest Spec

`deck.manifest.json` is the contract between host agent reasoning and deterministic rendering scripts.

M1.1 requires:

- `version: "0.1.1"`
- `designSystem.source`
- `designSystem.mode`
- `deck.size`
- one or more slides

Coordinates use inches and must fit inside `deck.size.width` and `deck.size.height`.

Element style values may reference DESIGN.md tokens:

- `{colors.primary}`
- `{typography.title}`
- `{components.hero-card}`

M1.1 supports:

- `text`
- `shape`
- `image`
- `table`
- `line`

v0.2 supports native-rendered `chart` elements with `kind: "bar"`. v0.3 also supports `line` and `pie`:

```json
{
  "type": "chart",
  "kind": "bar",
  "id": "chart-001",
  "x": 0.8,
  "y": 4.2,
  "w": 5.2,
  "h": 1.8,
  "data": [
    { "label": "Q1", "value": 12 },
    { "label": "Q2", "value": 18 }
  ],
  "style": { "color": "{colors.primary}" }
}
```

The renderer expands charts into native PPT shapes and editable labels. `pie` currently renders as editable proportional bars plus percent labels for reliable cross-suite editing.

v0.2 also supports native-rendered `icon` elements:

```json
{
  "type": "icon",
  "name": "check",
  "id": "status-check",
  "x": 0.8,
  "y": 1.2,
  "w": 0.4,
  "h": 0.4,
  "style": { "color": "{colors.primary}" }
}
```

Supported icon names: `check`, `x`, `info`, and `arrow-right`. The renderer expands icons into native PPT lines, shapes, and editable text.

M1.2 adds `scripts/html-to-manifest.mjs` to generate manifests from semantic HTML. See `references/html-to-pptx.md`.

M1.3 adds image inspection helpers that produce `image-hints.json` and `deck.manifest.skeleton.json` for host-agent completion. See `references/image-to-pptx.md`. Skeleton manifests may include `_skeleton: true` and placeholder text — remove before final validation.

Host agents must not include backend-specific PptxGenJS option names in the manifest.
