# Scene IR and benchmark

## Evidence model

Keep every slide in normalized pixel coordinates. Use stable IDs for objects,
layout groups, candidates, layers, and provenance references.

- OCR: retain word/line polygons, confidence, reading order, requested language
  packs, resolved language evidence, OSD direction, script, and recognition pass.
- Profiles: retain one deterministic `pageProfile` per slide and stable
  layout-group `regionProfiles` with observed boxes, member/object refs,
  density/complexity evidence, confidence, and candidate strategies. Profiles
  are inference metadata only; they never create text or data that is absent
  from the source.
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

The baseline `TesseractProvider` implements the `OcrProvider` contract:
whole-page OCR is preliminary PSM 11, while observed line regions are routed to
PSM 6/7/8/10/13 with at most two deterministic preprocessing candidates. A
future Paddle/layout provider is represented only by `LayoutProvider` metadata;
it is not installed, imported, or contacted, and adds no runtime dependency or
network call.

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

## Visual benchmark matrix

`tests/fixtures/visual-benchmark-matrix/manifest.json` is a deterministic,
source-bound corpus of 55 images: ten Chinese dense-layout samples and five
samples in each of the other nine categories.  The manifest records source
digests, expected features, accepted reconstruction route, and fixed quality
gates.  Its `evaluation.status` remains `not-run`; it is not a golden result.

The structural contract is covered by the local Python matrix tests.  Real
rendering is deliberately separate: CI runs
`npm run test:visual-matrix` as a ten-way category matrix with
`IMAGE_TO_PPTX_VISUAL_MATRIX=1` and one
`IMAGE_TO_PPTX_MATRIX_CATEGORY` per job.  Each job invokes the real build with
at most three repairs, validates the emitted QA/run/analysis/render/visual and
editability lineage, and uploads a category JSON summary even when a case
fails.  A summary is evidence from that CI execution only; local structural
tests do not claim that all 55 samples passed.

## Renderer rules

- Preserve rich runs, paragraph alignment/wrapping, font, rotation, gradients,
  shadows, line styles, image crop/alpha, and explicit z-order when supported.
- Reject unsafe chart data, off-slide objects, escaping asset paths, and unknown
  scene fields.
- Keep declared groups native only when their children and order can be emitted
  as valid OOXML and reopened by LibreOffice.
