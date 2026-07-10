# HTML replica route

## Trigger

Select when HTML/CSS is the visual source and layout fidelity must be preserved.

## Exclusions

Do not apply creative direction exploration or select for plain-text authoring, images, PDFs, or patch-only repair.

## Public command

npm run pptx -- html <input.html> <output-dir>

## Inputs and outputs

Input is local HTML and assets. Output is the existing HTML pipeline directory, including measurements, manifest, PPTX, and reports.

## Blocking conditions

Block on missing local input, unsupported loss without approval, failed layout validation, or more than three repair attempts.

## Next references

1. `references/html-measurement.md`
2. `references/manifest-spec.md`
3. `references/qa-rubric.md`
