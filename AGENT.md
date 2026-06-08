# PPTX Creator Agent Guide

This guide is for host agents that use `pptx-creator` to create editable PowerPoint files. Package scripts are deterministic helpers; the host agent performs all reasoning, content planning, visual interpretation, and repair decisions.

## Operating Contract

- Read `SKILL.md` first, then read the relevant reference file for the input type.
- Always choose or read a `DESIGN.md` before writing a manifest.
- Write a valid `deck.manifest.json`; do not ask package scripts to invent content.
- Prefer native PowerPoint objects: text, shapes, lines, tables, and images only where needed.
- Never call an LLM API from package scripts.
- Never silently output a full-slide raster image and call it editable.
- Host agents may autonomously use web search during planning, writing, design, and asset discovery when it improves factual accuracy, visual quality, layout references, or source material quality.
- Do not fabricate facts, metrics, case studies, source attributions, logos, or copyrighted/trademarked assets. When search informs content or assets, record the source URLs and any licensing/trademark caveats in the output notes or QA summary.
- Remote assets found online must be localized before rendering. Save them under the output directory, typically `output/assets/`, and reference them from the manifest with local relative paths.
- Run the pipeline and read reports before responding.

## Default Flow

1. Classify the input: text, HTML, image, or mixed.
2. Select a design system:
   - User-provided `DESIGN.md`
   - Project `DESIGN.md`
   - Input-adjacent `DESIGN.md`
   - Built-in `design-systems/<name>/DESIGN.md`
   - Fallback: `design-systems/business-neutral/DESIGN.md`
3. Read the selected `DESIGN.md`, `references/manifest-spec.md`, and the input-specific workflow reference.
4. Decide whether web search is useful:
   - Search when facts may be current or uncertain, when the topic is specialized, when visual/material references would improve the deck, or when user asks for online素材.
   - Skip search when the user forbids it, the provided input is sufficient, or exact 1:1 replication would be altered by outside references.
5. Author `output/deck.manifest.json`; localize any remote images or materials.
6. Run:

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

7. Read:
   - `output/editable-report.md`
   - `output/qa-report.md`
   - `output/output-manifest.json`
8. Respond with the PPTX path, editability level, rasterized regions, dependency gaps, and important sources used.

For creative text-to-PPTX work, use design-first mode before authoring the final manifest: write `deck.storyboard.json`, `deck.design-direction.json`, and `slide-design-specs.json`, then compile them into `deck.manifest.json`. For strict Replica mode, preserve source fidelity and do not beautify the source design.

## Web Search and Source Policy

Web search is available to the host agent throughout the PPTX creation process. Use it as an optional quality amplifier, not as a mandatory ceremony.

Good reasons to search:

- Verify facts, dates, product names, technical capabilities, standards, market context, and public company/project information.
- Collect visual references for layout, tone, iconography, diagrams, or comparable roadshow decks.
- Locate source material for screenshots, public documentation, technical diagrams, or imagery.
- Improve Chinese/English wording with domain-appropriate terminology.

Guardrails:

- If a slide is a strict 1:1 HTML/image/PDF replica, outside references may help identify assets or fonts, but must not change the original layout, color, tone, typography, or content.
- Do not use logos, trademarks, copyrighted images, commercial fonts, or brand-specific claims unless the user provides them or usage is clearly permitted.
- Downloaded or discovered assets must be stored locally before rendering. `html-to-manifest.mjs` localizes remote image URLs for HTML inputs; host-authored manifests should do the same manually.
- Keep a concise source list in `qa-report.md`, a companion notes file, or the final response when the deck's claims or assets depend on web research.

## Input Type Routing

| Input | Primary reference | Typical commands |
| --- | --- | --- |
| Text or Markdown | `references/workflow.md`, `references/prompt-library.md` | Host agent writes manifest, then runs pipeline |
| Semantic HTML | `references/html-to-pptx.md` | `node scripts/html-to-manifest.mjs input.html output/deck.manifest.json` |
| CSS-positioned HTML | `references/html-measurement.md` | `measure-html.mjs`, then `html-to-manifest.mjs --measurements` |
| Image or screenshot | `references/image-to-pptx.md` | `image-to-manifest-hints.py`, optional OCR/palette/crop |
| Mixed style + content | `references/workflow.md` | Extract style hints, write a new content manifest |

## Repair Loop

Use at most three automatic repair attempts before asking the user.

1. Read validator errors or QA risks.
2. Fix the manifest source of truth.
3. Re-run `run-deck-pipeline.mjs`.
4. If a dependency is missing, report it honestly instead of pretending the feature ran.

Common repairs:

- Text overflow: shorten copy, split slide, increase box height, or reduce density.
- Low editability: replace raster regions with text/shape/table elements where reasonable.
- Missing assets: fix paths or remove the asset reference.
- Design drift: return to the selected `DESIGN.md` tokens.

## Final Response Checklist

- `final.pptx` path.
- Slide count.
- Overall editability level.
- What is editable vs rasterized.
- Any missing optional tools: Playwright, Tesseract, LibreOffice, fonts.
- Suggested next edits in PowerPoint/WPS.
