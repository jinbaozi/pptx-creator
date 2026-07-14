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
by default: the host agent edits the narrative and visual direction, then after
successful packaging keeps `deck.plan.json`, the selected canonical
`semantic-slide-ir.json`, and `deck.manifest.json` as internal evidence.
`run.json` indexes the real published
artifacts. IR and run publication commits only after packaging succeeds; hook
or package failure triggers best-effort rollback before blocked evidence is
written. Direct manifest rendering is an explicit advanced compatibility path
only. HTML is optional, never a mandatory text intermediate.
An optional `compositionIntent.blockId` is a host-authored Creative choice;
deterministic scripts validate and snapshot it but never rank or infer blocks.
Without that field, the existing family geometry is unchanged.

## Shared invariants

- For deterministic rendering, the manifest is the single source of truth
  consumed by scripts. In Creative text runs, Semantic Slide IR is the
  authoring truth that lowers to that render contract.
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
