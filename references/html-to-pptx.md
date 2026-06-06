# HTML to PPTX (M1.2)

M1.2 adds a deterministic HTML → `deck.manifest.json` adapter. Host agents still own visual reasoning; the adapter maps semantic HTML to manifest elements for the M1.1 renderer.

## When to use

- User provides a single-page HTML or SVG-derived HTML visual draft.
- Agent has already structured content into headings, cards, and tables.
- Agent wants a repeatable script step instead of hand-authoring manifest coordinates.

## When not to use

- Arbitrary CSS layouts requiring browser measurement → use M1.4 `measure-html.mjs` (see `references/html-measurement.md`).
- Full-page screenshot fallback (violates editability rules).
- Complex SVG paths, filters, or gradients (rasterize as images in manifest).

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
| simple `svg path` | `line` | Only single `M ... L ...` paths with `data-x/y/w/h` on parent `svg` |

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

## Workflow

```bash
node scripts/html-to-manifest.mjs examples/html-input/one-page-dashboard.html output/deck.manifest.json
python scripts/validate-manifest.py output/deck.manifest.json
node scripts/render-pptx.mjs output/deck.manifest.json output/final.pptx
python scripts/package-output.py output
```

## Editability target

HTML conversion should reach Level 3–5 on the editability ladder. Prefer native text, shapes, and tables. Do not rely on full-slide rasterization.

## Host agent responsibilities

- Choose the correct built-in `DESIGN.md` or provide a custom one.
- Keep HTML semantic and reasonably structured.
- Add `data-x/y/w/h` when auto-layout is insufficient.
- Rasterize only complex decorative regions as `image` assets.
- Review `editable-report.md` after rendering.
