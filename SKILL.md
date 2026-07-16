---
name: pptx-creator
description: Route editable PowerPoint creation from text, HTML, images, or PDF, plus manifest repair.
---

# PPTX Creator Router

Select exactly one route from the input and requested outcome. Read only that
route contract and its listed next references before acting.

| Route | Select when | Contract |
|---|---|---|
| `text` | Text, outline, Markdown, or a document becomes a high-taste editable deck | `references/routes/text.md` |
| `html-replica` | HTML/CSS is the visual source to preserve | `references/routes/html-replica.md` |
| `image-replica` | An image or screenshot is the visual source | `references/routes/image-replica.md` |
| `pdf-replica` | PDF pages are the visual source | `references/routes/pdf-replica.md` |
| `manifest-repair` | An existing manifest plus a bounded patch is repaired | `references/routes/manifest-repair.md` |

The `text` route is Creative Director-led and HTML-first by default. Before any
PPT coordinates exist, the host defines the communication task, narrative,
visual concept, typography, palette, composition rules, image strategy,
editability target, and connector semantics. It then authors a complete local
`deck.html`, visually proves and repairs that 1280x720 HTML, freezes the repaired
HTML as the visual source (`deck.repaired.html`), and runs the strict
HTML-to-native-PPTX replica compiler. The final deck must preserve native text, shapes, tables, charts, and
semantic connectors; a full-slide screenshot is forbidden.

Do not deliver a deck produced by calling PptxGenJS, Artifact Tool, Office API,
or another renderer directly. Those may be implementation details or local
diagnostics only. A final text-route deliverable must be created by the packaged
entry point `npm run pptx -- text ...` and must carry its layout, PPTX geometry,
object-lineage, final-review, QA, and output-index evidence.

Style resolution is Host-owned. An explicit user-requested style, brand,
template, or visual reference wins. When the user does not specify a style, the
Host judges it from the audience, content, delivery context, and readability.
Built-ins are candidates, never automatic topic-based defaults; AI, cloud,
security, or developer-tool content must not automatically select `dark-tech`.

The former `deck.plan.json -> Semantic Slide IR` compiler remains available
only through explicit `--native` compatibility mode. Direct manifest rendering
still requires `--direct`. Neither compatibility path is the default.
The `--native` route retains its composition-block, direction-probe, Creative
Proof, resumable final-review, refinement, and benchmark contracts for existing
integrations. Those contracts do not override the default HTML-first route.

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
