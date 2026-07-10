# PDF replica capability

Use this capability only after selecting the `pdf-replica` route. The public entry is:

```bash
npm run pptx -- pdf source.pdf output/pdf-replica
```

## Current gate

The route blocks explicitly until a PDF replica compiler and fidelity proof capability are available. Extracted page hints or page screenshots are intermediate evidence, not an editable-PPTX delivery.

Install only the PDF profile dependencies before PDF work:

```bash
python3 -m pip install -r requirements-pdf.txt
npm run setup -- pdf
```

## Contract

- Preserve page size, layout, palette, typography, and reading order.
- Prefer native text and basic geometry.
- Use localized raster fallback only for unsupported effects or embedded artwork.
- Never package a full-page raster as an editable slide.
- Report fidelity, native coverage, editability, fallbacks, and unavailable capabilities separately.
- Stop after at most three evidence-driven repair attempts.
