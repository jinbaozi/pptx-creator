# PDF Page Reconstruction

Use this route when the input is a PDF and the output must remain editable. Treat each PDF page as a visual reference, not as the final slide bitmap.

## Convert pages to hints

```bash
node scripts/run-python.mjs scripts/pdf-to-page-hints.py source.pdf output/pdf-pages -o output/pdf-page-hints.json
```

The helper renders pages to local images and emits image-style layout hints. If PyMuPDF is unavailable, it reports `status: deferred`; install the optional dependency or report the gap.

## Rebuild the deck

1. Read `output/pdf-page-hints.json`.
2. Select and read a `DESIGN.md`. In strict replica mode, use it only to encode the source faithfully.
3. Rebuild text, shapes, tables, charts, and diagrams as native manifest elements.
4. Use cropped page regions only for photos, complex artwork, or effects that cannot be represented natively.
5. Write `output/deck.manifest.json` and run:

   ```bash
   node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
   ```

6. Read `references/qa-rubric.md` and disclose any page-level rasterization.

Do not package full PDF pages as editable slides unless the user explicitly accepts Level 1 output.
