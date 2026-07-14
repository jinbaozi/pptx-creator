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
`semantic-slide-ir.json`, validated `assets/asset-registry.json` 0.2, and
`deck.manifest.json` as evidence. `run.json` indexes the real published
artifacts. The Creative evidence transaction writes plan, IR, public registry,
then run; publication commits only after packaging succeeds, and hook or
package failure triggers best-effort reverse rollback before blocked evidence
is written. The public registry records provenance and verified localized
bytes; `.pptx-generated-assets.json` is a separate private cleanup sidecar.
Direct manifest rendering is an explicit advanced compatibility path
only. HTML is optional, never a mandatory text intermediate.
An optional `compositionIntent.blockId` is a host-authored Creative choice;
deterministic scripts validate and snapshot it but never rank or infer blocks.
Without that field, the existing family geometry is unchanged.
High-risk text plans may enter the conditional two-stage direction protocol in
`references/creative-direction-probes.md`: the host authors bounded
coordinate-free candidates, inspects anonymous rendered evidence, and records
complete pairwise preference. Scripts never invent a candidate or select from
diagnostic scores.
Every full Creative deck then enters the separate final-review resume protocol
in `references/creative-visual-proof.md`. Deterministic evidence alone is never
accepted: the host must inspect every full-size rendered slide and provide a
packet-bound `--host-final-review` sidecar. Until then the pipeline exposes only
candidate evidence and withholds the top-level PPTX, successful run index, and
output manifest.
A rejecting final review follows `references/creative-refinement.md`: emit a
dry-run evidence plan, wait for one protected Host-approved operation, then
render and review again. Creative repair/refinement shares a three-delta cap.

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
- Localize remote assets before deterministic compilation; scripts never search
  the web or call an LLM. `provenance.rights` is the sole rights authority.
  Runtime asset paths are normalized POSIX paths below `assets/`; remote
  HTTP(S) URLs may remain only as provenance.
- Report editability gaps honestly and preserve unrelated files.

## Public entry point

Use `npm run pptx -- <text|html|image|pdf|manifest> ...`. Each route contract
defines its one public command, inputs, outputs, and blocking conditions.
