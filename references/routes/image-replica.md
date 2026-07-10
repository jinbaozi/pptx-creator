# Image replica route

## Trigger

Select when a local image or screenshot is the visual reference for an editable reconstruction.

## Exclusions

Do not select for creative text decks, HTML, PDFs, or manifest patching; never promote the source image to a full-slide editable result.

## Public command

npm run pptx -- image <input.png> <analysis.json>

## Inputs and outputs

Input is a local PNG or JPEG. Output is the existing structured replica analysis used to author a `0.2.0` manifest.

## Blocking conditions

Block on unreadable input, missing dimensions, unlocalized assets, insufficient editable reconstruction, or more than three repair attempts.

## Next references

1. `references/image-to-pptx.md`
2. `references/manifest-spec.md`
3. `references/qa-rubric.md`
