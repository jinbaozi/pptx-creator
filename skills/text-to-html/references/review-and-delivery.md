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

The pipeline writes the offline deck and package-local assets, plan copies, source/provenance/review reports, `visual-scorecard.json`, browser previews, QA attempts, and output manifest. The scorecard is deterministic evidence from QA, narrative, pagination, and provenance reports; it does not approve a design. Its `accepted` flag means only that no automated hard error remains. `review-deck.mjs` still blocks an `attention-required` scorecard until a current Host-authored visual review decides every warning. The pipeline may make at most two bounded visual repairs after the initial build: spacing/padding first, then documented typography reductions. It cannot change claims, sources, slide boundaries, hierarchy, visual intent, or approvals.

Use `node scripts/qa-deck.mjs output --timeout-ms 90000` only to re-run browser QA for an existing package. It first recomputes the installed package/renderer/QA/CSS/JS fingerprint and rejects a missing or drifting record with `E_RUNTIME_PROVENANCE`; it then records a new official browser result without rebuilding or revising the plan.

`quality` is the default pipeline mode: it requires current approvals, permits up to three attempts, and can publish accepted evidence only after browser QA and finalization. `balanced` keeps those approval and acceptance gates but permits up to two attempts. `draft` performs one preview build, may use an unreviewed plan, and deliberately skips browser QA and finalization; its output remains pending and is not eligible for handoff as an accepted package.

## Acceptance and handoff

Inspect every standard and mobile preview at full size. A passed automated result is necessary evidence, not a Host design acceptance. An accepted delivery has a passed `qa-report.json`, `presentation-package.json.validation.status: "passed"`, and a passed `host-final-review.mjs` result. A clean scorecard needs no extra file. An `attention-required` scorecard needs a separately authored `visual-review.json` whose bindings match the current scorecard and preview bytes and whose decisions cover every warning. Hard errors and deterministic content loss cannot be waived.

The runtime fingerprint is traceability evidence, not proof that no other code executed. Finalization recomputes it from the installed Skill and verifies emitted CSS/JS bytes; only an official `qa-deck.mjs` rerun provides current measured QA authority.

If QA or validation fails, keep the output only as diagnosis evidence and route the problem to its earliest owner. Do not delete, rewrite, or relabel reports to make a pending or failed package look accepted. The optional protocol record is a handoff artifact, not a runtime dependency on another Skill.
