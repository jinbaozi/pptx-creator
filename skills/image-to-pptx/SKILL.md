---
name: image-to-pptx
description: Reconstruct one or more slide reference images, screenshots, PNGs, or JPEGs as a mostly editable PowerPoint deck. Use when Codex must OCR visible text, infer slide geometry and style, rebuild reliable content as native PPTX text/shapes/lines/tables, retain only bounded complex regions as local raster crops, report uncertainty, and prove the result by rendering it back to images.
---

# Image to PPTX

Rebuild only what is visible. Never invent unreadable text, chart data, brands, or facts, and never use the whole reference page as a slide background.

## Run

1. Install this folder by itself:

   ```bash
   npm install
   python3 -m pip install -r requirements.txt
   ```

2. Check that Tesseract, LibreOffice, and `pdftoppm` are available:

   ```bash
   node scripts/image-to-pptx.mjs doctor
   ```

3. Reconstruct one image or an ordered set:

   ```bash
   node scripts/image-to-pptx.mjs build --output ./output slide-01.png slide-02.png
   ```

The command copies source files, performs OCR, scene, mask, and layer analysis, creates native-first PPTX objects, renders the candidate, compares every page with its reference, applies at most three bounded region-level calibrations, and publishes `final.pptx` only after the blocking quality gate and strict output validator pass. It also emits an optional interoperable HTML reconstruction package unless `--no-html-package` is used.

## Decisions

- Use `--langs eng` or another locally installed Tesseract language. Do not substitute a different language silently.
- Use the default OCR confidence threshold `0.70`. Lowering it increases editable text but also increases factual risk; record any user-requested override.
- Keep text whose confidence is below the threshold as a labeled local crop and in the low-confidence report. Never guess its content.
- Rebuild flat fills, borders, simple lines, and reliable tables as native objects. Rebuild visible chart geometry as native shapes unless original numeric data is actually recoverable.
- Preserve OCR polygons, direction/script evidence, reading order, rich text, object rotation/transparency, masks, and inferred z-order in the scene analysis. Treat these as evidence, not permission to invent missing content.
- Emit a native chart only when `recoverability.sourceData` is true, `sourceRef` resolves to an analysis source, `sourceSha256` matches that source record, and every category/value is finite. Otherwise keep editable visible geometry or a bounded crop.
- Use a bounded local raster crop only when a region cannot be decomposed reliably. Fail if the only credible fallback would cover essentially the whole slide.
- Preserve all failure artifacts. Do not rename a failed candidate to `final.pptx`.

## Required reading

- Read [references/input-output-contract.md](references/input-output-contract.md) before integrating the CLI or consuming its artifacts.
- Read [references/confidence-and-truth.md](references/confidence-and-truth.md) when OCR is uncertain or the reference contains charts, tables, logos, or blurred content.
- Read [references/degradation-and-editability.md](references/degradation-and-editability.md) when any raster fallback or inferred component is present.
- Read [references/scene-ir-and-benchmark.md](references/scene-ir-and-benchmark.md) when extending the analyzer, renderer, object types, mask/layer model, or quality benchmark.
- Read [references/qa-and-errors.md](references/qa-and-errors.md) when a gate fails, a runtime is missing, or calibration is exhausted.
- Read [references/interoperability.md](references/interoperability.md) only when composing with another presentation Skill.

## Completion

Treat the task as complete only when `qa-report.json` says `passed`, `final.pptx` exists, the preview pages were rendered from that exact digest, the strict analysis/QA schemas and artifact index validate, all declared local raster regions are bounded, and the protocol validator passes when the optional HTML package is emitted.
