# Browser quality gate

## Contents

- Execution
- Viewports
- Blocking checks
- Bounded regeneration
- Manual acceptance

## Execution

`scripts/run-pipeline.mjs` launches installed Chromium through Playwright. Browser launch, navigation, and settling use a minimum timeout of 90,000 ms. The page waits for local images, `document.fonts.ready`, two animation frames, and stable slide geometry before measurement.

## Viewports

Every slide is activated and captured at:

- `standard`: 1280×720;
- `desktop`: 1440×900;
- `mobile`: 390×844.

The standard viewport is the canonical component geometry for the optional presentation-package protocol. Preview paths are `preview/<viewport>/slide-NNN.png`.

## Blocking checks

The report blocks:

- page or deck horizontal scrolling;
- text scroll overflow, clipping, canvas escape, or hidden required content;
- unapproved top-level module overlap;
- missing, zero-size, stretched, or invalidly cropped images;
- fonts not ready;
- low contrast for visible text;
- duplicate component IDs;
- detached, reversed, unmarked, or node-crossing connectors;
- keyboard navigation or direct page-jump failure;
- print mode that hides a slide, changes its canonical size, shows notes/controls, or omits page breaks.

Intentional overlap is pair-scoped with `data-allow-overlap-with`. It never exempts clipping, bounds, text fit, or connector errors.

## Bounded regeneration

The pipeline performs one initial build and at most two repair rebuilds. It records every attempt. Repair levels only:

1. tighten non-semantic gaps and padding;
2. tighten again and reduce typography to documented floors.

Scripts never change claims, sources, slide count, hierarchy, layout type, or meaning. Non-repairable errors fail immediately. If the final attempt still fails, the process exits with `E_QA_FAILED`, writes a failed report, and leaves `presentation-package.json.validation.status` as `failed`.

## Manual acceptance

Automated success is necessary, not sufficient. Inspect every standard and mobile preview at full size for hierarchy, rhythm, page-to-page consistency, meaningful whitespace, useful visuals, and source-label legibility. Record a Host rejection by keeping the package out of delivery; do not edit the QA report to manufacture a pass.
