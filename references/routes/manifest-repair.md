# Manifest repair route

## Trigger

Select only when applying a repair patch to an existing `0.2.0` manifest.

## Exclusions

Do not use it to author content, reinterpret replica sources, explore creative directions, or bypass validation.

## Public command

npm run pptx -- manifest <deck.manifest.json> <repair-patch.json> <repaired.manifest.json>

## Inputs and outputs

Inputs are a valid manifest and bounded repair patch. Output is a repaired manifest that must be validated before rendering.

## Blocking conditions

Block on invalid input/patch, unsafe or unsupported operations, validation failure, or once three automatic repair attempts have been used.

## Next references

1. `references/manifest-spec.md`
2. `references/qa-rubric.md`
3. `references/workflow.md`
