# Quality gate and error model

## Blocking gate

Every candidate is rendered through LibreOffice and compared to the normalized references. Thresholds are fixed:

| Metric | Threshold |
|---|---:|
| SSIM | `>= 0.94` |
| OCR character error rate | `<= 0.02` |
| matched text bounding-box IoU | `>= 0.90` |
| palette Delta E 2000 p95 | `<= 3.0` |
| high-confidence native text recall | `>= 0.90` |
| editability | Level `>= 3` |
| all raster area share | `<= 0.65` |

The OCR gate combines independent page-detection and source-bound region OCR:
region OCR recovers small labels, while a token-evidence comparison still charges
missing or extra global text. Page-level reading-order noise does not erase
region evidence. The gate also blocks page-count/size mismatch, missing fonts
that remove text, undeclared raster content, any whole-slide raster, off-slide
objects, and a local worst-region omission.
The analysis, QA, and output-validator gates also require complete, mutually
exclusive pixel ownership. Final OCR lines, native shapes/connectors, and
structured candidates are claimed before residual connected components; each
residual is a tight transparent crop that excludes native pixels. A failed or
pending ownership report cannot be published as a final delivery.

## Bounded repair

Perform at most three outer rounds. Each round measures every declared
`RegionProfile` from independent source/render crops and computes
`impact=areaShare*(1-regionSSIM)*severityWeight`; only the stable top five
measured contributors enter the bounded beam (pages with fewer regions use all
available contributors). Planner loss values are never substituted for these
measurements. Match rendered OCR lines to source lines by normalized text and
classify text, shape, image, background, and z-order regions, then:

1. translate the text box by the measured glyph-box displacement;
2. scale font size from measured width and height ratios;
3. enlarge only the text container required to prevent wrapping;
4. clamp each move and scale to a conservative bound;
5. adjust bounded shape/image geometry, safe color/background evidence, or one
   z-order step only when local source-color measurement (or explicit layer
   order evidence) identifies that category; ambiguous geometry remains
   diagnostic-only and is not applied;
6. render and measure again. A candidate is retained only when a selected
region has a measured hard-metric improvement, all full-page hard metrics and
the metric/threshold contract are unchanged or better, ownership has no new
conflict, and editability stays within budget. A route trial is executable only
when its source-bound composition has a renderer-observable difference; an
unchanged crop/digest is rejected as `no-observable-render-delta`.

Keep every round and its finite candidate beam under `reports/attempt-*`.
Thresholds never change, and each geometry/z/route/asset/object mutation
regenerates and validates the reconstruction plan/report/ref/digest before
rendering. Rejected candidates remain diagnostic evidence; only the best or
fully accepted candidate may be published. If the gate is still red, publish
`failure.json` and exit `2`.

## Stable errors

- `E_INPUT_REQUIRED`: no source image;
- `E_INPUT_FORMAT`: unsupported or corrupt image;
- `E_INPUT_LIMIT`: encoded or decoded safety limit exceeded;
- `E_PAGE_RATIO_MISMATCH`: pages have materially different ratios;
- `E_OCR_RUNTIME`: Tesseract, language data, Pillow, or pytesseract unavailable;
- `E_RENDER_RUNTIME`: LibreOffice or `pdftoppm` unavailable;
- `E_RENDER_SIZE_MISMATCH`: a rendered page does not match the requested pixel width and height;
- `E_VISUAL_RUNTIME`: required SSIM Python dependencies are unavailable;
- `E_FONT_RUNTIME`: pinned fontTools or a parseable offline font inventory is unavailable;
- `E_WHOLE_SLIDE_FALLBACK`: detector would require a prohibited page raster;
- `E_PIXEL_OWNERSHIP_CONFLICT`: ownership masks overlap or are incomplete;
- `E_RASTER_NATIVE_TEXT_OVERLAP`: a residual raster claim overlaps native text or shape pixels;
- `E_UNASSIGNED_PIXEL_BUDGET`: ownership leaves more pixels unassigned than the declared budget;
- `E_DUPLICATE_VISIBLE_CONTENT`: duplicate residual assets would render the same visible content twice;
- `E_RECONSTRUCTION_NO_ELIGIBLE`: a region has no candidate that satisfies all blocking reconstruction gates;
- `E_RECONSTRUCTION_COVERAGE`: selected region winners do not uniquely cover every observed object/asset;
- `E_RECONSTRUCTION_PLAN`: the selected reconstruction plan, independent report, loss, gate, provenance, or tie-break evidence is inconsistent;
- `E_PROTOCOL_VERSION`: unsupported presentation-package version;
- `E_CONTRACT`: generated artifact violates its contract;
- `E_QUALITY_GATE`: repairs exhausted without passing.

Do not collapse these into a generic success response. Inspect `failure.json` and the remaining findings.

## Deterministic render and metric evidence

`render_preview.py` receives `--width-px` and `--height-px` and passes both
dimensions directly to Poppler (`-scale-to-x`/`-scale-to-y`). It verifies every
PNG header before returning; no post-render scaling is allowed. The render
report records a runtime object with the renderer, LibreOffice, Poppler,
Tesseract, Python, Pillow, pytesseract, NumPy, scikit-image, and fontTools versions.

The only public SSIM hard gate is `pptx-creator-ssim` version `2.0`. Its
configuration is fixed and serialized with each visual report:

```json
{
  "implementation": "skimage.structural_similarity",
  "dataRange": 255,
  "gaussianWeights": true,
  "sigma": 1.5,
  "useSampleCovariance": false,
  "channelAxis": 2
}
```
