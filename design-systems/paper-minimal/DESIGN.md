---
version: alpha
name: Paper Minimal
description: A paper-like academic design system for Chinese handouts and lecture decks.
colors:
  primary: "#1E3A5F"
  secondary: "#52606D"
  accent: "#A16207"
  background: "#F8F4EA"
  surface: "#FFFDF7"
  surfaceAlt: "#F0EBE3"
  text: "#1F2933"
  textMuted: "#52606D"
  border: "#D9D2C5"
  success: "#166534"
  warning: "#A16207"
  danger: "#991B1B"
typography:
  title:
    fontFamily: "SimSun"
    fontSize: 30
    fontWeight: 700
    lineHeight: 1.25
  subtitle:
    fontFamily: "Microsoft YaHei"
    fontSize: 18
    fontWeight: 400
    lineHeight: 1.4
  heading:
    fontFamily: "Microsoft YaHei"
    fontSize: 20
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Microsoft YaHei"
    fontSize: 15
    fontWeight: 400
    lineHeight: 1.6
  caption:
    fontFamily: "Microsoft YaHei"
    fontSize: 11
    fontWeight: 400
    lineHeight: 1.35
  metric:
    fontFamily: "Arial"
    fontSize: 36
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 8
  md: 14
  lg: 22
  xl: 32
rounded:
  sm: 2
  md: 4
  lg: 8
  xl: 12
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 18
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 14
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: 6
---

# Paper Minimal

## Overview

Paper Minimal is a restrained academic design system for Chinese handouts, lecture decks, and paper-like educational materials. It pairs ink-blue accents with calm serif/sans typography on a warm paper canvas.

## Colors

Use paper-toned backgrounds and off-white surfaces. Ink-blue primary anchors headings and structural elements. Muted gold accent marks highlights and footnotes. Avoid saturated neon or dark cyber palettes.

## Typography

Use SimSun for formal titles and Microsoft YaHei for body text. Keep layouts calm and print-friendly. Minimum body size is 15pt for classroom projection.

## Layout

Favor single-column and two-column academic layouts. Use consistent left alignment. Keep margins wide like printed handouts.

## Elevation & Depth

Use hairline borders and flat fills only. No shadows, glows, or gradients. The deck should feel like a photocopied lecture note.

## Shapes

Use simple rectangles with minimal rounding, thin dividers, and understated lines. Circles only for bullet markers or step numbers.

## Components

Use hero cards for chapter headers, content cards for key points, badges for section numbers, and native tables for structured comparisons.

## Presentation Patterns

### Cover Slide

Use a centered or left-aligned title with course metadata below. Keep decoration minimal—one thin rule line is enough.

### Four-card Overview

Place four equal cards in a 2x2 grid with thin borders. Each card has one heading and two short bullet points.

### Metrics Slide

Show 3-4 statistics with large numbers and brief captions. Avoid flashy metric styling.

### Architecture or Method Slide

Use a simple top-to-bottom or left-to-right flow with labeled boxes and thin arrows. Favor clarity over visual flair.

### Comparison Slide

Use a two-column layout or native table with ink-blue headers. Highlight differences with accent gold sparingly.

### Timeline or Process Slide

Use a horizontal timeline with numbered steps. Vertical lists work for procedural workflows.

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

For academic handouts, target Level 4 or above. For screenshot recreation, target Level 3 or above.

## Do's and Don'ts

### Do

- Use paper-like backgrounds and restrained ink-blue accents.
- Keep typography calm and print-friendly.
- Use thin borders instead of shadows.
- Group content into clearly labeled sections.
- Use native text boxes for all generated copy.

### Don't

- Do not use dark backgrounds or luminous effects.
- Do not add decorative gradients or glossy UI elements.
- Do not overcrowd slides with dense paragraphs.
- Do not rasterize text unless unavoidable.
- Do not mimic real university or publisher branding.
- Do not create full-slide screenshots as PPT pages by default.
