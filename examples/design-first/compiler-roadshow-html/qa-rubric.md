# Compiler Roadshow HTML-first Showcase — QA Rubric (qualitative)

This rubric is **qualitative only**. It documents design rationale, tradeoffs, and known limitations. No numeric self-score is asserted here; the automated `slopRisk` scorer and `layout-safety` report are the authority on quantitative quality.

## Showcase scope

- Mirrors `examples/design-first/compiler-roadshow/` outline: same compiler-roadshow narrative arc (cover → problem/solution → three-stage pipeline), extended to nine slides to demonstrate archetype variety on the HTML-first path.
- Uses the new `slide-archetypes/*` (U8) and existing `layout-archetypes/*` catalogs via `data-archetype` attributes.
- HTML-first path: `deck.html` → HTML audit/repair → measurement → `deck.manifest.json` → strict pipeline.
- Deck-plan alignment (verbatim titles, identical content points for the first three slides):
  - slide-001 cover headline: "Modern C Compiler Component" / subtitle "Rust-based GCC-compatible compilation pipeline".
  - slide-002 problem-solution headline: "R&D Background: Why a Self-Contained Compiler Matters" / four problem bullets / one solution summary.
  - slide-003 architecture-layered headline: "Core Technical Path: Three-Stage Compiler Pipeline" / three layers with the same item lists.

## Design rationale

- **Why CSS Grid over coordinate hand-authoring.** Slides 2–4 each have multi-column layouts (2-pane, 3-layer, 6-card) where CSS Grid expresses the geometry faster and more consistently than computing inch coordinates per element.
- **Why `data-archetype` on every section.** The HTML adapter's archetype short-circuit (`scripts/lib/html-to-manifest-core.mjs`) resolves the catalog entry to the correct slot schema and bypasses heuristic detection, making the manifest layout-path deterministic.
- **Why `dark-tech` design system.** The compiler-roadshow tone is premium, technical, and precise. `dark-tech` carries the matching palette (`#07111F` background, `#35D0FF` primary) so colors stay on-tone.
- **Why nine slides.** The three-slide deck plan is the minimum viable deck; this showcase demonstrates that the HTML-first path scales beyond the minimum without losing alignment with the plan.

## Tradeoffs

- **Browser normalization.** The source uses content-driven slide heights. The guarded creative pipeline writes a repaired copy with 1280×720 canvases before measurement; the source showcase remains unchanged.
- **No web assets.** The showcase avoids remote images to keep the run reproducible offline. Adding a hero image would require localizing under `output/assets/` per the SKILL.md "Preserve editability and fidelity" rule.
- **Deck-plan fidelity vs showcase coverage.** The first three slides mirror the core plan messages; slides 4–9 extend the same narrative arc. This is intentional—the showcase demonstrates archetype variety on the same deck topic.

## Known limitations

- **Auto-layout coordinate consistency is not asserted.** Coordinates are produced by archetype resolution, not hand-tuned. A small visual review of the rendered PPTX is still required before shipping.
- **Bilingual parity is partial.** The deck language is `zh-CN` (matching the deck plan), but body copy in this showcase is English so the showcase reads clearly without localization context. A production version would re-translate.
- **Single design system per deck.** The `data-design-system` attribute sets one design system for the entire deck. Mixing design systems across slides is not supported on the HTML-first path.
- **No strict replica path.** This showcase is creative-mode (not strict replica), so it does not exercise the "preserve original layout, color, typography, tone" branch of the replica rules.

## Verification

- `npm run pptx -- html deck.html output` is the authoritative verification command.
- `html-layout-report.json` must contain zero criticals before conversion.
- Manifest layout safety, content coverage, and final PPTX reports remain mandatory after the HTML gate.
