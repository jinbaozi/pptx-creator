# Scene IR and benchmark

## Evidence model

Keep every slide in normalized pixel coordinates. Use stable IDs for objects,
layout groups, candidates, layers, and provenance references.

- OCR: retain word/line polygons, confidence, reading order, requested language
  packs, OSD direction, script, and recognition pass.
- Scene objects: retain native type, pixel and render boxes, z-order, rotation,
  opacity/transparency, style, relations, and recoverability.
- Candidates: tables require a closed grid and resolved cell assignment before
  native table emission. Charts require a resolving `sourceRef`, matching
  `sourceSha256`, and finite values before native chart emission; geometry-only
  candidates keep data fields `null`.
- Layers: retain foreground-mask digest, background evidence, occlusion edges,
  stable order, and repair provenance. Apply deterministic background repair only
  to small, flat, non-text holes; otherwise fail closed.

Validate `analysis.json` against `schemas/analysis.schema.json`. Do not fall back
to a looser envelope when the strict scene schema rejects an output.

## Object benchmark

Regenerate the deterministic challenge corpus with:

```bash
python3 scripts/generate_examples.py --output-root ./benchmark-output
```

The object-level fixture covers multiline text, rotation, transparency, chart
geometry, a table grid, a flat icon, and overlap/z-order. Its ground truth records
object IDs, types, boxes, style, relations, recoverability, and matching policy.
The analyzer must meet the manifest's required object recall with one-to-one
matches at or above the executable region-IoU floor, and must not emit a
whole-slide raster.

## Renderer rules

- Preserve rich runs, paragraph alignment/wrapping, font, rotation, gradients,
  shadows, line styles, image crop/alpha, and explicit z-order when supported.
- Reject unsafe chart data, off-slide objects, escaping asset paths, and unknown
  scene fields.
- Keep declared groups native only when their children and order can be emitted
  as valid OOXML and reopened by LibreOffice.
