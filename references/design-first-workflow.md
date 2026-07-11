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

The plan contains a one-line design read; typography, palette, material, imagery, and composition direction; contextual composition/density/energy dials; audience; narrative beats; slide messages; page roles; composition strategies; implementation layout families; content/asset references; and an explicit `visibleGrid` boolean that defaults to `false`. It never contains coordinates.

Direction candidates are optional. Use them only when material ambiguity or high risk makes a single direction unsafe; candidate count, scoring, and recommendation are host-agent judgments, never fixed deterministic outputs.

Text remains manifest-first. HTML is optional only when explicitly requested or genuinely necessary for source-defined layout; it is not a creative intermediate.

## Gate

Creative output passes only when deck score is at least 80, every slide is at least 70, slop risk is at most 20, P0/P1 findings are zero, deterministic text-fit evidence passes, and editability is at least L4. The proof must include a real LibreOffice render of every page and a complete contact sheet. Contextual checks come from the design read and dials. Explicit user brand and source intent override generic heuristics. Font compatibility is reported from real font preflight data, and visible background grids must match `metadata.designIntent.visibleGrid`.

Replica routes do not run this taste gate and must preserve source fidelity.
