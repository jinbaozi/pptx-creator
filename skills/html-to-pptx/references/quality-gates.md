# Quality gates

Completion is transactional: `final.pptx` and a passed QA report are published
only when every blocking gate passes on the same candidate and source evidence.
If finalization fails, the QA report is rewritten as failed and no delivery
package or output manifest remains.

## Gate sequence

| Gate | Evidence | Blocking rule |
|---|---|---|
| Secured browser stabilization | `html-layout-report.json` | DOM geometry must stabilize; local fonts and images must finish loading |
| Desktop HTML layout | `html-layout-report.json` | No critical overflow, clipping, out-of-slide content, harmful overlap, or invalid connector finding |
| Mobile HTML diagnostic | `html-mobile-report.json` | Reported separately; not used as PPTX geometry because slides use the desktop canvas |
| Manifest contract | `contract-report.json` | Slide size, elements, object bounds, IDs, and local resource paths must be valid |
| Full-slide raster prohibition | `fallback-ledger.json` | Zero full-slide raster violations |
| Native object coverage | `editable-report.json` | Default: editability level at least 3 and `nativeObjectCoverage` at least 0.90; `nativeCoverage` is an equal deprecated alias |
| Semantic editability coverage | `editable-report.json` | Report per-page weighted evidence; disabled by default and required at least 0.90 by `replica-strict` |
| Layout safety | `layout-safety-report.json` | Zero critical manifest layout findings |
| PPTX geometry | `pptx-geometry-report.json` | Zero critical OOXML boundary, overlap, ordering, connector, and explicit-group child/transform findings |
| Structure fidelity | `structure-fidelity-report.json` | Text SHA-256, code whitespace, key-heading lines, shape geometry, border sides, native chart object/relationship/type/count, and explicit-group child/order/transform checks must have zero critical findings; manifest/PPTX bindings must match |
| Target-office render | `evidence/attempt-N/render/preview-report.json` | LibreOffice must render one preview for every slide |
| Visual comparison | `visual-comparison.json` | Version 2.0.0 full-page dimensions, SSIM, normalized MAE, and deterministic tile evidence must pass |
| Component visual comparison | `component-comparison.json`, `components/summary.json` | Default: every detected high-risk region must pass SSIM >= 0.85 and normalized MAE <= 12/255; strict: every explicit/risk component must pass SSIM >= 0.94 and normalized MAE <= 0.05; strict missing keys fail |

The default visual threshold is `48` on a `0..255` RGB-channel scale. The report
also records mean difference, minimum similarity, image sizes, source/candidate
hashes, and per-slide diff images. Do not interpret similarity alone as proof;
all gates must pass.

## Quality profiles

`--quality-profile default` preserves the normal level-3/native-object-coverage
gate. Its semantic threshold is `null` (reported but not blocking). When the
manifest contains transformed, cropped-image, chart, table, group, SVG,
rich-text, or localized-fallback objects, those risk regions are compared and
can block the default profile; a deck with no risk regions does not invent a
component requirement. `--quality-profile replica-strict` raises the
editability gate to level 4, requires native-object and semantic coverage at
least `0.90`, whole-slide SSIM at least `0.90`, whole-slide normalized MAE at
most `0.05`, component SSIM at least `0.94`, component normalized MAE at most
`0.05`, zero full-slide raster and critical structure findings, and at least
one valid `data-pptx-visual-key="true"`/native-group/chart/pre/code component.
Unknown profile names are `E_ARGUMENT` failures.

Editability coverage is calculated per slide from clipped rectangular regions
using a deterministic union (no overlap double counting). Whole visual layers
are selected in manifest z-order; structured groups count once and their
children are excluded from the parent area. Evidence records each rectangle's
classification, area, weight, z-order, and visible contribution. Weights are:
native text/shape/line/table/chart/photo `1.0`, structured native group `0.95`,
decorative SVG `0.80`, text-bearing SVG `0.40`, chart/architecture SVG `0.20`,
and cropped/local raster fallback `0.0`.

## Bounded repair

At most three repair attempts are permitted. The deterministic repair loop can
adjust only findings it knows how to repair, such as:

- overflow-driven text fitting;
- elements extending beyond the slide;
- connector endpoint corrections represented in the manifest.

Every attempt is rendered, audited, and visually compared again. A previous
candidate cannot inherit the pass result of a later attempt.

If no deterministic repair applies, or the final attempt still fails, the
command returns `E_QUALITY_GATE`, writes `failure-report.json`, and leaves
candidate evidence under `evidence/`. It does not publish that candidate as
`final.pptx`.

## Release decision

Accept a delivery only when all of these are true:

```text
qa-report.status == "passed"
qa-report.gates.layoutSafety.criticalCount == 0
qa-report.gates.pptxGeometry.criticalCount == 0
qa-report.gates.structureFidelity.criticalCount == 0
qa-report.gates.visual.passed == true
qa-report.gates.editability.passed == true
qa-report.gates.fullSlideRaster.violations == 0
# When component status is enabled, also require qa-report.gates.visual.components.passed == true
```

Then inspect:

1. `preview/contact-sheet.png` at full size.
2. Every slide PNG in `preview/`.
3. Every local fallback and its editability impact.
4. Font substitutions and remaining non-critical findings.
5. `final.pptx` in the intended target office application when that application
   is available.

A syntactically valid PPTX, a successful script exit, or a montage alone is not
proof of visual acceptance.
