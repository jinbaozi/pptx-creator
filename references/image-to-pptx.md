# Image replica capability

Use this capability only after selecting the `image-replica` route. The public entry is:

```bash
npm run pptx -- image reference.png output/image-replica
```

## Current gate

The route is strict and currently blocks when the image replica compiler or fidelity proof capability is unavailable. A hints file, skeleton manifest, or full-slide screenshot is not a successful editable-PPTX delivery.

Install only the image profile dependencies before image work:

```bash
python3 -m pip install -r requirements-image.txt
npm run setup -- image
```

Tesseract is a separate system dependency. If it is missing, report OCR as unavailable instead of silently lowering confidence.

## Required layer plan

The image compiler must classify:

- high-confidence text with bounding box, content, font/style hints, alignment, and confidence;
- rectangles, lines, bands, and simple connected components;
- palette and background regions;
- residual complex regions that require localized crops.

High-confidence text and basic geometry must become native PowerPoint objects. Residual crops must record source bounding box, z-order, reason, and native alternatives attempted. Never use a full-slide raster as an editable result.

## Required evidence

The strict route must produce `replica-evidence.json` with separate fidelity and native-coverage metrics, editability level, fallback inventory, per-slide findings, retry count, and accepted status. Missing metrics are `N/A`, never an implicit perfect score.

The route may package only after its selected thresholds pass. Automatic geometry/style repair is bounded to three attempts.
