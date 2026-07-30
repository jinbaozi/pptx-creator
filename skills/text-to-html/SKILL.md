---
name: text-to-html
description: Turn natural-language requests, Markdown, long-form source text, or structured outlines into an offline HTML slide-deck package with a reviewed narrative plan, local assets, speaker notes, source and assumption traceability, versioned interoperability metadata, and real Playwright visual QA. Use for browser-presented decks, editable HTML presentation sources, or the first stage of an explicit text-to-html to html-to-pptx workflow.
---

# Text to HTML

Produce HTML, not PPTX. Keep Host reasoning and deterministic execution separate:

1. Read [workflow.md](references/workflow.md). Establish the audience, setting, core conclusion, action, duration, constraints, assumptions, and source inventory.
2. Read [plan-contract.md](references/plan-contract.md). Turn the input into `presentation-plan.json`; preserve claims, label uncertainty, use conclusion titles, and keep one core message plus at most three supports per slide.
3. Read [visual-design.md](references/visual-design.md). Select layouts from slide intent and review the complete plan before setting `hostReview.status` to `approved`.
4. Run:

   ```bash
   node scripts/run-pipeline.mjs presentation-plan.json output
   ```

5. Read [browser-quality-gate.md](references/browser-quality-gate.md). Inspect every full-size preview and `qa-report.json`; never call a failed or pending package complete.

The command writes an offline 1280×720 deck, local CSS/JS/assets, design tokens, notes, sources, QA evidence, and optional `pptx-creator.presentation-package` metadata version `1.0.0`. It performs at most three bounded regeneration attempts and keeps type above documented floors.

Use `scripts/scaffold-plan.mjs` only to preserve structure from Markdown or plain text. Its output is deliberately unapproved and cannot be packaged until the Host reviews positioning, story, claims, and layouts.

For installation, isolated execution, and publishing, read [installation-and-isolation.md](references/installation-and-isolation.md). For protocol consumers, read [presentation-package-protocol.md](references/presentation-package-protocol.md). For failures, read [errors.md](references/errors.md).

Constraints:

- Do not call an LLM from scripts or invent facts, numbers, sources, quotes, cases, brands, or policies.
- Do not import from a parent repository or sibling Skill. Resolve every runtime file inside this directory.
- Keep runtime assets local and paths package-relative; reject traversal, absolute paths, and missing assets.
- Treat optional protocol output as an interoperability artifact, never as a dependency on another Skill.
- Ask only when a missing decision materially changes the deck; otherwise record a conservative assumption.
