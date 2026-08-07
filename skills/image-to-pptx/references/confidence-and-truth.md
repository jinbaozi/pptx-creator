# Confidence and visible-truth policy

## OCR

Keep three distinct facts:

1. `observed`: pixels and exact source geometry;
2. `recognized`: OCR text plus engine confidence;
3. `inferred`: component roles such as title, table, chart, or connector.

Only OCR lines at or above `ocrThreshold` become editable text. Preserve their original spelling and punctuation. Below-threshold lines become bounded local crops and appear in `ocr-report.json`, `degradation-log.json`, and the annotated low-confidence preview.

The deterministic analyzer performs a primary RGB pass and a narrowly scoped
red-channel threshold pass (`recognitionPass: red-threshold-130`) for small
light or red labels on dark and saturated regions. Secondary results are
admitted only when confidence is at least `max(ocrThreshold, 0.85)` and the
line does not overlap text from either the primary pass or an already accepted
secondary line. The pass is provenance evidence, not permission to rewrite or
guess text.

Do not silently correct OCR. A human may approve a correction by editing `analysis.json` and recording the source decision, but automated runs must stay source-faithful.

Record Tesseract OSD orientation/script as advisory evidence. Keep source pixels
and coordinates unchanged unless a caller explicitly approves a rotation. Retain
word/line polygons, paragraph IDs, reading order, requested languages, and the
recognition pass so downstream calibration can distinguish observation from
inference.

Regional OCR is intentionally bounded: prioritized observed lines are routed by
their geometry to PSM 6 (body), 7 (title), 8 (label), 10 (number), or 13
(caption), with no more than two deterministic preprocessing candidates and a
fixed page-wide call budget. Selection uses content agreement, confidence, and
box stability; selected, no-result, and budget-deferred status remain in the OCR
report. `pageDetectionWords`/compatibility `words` are preliminary whole-page
evidence, while `finalLines`/compatibility `lines` are the lines consumed by
object reconstruction. `pageProfile` and layout-group `regionProfiles` describe
observed density/complexity and recommended native or bounded-raster
strategies; they do not authorize invented content.

## Charts and tables

- Rebuild a table as a native table only when a closed grid and cell assignment are both reliable.
- Rebuild a chart as native data only when the actual numeric labels or a supplied data source determine the series.
- If only bar heights, line positions, or pie angles are visible, use editable shapes and mark the component role as inferred. Do not synthesize a hidden dataset.
- Keep deterministic `componentCandidates` for unresolved table grids and
  geometry-only charts with `data: null`. A candidate is not a native object
  until its recoverability contract is satisfied.
- If a plot cannot be separated reliably, retain only its bounded plot area as a local crop.

## Branding and unreadable regions

Never invent logo text, product names, client names, citations, dates, or data. An unclear logo or photo may remain a local crop. An unclear text region remains a crop with a low-confidence marker.

## Confidence interpretation

- `>= 0.90`: high-confidence OCR;
- `0.70–0.89`: editable by default, still reported;
- `< 0.70`: local crop by default;
- `null`: detector unavailable; never treat as confidence `1`.

Compact labels of four alphanumeric characters or fewer require at least `0.80`, because OCR confusions such as `1`/`I`/`l` can silently alter chart or table labels. Preserve lower-confidence compact labels as local crops.

Confidence describes recognition evidence, not factual verification.
