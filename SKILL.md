---
name: pptx-creator
description: Route editable PowerPoint creation from text, HTML, images, or PDF, plus manifest repair.
---

# PPTX Creator Router

> V2.0 将核心能力拆分为三个可独立安装的标准 Skill：
> `skills/text-to-html`、`skills/html-to-pptx` 和
> `skills/image-to-pptx`。本根级 Router 仅保留迁移期兼容入口；新的
> 文本到 PPTX 链路应显式组合 `$text-to-html` 与 `$html-to-pptx`。

Select exactly one route, then read only its contract and listed references.

Invoking this Skill selects the project pipeline exclusively for the run. Do
not switch to a generic presentations/artifact tool, Office automation, or a
standalone PptxGenJS script. Such tools may inspect evidence but cannot produce
the deliverable or replace any project gate.

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
An isolated `.pptx` is unfinished. Delivery requires one mutually bound package
containing `deck.manifest.json`, a passing `pptx-geometry-report.json`, a
completed per-slide Host review, `output-manifest.json`, and `final.pptx`.
The geometry report binds manifest and PPTX hashes; the output index records
artifact hashes, so colocated but stale evidence is still rejected.

User style, brand, template, or reference wins. Otherwise the Host selects from
audience and context; built-ins are candidates, never topic-based defaults.

Legacy `deck.plan.json -> Semantic Slide IR` requires explicit `--native` compatibility mode;
direct manifest rendering requires `--direct`. Both retain their compatibility
contracts but never override the default HTML-first route.

## Shared invariants

- The repaired HTML is the frozen default-text visual source; the compiled
  manifest is the single source of truth for deterministic rendering.
- Never use a full-slide raster as an editable PPTX.
- Replica routes preserve source layout/style. Default text explores first,
  then freezes HTML and retains the creative safety profile during compilation.
- Full-size review confirms text remains inside its intended frame and every
  connector arrow terminates at its declared target.
- Block wrapped metrics; use metric/price groups, more width, or another slide.
- Use natural `<ul>/<ol>/<li>` flow; center single-line headers at line height `1.0–1.4`.
- Bind facts/claims/recommendations to typed evidence and clickable sources;
  visibly label vendor claims and internal recommendations.
- Creative floors are title 28pt, card title 18pt, body/list 16pt,
  label/header 11pt, source 9pt; repair cannot cross them.
- Titles default to one line. Two lines require `data-max-lines="2"` / `maxLines: 2`,
  measured height, and content below the painted bottom; never use viewer autofit.
- Rounded containers use `data-safe-inset` (default `0.12in`); children cannot
  enter the rounded-corner tangent zone.
- HTML-first review binds repaired HTML, manifest, PPTX, geometry, contact sheet,
  every slide, observations, `noOcclusion`, `textRhythm`, `whitespaceBalance`,
  `connectorSemantics`, `componentVisibility`, and passed PowerPoint/WPS/LibreOffice evidence
  in `host-html-visual-review.json`.
- Connectors declare endpoints, anchors, route, and target marker; invalid geometry blocks.
- Automatic repair is bounded to at most three attempts before requesting direction.
- Localize assets; scripts never search/call an LLM. Runtime paths stay below
  `assets/`, remote URLs are provenance only, and `provenance.rights` is authoritative.
- Report editability gaps honestly and preserve unrelated files.

## Public entry point

Use `npm run pptx -- <text|html|image|pdf|manifest> ...`. Each route contract defines its one public command, inputs, outputs, and blocking conditions.
