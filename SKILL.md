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

Do not combine creative rules with replica rules. The `text` route is creative
by default: the host agent edits the narrative and visual direction, then keeps
`deck.plan.json` and `deck.manifest.json` as internal evidence. Direct manifest
rendering is an explicit advanced compatibility path only. HTML is optional,
never a mandatory text intermediate.

## Shared invariants

- The manifest is the single source of truth; deterministic scripts render it.
- Never use a full-slide raster as an editable PPTX.
- Replica routes preserve source layout, color, typography, and tone; they do
  not explore creative directions.
- Creative exploration belongs only to the text route.
- Automatic repair is bounded to at most three attempts, then it must block and
  ask for user direction.
- Localize remote assets before validation; scripts never search the web or call
  an LLM.
- Report editability gaps honestly and preserve unrelated files.

## Public entry point

Use `npm run pptx -- <text|html|image|pdf|manifest> ...`. Each route contract
defines its one public command, inputs, outputs, and blocking conditions.
