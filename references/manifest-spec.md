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

v0.2 supports native-rendered `chart` elements with `kind: "bar"`. v0.3 also supports `line` and `pie`. The visual roadmap extension also accepts `stackedBar`, `horizontalBar`, `groupedBar`, `kpiGroup`, and `sparkline`; these newer kinds expand into editable primitive text, shape, and line elements before rendering:

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

Stacked and grouped charts use `series` values:

```json
{
  "type": "chart",
  "kind": "stackedBar",
  "id": "chart-workload",
  "x": 0.8,
  "y": 1.5,
  "w": 5.6,
  "h": 3.4,
  "data": [
    { "label": "Phase 1", "series": { "Dev": 30, "Test": 12, "Delivery": 8 } },
    { "label": "Phase 2", "series": { "Dev": 24, "Test": 18, "Delivery": 10 } }
  ],
  "style": {
    "palette": ["#36C5F0", "#7CFFB2", "#FFCF5A"],
    "showLegend": true,
    "showValues": true
  }
}
```

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

The visual roadmap extension supports semantic `diagram` elements. Diagrams compile to editable native shapes, lines, and text before rendering:

```json
{
  "type": "diagram",
  "kind": "layeredArchitecture",
  "id": "diagram-architecture",
  "x": 0.7,
  "y": 1.2,
  "w": 11.0,
  "h": 5.2,
  "layers": [
    { "label": "Frontend", "nodes": ["Lexer", "Parser", "Semantic Analysis"] },
    { "label": "Middle End", "nodes": ["IR", "Constant Propagation", "DCE", "CSE"] },
    { "label": "Backend", "nodes": ["Codegen", "Assembler", "Link Driver"] }
  ],
  "style": { "theme": "business-tech", "connector": "orthogonal" }
}
```

Supported diagram kinds are `layeredArchitecture`, `compilerPipeline`, `capabilityStack`, `swimlane`, and `matrixMap`.

M1.2 adds `scripts/html-to-manifest.mjs` to generate manifests from semantic HTML. See `references/html-to-pptx.md`.

M1.3 adds image inspection helpers that produce `image-hints.json` and `deck.manifest.skeleton.json` for host-agent completion. See `references/image-to-pptx.md`. Skeleton manifests may include `_skeleton: true` and placeholder text — remove before final validation.

Host agents must not include backend-specific PptxGenJS option names in the manifest.
