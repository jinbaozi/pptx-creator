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
HTML-to-native-PPTX replica
compiler. The final deck must preserve native text, shapes, tables, charts, and
semantic connectors; a full-slide screenshot is forbidden.

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

Use `npm run pptx -- <text|html|image|pdf|manifest> ...`. Each route contract
defines its one public command, inputs, outputs, and blocking conditions.
