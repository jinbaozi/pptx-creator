# PDF replica route

## Trigger

Select when PDF pages are the visual reference for editable reconstruction.

## Exclusions

Do not select for text authoring, HTML, standalone images, or patch-only repair; do not package rendered pages as editable slides.

## Public command

npm run pptx -- pdf <input.pdf> <output-dir>

## Inputs and outputs

Input is a local PDF. This public route currently fails closed because an editable PDF replica compiler and fidelity proof are not implemented; it does not silently package page screenshots.

## Blocking conditions

Always block with the explicit capability-unavailable error until the editable compiler and source-to-render proof are implemented.

## Next references

1. `references/pdf-to-pptx.md`
2. `references/manifest-spec.md`
3. `references/qa-rubric.md`
