# CSS to PPTX compatibility

The converter measures the browser's computed layout, then maps supported
visual semantics to native PowerPoint objects. CSS is not a PowerPoint object
model, so support is intentionally bounded and every fallback is explicit.

## Native mappings

| HTML or CSS surface | PowerPoint result | Notes |
|---|---|---|
| Headings, paragraphs, spans, lists | Native text boxes | Font family, size, weight, style, color, alignment, line height, transform, opacity, and measured wrapping are materialized |
| Solid backgrounds | Native shapes | Rectangles, rounded rectangles, and ellipses are inferred from measured geometry |
| Borders and outlines | Native shape borders or native lines | Per-side borders are emitted as separate lines when needed |
| Supported linear and radial gradients | Native gradient fill | Only parser-supported stop and direction forms are native |
| Single outer `box-shadow` | Native shape shadow | Unsupported multi-shadow syntax is a local fallback |
| Single `drop-shadow(...)` filter | Native shadow | Other filter functions are not native |
| `<img>` and CSS background images | Native image objects | `cover`, `contain`, object position, crop, opacity, and local assets are supported |
| Safe SVG `rect`, `circle`, `ellipse`, `line`, stroke-only `polyline`/`polygon`, simple paths, and `text` | Native editable shapes, lines, and text | Safe group `translate`/`scale`/`rotate`, inherited paint, and opacity are materialized; filled/curved paths remain vector media |
| Self-contained complex SVG without filters, masks, scripts, or external references | SVG vector image (`ppt/media/*.svg`) | The manifest records `vectorPreserved: true`; this is an editable-slide asset but not an editable SVG object |
| Semantic SVG connectors | Native lines with arrowheads | Declare `data-pptx-kind="line"`, `data-pptx-id`, and source/target IDs |
| HTML tables | Native editable tables | Cell text, fills, borders, alignment, and header styling are retained within the supported model |
| `data-pptx-chart` marker | Native editable chart primitives | Supported kinds: `stackedBar`, `groupedBar`, `horizontalBar`, `kpiGroup`, and `sparkline` |
| Layer order | Native object order | Derived from browser stacking and deterministic manifest order |
| `data-notes` | PPTX speaker notes | Notes stay outside the audience view |

Flexbox, Grid, normal flow, and absolute positioning are accepted as browser
layout mechanisms. They are not recreated as PowerPoint layout engines; their
settled geometry is converted to fixed slide coordinates.

## Localized raster fallback

The following effects may require a crop of only the affected region:

- unsupported filters or multiple shadows;
- `backdrop-filter`;
- `clip-path` or masks;
- unsupported background-image syntax;
- browser visual content without a stable native mapping;
- unsafe SVG effects (filters, masks, clipping/compositing, scripts, or external/path-traversal references).

Each raster crop becomes a `cropped-asset` element and an entry in
`fallback-ledger.json` containing the slide, component, geometry, reason, and
editability impact. The native coverage gate requires at least `0.90`.

Safe complex SVG is not rasterized: it remains an SVG media part and is
counted separately as `vectorPreserved` in renderer counters. PPTX may include
the Office-required PNG compatibility blip alongside the SVG; the SVG
relationship remains authoritative and the region is never treated as a
full-slide raster fallback.

The converter rejects a fallback that covers the full slide or effectively
matches slide geometry. It never uses an entire slide screenshot as the editable
delivery.

## Known boundaries

- Author JavaScript and event handlers do not run.
- Remote assets are disabled by default; explicitly authorized image assets are
  downloaded, content-sniffed, size-limited, and localized.
- Video, audio, canvas animation, WebGL, CSS blend modes, complex filters,
  arbitrary SVG paths, and pseudo-element-only content do not have complete
  native mappings. Unsafe SVGs are explicitly routed to local raster fallback;
  self-contained complex SVGs use vector preservation instead.
- Browser font metrics and Office font metrics can differ. Read
  `font-and-office.md` and inspect `font-report.json`.
- PowerPoint has no direct equivalent for arbitrary DOM clipping, CSS
  compositing, or responsive reflow.
- The converter preserves the measured desktop layout. It does not translate
  responsive behavior into PowerPoint.

When visual fidelity and editability conflict, prefer a native object when the
render difference remains within the gate. Use a localized crop only when a
stable native approximation is not reasonable, and record the cost.

## Authoring connectors

For an editable connector:

```html
<line
  data-pptx-kind="line"
  data-pptx-id="connector-a-b"
  data-source-id="node-a"
  data-target-id="node-b"
  x1="414" y1="261" x2="466" y2="261"
  stroke="#2563eb"
  stroke-width="4"
  marker-end="url(#arrow)">
</line>
```

The geometry audit checks connector endpoints, direction, bounds, and node
intersection. A decorative SVG line without stable semantics may still convert
as a line, but it cannot prove the intended node relationship.

## Authoring native charts

Use valid JSON in `data-pptx-chart`:

```html
<div
  data-pptx-kind="chart"
  data-pptx-id="chart-001"
  data-pptx-chart='{
    "kind":"horizontalBar",
    "data":[
      {"label":"文字","value":96},
      {"label":"形状","value":93}
    ],
    "style":{"palette":["#2563eb","#14b8a6"],"showValues":true}
  }'>
</div>
```

Invalid JSON, an unsupported kind, empty data, or missing stable measurement
fails with `E_CHART_MARKER`. Do not infer chart data from decorative pixels.
