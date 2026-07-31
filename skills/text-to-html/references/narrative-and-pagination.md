# Narrative and pagination

> **Purpose:** Design a causal slide sequence and explicit page budgets without letting deterministic tools rewrite the story.
>
> **Trigger:** Use after source/evidence intake and before content, design, and rights approvals are bound to a Plan 2.0.
>
> **Prereqs:** A complete brief, labeled claims, declared sources/assets, and the intended audience action.
>
> **Next:** [visual-design.md](visual-design.md) and [review-and-delivery.md](review-and-delivery.md)
>
> **Contract:** `narrative` and `pagination.pageBudgets` cover every stable slide ID exactly once in the rendered slide order.

## Host-authored story

Choose the argument structure from the actual communication task. Write one thesis, ordered chapters, and beats that together explain why the audience should take the desired action. The `titleChain` must reproduce slide titles in order, and `attentionCurve` gives every slide a level from 1 to 5.

For each slide, write one conclusion-bearing title, a distinct takeaway, semantic intent, a supported layout archetype, evidence references, a focal point, hierarchy, visual role, transition purpose, notes, and slots. Keep the visible message compact: one core conclusion and at most three primary supports. Move secondary material to notes, simplify it, or create a new slide with a meaningful semantic break.

## Page budgets and continuations

Create one `pagination.pageBudgets` entry for every slide in order. Set its visible-content limit, support limit, expected speaking time, material that must remain together, split permission, and notes-only content. A continuation requires both pages to permit a split, an earlier `continuationOf` target, and a real `semanticBreak`; it is not a mechanical overflow escape.

Make the total planned speaking time match the brief unless the Host deliberately revises the brief. Include a `closing` slide so the narrative ends with an action rather than an unresolved summary.

## Deterministic diagnostics

After the plan's review bindings are complete, these commands validate and report without changing any slide, claim, title, timing, or pagination decision:

```bash
node scripts/analyze-narrative.mjs presentation-plan.json narrative-report.json
node scripts/plan-pagination.mjs presentation-plan.json content-budget-report.json
node scripts/validate-plan.mjs presentation-plan.json
```

The reports identify coverage, title-chain, attention, budget, and continuation failures. The Host corrects the earliest narrative or page-design decision; scripts do not repartition content or approve a repaired plan.
