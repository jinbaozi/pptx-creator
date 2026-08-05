# Testing

## Test layers

| Command | Coverage |
|---|---|
| `npm run test:unit` | Input resolution, unit conversion helpers, contract validation, full-slide raster prohibition, and error behavior |
| `npm run test:browser` | Real Chromium stabilization, desktop/mobile layout audit, screenshots, and browser measurement |
| `npm run test:visual` | Full minimal HTML-to-PPTX transaction, LibreOffice render-back, visual comparison, editability, and reports |
| `PLAYWRIGHT_RUN=1 npx vitest run tests/visual.test.mjs -t "strict replica"` | Synthetic Chromium + LibreOffice `replica-strict` profile, component crop/diff, and strict thresholds |
| `npm run test:isolation` | Copy this Skill alone to a fresh directory, install only its declared dependencies, and complete the minimal conversion without sibling Skills |
| `npm run example:min` | One-slide editable text/shape/notes delivery |
| `npm run example:complex` | Native text, shapes, table, chart, connectors, notes, and one declared local fallback |

`npm test` runs the default suite. Browser, visual, and isolation tests are
opt-in so unit-only environments do not silently claim browser evidence.

## Required assertions

Tests must verify more than process exit:

- `qa-report.json` is passed;
- `structure-fidelity-report.json` is passed, has zero critical findings, and
  binds the published manifest and PPTX hashes;
- expected slide count equals preview count;
- layout and PPTX geometry critical counts are zero;
- visual comparison passes;
- `visual-comparison.json` is version `2.0.0` and records exact image sizes,
  SSIM, normalized MAE, and deterministic diff paths;
- editability level is at least 3;
- `nativeObjectCoverage` is at least 0.90; `nativeCoverage` is equal only as a
  deprecated compatibility alias;
- semantic coverage evidence includes per-page classification, clipped area,
  weight, z-order, and visible contribution; the semantic threshold is null in
  the default profile;
- strict fixtures include an explicit key marker and assert component IDs,
  exact clipped boxes, diff files, `components/summary.json`, SSIM >= 0.94,
  and normalized MAE <= 0.05. A local component failure must fail the
  comparator even when the whole slide passes;
- full-slide raster count is zero;
- fallback count and reason are correct for the complex fixture;
- protocol input and output validate against the same 1.0.0 schema;
- speaker notes exist in PPTX OOXML;
- isolated source contains no sibling imports or runtime references.

Focused fidelity tests should also prove the editable structure, not only a
successful conversion:

- pseudo elements use generated `<owner>-before`/`<owner>-after` IDs for the
  safe allowlist and a bounded pseudo-only crop for unsupported effects;
- layered backgrounds retain multiple gradient stops, alpha, a non-centred
  radial glow, border/shadow layers, and CSS paint order in OOXML;
- SVG Tier A/B/C routing preserves stable group/child lineage and native
  connector shape types, while Tier-C filled/curved or unsafe SVGs do not turn
  into a full-slide raster.
- semantic SVG classifications come from explicit DOM/measurement/manifest
  metadata; tests cover decorative, text-bearing, chart, and architecture
  weights plus group child exclusion.

## Fixture truth

All numbers in the example decks are synthetic regression values. They are
explicitly labeled as examples and must not be presented as external facts.
The strict visual fixture is synthetic and proves Chromium/LibreOffice
conversion gates only; it makes no claim about any external rendering service
or model.

The complex example intentionally uses a bounded `clip-path` effect to prove
the fallback ledger. It should produce one local crop while leaving the rest of
the deck native.

## Isolation procedure

The isolation test:

1. copies only this Skill to a temporary directory;
2. rejects any source reference to sibling Skill paths;
3. runs `npm ci` from the copied `package-lock.json`;
4. invokes the copied `scripts/convert.mjs`;
5. validates the copied output reports and final PPTX.

Because it installs declared packages and launches Chromium, this test requires
network/package-cache access and an installed Playwright Chromium binary. It
must not resolve code from the repository root.
