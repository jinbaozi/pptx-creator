# Manifest repair route

## Trigger

Select only when applying a repair patch to an existing `0.2.0` manifest.

## Exclusions

Do not use it to author content, reinterpret replica sources, explore creative directions, or bypass validation.

## Public command

npm run pptx -- manifest <deck.manifest.json> <repair-patch.json> <repaired.manifest.json>

## Inputs and outputs

Inputs are a valid `0.2.0` manifest and a schema-valid repair patch with integer `attempt` from 1 through 3. The wrapper validates the input, applies the patch, validates a temporary output, then atomically publishes the repaired manifest.

## Blocking conditions

Block on invalid input/patch, unsafe or unsupported operations, validation failure, or once three automatic repair attempts have been used.

## Next references

1. `references/manifest-spec.md`
2. `references/qa-rubric.md`
3. `references/workflow.md`
