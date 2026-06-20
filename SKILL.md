---
name: pptx-creator
description: Create, convert, recreate, redesign, validate, or repair mostly editable PowerPoint presentations from text, Markdown, HTML, images, PDFs, or mixed inputs. Use when an agent must produce a .pptx, slide deck, PowerPoint, editable presentation, deck manifest, design-first slide artifacts, or PPTX QA reports.
---

# PPTX Creator

Create a structured `deck.manifest.json`, then use deterministic scripts to validate, render, and package it. Keep the manifest as the single source of truth; perform all content and design reasoning in the host agent.

## Execute the core workflow

1. Classify the input as text, HTML, image, PDF, manifest, or mixed.
2. Read only the matching reference from the routing table below.
3. Select and read one `DESIGN.md` in this priority order:
   - user-provided;
   - project-root;
   - input-adjacent;
   - matching built-in under `design-systems/`;
   - `design-systems/business-neutral/DESIGN.md`.
4. Author or compile `output/deck.manifest.json` with local asset paths.
5. Run the pipeline:

   ```bash
   node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
   ```

6. Read `output/editable-report.md`, `output/qa-report.md`, `output/compatibility-report.md`, and `output/output-manifest.json`.
7. Repair the manifest and rerun at most three times. Ask for direction if material issues remain.
8. Return the PPTX path, slide count, editability level, rasterized regions, verification result, and dependency gaps.

## Load references progressively

Do not read every reference up front. Load only the files required by the current route.

| Need | Read |
| --- | --- |
| Text, Markdown, mixed content, batch runs, or common output rules | `references/workflow.md` |
| Creative text-to-deck planning | `references/design-first-workflow.md` |
| Manifest fields, coordinates, elements, or token syntax | `references/manifest-spec.md` |
| Design-system selection or token use | `references/design-md-for-pptx.md` and, only when choosing a built-in, `references/built-in-design-systems.md` |
| Semantic HTML conversion | `references/html-to-pptx.md` |
| CSS-positioned HTML measurement | `references/html-measurement.md` |
| Image or screenshot reconstruction | `references/image-to-pptx.md` |
| PDF page reconstruction | `references/pdf-to-pptx.md` |
| QA, editability, and final reporting | `references/qa-rubric.md` |
| Visual critic findings | `references/visual-critic-rubric.md` |
| Applying bounded repairs | `references/repair-patch-spec.md` |
| Prompt scaffolds for host-agent roles | `references/prompt-library.md` |
| OCR confidence threshold maintenance | `references/calibration.md` |

## Preserve editability and fidelity

- Prefer native text, shapes, lines, tables, charts, icons, and diagrams.
- Use raster assets only for photos or effects that are impractical to rebuild.
- Never describe a full-slide raster with no editable text as an editable deck.
- Preserve source layout, color, typography, content, and tone in strict replica mode; skip creative direction exploration.
- Use web research only when it improves accuracy or asset quality and the user permits it. Record source URLs, respect licenses and trademarks, and localize remote assets under the output directory.
- Do not call LLM APIs from package scripts or ask deterministic scripts to invent content.

## Prepare the runtime

Run setup only when dependencies are not already available:

```bash
npm install
pip install -r requirements.txt
npx playwright install chromium
npm run setup
```

Set `PPTX_CREATOR_PYTHON` when the default Python interpreter cannot be discovered. Treat Playwright, Tesseract, LibreOffice, PyMuPDF, and non-system fonts as optional unless the selected route requires them.
