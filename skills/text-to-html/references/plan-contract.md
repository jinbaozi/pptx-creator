# Presentation Plan 2.0 contract

> **Purpose:** Specify the complete reviewed input and immutable evidence records that drive the Text-to-HTML runtime.
>
> **Trigger:** Use when authoring, reviewing, validating, or repairing `presentation-plan.json`.
>
> **Prereqs:** A delivery brief, source inventory, resolved asset rights, and a Host-authored narrative and visual direction.
>
> **Next:** [narrative-and-pagination.md](narrative-and-pagination.md) and [visual-design.md](visual-design.md)
>
> **Contract:** `presentation-plan.json` declares version `2.0.0` and validates against the bundled schema plus `scripts/validate-plan.mjs`.

## Contents

- Accepted plan and immutable evidence
- Brief and assumptions
- Responsibility boundary
- Narrative and pagination
- Design intent and semantic slides
- Sources, assets, and rights
- Review approvals
- Output reports
- Markdown scaffolding

## Accepted plan and immutable evidence

`presentation-plan.json` must declare `version: "2.0.0"` and validate against `schemas/presentation-plan.schema.json` plus the local runtime validator. The schema establishes structure; runtime validation additionally enforces stable IDs and order, narrative coverage, evidence references, design locks, content budgets, asset safety, rights resolution, and current review approvals.

Only a complete Plan 2.0 document is accepted by this Skill.

For each generated package, the Skill writes two plan records:

| Artifact | Meaning |
|---|---|
| `presentation-plan.source.json` | The exact source-plan bytes supplied to the build. |
| `presentation-plan.json` | The validated Plan 2.0 content used to render the package. |

Treat both plan records, their hash bindings, and all reports below as immutable delivery evidence. To change a reviewed deck, produce a new reviewed plan and a new output package; do not edit accepted plans or reports in place.

## Brief and assumptions

`brief` is required and records the operating conditions that cannot safely be inferred from slide prose:

- `audience`: description, familiarity (`new`, `mixed`, or `expert`), and decision authority;
- `scenario`, `device`, `deliveryMode`, positive `durationMinutes`, and `desiredAction`;
- `networkPolicy`: `offline`, `prefer`, or `require`;
- `quietConstraints`, `brandConstraints`, `confidentiality`, `languageRegion`, and accessibility requirements.

Each assumption has `id`, `text`, `impact`, and `status: inferred|confirmed|rejected`. Rejected assumptions and high-impact inferred assumptions block an approved plan.

The deck is fixed at 1280×720 px. Give it a stable `deck.id`, title, and language.

## Responsibility boundary

The Host authors the brief, sources, claims, assumptions, narrative, design intent, asset choices, and review approvals. Deterministic commands only validate their structure and bindings, localize declared assets, render the approved plan, and write evidence. They never add facts, resolve rights, select a visual rationale, approve a review, or change a slide's meaning.

## Narrative and pagination

`narrative` makes the argument inspectable before layout:

- `framework` and a single `thesis`;
- ordered `chapters` and `beats`, each referencing slide IDs;
- a `titleChain` that reproduces slide titles in order;
- an `attentionCurve` with one level (1–5) for every slide.

Chapters and beats must each cover every slide exactly once and preserve slide order. A reviewed plan needs at least one `closing` layout archetype so the narrative ends in a next action.

`pagination.pageBudgets` has one entry for every slide, in slide order. Each budget declares `maxWords`, `maxPrimarySupports`, `timeSeconds`, `mustKeepTogether`, `canSplit`, and `notesOnly`. If a thought continues to another slide, both pages must explicitly allow a split and declare a meaningful `semanticBreak`; `continuationOf` must point to an earlier slide. A page budget cannot declare fewer primary supports than its semantic slide contains.

## Design intent and semantic slides

`designIntent` is a deliberate visual direction, not a renderer preference. It contains:

- `proposition`, `counterProposition`, mood, reference signals, and a stable theme ID;
- composition diversity, motion intensity, information density, imagery strategy, and allowed/forbidden techniques;
- bounded token overrides for fonts, colors, type, spacing, radius, and shadow;
- `lock`, with canonical-plan, theme, token, archetype, asset-lock hashes and a renderer version.

The lock binds the approved design to the current plan. A changed locked input invalidates the review.

Each semantic slide requires `id`, sequential `order`, `intent`, `layoutArchetype`, conclusion-bearing `title`, distinct `takeaway`, `focalPoint`, `hierarchy`, `visualRole`, `speakerNotes`, `transitionPurpose`, `evidence`, and `slots`.

`intent` says what the slide means; `layoutArchetype` says which supported form renders it. The supported forms are:

| Layout archetype | Required slot content |
|---|---|
| `cover` | Optional `subtitle` |
| `statement` | `statement` claim |
| `bullets` | `points` claims |
| `comparison` | `left` and `right` groups |
| `metrics` | One to three metrics |
| `process` | Two to five steps |
| `timeline` | Two to five milestones |
| `quote` | Quote claim and attribution |
| `image` | `assetId` and caption claim |
| `closing` | Action claim and optional summary claims |

Use one slide-level takeaway and no more than three primary supports. `evidence.sourceRefs` and `evidence.assetRefs` must resolve to declared records and include every source or asset used by the slots. Each claim uses `{ text, factStatus, sourceRefs }`; `inferred`, `unverified`, and `placeholder` claims are visibly labeled in generated HTML.

## Sources, assets, and rights

Sources use stable IDs and declare `kind`, label, and `factStatus`; a locator and SHA-256 may be recorded when available. `provided` means supplied by the user, not independently verified.

Every asset declares a stable ID, `selectedLocator`, `intendedPurpose`, MIME type, rights record, and alt text. A rights record includes status, SPDX expression, license URL, and attribution. `unknown` rights block delivery.

Local asset locators must be package-relative regular files below the plan directory. Traversal, absolute paths, symlinks, and missing files are rejected. Remote locators must be HTTPS and comply with `brief.networkPolicy`; remote localization is explicit and guarded. An optional fallback is recorded only when the policy permits it.

Before rendering, selected assets are localized below `assets/media/`. The reviewed plan is not mutated during localization. The package records the selected origin, localized path, hash, MIME, rights, attribution, and any fallback in:

- `asset-ledger.json` for provenance;
- `license-report.json` for rights and local-path reporting;
- `NOTICE` for a human-readable attribution and hash notice.

## Review approvals

`review` has three independent approvals: `content`, `design`, and `rights`. Each has a `status` of `required`, `approved`, or `rejected`, plus its artifact hashes; an approved record also has `reviewedAt`.

Every approval binds the current `designIntent`, asset lock, and renderer hashes. A rejected approval stops the build. A required approval produces `E_HOST_REVIEW_REQUIRED`. A stale or explicitly invalidated binding produces `E_REVIEW_INVALIDATED`. Deterministic scripts validate these bindings but never create an approval or timestamp.

## Output reports

In addition to the rendered HTML, notes, sources, and core presentation package, an output package contains:

- `design-intent.json` and `design-tokens.json`;
- `content-budget-report.json` and `narrative-report.json`;
- `review-report.json` and `provenance.json`;
- `asset-ledger.json`, `license-report.json`, and `NOTICE`;
- `qa-report.json`, `visual-scorecard.json`, browser evidence, and `output-manifest.json` after QA finalization.

The output manifest hash-binds emitted artifacts. `validation.status: "passed"` and a passed QA report are both required for an accepted package. Preserve a failed or pending report as evidence; neither is complete delivery.

## Markdown scaffolding

Use:

```bash
node scripts/scaffold-plan.mjs source.md draft-plan.json
```

The command preserves available source structure and creates a Plan 2.0 draft with all three review stages still required. It is a drafting aid, not factual verification, narrative approval, rights clearance, or visual-design approval.
