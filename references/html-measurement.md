# HTML measurement capability

This is an on-demand capability reference for the `html-replica` route. Agents should not load it for text, image, PDF, or manifest-repair work.

## Public workflow

```bash
npm run pptx -- html input.html output/html-replica
```

The route owns localization, browser measurement, manifest compilation, validation, rendering, proof, bounded repair, and packaging. Internal measurement and rendering modules are not alternate public workflows.

## Markup conventions

Stable semantic markers improve native reconstruction:

```html
<h1 data-pptx-kind="text" data-pptx-id="title">Title</h1>
<div data-pptx-kind="shape" data-pptx-id="card-1">...</div>
<table data-pptx-kind="table" data-pptx-id="metrics">...</table>
```

Supported kinds are `text`, `shape`, `card`, `table`, `line`, and `image`. Optional `data-typography`, `data-component`, and `data-color` values may reference the selected design system.

## Coordinate model

The default 1280×720 browser viewport maps to a 13.333×7.5 inch slide:

```text
x_in = px_x / 1280 * 13.333
y_in = px_y / 720 * 7.5
```

Each measured node records stable id, slide id, kind, pixel box, inch box, computed typography, paint, border, transform, clipping, and supported effect data.

## Security and determinism

- Author scripts and event handlers are stripped.
- Browser network requests are blocked.
- Remote images require `--allow-remote-assets`, are downloaded before measurement, and pass URL, DNS/IP, timeout, byte, and content-type checks.
- Animations and transitions are disabled.
- Fonts and images settle before boxes are read.
- Browser execution has one total timeout.

## Editability

Measured text, shapes, tables, and lines should remain native. Unsupported complex effects may use localized crops with an explicit fallback record. Full-slide rasterization is forbidden.

Use `npm run setup -- html` to verify the selected browser capability and `npm run test:browser` for its integration suite.
