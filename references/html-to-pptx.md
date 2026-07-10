# HTML to PPTX (M1.2)

M1.2 adds a deterministic HTML → `deck.manifest.json` adapter. Host agents still own visual reasoning; the adapter maps semantic HTML to manifest elements for the M1.1 renderer.

## When to use

- User provides a single-page HTML or SVG-derived HTML visual draft.
- Agent has already structured content into headings, cards, and tables.
- Agent wants a repeatable script step instead of hand-authoring manifest coordinates.

## When not to use

- Arbitrary CSS layouts requiring browser measurement → use M1.4 `measure-html.mjs` (see `references/html-measurement.md`).
- Full-page screenshot fallback (violates editability rules).
- Complex SVG paths, filters, or gradients beyond the strict replica native mappings below.

## HTML conventions

### Deck root

```html
<div class="pptx-deck"
     data-design-system="dashboard-data"
     data-deck-title="运营数据看板"
     data-language="zh-CN">
  <section class="pptx-slide" data-type="dashboard">...</section>
</div>
```

- `data-design-system`: built-in design system id (see `references/built-in-design-systems.md`).
- `data-deck-title`: manifest `deck.title`.
- `data-language`: manifest `deck.language`.

### Slides

- One or more `<section class="pptx-slide">` or `[data-slide]` children.
- Multi-slide HTML is supported; each slide section becomes one manifest slide.
- Oversized semantic card grids auto-paginate by default. Use `--no-auto-paginate` when exact single-slide output is required.
- Semantic conversion is content-loss safe: every heading, paragraph, list item, metric, and table cell must appear in the manifest. Conversion fails below 100% coverage unless `--allow-content-loss` is explicitly supplied.

### Semantic mapping

| HTML | Manifest | Notes |
| --- | --- | --- |
| `h1` | `text` + `{typography.title}` | Slide title |
| `.subtitle`, `[data-subtitle]` | `text` + `{typography.subtitle}` | Deck subtitle |
| `h2`, `h3` | `text` + `{typography.heading}` | Section headings |
| `p`, `li` | `text` + `{typography.body}` or `{typography.caption}` | Body copy |
| `.metric`, `[data-metric]` | `text` + `{typography.metric}` | Large numbers |
| `.card`, `[data-card]` | `shape` + inner `text` | Uses `{components.content-card}` |
| `.cards[data-cols]` | auto 2×N grid layout | Deterministic inch coordinates |
| `table` | `table` | Headers from `thead th` |
| `hr` | `line` | Divider |
| `img` | `image` | Requires `data-x/y/w/h` and existing asset path |
| simple `svg path` | `line` | Single `M ... L ...` paths with parent `data-x/y/w/h` and `viewBox`; preserves hex `stroke` and numeric `stroke-width` |
| simple `svg line` | `line` | Parent `svg` needs `data-x/y/w/h` and `viewBox`; preserves hex `stroke` and numeric `stroke-width` |
| simple `svg polyline` | multiple `line` elements | Parent `svg` needs `data-x/y/w/h` and `viewBox`; preserves hex `stroke`, numeric `stroke-width`, and opacity per segment |
| stroke-only `svg polygon` | closed multiple `line` elements | Parent `svg` needs `data-x/y/w/h` and `viewBox`; only `fill="none"`/transparent polygons are converted to avoid dropping filled areas |
| simple `svg circle` / `rect` | `shape` | Parent `svg` needs `data-x/y/w/h` and `viewBox`; preserves hex `fill`, `stroke`, and numeric `stroke-width`; `rect rx/ry` maps to native `roundRect` |
| simple `svg text` | `text` | Parent `svg` needs `data-x/y/w/h` and `viewBox`; preserves text, hex `fill`, opacity, numeric `font-size`, `font-family`, `font-weight`, `font-style`, `text-decoration`, and `text-anchor=start/middle/end`; complex `tspan`/baseline layout is not expanded |

### Explicit coordinates (optional)

Any element may include inch-based coordinates:

```html
<h1 data-x="0.7" data-y="0.6" data-w="12" data-h="0.8">Title</h1>
```

When omitted, the adapter applies deterministic auto-layout.

### Advanced explicit elements

```html
<div data-pptx-type="text" data-x="1" data-y="1" data-w="4" data-h="0.5" data-typography="body">Label</div>
```

Supported `data-pptx-type` values: `text`, `shape`, `table`, `line`, `image`.

### CSS measurement markers (M1.4)

For CSS-positioned layouts, add kind/id markers and run Playwright measurement:

```html
<h1 data-pptx-kind="text" data-pptx-id="title">Title</h1>
<div class="card" data-pptx-kind="card" data-pptx-id="card-1">...</div>
```

See `references/html-measurement.md` for the full measure → merge workflow.

## Guarded replica workflow

```bash
npm run pptx -- html examples/html-input/one-page-dashboard.html output/html
```

The command localizes explicitly allowed remote assets, measures the unchanged source, compiles the Manifest, and then follows the single six-stage pipeline. Chromium audits the HTML without running author scripts or network requests. Critical source or proof failures block packaging; the source HTML is never rewritten before proof.

Use the same public command for local files:

```bash
npm run pptx -- html input.html output/html
```

### Connector contract

Use an SVG `line`, `polyline`, or simple `M … L …` path. Complex curves and multi-branch connectors are unsupported in the first guarded version.

```html
<path data-connector
      data-pptx-kind="line"
      data-pptx-id="flow-a-b"
      data-source-id="card-a"
      data-target-id="card-b"
      marker-end="url(#arrowhead)"
      d="M 0 0 L 100 0" />
```

The auditor verifies both endpoints against declared node boundaries and verifies arrow direction. HTML conversion preserves `sourceId`, `targetId`, arrowheads, stroke color, width, and dash style in the native Manifest line.

## Strict replica workflow

Use replica mode when the user asks for HTML to be visually preserved instead of redesigned. Replica mode is native-first: browser measurements provide real DOM boxes and computed styles, then the manifest emits editable PPT text, shapes, tables, lines, and images wherever PowerPoint can represent them.

```bash
npm run pptx -- html input.html output/html
```

Replica extraction currently maps:

| Browser source | PPTX output | Editability |
| --- | --- | --- |
| slide/body solid background | native slide background color | high |
| visible text nodes | native `text` elements with measured CSS color, font, size, weight, alignment, and line height | high |
| direct text fragments inside mixed inline elements | separate native `text` layers measured with DOM Range boxes | high |
| explicit HTML text breaks (`<br>`) | native multiline `text` content with measured line height | high |
| CSS `white-space` text newlines (`pre`, `pre-line`, `pre-wrap`, `break-spaces`) | native multiline `text` content with measured line height | high |
| supported `text-transform` (`uppercase`, `lowercase`, `capitalize`) | transformed native PPT text content | high |
| supported `font-variant-caps` (`small-caps`, `all-small-caps`) | native PPT small-caps text run property | high |
| supported text decorations (`underline`, `line-through`) | native PPT underline/strike text options | high |
| CSS `-webkit-text-fill-color`, including alpha | native PPT text fill color and transparency, separate from stroke/color fallback | high |
| CSS `-webkit-text-stroke`, including alpha | native editable PPT text outline with stroke transparency | high |
| logical text alignment (`text-align:start/end` with CSS `direction`) | native PPT left/right text alignment | high |
| CSS RTL text direction (`direction:rtl`) | native editable PPT RTL paragraph text | high |
| CSS vertical `writing-mode` (`vertical-rl`, `vertical-lr`, `sideways-*`) | native editable PPT vertical text body | high |
| CSS `text-indent` | native editable PPT first-line paragraph indent | high |
| single-line CSS ellipsis (`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`) | editable PPT text containing the measured visible ellipsis text | medium |
| CSS list item markers (`display:list-item`, `list-style-type:disc/circle/square`) | native PPT bullet text, preserving editable text content | high |
| text `letter-spacing` | native PPT character spacing | high |
| text padding | native PPT text box margins | high |
| CSS `opacity` and `rgba()` alpha on text, fills, and borders | native PPT text/fill/stroke transparency | high |
| CSS `opacity` on `img` elements | native PPT image transparency | medium |
| single CSS `text-shadow` with px offsets and `rgb`/`rgba`/hex color | native PPT text shadow approximation | high |
| single CSS `filter: drop-shadow(...)` on text, shapes, or images | native PPT outer shadow approximation while preserving native editability | medium |
| flex-centered direct text (`align-items`, `justify-content`) | native PPT text horizontal/vertical alignment | high |
| 2D CSS rotation from `transform` | native PPT `rotate` on text, shapes, and images | high |
| element backgrounds and borders, including dashed/dotted border style | native `shape` elements with PPT line dash presets | high |
| CSS `outline` with px width/style/color/offset on boxes, text, and images | native transparent `shape` outline overlay | medium |
| fully rounded CSS boxes (`border-radius: 50%` or equivalent per-corner radius) | native PPT `ellipse` shapes | high |
| uniform CSS box corner radius from shorthand or equal per-corner radii | native PPT `roundRect` shapes | high |
| simple two-or-more-stop slide `linear-gradient(<deg>|to <side-or-corner>, <color> [<pos>], ...)` backgrounds | native editable PPT slide background gradient fills | high |
| simple two-or-more-stop element `linear-gradient(<deg>|to <side-or-corner>, <color> [<pos>], ...)` backgrounds | native editable PPT gradient fills on shape elements | high |
| centered two-or-more-stop `radial-gradient([circle|ellipse] at center, <color> [<pos>], ...)` backgrounds | native editable PPT path gradient fills on slide backgrounds and shape elements | high |
| single CSS element background image `url(...)` with `background-size:cover/contain/100% 100%`, explicit px/% size with optional single-axis `auto`, or fitting local `auto` intrinsic size, percent/keyword/px `background-position` including simple edge offsets, and `background-repeat:no-repeat` | native PPT `image` layer behind measured child content | medium |
| single CSS element background image `url(...)` with exact `background-repeat:repeat-x/repeat-y/repeat` tiling, no clipping, and at most 24 native tiles | multiple native PPT `image` layers behind measured child content | medium |
| fully rounded CSS background images (`border-radius:50%` or equivalent radius) | native PPT rounded/ellipse `image` layer | medium |
| uniform rounded CSS background images from shorthand or equal per-corner radii | native PPT `roundRect` image geometry behind measured child content | medium |
| single-side CSS borders (`border-top/right/bottom/left`) without fill | native PPT `line` elements at the measured edge | high |
| asymmetric side borders on filled rectangular boxes | native fill `shape` plus editable PPT `line` overlays at measured edges | high |
| single outer `box-shadow` with px offsets and `rgb`/`rgba`/hex color | native PPT shadow approximation on the shape | high |
| numeric `z-index` on measured elements | PPT layer order, with higher z-index emitted later/on top | high |
| `img` with supported `object-fit` (`cover`, `contain`) and percent/keyword `object-position` for `cover` crops | native `image` elements with PPT image sizing/crop, localized by `html-to-manifest.mjs` for remote URLs | medium |
| fully rounded `img` elements (`border-radius:50%` or equivalent radius) | native PPT rounded/ellipse `image` layer with editable sizing/crop | medium |
| uniform rounded `img` elements from shorthand or equal per-corner radii | native PPT `roundRect` image geometry with editable sizing/crop | medium |
| `img` with simple CSS border and radius | native editable transparent `shape` border overlay above the image | medium |
| `img` with single outer CSS `box-shadow` | native PPT image shadow approximation | medium |
| `table` with stable id and measured table-level CSS background, border, text color, and font size | native editable `table` element with matching fill, border, and typography | high |
| `hr` or measured line nodes | native `line` elements | high |
| simple SVG `line`, `polyline`, stroke-only `polygon`, `M ... L ...` paths, `circle`, `ellipse`, `rect`, and `text` primitives with parent `data-x/y/w/h` and `viewBox` | native editable PPT `line`, `ellipse`, `rect`, `roundRect`, and `text` elements with matching fill/stroke/font/opacity where supported | high |

Unsupported CSS/SVG effects such as non-`drop-shadow(...)` filters, backdrop filters, clipping, multiple/inner shadows, complex gradients, non-centered radial gradients, repeated/multiple background images, unsupported background sizing, and complex SVG paths or SVG effects are reported as `replica-unsupported-effect` findings by the visual critic. Do not silently replace a strict replica with a full-slide screenshot. If a browser-only effect must be rasterized for visual fidelity, rasterize only that local region and keep the rest native/editable.

The converter returns replica coverage as side-channel conversion metadata rather than a private manifest field. Coverage below `1.0` means some measured DOM nodes were not represented as native PPT layers; the visual critic reports per-slide incomplete coverage as `replica-coverage`.

## Editability target

HTML conversion should reach Level 3–5 on the editability ladder. Replica mode should prefer Level 4–5 for ordinary DOM text, boxes, tables, and images. Do not rely on full-slide rasterization.

## Host agent responsibilities

- Choose the correct built-in `DESIGN.md` or provide a custom one.
- Keep HTML semantic and reasonably structured.
- Use a 1280×720 `.pptx-slide` canvas for generated creative HTML.
- Add globally unique measurement ids and connector metadata when auto-layout is insufficient.
- Treat content-coverage or layout-safety failures as authoring errors; repair the HTML or manifest instead of silently dropping content or shrinking boxes.
- Rasterize only complex decorative regions as `image` assets.
- Review `editable-report.md` after rendering.
