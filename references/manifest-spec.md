# Manifest Spec

`deck.manifest.json` is the render-truth contract consumed by deterministic
rendering scripts. On the creative text route, the selected canonical
`semantic-slide-ir.json` is authoring truth and is lowered deterministically to
the manifest:

```text
deck.plan.json -> semantic-slide-ir.json -> deck.manifest.json -> PPTX
```

Direct and replica routes provide the manifest without producing Semantic IR.
The renderer never consumes Semantic IR directly. `run.json` is only an
artifact index: creative runs point to the canonical IR through
`artifacts.semanticIr` after successful packaging; it is not another source of
truth. Candidate evidence,
when a later stage produces it, must not replace the selected canonical IR.
The creative IR/run pair is committed only after packaging succeeds; hook or
package failure invokes best-effort compensating rollback before blocked state,
while the successful path does not invoke rollback.

Within the Creative Director Pipeline, the Host authors coordinate-free intent
and native-first semantic content; only deterministic lowering writes manifest
geometry. See `references/creative-intent.md` and
`references/semantic-slide-ir.md`. Direct and replica authors may provide a
manifest explicitly, but that does not change its renderer-facing role.

The breaking `0.2.0` contract requires:

- `version: "0.2.0"`
- `metadata.mode`: `direct | creative | replica | repair`
- `metadata.inputType`: `text | html | image | pdf | manifest | mixed`
- `metadata.qualityProfile`: `light | creative | replica`
- `designSystem.source`
- `designSystem.name`
- `deck.size`
- one or more slides

`designSystem` contains only theme source/name and optional tokens. Put optional
design intent, replica source, and generator provenance in `metadata`. Private
top-level `_...` fields and the removed `designSystem.mode` are invalid.

`metadata.designIntent.visibleGrid` is an optional boolean design-intent flag.
The creative plan compiler writes it explicitly and defaults it to `false`.
`false` prohibits a visible blueprint/graph-paper background; `true` permits
one but does not ask the renderer to synthesize it. Slide backgrounds remain
`solid`, `gradient`, or `image`; visible grids, when allowed, are explicit
manifest elements and remain subject to layout-safety checks.

HTML replica manifests store the localized source path and aggregate editable
layer coverage under `metadata.replicaSource`, for example
`{"type":"html","path":"source.html","coverage":{"coverage":1}}`.

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

Semantic connectors remain native `line` elements. Their coordinates describe
the rendered endpoints (`x`,`y` is the start; `x+w`,`y+h` is the end), while
the source/target contract lives in `connector`:

```json
{
  "type": "line",
  "role": "connector",
  "id": "connector-ingest-serve",
  "x": 3.0,
  "y": 2.0,
  "w": 2.0,
  "h": 0.0,
  "connector": {
    "sourceId": "ingest",
    "targetId": "serve",
    "sourceAnchor": "auto",
    "targetAnchor": "auto",
    "route": "straight"
  },
  "style": {
    "endArrowType": "triangle"
  }
}
```

`sourceId` and `targetId` must be supplied together and reference non-line
elements on the same slide. Anchors are `auto | top | right | bottom | left`;
routes are `straight | orthogonal`. Legacy manifests may keep these fields in
`style`; compilers normalize them into `connector` before writing new output.
Axis, divider, and decorative lines use
`role: axis | divider | decorative` and do not require endpoint metadata.
Horizontal or vertical lines may use a zero delta on one axis, but both deltas
cannot be zero. The compiler resolves connector coordinates after all layout
transforms so the manifest remains deterministic.

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

M1.3 adds image inspection helpers that produce `image-hints.json` and `deck.manifest.skeleton.json` for host-agent completion. See `references/image-to-pptx.md`. Skeleton provenance belongs in `metadata.generator`; placeholder text must be replaced before final delivery.

Host agents must not include backend-specific PptxGenJS option names in the manifest.
