# Creative text workflow

Creative text work uses one coordinate-free intermediate: `deck.plan.json`. The host agent writes the plan; deterministic code validates each selected layout family, compiles native geometry into `deck.manifest.json`, renders the editable deck, and applies the creative quality gate.

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

The plan contains a one-line design read, contextual composition/density/energy dials, audience, narrative beats, slide messages, a selected layout family, and content/asset references. It never contains coordinates.

Direction candidates are optional. Use them only when material ambiguity or high risk makes a single direction unsafe; candidate count, scoring, and recommendation are host-agent judgments, never fixed deterministic outputs.

Text remains manifest-first. HTML is optional only when explicitly requested or genuinely necessary for source-defined layout; it is not a creative intermediate.

## Gate

Creative output passes only when deck score is at least 80, every slide is at least 70, slop risk is at most 20, critical findings are zero, and editability is at least L4. Contextual checks come from the design read and dials. Explicit user brand and source intent override generic heuristics. Font compatibility is reported from real font preflight data.

Replica routes do not run this taste gate and must preserve source fidelity.
