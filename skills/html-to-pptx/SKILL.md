---
name: html-to-pptx
description: Convert a local HTML/CSS slide deck, HTML directory, or compatible presentation-package 1.0.0 into a mainly editable PPTX with real browser measurement, native object reconstruction, localized fallback accounting, render-back visual comparison, and blocking quality gates. Use when an existing HTML presentation must become an editable PowerPoint without using a full-slide screenshot; do not use this Skill to plan presentation content or reconstruct slides directly from reference images.
---

# HTML to PPTX

## Purpose

Convert an existing HTML presentation into a PowerPoint file while preserving
text, shapes, images, tables, supported charts, and supported connectors as
native objects wherever possible. Treat the browser-rendered HTML as the visual
baseline and publish `final.pptx` only after layout, geometry, editability, and
render-back checks pass.

This Skill is self-contained. Do not import from, invoke, or require
`text-to-html`, `image-to-pptx`, a sibling Skill, or a repository-level private
runtime. A compatible presentation package is an optional input, not a
prerequisite.

## Install

Run these commands from this Skill directory:

```bash
npm ci
npx playwright install chromium
python3 -m pip install -r requirements.txt
```

Install LibreOffice and Poppler's `pdftoppm` on the host. They are explicit
system dependencies for the blocking PPTX render-back gate. Use Python 3.10 or
newer; set `HTML_TO_PPTX_PYTHON` when `python3` is not the intended
interpreter.

## Choose the input

- For one file, pass a local `.html` or `.htm` file.
- For a directory, include `index.html`, or exactly one HTML file.
- For optional composition, pass `presentation-package.json`,
  `deck-manifest.json`, or a directory containing one of them.
- Accept protocol version `1.0.0` only. Reject every other version with
  `E_PROTOCOL_VERSION`; never silently coerce it.

Read [input-output-contract.md](references/input-output-contract.md) when
handling a package, assets, custom slide dimensions, or downstream consumers.

## Prepare the HTML

Prefer a deterministic document with:

- one `.pptx-slide` element per slide;
- a stable slide size, normally `1280px × 720px`;
- local relative images, SVG, fonts, and styles;
- unique `data-slide-id` and `data-pptx-id` values;
- speaker notes in `data-notes` on each slide;
- explicit connector semantics on supported SVG lines;
- optional native chart data in `data-pptx-chart`.

The browser pass strips author scripts and inline event handlers, disables
network access, disables animation and transition effects, waits for fonts and
images, and requires stable geometry. Do not rely on JavaScript to construct the
final slide DOM.

Read [css-pptx-compatibility.md](references/css-pptx-compatibility.md) before
using advanced CSS, charts, SVG paths, masks, filters, or unusual typography.

## Convert and verify

Run:

```bash
node scripts/convert.mjs input.html output
```

Useful explicit options:

```bash
node scripts/convert.mjs input.html output \
  --max-repair-attempts 3 \
  --browser-timeout-ms 90000 \
  --visual-threshold 48
```

- Add `--overwrite` only when replacing generated artifacts in the exact
  destination is intended.
- Add `--allow-remote-assets` only when network retrieval is authorized. The
  converter localizes supported remote image assets before conversion.
- Keep the browser timeout at `90000` milliseconds or higher.
- Keep repair attempts between `0` and `3`.

The command performs this fixed sequence:

1. Resolve and validate the input boundary.
2. Render the source in Chromium at desktop and mobile viewports.
3. Block critical desktop overflow, clipping, overlap, connector, and boundary
   defects.
4. Measure computed geometry and computed style in the stable browser DOM.
5. Compile native PowerPoint objects and record every local raster fallback.
6. Block full-slide raster fallback.
7. Preflight fonts, resources, manifest structure, layout, and object geometry.
8. Render the candidate PPTX with LibreOffice and compare every slide with the
   HTML screenshot.
9. Apply only bounded deterministic layout repairs, then render and compare
   again.
10. Publish `final.pptx` and the versioned delivery package only after all
    blocking gates pass.

Read [quality-gates.md](references/quality-gates.md) before changing thresholds,
interpreting a visual report, or deciding whether delivery is complete.

## Decide from the result

- Deliver only when `qa-report.json` has `status: "passed"`.
- Require editability level `3` or higher and native coverage of at least
  `0.90`.
- Treat every `fallback-ledger.json` entry as a visible editability limitation.
- Treat mobile findings as diagnostics for the source HTML; desktop conversion
  geometry remains the PPTX baseline.
- If `failure-report.json` exists, report the failure code and unresolved
  evidence. Do not describe the run as successful.
- If an unsupported effect covers a whole slide, stop with
  `E_FULL_SLIDE_RASTER_FORBIDDEN`.
- If the visual threshold is exceeded after the repair limit, stop with
  `E_QUALITY_GATE`; do not ship the candidate hidden in `evidence/`.

Read [errors-and-recovery.md](references/errors-and-recovery.md) for the
earliest safe repair stage.

## Output contract

A passed run contains:

- `final.pptx`;
- `presentation-package.json` using protocol `1.0.0`;
- `output-manifest.json` with hashes and byte counts;
- `deck.manifest.json` and `layout-measurements.json`;
- `qa-report.json` and `qa-report.md`;
- `editable-report.json` and `editable-report.md`;
- `compatibility-report.json`, `fallback-ledger.json`, and `font-report.json`;
- HTML, layout, PPTX geometry, and visual-comparison reports;
- source screenshots, candidate evidence, final previews, and visual diffs.

Do not edit generated reports to make a failed result appear passed. Fix the
input or conversion code, rerun the entire gate, and preserve the evidence.

## Test this Skill

Run deterministic tests first, then browser, visual, and isolated-copy tests:

```bash
npm run test:unit
npm run test:browser
npm run test:visual
npm run test:isolation
```

Run the two representative deliveries with:

```bash
npm run example:min
npm run example:complex
```

Read [testing.md](references/testing.md) for coverage boundaries and evidence.
Read [font-and-office.md](references/font-and-office.md) when target-office
rendering differs from the Chromium baseline.
Read [provenance.md](references/provenance.md) when auditing implementation
origin, license, or independence.
