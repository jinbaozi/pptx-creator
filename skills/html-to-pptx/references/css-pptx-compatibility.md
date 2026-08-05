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
| Layered backgrounds | Ordered native layers | Solid base plus parser-supported linear/radial gradients, alpha, local URL images, per-side borders, and one outer shadow retain CSS paint order; non-centred radial gradients also emit a bounded glow ellipse |
| Supported linear and radial gradients | Native gradient fill | Only parser-supported stop and direction forms are native; multiple layers are emitted independently |
| Single outer `box-shadow` | Native shape shadow | Unsupported multi-shadow syntax is a local fallback |
| Single `drop-shadow(...)` filter | Native shadow | Other filter functions are not native |
| `<img>` and CSS background images | Native image objects | `cover`, `contain`, object position, crop, opacity, and local assets are supported |
| SVG Tier A: ungrouped simple primitives | Native editable shapes, lines, and text | `rect`, `circle`, `ellipse`, `line`, stroke-only `polyline`/`polygon`, simple paths, and `text` with safe transforms/paint |
| SVG Tier B: explicitly grouped simple primitives | Native editable `<p:grpSp>` with stable direct children | Declare a stable group ID and stable drawable IDs; child order and connector ownership are preserved |
| SVG Tier C: filled/curved or otherwise complex self-contained SVG | SVG vector image (`ppt/media/*.svg`) | Safe vector media is preserved as one asset; filters, masks, clipping/compositing, scripts, external references, or traversal are localized to a bounded raster crop |
| Self-contained complex SVG without filters, masks, scripts, or external references | SVG vector image (`ppt/media/*.svg`) | The manifest records `vectorPreserved: true`; this is an editable-slide asset but not an editable SVG object |
| Semantic SVG connectors | Native lines with arrowheads | Declare `data-pptx-kind="line"`, `data-pptx-id`, and source/target IDs |
| Explicit `data-pptx-kind="group"` | Native editable `<p:grpSp>` container | Give the group a stable `data-pptx-id`; only stable descendant IDs become flat, direct children in paint order. `data-pptx-background="grid"` is the sole approved grid marker and must use the background role |
| HTML tables | Native editable tables | Cell text, fills, borders, alignment, and header styling are retained within the supported model |
| `data-pptx-chart` marker with `renderMode` `native` or `semantic` | Native editable chart objects | Supported kinds: `stackedBar`, `groupedBar`, `horizontalBar`, `line`, `area`, and single-series `lineArea`; `kpiGroup` and `sparkline` remain fidelity-first primitives |
| Legacy `data-pptx-chart` marker without `renderMode` | Fidelity-first editable primitives | `stackedBar`, `groupedBar`, `horizontalBar`, `kpiGroup`, and `sparkline` remain supported; new `line`, `area`, and `lineArea` markers require an explicit native/semantic mode |
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
editability impact. The default native-object coverage gate requires at least
`0.90`; strict additionally evaluates semantic coverage.

Safe complex SVG is not rasterized: it remains an SVG media part and is
counted separately as `vectorPreserved` in renderer counters. PPTX may include
the Office-required PNG compatibility blip alongside the SVG; the SVG
relationship remains authoritative and the region is never treated as a
full-slide raster fallback.

### Semantic editability weights

`editable-report.json` version 2.0.0 computes clipped per-slide region unions
without counting overlaps twice. A native structured group contributes once;
its owned children are evidence only and do not add area again. The deterministic
weights are:

| Classification | Weight |
|---|---:|
| Native text, shape, line, table, chart, or photo | 1.00 |
| Structured native group | 0.95 |
| Decorative SVG | 0.80 |
| Text-bearing SVG | 0.40 |
| Chart or architecture SVG | 0.20 |
| Cropped/local raster fallback | 0.00 |

SVG semantic classes come only from explicit DOM/measurement/manifest metadata,
not image-pixel guesses. Use `data-pptx-semantic="chart|architecture|text-bearing|decorative"`,
`data-pptx-kind="chart|architecture"`, or `data-pptx-text-bearing="true"` on
complex SVG roots when primitives alone do not establish the class. Coverage
evidence records the clipped box, area, weight, z-order, and visible contribution;
`nativeCoverage` is retained only as an equal-valued deprecated alias.

### Strict component visual QA

Opt a stable key region into deterministic local visual comparison with
`data-pptx-visual-key="true"`. Native charts and explicit groups are also
eligible; `pre`/`code` blocks are eligible when they have stable IDs. The
converter writes `component-regions.json`, crops source and LibreOffice images
without resizing, and emits `component-diff/` plus `components/summary.json`.
The `replica-strict` profile requires every key component to pass SSIM `>= 0.94`
and normalized MAE `<= 0.05`; missing keys, illegal IDs/paths, duplicate IDs,
invalid slide indices, and fully out-of-bounds boxes fail the component gate.

The converter rejects a fallback that covers the full slide or effectively
matches slide geometry. It never uses an entire slide screenshot as the editable
delivery.

## Known boundaries

- Author JavaScript and event handlers do not run.
- Remote assets are disabled by default; explicitly authorized image assets are
  downloaded, content-sniffed, size-limited, and localized.
- Video, audio, canvas animation, WebGL, CSS blend modes, complex filters, and
  arbitrary SVG paths do not have complete native mappings. Unsafe SVGs are
  explicitly routed to local raster fallback; self-contained Tier-C SVGs use
  vector preservation instead.
- `::before`/`::after` quoted text, a solid dot/rect/circle, one border side, a
  simple linear/radial gradient, or one outer shadow is materialized as a
  generated native element (`<owner>-before`/`<owner>-after`,
  `data-pptx-generated="true"`). Unsupported pseudo filters, masks, blending,
  complex clipping, multiple shadows/borders, or other effects use a local
  crop of the pseudo bounds; the owner remains native and editable.
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
    "renderMode":"native",
    "data":[
      {"label":"文字","value":96},
      {"label":"形状","value":93}
    ],
    "style":{"palette":["#2563eb","#14b8a6"],"showValues":true}
  }'>
</div>
```

Native chart data must be a non-empty array of points with a `label` and either
one finite numeric `value` or a consistent, non-empty `series` object across all
points. `lineArea` currently requires one series. Invalid JSON, an unsupported
kind, empty or non-finite data, inconsistent series keys, or missing stable
measurement fails with `E_CHART_MARKER`; legacy kinds without `renderMode`
remain fidelity-first primitives, while new line/area kinds without a native
mode fail deterministically. A decorative SVG or preview graphic without
`data-pptx-chart` is never inferred as a chart.

## Authoring explicit groups

Use groups only when the source explicitly declares a stable group ID and the
children already have stable IDs. The renderer writes the group after all
normal PPTX patches, preserving child object XML, chart relationships, and
paint order. Groups are flat: nested groups, missing or duplicate children,
and interleaved children are rejected. For inline SVG groups without a direct
browser box, the measured union of descendant boxes supplies group geometry;
the source group and every drawable child still need stable IDs. The group
wrapper is not a second layout or editability object; its declared or measured
`x`, `y`, `w`, and `h` become the group transform while child geometry remains
independently editable.

```html
<div
  data-pptx-kind="group"
  data-pptx-id="background-grid"
  data-pptx-background="grid"
  data-role="background">
  <div data-pptx-kind="line" data-pptx-id="grid-line-1"></div>
  <div data-pptx-kind="line" data-pptx-id="grid-line-2"></div>
</div>
```

Repeated lines without the explicit `grid` marker remain a blocking
`decorative-grid` finding. Structure and geometry reports verify the group,
direct child IDs/order, transforms, and one top-level object for an explicit
grid.
