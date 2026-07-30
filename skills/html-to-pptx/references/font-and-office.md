# Fonts and office renderers

## Font policy

The browser and PowerPoint may measure the same font differently. The converter:

1. waits for browser fonts before geometry capture;
2. records requested font families;
3. checks the host font catalog;
4. applies deterministic substitutions when a requested family is unavailable;
5. writes the chosen font names into native text objects;
6. renders the PPTX again before acceptance.

Inspect `font-report.json` for missing families, substitutions, and the metrics
catalog source. Keep fonts local and licensed. This Skill does not download
commercial fonts or embed them without explicit rights.

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
