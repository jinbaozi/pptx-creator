# Repair Patch Spec

Patch operations apply to `deck.manifest.json` elements.

Supported operations:

- move
- resize
- updateStyle
- updateText
- removeElement
- splitText
- splitSlide
- increaseSpacing
- reduceDensity
- replaceLayoutType

Constraints:

- Do not reduce editability.
- Do not violate the selected `DESIGN.md`.
- Do not use remote assets that are not localized.
- Do not beautify strict replicas.
- Stop after three repair attempts.
