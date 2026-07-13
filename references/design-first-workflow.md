# Creative text workflow

Text work is Creative by default and uses one coordinate-free internal intermediate: `deck.plan.json`. The host agent edits content and visual direction; deterministic code validates page roles and composition strategies, compiles native geometry into `deck.manifest.json`, renders the editable deck, renders every slide through LibreOffice, and applies the Creative visual proof gate.

## Artifacts

```text
deck.plan.json
deck.manifest.json
final.pptx
quality-report.json
quality-report.md
output-manifest.json
preview/index.html
```

The plan is version `0.2.0` with exactly six required top-level keys: `version`, `context`, `designIntent`, `story`, `assets`, and `slides`.

- `context` records title, language, structured audience and environment, decision goal, tone, duration, memory anchors, brand references, requested quality profile, required office suites, editability floor, asset intensity, and visual ambition. LibreOffice must be present and required.
- `designIntent` records the design read; typography, palette, material, imagery, composition direction and `visibleGrid`; contextual composition/density/energy dials; and source/brand locks.
- `story` records narrative beats, ordered sections with slide references, and the decision path.
- `assets` records localized asset intent and provenance. Every asset has a non-empty `provenance.sourceRef`; empty asset lists remain valid.
- Every slide records `pageRole`, one message, a strict `contentModel`, an explicit `attentionTarget`, `compositionIntent`, `assetIds`, and a `routePolicy` whose preferred route is `native`, whose allowed routes include `native`, and whose `fullSlideRaster` is always `false`.

The current migration shell keeps eight strict native content families: `cover`, `architecture`, `comparison`, `process`, `dashboard`, `quote`, `matrix`, and `closing`. It is coordinate-free at every depth: coordinates, manifest geometry, and `elements` are invalid. `schemas/deck-plan.schema.json` is the only structural validator; runtime checks add only ID uniqueness, reference resolution, required route/suite membership, and composition ordering. Version `0.1.0` is retired and cannot compile.

Direction candidates are optional. Use them only when material ambiguity or high risk makes a single direction unsafe; candidate count, scoring, and recommendation are host-agent judgments, never fixed deterministic outputs.

Text remains manifest-first. HTML is optional only when explicitly requested or genuinely necessary for source-defined layout; it is not a creative intermediate.

## Gate

Creative output passes only when deck score is at least 80, every slide is at least 70, slop risk is at most 20, P0/P1 findings are zero, deterministic text-fit evidence passes, and editability is at least the plan's L4 or L5 floor. The proof must include a real LibreOffice render of every page and a complete contact sheet. Contextual checks come from the design read and dials. Explicit user brand and source locks override generic heuristics. Font compatibility is reported from real font preflight data, and visible background grids must match `metadata.designIntent.visibleGrid`.

Replica routes do not run this taste gate and must preserve source fidelity.
