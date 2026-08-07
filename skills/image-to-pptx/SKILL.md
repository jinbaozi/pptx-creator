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

   The doctor also imports the required Python measurement and font stack
   (Pillow, pytesseract, NumPy, scikit-image, and version-bounded fontTools) and prints
   its versions.

3. Reconstruct one image or an ordered set:

   ```bash
   node scripts/image-to-pptx.mjs build --output ./output slide-01.png slide-02.png
   ```

The command copies source files, performs OCR, scene, mask, and layer analysis, creates native-first PPTX objects, renders the candidate, compares every page with its reference, applies at most three bounded region-level calibrations, and publishes `final.pptx` only after the blocking quality gate and strict output validator pass. It also emits an optional interoperable HTML reconstruction package unless `--no-html-package` is used.

## Decisions

- Use `--langs eng`, `--langs chi_sim+eng`, or `--langs auto`. Explicit language requests must be installed; `auto` requires OSD script evidence before resolving to `chi_sim+eng` or `eng`. Missing packs or missing/unsupported script evidence fail deterministically; no language is silently substituted.
- Use the default OCR confidence threshold `0.70`. Lowering it increases editable text but also increases factual risk; record any user-requested override.
- Keep text whose confidence is below the threshold as a labeled local crop and in the low-confidence report. Never guess its content.
- Rebuild flat fills, borders, simple lines, and reliable tables as native objects. Rebuild visible chart geometry as native shapes unless original numeric data is actually recoverable.
- Preserve OCR polygons, direction/script evidence, reading order, rich text, object rotation/transparency, masks, and inferred z-order in the scene analysis. Treat these as evidence, not permission to invent missing content.
- Emit a deterministic five-class pixel ownership report for every slide. Claim final OCR lines, native shapes/connectors, and structured candidates before extracting residual connected components; residuals are tight transparent crops with auditable mask/source/asset digests and never replace a whole slide.
- `analysis.json` includes a deterministic `pageProfile` and layout-group `regionProfiles` (with evidence-bound singleton regions when needed) with density, complexity evidence, member/object refs, confidence, and candidate reconstruction strategies. Regional Tesseract OCR routes prioritized observed lines through bounded PSM 6/7/8/10/13 candidates under a fixed page call budget and records the single selected result in `ocr-report.json`; deferred lines retain page-pass evidence.
- `analysis.json` also carries a versioned `reconstructionPlan`: every owned region has complete executable `native-all`, `native-plus-local-assets`, and `bounded-raster` candidates with object/asset refs, ownership masks, z-range, provenance digests, editability, deterministic loss, and hard-gate results. The selected refs are rendered exclusively; the independent `reports/reconstruction-plan.json` report and digest must agree before QA can pass. No eligible route or incomplete object/asset coverage fails closed. `reports/visual-report.json` measures each RegionProfile from independent source/preview crops, ranks `impact=areaShare*(1-regionSSIM)*severityWeight`, and drives a deterministic top-five beam for at most three outer repair rounds. Unavailable metrics/routes remain explicit diagnostics, and every applied geometry/z/route/asset/object action regenerates and validates the plan/ref/digest.
- Emit a native chart only when `recoverability.sourceData` is true, `sourceRef` resolves to an analysis source, `sourceSha256` matches that source record, and every category/value is finite. Otherwise keep editable visible geometry or a bounded crop.
- Build the offline `reports/font-inventory.json` before solving text. Keep candidate families capped at six, preserve face/path/weight/glyph evidence, cluster text into stable Display Title/Section Title/Card Title/Body/Caption/Footnote/Badge tiers, and retain measured `font-fit-v1` evidence on each editable text object. A missing glyph or fontTools runtime is a blocking diagnostic, never a silent substitute.
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
