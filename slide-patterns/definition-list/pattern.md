# definition-list

A two-column "term : definition" pattern used for FAQ answers, glossary entries, and any content where one side names a concept and the other side explains it. Composes the [`quote`](../quote/) visual archetype (left column = term pulled out as a quote-style callout) and the [`two-column`](../two-column/) visual archetype (right column = definition body).

## Worked example

Slide index 7 of the "Product FAQ" deck (8-slide deck):

- Left column uses the `quote` archetype slots (`quote`, `attribution`) to render the term "Single sign-on" as a 32pt pull-quote, with `attributionRole` reading "Glossary term" as a caption-styled attribution.
- Right column uses the `two-column` archetype slots (`leftHeading`, `leftColumn`) — here repurposed as a single column of definition body — to render the explanation as 4 supporting bullets.

The two archetypes are merged at the layout level: the slide's `type` is `definition-list`, but its `archetypes` array cites both `quote` and `two-column` so the resolver loads each schema for validation.

## Visual archetypes used (in order)

1. `quote` — term in the left column, styled as a pull-quote with a small caption-style attribution.
2. `two-column` — definition body in the right column, treated as a single-column list.

## Content slot table

| Slot                 | Source archetype | Required | Floor / cap                  | Notes                                                          |
| -------------------- | ---------------- | -------- | ---------------------------- | -------------------------------------------------------------- |
| `title`              | two-column       | yes      | `fontSize >= 26pt`, max 8 words | Title describes the FAQ topic, not the whole deck.             |
| `quote`              | quote            | yes      | `fontSize >= 32pt`, max 240 chars | Term rendered as a pull-quote on the left.                     |
| `attribution`        | quote            | no       | `fontSize >= 14pt`           | Glossary section name (e.g., "Security", "Billing").            |
| `attributionRole`    | quote            | no       | `fontSize >= 11pt`           | Always reads "Glossary term" unless explicitly overridden.       |
| `leftColumn`         | two-column       | yes      | `fontSize >= 13pt`, min 2 items | Definition body as a bullet list (or short paragraph).         |
| `leftHeading`        | two-column       | no       | `fontSize >= 16pt`           | Optional sub-label above the definition (e.g., "In short").      |
| `footnote`           | two-column       | no       | `fontSize >= 11pt`           | Source link or doc reference for the term.                       |

## Anti-patterns

- **Don't stack multiple terms on one slide.** Two-column refuses triples; if you have three terms, make three slides.
- **Don't use the quote archetype's slot for the *answer*.** The quote slot is for the *term*, not the explanation — keeping them visually distinct is what makes the pattern readable.
- **Don't bury the term inside a paragraph.** The term must be the first thing the eye lands on; if it isn't, switch to bullets-list or two-column instead.
