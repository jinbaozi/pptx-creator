# Text HTML authoring contract

Default text-to-PPTX generation is a two-part contract:

1. The Host Agent creates and visually accepts the design in HTML.
2. Deterministic scripts freeze that HTML and reproduce it as mostly editable PowerPoint objects.

## Before authoring HTML

Write down the one-sentence communication task, audience outcome, narrative arc,
visual concept, palette, typography, material and image language, whitespace and
density policy, page rhythm, editability target, and forbidden visual patterns.
Flagship work compares two to four materially different directions using at
least three representative pages per direction. A palette swap is not a new
direction.

## HTML canvas and native conversion

- Use one `<section class="pptx-slide">` per 1280x720 slide.
- Give every editable object a globally unique `data-pptx-id`.
- Mark native text, shape, image, table, chart, and line intent with supported
  semantic markup or `data-pptx-kind`.
- Use HTML/CSS for composition and browser proof, but prefer effects that map to
  native PowerPoint objects. Unsupported local effects may use bounded crops;
  full-slide rasters are forbidden.
- Keep all runtime assets local. Remote URLs are provenance only after
  localization.
- Do not use generic cards, short floating rules, or decorative arrows as a
  substitute for explaining a relationship.

## Module connector contract

Every line that communicates a relationship between modules must be an SVG
line, simple path, or polyline and declare:

```html
<line
  data-connector
  data-pptx-kind="line"
  data-pptx-id="flow-a-b"
  data-source-id="module-a"
  data-target-id="module-b"
  data-source-anchor="auto"
  data-target-anchor="auto"
  data-connector-route="straight"
  marker-end="url(#arrow)" />
```

Source and target IDs must identify distinct non-line modules on the same
slide. Allowed anchors are `auto`, `top`, `right`, `bottom`, and `left`.
Allowed routes are `straight` and `orthogonal`. Auto anchors use the
center-to-center ray intersection with each module boundary. The end marker
must face the target. A connector fails when it is detached from the declared
anchor, reversed, missing its end marker, represented as a diagonal while
declaring an orthogonal route, or crosses an unrelated module.

Axes, dividers, and decorative rules must declare their non-connector role and
must not use arrow markers or connector-like IDs.

## Proof sequence

Run browser layout audit and bounded HTML repair first. Only a critical-free
repaired HTML file becomes the replica source. Then measure DOM geometry,
compile native objects, render the PPTX, compare its pages with the frozen HTML,
and repair bounded object drift at most three times. Packaging is rejected when
connector checks, content coverage, editability, fidelity proof, or final visual
inspection fails.
