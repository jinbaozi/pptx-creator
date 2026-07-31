# Input, evidence, and assets

> **Purpose:** Establish the Host-owned brief, source records, claim labels, asset choices, and rights evidence before a Plan 2.0 is approved.
>
> **Trigger:** Use when converting supplied prose, files, URLs, or assets into a reviewable `presentation-plan.json`.
>
> **Prereqs:** The complete available source material, delivery context, and any supplied brand or asset constraints.
>
> **Next:** [narrative-and-pagination.md](narrative-and-pagination.md) and [plan-contract.md](plan-contract.md)
>
> **Contract:** Every claim and asset used by a slide resolves to a declared source or asset record with an explicit fact or rights status.

## Host-owned inputs

Read the supplied material before choosing a message or a slide count. Fill the Plan 2.0 `brief` with the audience, scenario, delivery mode, duration, desired action, network policy, confidentiality, language/region, accessibility, and actual constraints. Record assumptions separately with their impact and status.

Create one source record for each user input, supplied file, verified URL, assumption, or intentional placeholder. Use the status that the evidence supports:

- `provided` means the user supplied the material; it does not independently verify the claim;
- `verified` means the Host checked the locator recorded in the plan;
- `inferred`, `unverified`, and `placeholder` remain visibly labeled in the rendered deck.

Do not complete illegible material, invent a source URL, or turn a visual preference into a fact. Ask only when the missing choice would materially change the conclusion, audience, scope, rights, brand, or disclosure risk; otherwise record a conservative assumption.

## Asset commitment

Select each asset before approval. Give it a stable ID, purpose, MIME type, alt text, rights record, and—when applicable—a source reference and SHA-256. A rights status of `unknown` blocks delivery.

For local assets, use a regular package-relative file below the plan directory. Do not use a traversal path, absolute path, symlink, or missing file. HTTPS assets are allowed only when the `brief.networkPolicy` permits them and must be explicitly localized before delivery. The generated package records local output paths, hashes, rights, attribution, and fallbacks in `asset-ledger.json`, `license-report.json`, and `NOTICE`.

## Deterministic boundary

`scripts/scaffold-plan.mjs` can preserve headings and prose structure from Markdown or text:

```bash
node scripts/scaffold-plan.mjs source.md draft-plan.json
```

It creates an unapproved structural draft. It does not verify a claim, choose a visual rationale, resolve rights, write an approval, or make the draft renderable. Complete the Host-owned fields and review bindings described in [plan-contract.md](plan-contract.md) before running the pipeline.
