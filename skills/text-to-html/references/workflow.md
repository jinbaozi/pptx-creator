# Workflow

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

Record `goal`, `audience`, `scenario`, `coreConclusion`, `desiredAction`, duration, target slide count, brand constraints, required material, confidentiality, and delivery mode. Use a conservative default only when it will not materially change the result; add it to `assumptions` with its impact and status. Ask the fewest questions needed when the missing choice would alter the conclusion, evidence boundary, slide count, brand, or disclosure risk.

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

## Write the page script

For every slide record: order, type, conclusion title, one core message, no more than three primary supports, evidence references, visual form, required assets, transition, notes, and emphasis/action. Split independent conclusions. Do not mechanically apply a word-count rule; move detail to notes, simplify, or paginate when the visual load becomes unsafe.

## Generate and verify

Validate first:

```bash
node scripts/validate-plan.mjs presentation-plan.json
```

Run the complete bounded loop:

```bash
node scripts/run-pipeline.mjs presentation-plan.json output --max-attempts 3 --timeout-ms 90000
```

The timeout floor is 90 seconds. Attempts may only tighten spacing and typography within documented floors. A claim, layout meaning, source mapping, or slide boundary is never rewritten automatically. Inspect every preview at full size after the command passes.

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
speaker-notes.md
sources.json
generation-report.json
qa-report.json
qa/
preview/
output-manifest.json
```

`presentation-plan.source.json` preserves the reviewed input. `presentation-plan.json` rewrites only asset paths to the packaged local copies so it can be rerun from the delivery directory.
