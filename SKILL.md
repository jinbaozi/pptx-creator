---
name: pptx-creator
description: Route editable PowerPoint creation from text, HTML, images, or PDF, plus manifest repair.
---

# PPTX Creator Router

Select exactly one route, then read only its contract and listed references.

| Route | Select when | Contract |
|---|---|---|
| `text` | Text, outline, Markdown, or a document becomes a high-taste editable deck | `references/routes/text.md` |
| `html-replica` | HTML/CSS is the visual source to preserve | `references/routes/html-replica.md` |
| `image-replica` | An image or screenshot is the visual source | `references/routes/image-replica.md` |
| `pdf-replica` | PDF pages are the visual source | `references/routes/pdf-replica.md` |
| `manifest-repair` | An existing manifest plus a bounded patch is repaired | `references/routes/manifest-repair.md` |

The `text` route is Creative Director-led and HTML-first by default. Define the narrative
and visual system, author and visually repair a 1280x720 `deck.html`; the Host
freezes the repaired HTML as the visual source (`deck.repaired.html`), then compiles native objects.

Final text deliverables must use `npm run pptx -- text ...` and carry layout,
geometry, object-lineage, final-review, QA, and output-index evidence.
Do not deliver by invoking PptxGenJS, Office API, or another renderer directly;
those are implementation details and diagnostics only.

User style, brand, template, or reference wins. Otherwise the Host selects from
audience and context; built-ins are candidates, never topic-based defaults.

Legacy `deck.plan.json -> Semantic Slide IR` requires explicit `--native` compatibility mode;
direct manifest rendering requires `--direct`. Both retain their compatibility
contracts but never override the default HTML-first route.

## Shared invariants

- For deterministic rendering, the manifest is the single source of truth
  consumed by scripts. In default text runs, the repaired HTML is the frozen
  visual source and the manifest is its native-object compilation result.
- Never use a full-slide raster as an editable PPTX.
- User-supplied replica routes preserve source layout, color, typography, and
  tone and never add creative exploration. Default text runs complete creative
  exploration before freezing their internally authored HTML replica source.
- Final full-size slide review must confirm that text remains inside its
  intended frame and every connector arrow terminates at its declared target.
- Default text runs use the `creative` layout-safety profile even while HTML
  fidelity is proved through the replica compiler. Unapproved content or
  decorative occlusion, unsafe CJK line height, and unbalanced layout-region
  gaps are blocking defects.
- Block wrapped metrics; use metric/price groups, more width, or another slide.
- Lists use natural `<ul>/<ol>/<li>` flow and retain measured item geometry.
- Single-line table headers use `valign: middle` and line height `1.0–1.4`.
- Bind facts/claims/recommendations to typed evidence and clickable sources;
  visibly label vendor claims and internal recommendations.
- Creative floors: title 28pt, card title 18pt, body/list 16pt, label/header
  11pt, source 9pt. Repair cannot cross them. See authoring and QA references.
- Every HTML-first final review is packet-bound to the repaired HTML, manifest,
  candidate PPTX, geometry report, contact sheet, and every full-size slide.
  It explicitly records `noOcclusion`, `textRhythm`, `whitespaceBalance`,
  `connectorSemantics`, and `componentVisibility` for each slide.
  Acceptance is published as `host-html-visual-review.json`; until it validates, top-level `final.pptx` is not a deliverable.
- Every connector between modules must declare source, target, anchors, route,
  and a target-facing end marker. Detached, reversed, obstructed, or invalidly
  routed connectors block packaging.
- Automatic repair is bounded to at most three attempts, then it must block and
  ask for user direction.
- Localize remote assets before deterministic compilation; scripts never search
  the web or call an LLM. `provenance.rights` is the sole rights authority.
  Runtime asset paths are normalized POSIX paths below `assets/`; remote
  HTTP(S) URLs may remain only as provenance.
- Report editability gaps honestly and preserve unrelated files.

## Public entry point

Use `npm run pptx -- <text|html|image|pdf|manifest> ...`. Each route contract defines its one public command, inputs, outputs, and blocking conditions.
