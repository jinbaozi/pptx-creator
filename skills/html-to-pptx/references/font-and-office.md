# Fonts and office renderers

## Font policy

The browser and PowerPoint may measure the same font differently. The converter:

1. waits for browser fonts before geometry capture;
2. records requested font families;
3. checks the host font catalog;
4. resolves each Unicode grapheme to a deterministic face when one family does not cover the full string;
5. writes explicit font runs into native text, table cells/captions, and chart labels;
6. renders the PPTX again before acceptance.

Inspect `font-report.json` for missing families, substitutions, and the metrics
catalog source. The report also records the selected face (family, PostScript
name, full name, weight/style/stretch and variable axes), glyph coverage for
each text request, and the OpenType `OS/2.fsType` embedding decision. A
restricted (`fsType & 0x0002`) face is never reported as embeddable. Keep fonts
local and licensed. This Skill does not download commercial fonts or embed them
without explicit rights.

`layout-measurements.json` records the Chromium and Node versions used for DOM
geometry. Accepted preview evidence records Python, LibreOffice, Poppler, and
Pillow versions, and the same payload is copied into `qa-report.json` and
`compatibility-report.json`.

Set the Python interpreter explicitly when needed:

```bash
HTML_TO_PPTX_PYTHON=/path/to/python3 node scripts/convert.mjs input.html output
```

The interpreter must have Pillow from `requirements.txt`.

## Rendering dependencies

The blocking preview path uses:

- LibreOffice headless to convert PPTX to PDF;
- Poppler `pdftoppm` to rasterize PDF pages at 96 DPI;
- Pillow to inspect previews, construct a contact sheet, and calculate visual
  differences.

If LibreOffice or `pdftoppm` is unavailable, conversion fails with `E_PREVIEW`.
This is intentional: publishing without target-office render evidence would
weaken the quality gate.

## Cross-application differences

PowerPoint, LibreOffice Impress, and WPS can differ in:

- font substitution and fallback glyph selection;
- line breaking and line-height behavior;
- bullet indentation;
- gradient and shadow rendering;
- chart labeling;
- SVG support;
- table cell padding;
- connector arrowhead geometry.

LibreOffice is the deterministic automated baseline, not proof of identical
rendering in every office suite. For a named target application, open and render
the accepted file there as an additional manual gate. Record that result
separately; do not overwrite automated evidence.

Prefer fonts installed on both the conversion and target hosts. When that is not
possible, select a compatible fallback explicitly in the HTML and verify the
final application render.

## Office validation matrix

Run the independent matrix after the HTML render has produced source PNGs:

```bash
node scripts/verify-office-matrix.mjs \
  --pptx /path/to/final.pptx \
  --source-dir /path/to/html-pngs \
  --render-dir libreoffice=/path/to/libreoffice-pngs \
  --render-dir powerpoint=/path/to/powerpoint-pngs \
  --render-dir wps=/path/to/wps-pngs \
  --output /path/to/office-matrix.json
```

`LibreOffice` is the supported safe headless adapter. When no PNG directory is
provided and LibreOffice is available, the matrix invokes `render-preview.py`,
then calls the self-contained `compare-deck.py` for the per-target report.
PowerPoint is automatable only through the Windows COM adapter; the generated
contract uses PowerPoint's `Presentation.SaveAs(..., EmbedFonts)` /
`SaveCopyAs(..., EmbedTrueTypeFonts)` arguments for legal font embedding. WPS
and non-Windows PowerPoint are reported as `detected-but-not-automatable` until
external PNGs are supplied.

The only passing state is `passed` after comparison. `available`,
`detected-but-not-automatable`, `failed`, and `unavailable` remain explicit
non-passing evidence states; in particular, an unavailable target is never
converted to a pass merely because another target rendered successfully.

### Optional legal font embedding (Windows PowerPoint only)

Request an embedded copy explicitly; the command requires both an output path
and the generated font report:

```bash
node scripts/verify-office-matrix.mjs \
  --pptx /path/to/final.pptx \
  --embed-fonts-output /path/to/final-embedded.pptx \
  --font-report /path/to/font-report.json \
  --output /path/to/office-matrix.json
```

The matrix permits `SaveCopyAs(output, 24, -1)` only when the PowerPoint
Windows COM adapter is available and every actual report resolution has
`resolved.embedding.canEmbed === true`. Restricted (`false`), unknown/missing
license evidence, missing reports, non-Windows hosts, and GUI-only adapters
produce an explicit non-passing embedding status and do not create an output
file or claim that fonts were embedded.
