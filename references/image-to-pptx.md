# Image to PPTX (M1.3)

M1.3 adds deterministic image inspection helpers. Host agents still own visual understanding, text extraction, and editability decisions; scripts supply measurements and structured hints.

## When to use

- User provides a slide screenshot, exported PNG, or photo of a presentation page.
- Agent needs pixel dimensions, dominant palette, and inch-coordinate starting points.
- Agent will author `deck.manifest.json` manually (or semi-automatically) from visual analysis.

## When not to use

- Expecting fully automatic image → PPTX without host-agent reasoning (out of scope for M1.3).
- Defaulting to full-slide raster embed (violates editability rules).
- Arbitrary HTML/CSS layout measurement (defer to Playwright in M1.4+).

## Workflow

```text
Reference image
  -> python scripts/inspect-image.py <image>           # quick metadata
  -> python scripts/image-to-manifest-hints.py <image> <hints.json>
  -> host agent reads hints + visually inventories objects
  -> host agent writes deck.manifest.json (from manifestSkeleton)
  -> python scripts/validate-manifest.py deck.manifest.json
  -> node scripts/render-pptx.mjs deck.manifest.json output/final.pptx
```

## Object inventory (host agent)

Before writing the manifest, list detected objects:

```text
- Background (solid / image / gradient)
- Title and subtitles
- Body text blocks
- Cards / panels
- Tables
- Charts (often cropped-image in MVP)
- Icons and photos
- Lines / arrows
- Decorative patterns
```

Assign editability per object (see `references/editability-ladder.md`):

| Class | Manifest element |
| --- | --- |
| `native-text` | `text` |
| `native-shape` | `shape` |
| `native-table` | `table` |
| `native-line` | `line` |
| `cropped-image` | `image` (cropped asset) |
| `full-slide-raster-fallback` | last resort only |

## Coordinate conversion

Hints JSON includes `slideMapping` for 16:9 wide slides:

```text
inch_x = pixel_x / pxPerInX
inch_y = pixel_y / pxPerInY
```

Default preset `wide`: 13.333 × 7.5 inches. Match reference image aspect ratio when possible (1920×1080 recommended).

`layoutHints.regions` provides coarse horizontal bands (header/content/footer) with both `pixelBox` and `inchBox`. Refine per text block after visual inspection.

## Scripts

### `inspect-image.py`

Quick metadata:

- width/height, format, alpha channel
- 5–8 dominant palette colors
- OCR availability stub

```powershell
python scripts/inspect-image.py examples/image-input/business-slide.png
```

### `image-to-manifest-hints.py`

Full hints for manifest authoring:

- `slideMapping`, `palette`, `layoutHints`
- `designSystemSuggestion`
- `manifestSkeleton` with placeholder elements
- `hostAgentTasks` checklist
- `ocr` section (deferred unless Tesseract installed)

```powershell
python scripts/image-to-manifest-hints.py examples/image-input/business-slide.png examples/image-input/image-hints.json
```

## OCR (M1.5)

```powershell
python scripts/ocr-image.py reference.png -o output/ocr.json
```

- `status: ok` — Tesseract + pytesseract extracted `textBlocks` with `pixelBox` and confidence.
- `status: deferred` — use host-agent vision; exit code 2.

Host agent must verify OCR text; scripts do not rewrite content.

## Crop and preview (M1.5)

```powershell
python scripts/crop-assets.py reference.png crops.json output/assets
python scripts/render-preview.py output/final.pptx output/preview
python scripts/compare-preview.py reference.png output/preview/slide.png -o output/preview-diff.json
```

`crops.json` format: `[{"id":"icon-1","x":100,"y":200,"w":50,"h":50,"unit":"px"}]` or `{"crops":[...]}`.

## DESIGN.md rule

Image replication still requires a `DESIGN.md`. Use `designSystemSuggestion` from hints or pick a built-in system (`references/built-in-design-systems.md`). Set `designSystem.source` in the final manifest.

## Example

See `examples/image-input/`:

- `business-slide.png` — sample 1920×1080 slide
- `image-hints.json` — golden hints output
- `deck.manifest.skeleton.json` — starter manifest for host agent completion

## Quality targets

| Task type | Editability target |
| --- | --- |
| Image replication | Level 2–4 |
| Simple business slide | Level 3–4 (text + cards native) |

Report rasterized regions in `editable-report.md` with reasons.
