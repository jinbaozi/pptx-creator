# PDF replica route

## Trigger

Select when PDF pages are the visual reference for editable reconstruction.

## Exclusions

Do not select for text authoring, HTML, standalone images, or patch-only repair; do not package rendered pages as editable slides.

## Public command

npm run pptx -- pdf <input.pdf> <pages-dir> <hints.json>

## Inputs and outputs

Input is a local PDF. Outputs are localized page images and page-level authoring hints for a `0.2.0` manifest.

## Blocking conditions

Block on unreadable/encrypted PDF, failed page rendering, incomplete page mapping, insufficient editability, or more than three repair attempts.

## Next references

1. `references/pdf-to-pptx.md`
2. `references/manifest-spec.md`
3. `references/qa-rubric.md`
