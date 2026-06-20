# Image to PPTX

Image replication uses deterministic helpers plus host-agent visual reasoning. Scripts supply measurements, structured hints, replica analysis, and layer planning. Host agents still own visual understanding, exact text verification, component reconstruction, and final editability decisions.

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
  -> node scripts/image-to-manifest.mjs --input <image> --output <out-dir>     # unified wrapper
       (auto-detects creative hints flow or replica flow via --mode)
  -> host agent reads hints + analysis + layer plan, then inventories objects
  -> host agent writes deck.manifest.json (from manifestSkeleton)
  -> python scripts/validate-manifest.py deck.manifest.json
  -> node scripts/render-pptx.mjs deck.manifest.json output/final.pptx
  -> python scripts/compare-preview.py <image> <rendered-slide.png> -o <visual-report.json>
```

Both flows are first-class. The unified wrapper (`scripts/image-to-manifest.mjs`)
auto-detects between them:

- `--mode creative` (default) → calls `image-to-manifest-hints.py`. Fast and
  deterministic; designed for design-first or single-image creative decks.
- `--mode replica` → calls `image-replica-analyze.py` and
  `image-replica-plan.py`. Targets higher-fidelity reconstruction and Level 3-4
  editability; honors `--ocr-confidence` (calibrated in U10).
- `--mode auto` → same as creative for v1; reserved for future heuristic
  detection (low color variance, text-heavy).

Pass a directory of PNGs as `--input` to enable the multi-image flow: each
PNG becomes one slide, with consistent `designSystem` and `deck.size` across
the deck. Per-image artifacts land in `slide-001/`, `slide-002/`, ... under
the chosen `--output` directory.

If you prefer to drive the Python scripts directly, the equivalent
per-script commands are:

```text
Reference image
  -> python scripts/inspect-image.py <image>           # quick metadata
  -> python scripts/image-to-manifest-hints.py <image> <hints.json>
  -> python scripts/image-replica-analyze.py <image> <analysis.json>
  -> python scripts/image-replica-plan.py <analysis.json> <layer-plan.json>
```

Use `image-to-manifest-hints.py` for a lightweight first pass. Use `image-replica-analyze.py` and `image-replica-plan.py` when the task requires higher fidelity, stricter editability reporting, or later visual repair loops.

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

### `image-replica-analyze.py`

Structured replica analysis for higher-accuracy reconstruction:

- `sourceImage`, `image`, `slideMapping`, and `palette`
- `regions`: coarse layout bands with pixel and inch boxes
- `objectCandidates`: first-pass candidates such as background bands, title text, and content groups
- `detectors`: status for metadata, palette, layout bands, OCR, and planned geometry detection
- `qualityTargets`: text offset, shape offset, color, coverage, and visual similarity thresholds

```powershell
python scripts/image-replica-analyze.py reference.png output/image-replica-analysis.json
```

### `image-replica-plan.py`

Layer planning from analysis JSON:

- `source-reference`: alignment and diff reference, not the delivered editable layer
- `background-repair`: clean background or native filled bands
- `editable-shapes`: native rectangles, rounded rectangles, lines, arrows, and table grids
- `editable-text`: OCR-confirmed PowerPoint text boxes
- `cropped-assets`: limited raster fallback for photos, dense icons, logos, textures, or unsupported effects

```powershell
python scripts/image-replica-plan.py output/image-replica-analysis.json output/replica-layer-plan.json
```

### `image-to-manifest.mjs` (unified wrapper)

Single entry point that auto-dispatches to either of the flows above and
emits a `deck.manifest.skeleton.json` ready for host-agent completion.

```powershell
# single image, default creative hints flow
node scripts/image-to-manifest.mjs --input reference.png --output output/image-deck

# single image, replica flow with custom OCR confidence
node scripts/image-to-manifest.mjs --mode replica --input reference.png --output output/replica --ocr-confidence 0.6

# multi-image: a directory of PNGs, one slide each
node scripts/image-to-manifest.mjs --mode creative --input examples/image-batch --output output/batch
```

Wrapper responsibilities:

- Dispatch to `image-to-manifest-hints.py` (`--mode creative`) or to
  `image-replica-analyze.py` + `image-replica-plan.py` (`--mode replica`).
- Forward `--ocr-confidence` to `image-replica-plan.py` when the upstream
  script advertises support (probed via `--help`); otherwise persist the
  configured value in the manifest `_generator` block so U10 calibration can
  read it.
- When `--input` is a directory, run the chosen flow per PNG and concatenate
  the per-image manifests into one deck. `designSystem` and `deck.size` are
  pinned to the first slide so the deck stays internally consistent.
- Validate flags eagerly (unknown flags, `--ocr-confidence` outside `0..1`,
  `--palette-count` outside `1..12`) and surface Python errors with the
  original exit code.

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

For stricter replicas, use the thresholds emitted in `image-replica-analysis.json`: text boxes should stay within a small pixel offset, simple shapes should remain close to source bounds, palette colors should be sampled from the source, and the rendered PPTX screenshot should be compared against the original before delivery.
