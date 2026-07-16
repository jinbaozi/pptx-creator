# Creative intent and contextual taste

This is the first focused contract in the Creative Director Pipeline. The Host
turns source text into a communication task, narrative, Creative Direction, and
complete local `deck.html`; deterministic scripts validate and lower the frozen
HTML but never invent a narrative, visual thesis, asset, or claim. The former
coordinate-free `deck.plan.json` version `0.2.0` contract remains available only
through explicit `--native` compatibility mode.

## Host-owned intent

Before compilation, the Host records:

- audience, presentation environment, decision goal, duration, language, and
  evidence constraints;
- source and brand locks that generic taste heuristics may not override;
- narrative beats, memory anchors, slide roles, one-message-per-slide logic,
  and the intended decision path;
- a concise visual thesis through `designRead`, typography, palette, material,
  imagery, composition direction, and the three contextual taste dials;
- requested quality, editability, asset intensity, and visual ambition; and
- localized assets with rights and generation provenance.

The Host chooses a design system and may explicitly select a compatible
composition block. An explicit user-requested style, brand, template, or visual
reference is the highest-priority style lock. If the user supplies none, the
Host judges the direction from audience, content, delivery environment,
language, readability, and emotional tone. Built-ins are candidates rather
than defaults, and topic keywords never auto-select `dark-tech` or another
system. Scripts validate the Host choice; they do not rank design systems,
infer a block, search the web, or call an LLM.

## Context before generic style rules

Taste is evaluated against the audience, domain, language, source locks, and
brand system. The nine anti-slop rules are contextual signals with declared
applicability, evidence, severity, confidence, repair command, and bounded
exemptions. Approved brand fonts, brand gradients, component systems,
government templates, dashboards, editorial grids, literal content, and
verbatim quotations may justify specific exemptions. Readability and factual
integrity never receive an exemption.

Use the visual thesis to make the deck recognizable without decorating every
slide. Prefer contrast in scale, pacing, composition, and information density
over repeated card grids. Preserve source-defined claims and use explicit
evidence records instead of plausible-sounding filler.

## Editable HTML-first boundary

Default text work expresses composition in 1280x720 HTML/CSS and declares
module connectors with source, target, anchors, route, and a target-facing end
marker. After browser proof and bounded repair, the repaired HTML is the frozen
visual source; the generated manifest is render truth. Text, shapes, tables,
charts, and connectors must remain native PowerPoint objects. Remote runtime
assets and full-slide rasters are prohibited.

In explicit `--native` mode, each slide instead declares semantic content,
attention, composition intent, assets, and a native-first route policy in
`deck.plan.json`. Coordinates, manifest geometry, arbitrary `elements`, remote
runtime assets, and full-slide rasters are prohibited in the plan. The selected
Semantic Slide IR is authoring truth after normalization; the manifest is
render truth. See `references/semantic-slide-ir.md`.

Conditional direction probes, mandatory Host visual review, safe refinement,
and release benchmarking are separate later boundaries. The upstream ideas
adapted for this contract are documented, with pinned provenance and explicit
non-integration language, in `references/external-design-provenance.md`.
