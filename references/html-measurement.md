# HTML DOM Measurement (M1.4)

M1.4 adds Playwright-based DOM measurement for CSS-positioned HTML visual drafts. Host agents still own semantic structure; measurement scripts extract real bounding boxes for manifest coordinates.

## When to use

- HTML uses CSS absolute/flex/grid positioning without explicit `data-x/y/w/h`.
- Agent wants accurate inch coordinates from rendered layout.
- Combining M1.2 semantic mapping with browser-measured positions.

## When not to use

- Semantic HTML with auto-layout cards (M1.2 alone is sufficient).
- Environments without Playwright Chromium installed.
- Full-page screenshot fallback (still violates editability rules).

## Markup conventions

Mark measurable elements with stable ids and kinds:

```html
<h1 data-pptx-kind="text" data-pptx-id="title">Title</h1>
<div class="card" data-pptx-kind="card" data-pptx-id="card-1">...</div>
<table data-pptx-kind="table" data-pptx-id="metrics-table">...</table>
```

Supported `data-pptx-kind` values:

| Kind | Manifest output |
| --- | --- |
| `text` | `text` element |
| `shape` | `shape` element |
| `card` | `shape` + inner text |
| `table` | `table` element |
| `line` | `line` element |
| `image` | `image` element (requires `src`) |

Optional attributes:

- `data-typography`: typography token key (`h1`, `subtitle`, `body`, …)
- `data-component`: shape component token
- `data-color`: text color token

## Viewport and coordinate mapping

Default viewport: **1280 × 720 px** (16:9) maps to slide **13.333 × 7.5 in**.

```text
x_in = px_x / viewport_width * slide_width
y_in = px_y / viewport_height * slide_height
```

Override via CLI flags on `measure-html.mjs`:

```powershell
node scripts/measure-html.mjs input.html output/layout-measurements.json `
  --viewport-width 1280 --viewport-height 720
```

## Workflow

### 1. Measure rendered HTML

```powershell
cd pptx-creator
npm install
npx playwright install chromium
node scripts/measure-html.mjs examples/html-input/css-positioned-dashboard.html examples/html-input/layout-measurements.json
```

Output: `layout-measurements.json` with inch + pixel boxes per `data-pptx-id`.

### 2. Convert HTML + measurements → manifest

```powershell
node scripts/html-to-manifest.mjs examples/html-input/css-positioned-dashboard.html output/deck.manifest.json `
  --measurements examples/html-input/layout-measurements.json
```

When measurements are provided and slides contain `[data-pptx-kind]` elements, the adapter uses measured coordinates instead of auto-layout.

### 3. Validate and render (M1.1)

```powershell
python scripts/validate-manifest.py output/deck.manifest.json
node scripts/render-pptx.mjs output/deck.manifest.json output/final.pptx
```

## Measurement JSON schema

```json
{
  "version": "0.1.0",
  "source": "examples/html-input/css-positioned-dashboard.html",
  "slideSize": { "preset": "wide", "width": 13.333, "height": 7.5, "unit": "in" },
  "viewport": { "width": 1280, "height": 720 },
  "elements": [
    {
      "id": "title",
      "kind": "text",
      "x": 0.938,
      "y": 0.438,
      "w": 11.458,
      "h": 0.604,
      "px": { "x": 90, "y": 42, "w": 1100, "h": 58 }
    }
  ]
}
```

## Setup and CI

- `node scripts/setup.mjs` reports Playwright Chromium availability.
- Unit tests for px→inch conversion and manifest merge always run.
- Playwright integration tests skip by default; set `PLAYWRIGHT_RUN=1` locally when Chromium is installed.

Install Playwright browser:

```powershell
npx playwright install chromium
```

## Host agent responsibilities

- Add `data-pptx-kind` and `data-pptx-id` to elements that need measured coordinates.
- Keep slide canvas aspect ratio aligned with viewport (16:9 recommended).
- Review merged manifest coordinates before rendering.
- Rasterize only complex decorative regions as `image` assets.

## Editability target

CSS measurement workflow should reach Level 3–5. Prefer native text, shapes, and tables with measured boxes — not full-slide rasterization.
