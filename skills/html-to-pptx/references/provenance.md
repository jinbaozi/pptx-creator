# Provenance and license

## Internal implementation origin

This independent Skill was split from the repository's real HTML-first
conversion implementation on:

- source branch: `creative-director-pipeline`;
- recorded base commit:
  `2b4b0e0382fbdd88fae390669f6adbb5da59391d`;
- target refactor branch: `V2.0`.

The following capabilities were copied and adapted into this Skill boundary:

- secured Playwright layout measurement and screenshots;
- HTML/CSS to native manifest compilation;
- PptxGenJS object rendering;
- font preflight and text fitting;
- layout safety and PPTX OOXML geometry audits;
- LibreOffice preview rendering and image comparison;
- chart, diagram, connector, and archetype helpers.

The V2.0 copy includes local corrections present in the working implementation,
including border-safe inset behavior, HTML measurement stability, speaker notes,
object naming, package-relative resource resolution, 90-second browser
timeouts, and replica-aware geometry checks.

## V2.0 additions

The independent boundary adds:

- one public `convert.mjs` transaction;
- plain HTML, directory, and protocol input resolution;
- strict shared presentation-package 1.0.0 validation;
- secure remote-image localization behind explicit authorization;
- native chart markers;
- localized raster fallback ledger and full-slide raster prohibition;
- editability/native-coverage gate;
- bounded repair plus render-back visual proof;
- self-contained dependencies, examples, tests, and isolated-copy validation.

No runtime import points outside this Skill directory. No sibling Skill is
invoked. Shared interoperability exists only through a copied, versioned public
schema and ordinary files.

## External references

No source code from the separately researched reference projects was copied into
this Skill. Their concepts were evaluated by the parent architecture work; this
implementation uses repository-owned code and newly written adapters/tests.

## License

This Skill is distributed under the included MIT `LICENSE`. Third-party npm and
Python packages retain their own licenses. User-provided HTML, fonts, images,
and localized fallback crops retain their original rights; the converter marks
derived local assets as user-provided and does not grant additional rights.
