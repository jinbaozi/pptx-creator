# Presentation plan contract

## Contents

- Canonical file
- Positioning and assumptions
- Sources and assets
- Slides
- Review transaction
- Markdown scaffolding

## Canonical file

`presentation-plan.json` version `1.0.0` is the deterministic input. Validate it against `schemas/presentation-plan.schema.json` and the runtime validator. The schema documents shape; runtime validation also checks unique IDs, ordered slides, references, path safety, content/layout compatibility, visible uncertainty labels, and Host approval.

## Positioning and assumptions

`positioning.statement` must implement:

> Let which audience, in which setting, understand which conclusion, and take which action.

Record the structured fields so later reviewers do not infer them from prose. Each assumption has `id`, `text`, `impact`, and `status: inferred|confirmed|rejected`. Rejected assumptions block the plan. High-impact inferred assumptions must be resolved before approval.

## Sources and assets

Source status values:

- `provided`: present in user input; authenticity not independently checked;
- `verified`: checked against the locator recorded in the plan;
- `inferred`: a conservative interpretation, never a fact;
- `unverified`: factual-looking content without sufficient verification;
- `placeholder`: intentionally incomplete content.

Assets use package-relative paths from the plan directory, a MIME type, rights status, alt text, and optional source reference. Absolute paths, traversal, symlinks, URLs as runtime paths, and missing files are rejected. URLs belong in source `locator` fields.

## Slides

Supported page types and content:

| Type | Required content | Preferred use |
|---|---|---|
| `cover` | optional eyebrow/subtitle | Opening and positioning |
| `statement` | `statement` | One decisive conclusion |
| `bullets` | `points` | Up to three supports |
| `comparison` | `left` and `right` groups | Two-sided comparison |
| `metrics` | one to three metrics | Key numbers with units/context |
| `process` | two to five steps | Ordered path with anchored connectors |
| `timeline` | two to five milestones | Time or stage progression |
| `quote` | quote and attribution | Provided quotation only |
| `image` | `assetId` and caption | Local evidence or atmosphere |
| `closing` | action and optional summary | Conclusion and next action |

Every slide has exactly one `coreMessage`, a conclusion-bearing `title`, source references, transition, notes, and a visual recommendation. Keep primary supports at three or fewer. Claims use `{text, factStatus, sourceRefs}`. `inferred`, `unverified`, and `placeholder` claims receive visible labels in generated HTML. A `provided` or `verified` factual claim must resolve to at least one source.

## Review transaction

Set:

```json
{
  "hostReview": {
    "status": "approved",
    "reviewedAt": "2026-07-30T00:00:00.000Z",
    "checks": {
      "positioning": true,
      "sourceIntegrity": true,
      "narrative": true,
      "oneMessagePerSlide": true,
      "visualIntent": true
    }
  }
}
```

Only after reviewing the complete plan. The deterministic scripts reject `required` or incomplete reviews with `E_HOST_REVIEW_REQUIRED`; they never approve their own output.

## Markdown scaffolding

Use:

```bash
node scripts/scaffold-plan.mjs source.md draft-plan.json
```

The scaffold preserves headings and bullets, adds explicit conservative assumptions, and leaves `hostReview.status` as `required`. It is a drafting aid, not content understanding or factual verification.
