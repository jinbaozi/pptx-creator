# Error model

> **Purpose:** Map deterministic failure codes to the earliest owner who can correct the input, environment, or approval.
>
> **Trigger:** Use when any Text-to-HTML command exits non-zero or when triaging a failed output package.
>
> **Prereqs:** The command's JSON stderr object and, when available, the output package's reports and QA evidence.
>
> **Next:** [workflow.md](workflow.md)
>
> **Contract:** Errors preserve a blocking state; a caller must repair the declared cause rather than relabel it as accepted.

All command-line failures write one JSON object to stderr with `status`, `code`, `message`, and optional `path` or `details`. Exit code is non-zero.

| Code | Meaning | Earliest repair owner |
|---|---|---|
| `E_USAGE` | Missing or invalid CLI arguments | Caller |
| `E_INPUT_READ` / `E_INPUT_JSON` | Input cannot be read or parsed | Caller |
| `E_PLAN_VERSION` | Plan does not declare version `2.0.0` | Plan author |
| `E_PLAN_SCHEMA` | Required Plan 2.0 field, value, or type is invalid | Plan author |
| `E_HOST_REVIEW_REQUIRED` | A high-impact assumption is unresolved or content/design/rights approval is still required | Host |
| `E_REVIEW_REJECTED` | A review approval is rejected | Host |
| `E_REVIEW_INVALIDATED` / `E_REVIEW_SCHEMA` | A locked input or approval binding is stale or malformed | Host |
| `E_NARRATIVE_REF` / `E_NARRATIVE_COVERAGE` / `E_NARRATIVE_TITLE_CHAIN` / `E_NARRATIVE_ATTENTION` / `E_NARRATIVE_ACTION` | Narrative references, ordered coverage, title chain, attention curve, or final action are invalid | Host |
| `E_PAGINATION_COVERAGE` / `E_PAGINATION_BUDGET` / `E_PAGINATION_CONTINUATION` | Page budgets are incomplete, under-declare content, or lack split semantics | Host |
| `E_SOURCE_REF` / `E_FACT_LABEL` | Claim or asset evidence is unresolved, or an uncertain claim lacks its required status | Host |
| `E_SLIDE_ORDER` / `E_DUPLICATE_ID` | Slide ordering or a stable identifier is invalid | Host |
| `E_LAYOUT_CONTENT` | Semantic intent, layout archetype, or slots disagree | Host |
| `E_RIGHTS_UNKNOWN` | Asset rights remain unresolved | Host |
| `E_ASSET_PATH` / `E_ASSET_MISSING` / `E_ASSET_SYMLINK` | Asset path is unsafe, absent, or a symlink | Caller/Host |
| `E_ASSET_HASH` / `E_ASSET_MIME` / `E_ASSET_SIZE` / `E_ASSET_UNSAFE` | Localized asset does not meet declared integrity or safety constraints | Host |
| `E_ASSET_NETWORK` / `E_REMOTE_ASSET` / `E_ASSET_FALLBACK` | Remote asset conflicts with network policy or cannot be safely localized | Host/environment |
| `E_OUTPUT_PATH` / `E_OUTPUT_SYMLINK` / `E_OUTPUT_ARTIFACT` / `E_OUTPUT_STALE` | Output target or existing package evidence is unsafe, malformed, or stale | Caller/Host |
| `E_BROWSER_UNAVAILABLE` / `E_BROWSER_TIMEOUT` | Chromium cannot launch or settle within the 90-second minimum | Environment/source |
| `E_COMPONENT_METADATA` | A rendered component lacks its stable ID, kind, typography tier, or QA region | Renderer |
| `E_SAFE_AREA` / `E_FOOTER_COLLISION` | Content escapes the content safe area or intersects the reserved footer/navigation region | Renderer/plan author |
| `E_TYPE_FLOOR` / `E_TITLE_LINE_COUNT` / `E_SOURCE_TRUNCATION` | Rendered type is below its semantic floor, a title exceeds its line budget, or source text is visually lost | Renderer/plan author |
| `E_QA_REPORT_SCHEMA` / `E_QA_ATTEMPT` / `E_QA_FAILED` | QA evidence is malformed, cannot be recorded, or leaves blockers | Host/environment |
| `E_RUNTIME_PROVENANCE` | Package, generation evidence, or emitted runtime assets do not match the installed Skill runtime | Environment/producer |
| `E_RUNTIME_OVERRIDE` | A caller attempted to replace the official renderer, browser QA, or finalizer outside a Node test worker | Caller |
| `E_VISUAL_REVIEW_READ` / `E_VISUAL_REVIEW_SCHEMA` / `E_VISUAL_REVIEW_EVIDENCE` | External Host visual-review evidence is unreadable, malformed, or references unsafe preview evidence | Host/caller |
| `E_VISUAL_REVIEW_REQUIRED` / `E_VISUAL_REVIEW_STALE` / `E_VISUAL_REVIEW_REJECTED` / `E_VISUAL_REVIEW_DECISIONS` | Visual warnings lack a complete current Host decision, or the Host explicitly rejected them | Host |
| `E_REPORT_WRITE` / `E_PACKAGE_WRITE` / `E_OUTPUT_MANIFEST` / `E_FINALIZATION_*` | Final delivery evidence cannot be safely written or finalized | Environment/Host |
| `E_PROTOCOL_ID` / `E_PROTOCOL_VERSION` | Core presentation-package protocol is unsupported | Caller |
| `E_PROTOCOL_*` | Core protocol structure, path, reference, or validation state is invalid | Producer |

Do not convert a blocking error to a warning. Preserve failed QA, provenance, and report artifacts for diagnosis; a pending or failed package is never complete delivery.
