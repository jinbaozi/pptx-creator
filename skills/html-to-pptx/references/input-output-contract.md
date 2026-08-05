# Input and output contract

## Accepted inputs

The public entry point is:

```text
node scripts/convert.mjs <input> <output-directory> [options]
```

`<input>` may be:

1. A readable `.html` or `.htm` file.
2. A directory containing `presentation-package.json` or
   `deck-manifest.json`.
3. A directory containing `index.html`.
4. A directory containing exactly one HTML file.
5. A protocol JSON file named by the caller.

Resolution is deterministic in that order. A directory with several HTML files
and no explicit package or `index.html` fails with `E_INPUT_AMBIGUOUS`.

Plain HTML is a first-class input and does not need protocol metadata. For
protocol input, the only supported boundary is:

```json
{
  "protocol": "pptx-creator.presentation-package",
  "version": "1.0.0",
  "kind": "html-presentation",
  "entrypoint": "index.html"
}
```

The complete contract is
`schemas/presentation-package.schema.json`. The validator uses JSON Schema
Draft 2020-12 plus semantic checks for stable IDs, source references,
degradation targets, hashes, and cross-platform safe relative paths. Protocol
paths cannot be absolute, use a Windows drive or UNC root, contain a null byte,
or escape the package directory.

The optional protocol preserves deck size, page order, IDs, notes, sources,
design tokens, asset metadata, validation results, degradations, and
compatibility features. It is an interoperability artifact, not a Codex Skill
manifest.

When `designTokens` is present, the converter reads the package-local artifact
before manifest conversion, maps the `text-to-html` `fonts`/`type`/`space`/
`radius` surface to the editable PPTX typography, spacing, component, and
chart-token surface, and copies the original file into the output package.
Native chart palettes resolve those token references before PowerPoint objects
are created; the converter never imports a sibling Skill at runtime.

## HTML authoring boundary

Use one stable slide container per page. `.pptx-slide` is the preferred
selector. Supply dimensions in CSS; the normal conversion baseline is
`1280 × 720` pixels mapped to `13.333 × 7.5` inches.

Recommended semantics:

| Attribute | Purpose |
|---|---|
| `data-slide-id` | Stable page identifier |
| `data-title` | Page title in reports and notes |
| `data-notes` | Speaker notes written to PPTX |
| `data-pptx-id` | Stable native-object identifier |
| `data-pptx-kind` | Explicit type such as `line`, `table`, or `chart` |
| `data-source-id` / `data-target-id` | Connector anchor targets |
| `data-max-lines` | Text-fit constraint |
| `data-pptx-chart` | JSON data for supported native chart primitives |

JavaScript-generated content is outside the contract. The secured browser copy
removes script elements and inline event handlers before layout measurement.
HTTP and HTTPS requests are blocked during rendering. Local `file:`, `data:`,
and localized asset URLs remain available.

## Output transaction

The destination must be empty unless `--overwrite` is passed. Overwrite removes
only the known generated top-level artifacts, then recreates the evidence for
the current run. Unknown residual files and every symbolic link in the output
tree are rejected rather than deleted or followed. A failure replaces any
top-level passed QA report with failed QA evidence, writes `failure-report.json`,
and removes `final.pptx`, the delivery package, and the passed output manifest.

A passed run produces:

| Artifact | Meaning |
|---|---|
| `final.pptx` | Accepted deliverable |
| `presentation-package.json` | `pptx-delivery` protocol 1.0.0 |
| `output-manifest.json` | Recursive published-file hashes, byte counts, and a canonical root digest |
| `deck.manifest.json` | Deterministic render truth |
| `layout-measurements.json` | Browser geometry and computed style |
| `qa-report.json` | Aggregate gate result and repair history |
| `editable-report.json` | Native object counts and coverage |
| `compatibility-report.json` | Native mappings, font substitutions, and fallbacks |
| `fallback-ledger.json` | Every localized raster region and reason |
| `font-report.json` | Font availability and deterministic substitutions |
| `html-layout-report.json` | Desktop browser audit |
| `html-mobile-report.json` | Mobile source diagnostic |
| `layout-safety-report.json` | Accepted manifest layout gate |
| `pptx-geometry-report.json` | Accepted OOXML geometry gate |
| `visual-comparison.json` | Slide-by-slide render difference |
| `preview/` | Accepted PPTX page renders and contact sheet |
| `evidence/` | Source screenshots and each candidate attempt |

Paths in reports are evidence paths, not APIs. Downstream automation should use
`presentation-package.json`, `output-manifest.json`, and the named top-level
reports.

## Compatibility behavior

The reader supports protocol version `1.0.0` exactly. Unsupported versions fail
with `E_PROTOCOL_VERSION`. Unknown fields that violate the strict schema fail
instead of being silently ignored. Plain HTML remains usable if no protocol
package is present.
