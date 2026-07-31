# Review, generation, and delivery

> **Purpose:** Bind Host approvals to a Plan 2.0, run bounded deterministic generation, and decide whether its evidence supports accepted delivery.
>
> **Trigger:** Use when a complete plan is ready for approval, when running the pipeline, or when assessing a generated package.
>
> **Prereqs:** A complete Plan 2.0, current design/asset/renderer hash bindings, local runtime dependencies, and a safe output directory.
>
> **Next:** [browser-quality-gate.md](browser-quality-gate.md), [presentation-package-protocol.md](presentation-package-protocol.md), and [errors.md](errors.md)
>
> **Contract:** All `review` approvals must be `approved`, and `presentation-package.json.validation.status` plus `qa-report.json` must be `passed` before acceptance.

## Host approval boundary

The Plan 2.0 `review` contains independent `content`, `design`, and `rights` approvals. Each approval records a status, the current artifact hashes, and—when approved—a Host-provided review time. A changed design intent, asset lock, or renderer binding invalidates the approval.

The Host approves only after checking the narrative, claim/evidence boundary, visual intent, selected assets, rights, and delivery constraints. Scripts validate the binding and preserve it in reports; they never synthesize an approval, timestamp, rights decision, or source fact.

## Deterministic generation and QA

Validate the approved plan, then run the bounded pipeline:

```bash
node scripts/validate-plan.mjs presentation-plan.json
node scripts/run-pipeline.mjs presentation-plan.json output --max-attempts 3 --timeout-ms 90000
```

The pipeline writes the offline deck and package-local assets, plan copies, source/provenance/review reports, `visual-scorecard.json`, browser previews, QA attempts, and output manifest. The scorecard is deterministic evidence from QA, narrative, pagination, and provenance reports; it does not approve a design. The pipeline may make at most two bounded visual repairs after the initial build: spacing/padding first, then documented typography reductions. It cannot change claims, sources, slide boundaries, hierarchy, visual intent, or approvals.

Use `node scripts/qa-deck.mjs output --timeout-ms 90000` only to re-run browser QA for an existing package. It records a new QA result; it does not rebuild or revise the plan.

`quality` is the default pipeline mode: it requires current approvals, permits up to three attempts, and can publish accepted evidence only after browser QA and finalization. `balanced` keeps those approval and acceptance gates but permits up to two attempts. `draft` performs one preview build, may use an unreviewed plan, and deliberately skips browser QA and finalization; its output remains pending and is not eligible for handoff as an accepted package.

## Acceptance and handoff

Inspect every standard and mobile preview at full size. A passed automated result is necessary evidence, not a Host design acceptance. An accepted package has both a passed `qa-report.json` and `presentation-package.json.validation.status: "passed"`; it retains its plan, report, asset, and `NOTICE` evidence unchanged.

If QA or validation fails, keep the output only as diagnosis evidence and route the problem to its earliest owner. Do not delete, rewrite, or relabel reports to make a pending or failed package look accepted. The optional protocol record is a handoff artifact, not a runtime dependency on another Skill.
