# image-feature

A two-column pattern where one column holds an image and the other holds explanatory text. Composes the [`two-column`](../two-column/) visual archetype (with one column repurposed for an image) plus an implicit image element. Used for product screenshots, photos with captions, and any "show + tell" beat.

## Worked example

Slide index 3 of the "Onboarding Redesign" deck (10-slide deck), titled "The new home screen":

- Left column (60% width) holds a product screenshot. The image is a native PPTX image element with id `featureImage`, sized to fit the column, with a thin 1px border in `{colors.muted}` and rounded corners (4px radius).
- Right column (40% width) uses the two-column archetype's `rightHeading` and `rightColumn` slots to render the heading "What's new" and three short bullets explaining the screenshot.

The slide's `type` is `image-feature`, but its `archetypes` array cites `two-column` once (the pattern is a composition, not a new archetype). The image element is a regular manifest image, not a new archetype slot.

## Visual archetypes used (in order)

1. `two-column` — provides the column grid, headings, and bullet body. One of the two columns is replaced by an image element.

## Content slot table

| Slot           | Source archetype | Required | Floor / cap                                | Notes                                                            |
| -------------- | ---------------- | -------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `title`        | two-column       | yes      | `fontSize >= 26pt`, max 8 words            | Title describes the feature, not the deck.                        |
| `featureImage` | (manifest image) | yes      | width `>= 4in`, height `>= 3in`            | Native PPTX image element; `src` must be localized under `output/assets/` before render. |
| `imageCaption` | (manifest text)  | no       | `fontSize >= 10pt`, max 120 chars          | Optional small caption beneath the image.                          |
| `leftHeading` or `rightHeading` | two-column | yes      | `fontSize >= 16pt`                         | Heading on the text column.                                       |
| `leftColumn` or `rightColumn`  | two-column | yes      | `fontSize >= 13pt`, min 2 items, max 6     | Text column rendered as a bullet list or short paragraph.          |
| `footnote`     | two-column       | no       | `fontSize >= 11pt`                         | Optional source line below the text column.                        |

## Anti-patterns

- **Don't use a full-bleed screenshot.** If the image fills the slide, you don't have an image-feature slide — you have a screenshot slide. Use the screenshot as background and overlay a single text element instead, or pick a different pattern.
- **Don't decouple the image from the text.** The image must illustrate the heading; if the image and text could be reordered without losing meaning, the pattern isn't right.
- **Don't use stock photos.** Decorative imagery (laptop on a desk, person pointing at a screen) signals AI slop. Use real screenshots, real diagrams, or omit the image entirely.
