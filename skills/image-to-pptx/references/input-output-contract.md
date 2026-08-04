# Input and output contract

## Input

`build` accepts one or more local PNG/JPEG/WebP images, or directories containing those formats. Directory entries are sorted by filename. All pages must have the same aspect ratio within one percent; mixed ratios fail with `E_PAGE_RATIO_MISMATCH`.

Limits per source:

- encoded size: 50 MiB;
- decoded size: 16 megapixels;
- width or height: 8192 pixels;
- no remote URL input.

The first page establishes the deck ratio. Analysis uses a normalized 1280-pixel-wide reference so OCR, PPT coordinates, and render comparison share one coordinate system. Original bytes are copied under `sources/` and retained with SHA-256 evidence.

## CLI

```text
node scripts/image-to-pptx.mjs build [options] IMAGE...

--output DIR             required output directory
--title TEXT             deck title; defaults to the first filename
--langs LANGS            installed Tesseract languages; default eng
--ocr-threshold N        editable-text threshold in [0,1]; default 0.70
--max-repairs N          bounded calibration attempts in [0,3]; default 3
--html-package           emit the optional HTML package; default
--no-html-package        skip the optional HTML package
```

Set `IMAGE_TO_PPTX_PYTHON` to select the Python interpreter.

## Successful output

```text
final.pptx
analysis.json
ocr-report.json
design-tokens.json
sources/
assets/
preview/
reports/
  low-confidence/
  render-report.json
  editability-report.json
  degradation-log.json
qa-report.json
run.json
html-package/                 optional
  index.html
  presentation-package.json
  deck-manifest.json
  design-tokens.json
  sources.json
  qa-report.json
  assets/
```

`run.json` binds the accepted PPTX, preview, analysis, QA, sources, and optional HTML package by relative path and digest. A failed run keeps `failed-candidate.pptx`, `qa-report.json`, and `failure.json`, but never publishes `final.pptx`.

`analysis.json` also carries `componentCandidates`, `layoutGroups`,
`layerAnalysis`, and `sceneLayerGraph`. `reports/visual-report.json` carries
per-region/object diagnostics plus global, localized, and merged OCR evidence.
`reports/render-report.json` binds preview pages to the exact final/failed PPTX
digest. Any schema, path, digest, protocol, or lineage failure removes complete
delivery markers and leaves `failure.json` plus attempt evidence.

## Exit codes

- `0`: blocking quality gate passed;
- `1`: invalid input, missing dependency, contract violation, or conversion error;
- `2`: conversion ran, but visual/editability quality stayed below threshold after bounded repairs.

All JSON contracts use stable IDs and explicit versions. Unknown protocol versions fail closed.
