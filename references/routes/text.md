# Text route

## Trigger

Select for prose, outlines, Markdown, text documents, or an internal `deck.plan.json`. The host agent may change page count, titles, compression, and narrative order, but must not invent facts, metrics, or sources. Users should only need to ask for the final editable PPTX.

## Exclusions

Do not select when HTML, an image, or a PDF defines the visual layout, or when applying a repair patch.

## Public command

npm run pptx -- text <deck.html|plan-directory|deck.plan.json> <output-dir> [--design-system <path-or-name>] [--host-final-review <json>]

## Inputs and outputs

The host follows `references/design-first-workflow.md` and `references/text-html-authoring.md`. It turns raw text into a narrative and Creative Direction, authors a complete `deck.html`, inspects real browser screenshots, repairs critical HTML geometry, then freezes the repaired HTML as the strict visual source. Deterministic scripts measure that source, compile it into native PowerPoint objects, compare the rendered PPTX against the HTML source, apply at most three bounded geometry repairs, and package only accepted output.

HTML is the mandatory default text intermediate. The input may be the HTML file itself, a directory containing `deck.html` or `visual-source.html`, or a plan file with one of those HTML files beside it. Missing HTML fails closed. The former eight-family Semantic Slide IR compiler is available only with `--native`; an authored manifest requires `--direct`. `--creative` is a deprecated no-op alias because the default route is already creative and HTML-first.

On the default route, the Host-authored CSS is the visual system. An explicit
user-requested style, brand, template, or visual reference wins. Without one,
the Host judges the direction from audience, content, delivery environment,
language, readability, and emotional tone; topic keywords must not auto-select
`dark-tech` or another built-in. An optional built-in `--design-system` value
supplies portable PowerPoint theme metadata; it must not replace or restyle the
accepted HTML. Existing `DESIGN.md` path selection remains available in
`--native` compatibility mode.

For flagship work, the Host still explores two to four materially different
directions and compares representative multi-page browser screenshots before
authoring the selected full HTML deck. Direction selection is a Host decision;
deterministic scripts neither invent nor rank creative candidates.

The selected full HTML deck is reviewed before it becomes the replica source.
After conversion, source-vs-PPTX fidelity proof and final per-slide visual
inspection are both required. A green structural check never substitutes for
visual acceptance.

The first successful deterministic pass writes full-size PNGs, a contact sheet,
`html-final-review/review-packet.json`, and a deliberately incomplete
`pending/null` review template, then
blocks at `host-final-visual-review` without publishing top-level `final.pptx`.
The Host inspects every page and reruns the same command with
`--host-final-review <json>`. The sidecar must bind the packet and record
`noOcclusion`, `textRhythm`, `whitespaceBalance`, `connectorSemantics`, and
`componentVisibility` plus a non-empty observation summary for every slide.
It must also bind passed evidence for PowerPoint, WPS, and LibreOffice; an
unavailable suite cannot be claimed as passed. Copying the generated template
unchanged is invalid. Rejection returns to the earliest HTML, layout, or
connector responsibility layer; three rejected rounds exhaust the automatic
review budget.

Assets used by HTML must be local before compilation. The compiler preserves
native images and localized bounded fallbacks, records coverage, and forbids a
full-slide fallback. Reusing an output directory invalidates stale public
artifacts while preserving the frozen input and unrelated user files.

The `--native` compatibility mode retains the existing `deck.plan.json`,
Semantic Slide IR, asset registry, direction-probe, Creative Proof, final-review,
and refinement contracts described in their dedicated references.

Successful default output contains `deck.source.html`, `deck.repaired.html`,
`html-repair-report.json`, `html-layout-report.json`, layout measurements,
`deck.manifest.json`, `replica-evidence.json`, `pptx-geometry-report.json`,
`html-final-review/review-packet.json`, `host-html-visual-review.json`,
editability and QA reports, `final.pptx`, and `output-manifest.json`. The `--native` compatibility route
retains its existing Semantic IR and Creative Proof artifacts.

## Blocking conditions

Block on missing HTML, a symlink output root, browser layout defects, incomplete
content coverage, detached/reversed/obstructed connectors, invalid manifest,
negative PPTX line extents, stale/missing manifest object lineage,
generic PPTX object names, a title exceeding its declared line count, title
content entering the painted title band, rounded-container safe-inset entry,
viewer-dependent autofit on critical text, missing cross-suite evidence,
full-slide rasterization, editability below the requested floor, failed HTML to
PPTX fidelity proof, more than three repair attempts, or a rejecting final
visual review. `--native` additionally retains its plan, IR, provenance,
Creative Proof, and resumable Host-review blocking conditions.

## Next references

1. `references/creative-intent.md`
2. `references/text-html-authoring.md`
3. `references/html-measurement.md`

## Migration from 0.1.1

| 0.1.1 | 0.2.0 |
|---|---|
| `version: "0.1.1"` | `version: "0.2.0"` |
| `designSystem.mode: balanced\|inspired` | `metadata.mode: creative` |
| `designSystem.mode: strict` with HTML/image/PDF | `metadata.mode: replica` |
| `designSystem.mode: strict` otherwise | Manually choose `metadata.mode: direct\|repair` |
| input implied by workflow | `metadata.inputType: text\|html\|image\|pdf\|manifest\|mixed` |
| quality implied by mode | `metadata.qualityProfile: light\|creative\|replica` |
| private `_...` provenance | `metadata.designIntent`, `metadata.replicaSource`, or `metadata.generator` |
| `designSystem.mode` | Removed; `designSystem` keeps theme source/name/tokens only |
