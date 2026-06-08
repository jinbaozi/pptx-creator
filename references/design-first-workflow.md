# Design-First Creative Deck Workflow

Design-first mode is the default route for creative text-to-PPTX work. It gives the host agent room to plan story and visual direction before compiling a deterministic `deck.manifest.json`.

## Creative mode

Use Creative mode when the user asks for a polished business, technical, roadshow, product, research, or training deck from text or mixed source material.

Required artifacts (design artifacts):

```text
output/deck.storyboard.json
output/deck.design-direction.json
output/slide-design-specs.json
output/ui-component-spec.json         # optional, when UI components are referenced
output/preview/                      # preview artifacts, when preview generation is enabled
output/deck.manifest.json
output/final.pptx                    # editable PPTX
output/visual-review.json
output/run.json
```

Flow:

1. Planner writes `deck.storyboard.json`.
2. Art Director writes `deck.design-direction.json`.
3. Slide Designer writes `slide-design-specs.json`.
4. Compiler resolves layout archetypes and writes `deck.manifest.json`.
5. Existing pipeline renders `final.pptx` (editable PPTX).
6. Preview generator writes preview artifacts under `output/preview/` for offline inspection.
7. Visual critic writes `visual-review.json`.
8. Screenshot-level review runs through the mock provider boundary by default; real vision providers must keep the same JSON contract and never mutate `final.pptx` directly.
9. Repair loop applies bounded changes when scores are below threshold.

### Strict replica boundary

Strict HTML, image, or PDF replica work must not be loosened by creative design exploration. Replica mode may bypass design artifacts when source fidelity is the primary objective, but the replica path must keep the original background, layout, typography, color, content, tone, and effects intact.

## Replica mode

Use Replica mode for strict HTML, image, or PDF reconstruction. Outside references may help identify missing assets or fonts, but must not change the source background, layout, typography, color, content, tone, or effects.

Replica mode may bypass design-first artifacts and write `deck.manifest.json` directly when source fidelity is the primary objective.

## Agent responsibilities

- Keep factual claims sourced when web research influences the deck.
- Choose or read a `DESIGN.md` before writing design direction.
- Prefer native PPTX text, shapes, tables, charts, and lines.
- Do not lower editability to hide layout problems.
- Report rasterized regions honestly.

## Multi-Direction Exploration

For creative decks, run direction exploration before full deck generation. The explorer creates three direction folders, each with a direction contract and scorecard. The approved direction should be copied into the full deck generation path and recorded in `run.json`.

## Visual Workbench and Artifact Inspection

The local Visual Workbench shell browses design artifacts, preview artifacts, repair patches, and review reports under `output/`. It does not own rendering: the deterministic pipeline still writes the editable PPTX. screenshot-level review results appear alongside other review outputs but never replace the deterministic render step.
