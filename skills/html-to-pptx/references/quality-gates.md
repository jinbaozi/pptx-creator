# Quality gates

Completion is transactional: `final.pptx` is published only when every blocking
gate passes on the same candidate and source evidence.

## Gate sequence

| Gate | Evidence | Blocking rule |
|---|---|---|
| Secured browser stabilization | `html-layout-report.json` | DOM geometry must stabilize; local fonts and images must finish loading |
| Desktop HTML layout | `html-layout-report.json` | No critical overflow, clipping, out-of-slide content, harmful overlap, or invalid connector finding |
| Mobile HTML diagnostic | `html-mobile-report.json` | Reported separately; not used as PPTX geometry because slides use the desktop canvas |
| Manifest contract | `contract-report.json` | Slide size, elements, object bounds, IDs, and local resource paths must be valid |
| Full-slide raster prohibition | `fallback-ledger.json` | Zero full-slide raster violations |
| Native coverage | `editable-report.json` | Editability level at least 3 and native coverage at least 0.90 |
| Layout safety | `layout-safety-report.json` | Zero critical manifest layout findings |
| PPTX geometry | `pptx-geometry-report.json` | Zero critical OOXML boundary, overlap, ordering, and connector findings |
| Target-office render | `evidence/attempt-N/render/preview-report.json` | LibreOffice must render one preview for every slide |
| Visual comparison | `visual-comparison.json` | Maximum per-slide mean absolute channel difference must be at or below the configured threshold |

The default visual threshold is `48` on a `0..255` RGB-channel scale. The report
also records mean difference, minimum similarity, image sizes, source/candidate
hashes, and per-slide diff images. Do not interpret similarity alone as proof;
all gates must pass.

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
qa-report.gates.visual.passed == true
qa-report.gates.editability.passed == true
qa-report.gates.fullSlideRaster.violations == 0
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
