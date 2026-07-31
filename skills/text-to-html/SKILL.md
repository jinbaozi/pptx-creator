---
name: text-to-html
description: Turn natural-language requests, Markdown, long-form source text, or structured outlines into an offline HTML slide-deck package using the reviewed Text-to-HTML Plan 2.0 contract, localized assets, traceable evidence, and browser QA. Use for browser-presented decks, editable HTML presentation sources, or the first stage of an explicit text-to-html to html-to-pptx workflow.
---

# Text to HTML

Produce HTML, not PPTX. Keep Host judgment separate from deterministic execution.

1. Read [plan-contract.md](references/plan-contract.md). Create a complete `presentation-plan.json` with `version: "2.0.0"`: a delivery `brief`, narrative, locked `designIntent`, pagination budget, semantic slides, evidence, assets, and three independent review approvals.
2. Read [visual-design.md](references/visual-design.md). Choose the presentation direction before approving the plan; do not let deterministic scripts invent a story, brand, source, or visual rationale.
3. Localize every asset and resolve its rights/provenance before delivery. Read [plan-contract.md](references/plan-contract.md) for allowed locators and the emitted `asset-ledger.json`, `license-report.json`, and `NOTICE`.
4. Run the bounded build and browser-QA loop:

   ```bash
   node scripts/run-pipeline.mjs presentation-plan.json output
   ```

5. Read [browser-quality-gate.md](references/browser-quality-gate.md). Inspect every full-size preview and `qa-report.json`; a pending or failed QA result is not a complete package.

Plan 2.0 is the only accepted plan contract. A Plan 1.x input is rejected with `E_PLAN_VERSION`; do not send it to the pipeline.

The command writes an offline 1280×720 deck, local CSS/JS/assets, notes, source traceability, immutable plan/report evidence, QA evidence, and an optional `pptx-creator.presentation-package` core record at version `1.0.0`. That record may include the optional `pptx-creator.text-to-html/v2` extension; it does not change the core protocol version or make another Skill a runtime dependency.

Use `scripts/scaffold-plan.mjs` only to preserve structure from Markdown or plain text. It creates a Plan 2.0 draft with all review approvals still required. Use `node scripts/run-pipeline.mjs draft-plan.json preview --mode draft` only for a pending local preview; it never runs final QA or emits an accepted manifest. The Host must complete and approve the brief, narrative, design intent, rights, and slide semantics before quality or balanced mode can publish a package.

Use `scripts/localize-assets.mjs` to materialize selected assets. Remote acquisition requires an explicit `--allow-host` list; `prefer` may use only a plan-declared local fallback, while `require` blocks if the selected resource cannot be fetched safely. Use `scripts/plan-check.mjs`, `scripts/review-deck.mjs`, and `scripts/host-final-review.mjs` to inspect diagnostics and verify evidence; none of them invents or writes a Host approval.

For installation, isolated execution, and publishing, read [installation-and-isolation.md](references/installation-and-isolation.md). For protocol consumers, read [presentation-package-protocol.md](references/presentation-package-protocol.md). For failures, read [errors.md](references/errors.md).

Constraints:

- Do not call an LLM from scripts or invent facts, numbers, sources, quotes, cases, brands, policies, or approval.
- Do not import from a parent repository or sibling Skill. Resolve every runtime file inside this directory.
- Keep runtime assets local in the delivered package; reject traversal, absolute paths, symlinks, unsafe remote requests, and missing assets.
- Treat the plan copies, report bundle, `NOTICE`, and output manifest as delivery evidence. Preserve accepted evidence rather than editing it in place.
- Treat the optional protocol record and extension as interoperability artifacts, never as dependencies on `html-to-pptx` or `image-to-pptx`.
- Ask only when a missing decision materially changes the deck; otherwise record a conservative assumption.
