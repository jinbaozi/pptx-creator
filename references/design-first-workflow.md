# Design-First Creative Deck Workflow

Design-first mode is the default route for creative text-to-PPTX work. It gives the host agent room to plan story and visual direction before compiling a deterministic `deck.manifest.json`.

## Creative mode

Use Creative mode when the user asks for a polished business, technical, roadshow, product, research, or training deck from text or mixed source material.

Required artifacts:

```text
output/deck.storyboard.json
output/deck.design-direction.json
output/slide-design-specs.json
output/deck.manifest.json
```

Flow:

1. Planner writes `deck.storyboard.json`.
2. Art Director writes `deck.design-direction.json`.
3. Slide Designer writes `slide-design-specs.json`.
4. Compiler resolves layout archetypes and writes `deck.manifest.json`.
5. Existing pipeline renders `final.pptx`.
6. Visual critic writes `visual-review.json`.
7. Repair loop applies bounded changes when scores are below threshold.

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
