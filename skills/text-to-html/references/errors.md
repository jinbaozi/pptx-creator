# Error model

All command-line failures write one JSON object to stderr with `status`, `code`, `message`, and optional `path` or `details`. Exit code is non-zero.

| Code | Meaning | Earliest repair owner |
|---|---|---|
| `E_USAGE` | Missing or invalid CLI arguments | Caller |
| `E_INPUT_READ` / `E_INPUT_JSON` | Input cannot be read or parsed | Caller |
| `E_PLAN_VERSION` | Unsupported plan version | Caller/migration |
| `E_PLAN_SCHEMA` | Required field or type is invalid | Host |
| `E_HOST_REVIEW_REQUIRED` | Plan was not fully approved | Host |
| `E_SOURCE_REF` | Claim or asset points to an unknown source | Host |
| `E_FACT_LABEL` | Uncertain claim lacks its required status | Host |
| `E_SLIDE_ORDER` / `E_DUPLICATE_ID` | Ordering or identity is unstable | Host |
| `E_LAYOUT_CONTENT` | Slide type and content disagree | Host |
| `E_ASSET_PATH` / `E_ASSET_MISSING` / `E_ASSET_SYMLINK` | Asset is unsafe or unavailable | Caller/Host |
| `E_OUTPUT_PATH` | Output target is unsafe | Caller |
| `E_BROWSER_UNAVAILABLE` | Chromium cannot launch | Environment |
| `E_BROWSER_TIMEOUT` | Browser did not settle within at least 90 seconds | Environment/source |
| `E_QA_FAILED` | Final visual gate remains blocked | Host or environment |
| `E_PROTOCOL_ID` / `E_PROTOCOL_VERSION` | Interoperation contract is unsupported | Caller/migration |
| `E_PROTOCOL_*` | Protocol structure or reference is invalid | Producer |

Do not convert a blocking error to a warning. Retain failed reports and screenshots when diagnosing.
