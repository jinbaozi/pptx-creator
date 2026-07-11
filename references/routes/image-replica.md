# Image replica route

## Trigger

Select when a local image or screenshot is the visual reference for an editable reconstruction.

## Exclusions

Do not select for creative text decks, HTML, PDFs, or manifest patching; never promote the source image to a full-slide editable result.

## Public command

npm run pptx -- image <input.png> <output-dir>

## Inputs and outputs

Input is a local PNG or JPEG. Output includes `final.pptx`, the measured analysis and layer plan, `deck.manifest.json`, `replica-evidence.json`, preview pages, and quality reports.

## Blocking conditions

Block on unreadable or oversized input, source/analysis/plan digest drift, incomplete editable reconstruction, failed fidelity thresholds, missing OOXML native objects, full-slide or undeclared raster references anywhere in the PPTX archive, or more than three repair attempts.

## Next references

1. `references/image-to-pptx.md`
2. `references/manifest-spec.md`
3. `references/qa-rubric.md`
