# Compiler Roadshow HTML-first Showcase — QA Rubric (qualitative)

This rubric is **qualitative only**. It documents design rationale, tradeoffs, and known limitations. No numeric self-score is asserted here; the automated `slopRisk` scorer and `layout-safety` report are the authority on quantitative quality.

## Showcase scope

- Mirrors `examples/design-first/compiler-roadshow/` outline: same compiler-roadshow narrative arc (cover → problem/solution → three-stage pipeline), extended to nine slides to demonstrate archetype variety on the HTML-first path.
- Uses the new `slide-archetypes/*` (U8) and existing `layout-archetypes/*` catalogs via `data-archetype` attributes.
- HTML-first path: `deck.html` → `node scripts/html-to-manifest.mjs` → `deck.manifest.json` → pipeline.
- Storyboard alignment (verbatim titles, identical content points for the first three slides):
  - slide-001 cover headline: "Modern C Compiler Component" / subtitle "Rust-based GCC-compatible compilation pipeline".
  - slide-002 problem-solution headline: "R&D Background: Why a Self-Contained Compiler Matters" / four problem bullets / one solution summary.
  - slide-003 architecture-layered headline: "Core Technical Path: Three-Stage Compiler Pipeline" / three layers with the same item lists.

## Design rationale

- **Why CSS Grid over coordinate hand-authoring.** Slides 2–4 each have multi-column layouts (2-pane, 3-layer, 6-card) where CSS Grid expresses the geometry faster and more consistently than computing inch coordinates per element.
- **Why `data-archetype` on every section.** The HTML adapter's archetype short-circuit (`scripts/lib/html-to-manifest-core.mjs`) resolves the catalog entry to the correct slot schema and bypasses heuristic detection, making the manifest layout-path deterministic.
- **Why `dark-tech` design system.** The compiler-roadshow tone is "premium / technical / precise" (`deck.design-direction.json`). `dark-tech` carries the matching palette (`#07111F` background, `#35D0FF` primary) so colors stay on-tone.
- **Why nine slides.** The three-slide storyboard is the minimum viable deck; this showcase demonstrates that the HTML-first path scales beyond the minimum without losing alignment with the design-first artifacts.

## Tradeoffs

- **Empty `elements` arrays in the produced manifest.** The HTML adapter emits `path: "measured"` and an `archetype` reference when `data-archetype` is present; per-slide `elements` get populated by the renderer's archetype expansion rather than the HTML adapter. This is intentional but means `node scripts/html-to-manifest.mjs` reports `elements: 0` in its summary — the count is recovered at render time.
- **No web assets.** The showcase avoids remote images to keep the run reproducible offline. Adding a hero image would require localizing under `output/assets/` per the SKILL.md "Preserve editability and fidelity" rule.
- **Storyboard fidelity vs showcase coverage.** The first three slides are strict storyboard mirrors (verbatim titles, same content points); slides 4–9 are extensions that follow the same narrative arc but are not 1:1 with any `slide-design-specs.json` entry. This is intentional — the showcase demonstrates archetype variety on the same deck topic.

## Known limitations

- **Auto-layout coordinate consistency is not asserted.** Coordinates are produced by archetype resolution, not hand-tuned. A small visual review of the rendered PPTX is still required before shipping.
- **Bilingual parity is partial.** The deck language is `zh-CN` (matching the storyboard), but body copy in this showcase is English so the showcase reads clearly without localization context. A production version would re-translate.
- **Single design system per deck.** The `data-design-system` attribute sets one design system for the entire deck. Mixing design systems across slides is not supported on the HTML-first path.
- **No strict replica path.** This showcase is creative-mode (not strict replica), so it does not exercise the "preserve original layout, color, typography, tone" branch of the replica rules.

## Verification

- `node scripts/html-to-manifest.mjs` produced 9 slides with `designSystem: "Dark Tech"`.
- `python scripts/validate-manifest.py` reports `manifest valid`.
- The full pipeline (`node scripts/run-deck-pipeline.mjs`) and `slopRisk` / `layout-safety` reports remain the quantitative authority for shipped decks.