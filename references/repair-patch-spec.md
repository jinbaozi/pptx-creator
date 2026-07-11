# Repair Patch Spec

Patch operations apply to `deck.manifest.json` elements.

Supported operations:

- move
- resize
- updateStyle
- updateText
- removeElement
- increaseSpacing
- adjustStyle

Constraints:

- Do not reduce editability.
- Do not violate the selected `DESIGN.md`.
- Do not use remote assets that are not localized.
- Do not beautify strict replicas.
- `attempt` is required and must be an integer from 1 through 3.
- Validate the input manifest and patch before applying; validate the temporary output before publishing it.
- Text overflow produces a repair patch only when measurement supplies a concrete resize or readable font-size change. Content reflow remains a host-agent decision and blocks deterministic packaging.
