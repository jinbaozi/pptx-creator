# Optional presentation-package protocol

Version `1.0.0` identifies `pptx-creator.presentation-package`. This Skill emits `kind: html-presentation`, producer `text-to-html`, `entrypoint: index.html`, a 1280×720 deck, ordered stable slide IDs, source-bound component geometry, assets, validation reports, degradations, and supported feature flags.

The canonical schema is bundled at `schemas/presentation-package.schema.json`; validation is implemented locally by `scripts/validate-presentation-package.mjs`. This is an optional versioned handoff, not a Codex manifest and not a dependency on `html-to-pptx` or `image-to-pptx`.

Consumers must:

- reject an unsupported `protocol` or `version` with `E_PROTOCOL_ID` or `E_PROTOCOL_VERSION`;
- resolve every path below the package directory;
- preserve slide order, IDs, dimensions, notes, sources, assets, z-order, and `editableIntent`;
- treat `validation.status !== "passed"` as unaccepted input;
- honor `degradations` and never silently claim lost editability;
- ignore unknown `extensions` only when the major/minor protocol version remains supported.

The source plan remains the content authority; computed browser geometry in the protocol is the rendered HTML authority.
