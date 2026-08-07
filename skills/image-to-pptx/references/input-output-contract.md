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
--langs LANGS            eng, chi_sim+eng, auto, or another exact installed pack; default eng
--ocr-threshold N        editable-text threshold in [0,1]; default 0.70
--max-repairs N          bounded calibration attempts in [0,3]; default 3
--html-package           emit the optional HTML package; default
--no-html-package        skip the optional HTML package
```

Set `IMAGE_TO_PPTX_PYTHON` to select the Python interpreter.

`--langs auto` resolves only after Tesseract OSD reports a supported script
(`Latin` → `eng`, `Han`/CJK → `chi_sim+eng`). Missing or unsupported script
evidence fails with `E_OCR_RUNTIME`; use an explicit language string when OSD is
unavailable. Explicit requests are checked verbatim and are never replaced.

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
  font-inventory.json
  low-confidence/
  ownership/
  reconstruction-plan.json
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

Preview rendering is pixel-exact. The renderer invokes `pdftoppm` with both
`-scale-to-x WIDTH_PX` and `-scale-to-y HEIGHT_PX`; every page must have that
exact size. A mismatch fails closed with `E_RENDER_SIZE_MISMATCH` and is never
repaired by a second image resize. `reports/render-report.json` records the
requested size, renderer, LibreOffice, Poppler, Tesseract, Python, and Python
library versions (including the pinned `fontTools` version). The same runtime
evidence is copied to `qa-report.json`.

The blocking visual metric is the versioned `pptx-creator-ssim` 2.0 contract:
`skimage.metrics.structural_similarity` with `data_range=255`,
`gaussian_weights=True`, `sigma=1.5`, `use_sample_covariance=False`, and
`channel_axis=2`. Its metadata is present in the visual report and QA report.

`analysis.json` also carries `componentCandidates`, `layoutGroups`,
`layerAnalysis`, `sceneLayerGraph`, and per-slide `pageProfile` plus stable
layout-group `regionProfiles` with member/object refs (singleton regions are
allowed when no group is observed). `ocr-report.json` records requested and
resolved languages, script-resolution evidence, page-detection words versus
final selected lines, and each regional OCR request's role, PSM, bounded
candidate count, selected result, and budget/deferred reason. `reports/visual-report.json` carries
per-region/object diagnostics plus global, localized, and merged OCR evidence.
Each `regionMeasurements` entry is measured from its source and preview crops
and records `regionSSIM`, OCR CER, bbox IoU, normalized MAE, palette Delta E,
`areaShare`, `severityWeight`, and the exact impact formula. Unavailable metrics
carry an explicit status/reason and are never filled with planner estimates;
`topErrorRegions` is stably ordered and the executable `repairQueue` is capped
at five measured regions. Repair history records the applied round action,
before/after measured metrics, strategy, raster delta, candidate digest, and
reconstruction-plan reference/digest. Every candidate plan is regenerated and
validated after geometry, z-order, route, asset, or object changes.
Each slide also includes a deterministic `ownershipReport` in normalized page
pixel coordinates. Its five disjoint classes (`background`, `native_text`,
`native_shape`, `raster_asset`, and `unresolved`) record pixel counts/shares,
mask paths and SHA-256 digests, the two-pixel tolerance band, conflicts, and
the unassigned-pixel budget. Residual raster objects reference tight
transparent PNG crops plus matching mask, source, and asset digests; masks are
written under `reports/ownership/`. Residual `sourceDigest`/`normalizedSourceDigest`
refer to the normalized source record used for pixel coordinates, not the
original encoded upload. Ownership failures are blocking and never
produce a complete delivery.

Region reconstruction is selected by an executable, versioned plan. Each slide
stores `reconstructionPlan` with exactly three complete candidates per owned
region: `native-all`, `native-plus-local-assets`, and `bounded-raster`. A
candidate records the object/asset refs it would render, pixel box, ownership
classes and mask refs, z-range, source/asset digests, editability level,
analysis-estimated SSIM/CER/IoU/MAE metrics, the versioned weighted loss, and
every hard-gate result. Ownership, unassigned-pixel, near-whole/large-region,
high-confidence-text-overlap, provenance, invented-content, and chart/table
traceability gates run before scoring; if no candidate is eligible, analysis
fails closed. Eligible candidates use a deterministic loss and tie-break
(`loss.total`, editability level, route priority, candidate id). The page plan
also records unique selected refs, z-order ownership, coverage, and page gates.
Every candidate carries the same versioned twelve-gate universe and loss-weight
configuration; validators recompute all loss values, metrics, editability, and
the total from the assigned profile/refs and page area rather than trusting
candidate values. Page coverage is guarded by exactly five ordered blocking
gates (`region-ownership-unique`, `page-object-coverage`,
`page-asset-coverage`, `selected-object-coverage`, and
`selected-asset-coverage`); page `sourceRefs`/`sourceDigests` are recomputed
from that page's bound source records, while the report-level provenance must
enumerate every analysis source and the deterministic planner constant.
The same report is written independently to `reports/reconstruction-plan.json`;
`analysis.reconstructionPlanRef` binds its relative path and SHA-256 digest.
Published `qa-report.json.reconstructionPlanRef`,
`reports/render-report.json.lineage.reconstructionPlanRef`, and
`run.json.summary.reconstructionPlanRef` must match that reference and the
published report digest; a missing, changed, or mismatched reference fails
closed.
The renderer filters solely by the selected object refs, and output validation
recomputes the report digest, candidate gates/loss, winner tie-break, asset
provenance, and coverage before delivery can pass.

Font reconstruction is offline and source-bound. `reports/font-inventory.json`
records fontconfig-discovered family/face paths, SHA-256 path digests, runtime
identity, OS/2 weight, Latin/Han/digit coverage, and required/missing glyphs
for current OCR text. At most six deterministic candidate families are
exposed. Every editable text object references this inventory, a stable
typography tier, and `font-fit-v1` evidence. The bounded solver evaluates no
more than five sizes, three weights, three spacing values in four deterministic
representative tuples per new tier (at most 24 measured candidates per tier,
within the fixed 180-candidate page budget); later members reuse that tier
representative without pretending to have a fresh fit score. Measurements use
96-DPI Pillow rendering, ink-box IoU, local SSIM, target ink density,
baseline/width/height, line-count, and OCR-content consistency. Each object also
records selected-font layout evidence (deterministic line breaks, rendered line
count, current text-box width, and selected line height); reuse members measure
that layout from the representative face without rasterizing another candidate
or spending page budget. The renderer consumes these breaks and line-height
values when writing native PPTX paragraphs. Missing glyphs are recorded and
never silently treated as available.
`reports/render-report.json` binds preview pages to the exact final/failed PPTX
digest. Any schema, path, digest, protocol, or lineage failure removes complete
delivery markers and leaves `failure.json` plus attempt evidence.

## Exit codes

- `0`: blocking quality gate passed;
- `1`: invalid input, missing dependency, contract violation, or conversion error;
- `2`: conversion ran, but visual/editability quality stayed below threshold after bounded repairs.

All JSON contracts use stable IDs and explicit versions. Unknown protocol versions fail closed.
