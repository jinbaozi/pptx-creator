---
version: alpha
name: Warm Editorial
description: A warm editorial design system for courses, whitepapers, and content-heavy presentation decks.
colors:
  primary: "#92400E"
  secondary: "#78716C"
  accent: "#C2410C"
  background: "#FFFBF3"
  surface: "#FFF7ED"
  surfaceAlt: "#FFEDD5"
  text: "#292524"
  textMuted: "#78716C"
  border: "#E7E5E4"
  success: "#15803D"
  warning: "#CA8A04"
  danger: "#B91C1C"
typography:
  title:
    fontFamily: "Georgia"
    fontSize: 34
    fontWeight: 700
    lineHeight: 1.2
  subtitle:
    fontFamily: "Georgia"
    fontSize: 20
    fontWeight: 400
    lineHeight: 1.4
  heading:
    fontFamily: "Microsoft YaHei"
    fontSize: 22
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Microsoft YaHei"
    fontSize: 16
    fontWeight: 400
    lineHeight: 1.65
  caption:
    fontFamily: "Microsoft YaHei"
    fontSize: 12
    fontWeight: 400
    lineHeight: 1.4
  metric:
    fontFamily: "Georgia"
    fontSize: 40
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 10
  md: 18
  lg: 28
  xl: 40
rounded:
  sm: 2
  md: 6
  lg: 10
  xl: 16
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: 24
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: 18
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.accent}"
    rounded: "{rounded.xl}"
    padding: 8
---

# Warm Editorial

## Overview

Warm Editorial is a paper-canvas design system for courses, whitepapers, research reports, and content-heavy decks. It favors editorial spacing, readable long-form layouts, and warm amber-brown accents over flashy decoration.

## Colors

Use warm cream and paper-toned surfaces as the foundation. Primary brown anchors headings and key labels. Accent orange highlights callouts and badges. Avoid cold blues and neon accents that break the editorial mood.

## Typography

Use Georgia for display titles and Microsoft YaHei for body copy. Favor generous line height for long paragraphs. Keep body text at 16pt or above for lecture readability.

## Layout

Use wide margins and column-like content blocks. Let text breathe with editorial spacing between sections. Prefer single-column narrative flows over dense grids.

## Elevation & Depth

Use thin borders and soft surface fills instead of drop shadows. The deck should feel like a printed report, not a glossy app UI.

## Shapes

Prefer simple rectangles with modest rounding, horizontal dividers, and understated lines. Avoid glossy 3D effects.

## Components

Use hero cards for chapter openers, content cards for grouped insights, badges for section labels, and native tables for structured data.

## Presentation Patterns

### Cover Slide

Use a serif title, a warm subtitle band, and a single editorial hero block. Leave generous top and bottom margins like a book cover.

### Four-card Overview

Arrange four cards in a 2x2 grid with equal height. Each card carries one heading, two to three sentences, and an optional accent badge.

### Metrics Slide

Present 3-4 key figures with large serif numbers, short labels, and one supporting sentence each. Keep metrics sparse and meaningful.

### Architecture or Method Slide

Use left-to-right flow with labeled groups and thin connectors. Favor method diagrams over decorative tech illustrations.

### Comparison Slide

Use a two-column or table layout with clear headers. Highlight differences with accent color, not background noise.

### Timeline or Process Slide

Use a horizontal timeline with warm accent markers for phases. Vertical stacks work for step-by-step methodology.

## PPTX Export Rules

- All visible titles must be exported as native PowerPoint text boxes.
- Body text must be exported as native PowerPoint text boxes unless the source is an unreadable raster image.
- Simple rectangles, rounded rectangles, circles, dividers, and arrows must be exported as native PowerPoint shapes.
- Tables must be exported as native PowerPoint tables whenever the cell structure is clear.
- Charts should be exported as native charts when data is available. If only a screenshot is available, use an image asset and mark it in the editable report.
- Complex illustrations, photos, shadows, decorative textures, and noisy backgrounds may be exported as image assets.
- Full-slide raster fallback is only allowed when visual fidelity is explicitly more important than editability.

## Editability Rules

Default target: Level 4.

Level 5 means all major objects are native PowerPoint objects.
Level 4 means all text and main shapes are editable, while complex decorative assets may be rasterized.
Level 3 means text is editable, but many visual objects are rasterized.
Level 2 means only key text and a few shapes are editable.
Level 1 means full-slide raster fallback.

For editorial presentations, target Level 4 or above. For screenshot recreation, target Level 3 or above.

## Do's and Don'ts

### Do

- Use warm paper backgrounds and generous whitespace.
- Keep paragraphs readable with editorial line height.
- Use accent orange sparingly for emphasis.
- Group long content into clearly labeled sections.
- Use native text boxes for all generated copy.

### Don't

- Do not use dark backgrounds or high-contrast cyber palettes.
- Do not cram dense paragraphs into small cards.
- Do not use more than three font sizes per slide.
- Do not rasterize text unless unavoidable.
- Do not add decorative stock imagery by default.
- Do not create full-slide screenshots as PPT pages by default.
