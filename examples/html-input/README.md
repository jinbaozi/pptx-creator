# HTML Input Examples

## Files

| File | Purpose |
| --- | --- |
| `one-page-dashboard.html` | Semantic auto-layout (M1.2) |
| `css-positioned-dashboard.html` | CSS + `data-pptx-kind` markers (M1.4) |
| `layout-measurements.json` | Golden Playwright measurements |
| `deck.manifest.json` | Pre-built manifest from semantic HTML |

## Semantic HTML pipeline

```powershell
cd pptx-creator
node scripts/html-to-manifest.mjs examples/html-input/one-page-dashboard.html output/html-semantic.manifest.json
node scripts/run-deck-pipeline.mjs output/html-semantic.manifest.json output/html-semantic
```

## CSS measurement pipeline

```powershell
npx playwright install chromium
node scripts/measure-html.mjs examples/html-input/css-positioned-dashboard.html output/layout-measurements.json
node scripts/html-to-manifest.mjs examples/html-input/css-positioned-dashboard.html output/html-css.manifest.json --measurements output/layout-measurements.json
node scripts/run-deck-pipeline.mjs output/html-css.manifest.json output/html-css
```

## Notes

- Playwright is required for live measurement; golden `layout-measurements.json` supports offline regression.
- See `references/html-to-pptx.md` and `references/html-measurement.md`.
