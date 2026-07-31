# Workflow

> **Purpose:** Route a request from source intake through review, deterministic generation, browser QA, and package delivery.
>
> **Trigger:** Use at the start of every Text-to-HTML request or when resuming a package that is not yet accepted.
>
> **Prereqs:** The request's source material, delivery context, and a writable location for a new package directory.
>
> **Next:** [input-and-evidence.md](input-and-evidence.md), [narrative-and-pagination.md](narrative-and-pagination.md), and [review-and-delivery.md](review-and-delivery.md)
>
> **Contract:** The only deterministic input is a complete, approved Plan 2.0; scripts preserve and validate it rather than inventing its decisions.

## Contents

- Position the presentation
- Extract and verify content
- Build the narrative
- Write the page script
- Generate and verify
- Deliver

## Position the presentation

Write one sentence before outlining:

> Let which audience, in which setting, understand which conclusion, and take which action.

Record the `brief` audience, scenario, device, delivery mode, duration, desired action, network policy, constraints, confidentiality, language/region, and accessibility requirements. Record the core conclusion as the `narrative.thesis`. Use a conservative default only when it will not materially change the result; add it to `assumptions` with its impact and status. Ask the fewest questions needed when the missing choice would alter the conclusion, evidence boundary, brand, or disclosure risk.

Map these Host decisions into the required `brief` fields before authoring slides. See [input-and-evidence.md](input-and-evidence.md) for the source and claim boundary.

## Extract and verify content

Read the complete source. Separate:

- core claims, facts, data, examples, turning points, and actions;
- visual evidence that belongs on-slide;
- supporting detail that belongs in notes;
- repetition or setup that does not support the communication task.

Create a source record for user text, each supplied file, each verified URL, and every explicit assumption or placeholder. A user-provided claim is `provided`, not automatically `verified`. Never create a source URL or complete illegible/missing content. Label `inferred`, `unverified`, and `placeholder` content visibly.

## Build the narrative

Choose a framework from the use case rather than forcing a template:

- report: context → conclusion → evidence → execution → action;
- proposal: pain → solution → value → implementation → risk/investment → action;
- progress: objective → completed → result → problem → next;
- training: problem → concept → example → method → practice/summary;
- other: use a causal, comparative, chronological, SCQA, pyramid, or problem-solution loop that fits the material.

Use three to five chapters when complexity warrants it. Check that title-only reading exposes the argument, sections are as MECE as practical, and setup does not crowd out evidence and action.

Record chapters, beats, the title chain, attention curve, and per-slide page budgets as Plan 2.0 fields. See [narrative-and-pagination.md](narrative-and-pagination.md) for the exact Host decisions and read-only diagnostics.

## Write the page script

For every semantic slide, record its stable ID, order, intent, layout archetype, conclusion title, distinct takeaway, focal point, hierarchy, visual role, evidence references, slots, transition purpose, and speaker notes. Keep one core conclusion and no more than three primary supports. Split independent conclusions. Do not mechanically apply a word-count rule; move detail to notes, simplify, or paginate when the visual load becomes unsafe.

## Generate and verify

Validate first:

```bash
node scripts/validate-plan.mjs presentation-plan.json
```

Run the complete bounded loop:

```bash
node scripts/run-pipeline.mjs presentation-plan.json output --max-attempts 3 --timeout-ms 90000
```

Select the mode deliberately:

- `quality` is the default. It requires current approvals, allows up to three attempts, and runs browser QA and finalization before it can publish accepted evidence.
- `balanced` also requires current approvals, allows up to two attempts, and runs the same browser QA and finalization gates.
- `draft` allows one unreviewed preview build only. It skips browser QA and finalization, and its pending output is never accepted or handed off as a passed package.

The timeout floor is 90 seconds. Attempts may only tighten spacing and typography within documented floors. A claim, layout meaning, source mapping, or slide boundary is never rewritten automatically. Inspect every preview at full size after the command passes.

See [review-and-delivery.md](review-and-delivery.md) for approval bindings, output evidence, and final acceptance.

## Deliver

Deliver the directory as one unit. `index.html` is the entrypoint; `presentation-package.json` is an optional interoperation record. Do not remove reports or source/assumption metadata. If the gate fails after the maximum attempts, deliver the failed evidence only when the user needs diagnosis and state that no accepted deck exists.

Accepted output contains:

```text
index.html
assets/
presentation-plan.source.json
presentation-plan.json
deck-manifest.json
presentation-package.json
design-tokens.json
design-intent.json
content-budget-report.json
narrative-report.json
review-report.json
asset-ledger.json
license-report.json
provenance.json
visual-scorecard.json
NOTICE
speaker-notes.md
sources.json
generation-report.json
qa-report.json
qa/
preview/
output-manifest.json
```

`presentation-plan.source.json` preserves the exact supplied input bytes. `presentation-plan.json` preserves the validated Plan 2.0; localized media paths and integrity records belong in `assets/media/`, `asset-ledger.json`, and `license-report.json` rather than rewriting the approved asset locators.
