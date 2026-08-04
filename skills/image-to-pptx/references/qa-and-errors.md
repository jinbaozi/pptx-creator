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

The OCR gate combines independent page-level and source-bound region OCR: region
OCR recovers small labels, while a token-evidence comparison still charges
missing or extra global text. Page-level reading-order noise does not erase
region evidence. The gate also blocks page-count/size mismatch, missing fonts
that remove text, undeclared raster content, any whole-slide raster, off-slide
objects, and a local worst-region omission.

## Bounded repair

Perform at most three attempts. Match rendered OCR lines to source lines by normalized text and classify text, shape, image, background, and z-order regions, then:

1. translate the text box by the measured glyph-box displacement;
2. scale font size from measured width and height ratios;
3. enlarge only the text container required to prevent wrapping;
4. clamp each move and scale to a conservative bound;
5. adjust bounded shape/image geometry, safe color/background evidence, or one
   z-order step only when local source-color measurement (or explicit layer
   order evidence) identifies that category; ambiguous geometry remains
   diagnostic-only and is not applied;
6. render and measure again.

Keep every attempt under `reports/attempt-N/`. Thresholds never change. The loop
may traverse one bounded Pareto step when a hard metric improves materially but
another OCR metric fluctuates; only the best or fully accepted candidate may be
published. If the gate is still red, publish `failure.json` and exit `2`.

## Stable errors

- `E_INPUT_REQUIRED`: no source image;
- `E_INPUT_FORMAT`: unsupported or corrupt image;
- `E_INPUT_LIMIT`: encoded or decoded safety limit exceeded;
- `E_PAGE_RATIO_MISMATCH`: pages have materially different ratios;
- `E_OCR_RUNTIME`: Tesseract, language data, Pillow, or pytesseract unavailable;
- `E_RENDER_RUNTIME`: LibreOffice or `pdftoppm` unavailable;
- `E_WHOLE_SLIDE_FALLBACK`: detector would require a prohibited page raster;
- `E_PROTOCOL_VERSION`: unsupported presentation-package version;
- `E_CONTRACT`: generated artifact violates its contract;
- `E_QUALITY_GATE`: repairs exhausted without passing.

Do not collapse these into a generic success response. Inspect `failure.json` and the remaining findings.
