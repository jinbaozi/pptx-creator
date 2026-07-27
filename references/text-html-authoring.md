# Text HTML authoring contract

Default text-to-PPTX generation is a two-part contract:

1. The Host Agent creates and visually accepts the design in HTML.
2. Deterministic scripts freeze that HTML and reproduce it as mostly editable PowerPoint objects.

## Before authoring HTML

Write down the one-sentence communication task, audience outcome, narrative arc,
visual concept, palette, typography, material and image language, whitespace and
density policy, page rhythm, editability target, and forbidden visual patterns.
Treat this as the Deck Read: deck kind, audience, communication job, delivery
environment, vibe, references, brand assets, accessibility constraints, and
regulatory constraints. Lock three explicit slide-native controls before
exploration: composition variance, visual density, and narrative tempo
(represented by the existing `visualEnergy` dial). These controls describe the
brief; they are not universal preferences.
Start from the user's explicit style, brand, template, or visual references. If
none are provided, make a Host judgment from the audience, content, delivery
environment, language, readability, and emotional tone; do not auto-select a
built-in from topic keywords.
Flagship work compares two to four materially different directions using at
least three representative pages per direction. A palette swap is not a new
direction. Test the cover, a representative content page, and the most
data- or structure-heavy page. Record why the selected direction won and which
rejected characteristics must not drift back into the full deck.

## HTML canvas and native conversion

- Use one `<section class="pptx-slide">` per 1280x720 slide.
- The browser source must settle after fonts and local images load. Geometry is
  accepted only after two consecutive DOM snapshots agree; an unstable source
  blocks measurement instead of producing a race-dependent PPTX.
- Give every editable object a globally unique `data-pptx-id`.
- When text or media belongs inside a visible panel/card, set
  `data-semantic-parent-id="<container-id>"`. The compiled element must remain
  fully inside that referenced shape. Mark the parent with a container-like
  ID or role (`panel`, `card`, `container`, `surface`, or `module`) so
  the containment gate is unambiguous; reducing font size is not an acceptable
  substitute for repairing the geometry.
- Use `data-layout-region="<id>"` on stacked content and implement it with CSS
  flex/grid. Adjacent vertical gaps must remain between 0.25em and 0.75in;
  larger intentional whitespace requires `data-gap-intent="spacious"`.
- A content slide whose substantive objects are compressed into one edge or
  corner fails as `excessive-whitespace`. Sparse covers, section breaks,
  quotations, closings, or deliberately breathing content must declare
  `data-whitespace-intent="spacious"`; this documents intent but never exempts
  overlap, clipping, bounds, or text-fit failures.
- Unapproved overlap is forbidden. When a specific pair must overlap by design,
  declare only that pair with `data-allow-overlap-with="<other-id>"`; do not use
  a global exemption.
- CJK body copy must use computed line-height at least 1.20 (1.35 preferred),
  and adjacent list items need at least 0.35em paragraph spacing. Use real
  `<ul>/<ol>/<li>` markup instead of separate dot and text objects. Keep every
  `li` at natural height; do not use a shared fixed height.
- Keep Creative text at or above these post-compilation floors: slide title
  28pt, card title 18pt, body/list 16pt, label/table header 11pt, source 9pt.
- Use an `<h1>` for the slide title and declare `data-max-lines="1"` (the
  default). A deliberate two-line title must use `data-max-lines="2"`; its box
  height is computed from the actual font metrics, and the following content
  starts after the measured painted bottom plus at least `0.12in`. Never pin
  content to a nominal `y` that assumes a single title line. If 28pt cannot fit,
  shorten the title, widen the title region, or switch layouts. Do not depend on
  `normAutofit`, `spAutoFit`, or another viewer-specific auto-shrink behavior.
- Rounded cards and panels use `data-safe-inset` when the default `0.12in`
  inner frame is insufficient. Every semantic child, including axis labels and
  corner captions, must remain inside that inset, not merely inside the outer
  rectangle.
- Mark atomic metrics with `data-layout-role="metric"`. If browser measurement
  wraps one onto a second line, change the component to a price group, metric
  group, wider layout, or another slide. Do not shrink below the role floor and
  do not let an automatic repair split prices, dates, or formulas.
- Use `vertical-align: middle` or flex centering for a single-line `<th>` and a
  computed line-height in the 1.0–1.4 range. Do not use oversized line-height to
  push text toward the center.
- Mark native text, shape, image, table, chart, and line intent with supported
  semantic markup or `data-pptx-kind`.
- Mark footer rules and folios explicitly with `data-layout-role="footer-decoration"`
  or `data-layout-role="slide-number"` and `data-layout-region="footer"`.
  Body content must end above the first footer element.
- Use HTML/CSS for composition and browser proof, but prefer effects that map to
  native PowerPoint objects. Unsupported local effects may use bounded crops;
  full-slide rasters are forbidden.
- Keep all runtime assets local. Remote URLs are provenance only after
  localization.
- Register cited sources on clickable anchors with `data-source-id` and `href`.
  Mark claims with `data-evidence-kind`, `data-source-ids`, and `data-as-of`:

```html
<p data-pptx-kind="text"
   data-pptx-id="claim-k3"
   data-evidence-kind="vendor-claim"
   data-source-ids="vendor-doc"
   data-as-of="2026-07-17">厂商声明：该数字来自公开技术文档。</p>
<a data-pptx-kind="text"
   data-pptx-id="source-k3"
   data-layout-role="source"
   data-source-id="vendor-doc"
   href="https://example.com/vendor-doc">https://example.com/vendor-doc</a>
```

  Use one of `official-fact`, `vendor-claim`, `secondary-report`, or
  `internal-recommendation`. Vendor claims and internal recommendations must
  include the visible label in the slide copy; official, vendor, and secondary
  evidence must bind at least one registered source.
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
must not use connector-like IDs. Axes use `data-layout-role="axis"` plus
`data-axis-direction="left|right|up|down"`; their direction is validated
separately from source/target relationship arrows.

## Proof sequence

Run browser layout audit and bounded HTML repair first. Only a critical-free
repaired HTML file becomes the replica source. Then measure DOM geometry,
compile native objects, render the PPTX, compare its pages with the frozen HTML,
and repair bounded object drift at most three times. Packaging is rejected when
connector checks, content coverage, editability, fidelity proof, or final visual
inspection fails. Automatic repairs run in this order: normalize line height,
vertical alignment, and natural list height; grow text inside the semantic
parent and footer-safe band; reflow siblings or grow the parent; change card
columns or paginate; only then reduce type without crossing its role floor.
Re-run text fit and layout safety after every change, for at most three rounds.
A `metric-wrap` finding is Host-owned and is never automatically split. Repairs
must not clip content to silence a gate.
