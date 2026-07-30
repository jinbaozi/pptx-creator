# Degradation and editability

## Editability classes

- Level 5: native text, shapes, tables, charts, and connectors with no raster fallback.
- Level 4: native text and main geometry; bounded complex regions remain raster.
- Level 3: editable text plus partial native structure.
- Level 2: mostly local raster reconstruction.
- Level 1: whole-slide raster. This Skill prohibits Level 1 output.

The blocking minimum is Level 3. The editability report lists native object counts, raster regions, raster area share, and OOXML evidence.

## Allowed degradation

A local raster fallback is allowed only when:

- the region is bounded, covers less than 80% of one page, and all raster
  regions together cover at most 65% of the deck area;
- the reason is explicit;
- attempted native alternatives are recorded;
- its source crop is digest-bound;
- it does not replace editable high-confidence text.

Typical reasons are `low-confidence-ocr`, `high-local-color-complexity`, `photo`, and `unresolved-chart-data`.

## Prohibited degradation

- full-slide screenshot or background image;
- raster text when OCR confidence meets the editable threshold;
- hidden source image used to inflate similarity;
- undeclared images in PPTX;
- generated text or data used to fill unreadable pixels;
- importing or executing any sibling Skill.

## Connectors

Use native line objects for reliable lines. Preserve direction only when arrowheads are visible. Geometry checks require endpoints inside the slide and reject zero-length or off-slide connectors. Pixel evidence alone cannot prove semantic node attachment; record such attachment as inferred.
