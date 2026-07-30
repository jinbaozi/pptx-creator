# Testing

## Test layers

| Command | Coverage |
|---|---|
| `npm run test:unit` | Input resolution, unit conversion helpers, contract validation, full-slide raster prohibition, and error behavior |
| `npm run test:browser` | Real Chromium stabilization, desktop/mobile layout audit, screenshots, and browser measurement |
| `npm run test:visual` | Full minimal HTML-to-PPTX transaction, LibreOffice render-back, visual comparison, editability, and reports |
| `npm run test:isolation` | Copy this Skill alone to a fresh directory, install only its declared dependencies, and complete the minimal conversion without sibling Skills |
| `npm run example:min` | One-slide editable text/shape/notes delivery |
| `npm run example:complex` | Native text, shapes, table, chart, connectors, notes, and one declared local fallback |

`npm test` runs the default suite. Browser, visual, and isolation tests are
opt-in so unit-only environments do not silently claim browser evidence.

## Required assertions

Tests must verify more than process exit:

- `qa-report.json` is passed;
- expected slide count equals preview count;
- layout and PPTX geometry critical counts are zero;
- visual comparison passes;
- editability level is at least 3;
- native coverage is at least 0.90;
- full-slide raster count is zero;
- fallback count and reason are correct for the complex fixture;
- protocol input and output validate against the same 1.0.0 schema;
- speaker notes exist in PPTX OOXML;
- isolated source contains no sibling imports or runtime references.

## Fixture truth

All numbers in the example decks are synthetic regression values. They are
explicitly labeled as examples and must not be presented as external facts.

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
