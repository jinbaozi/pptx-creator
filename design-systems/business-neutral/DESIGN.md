---
version: alpha
name: Business Neutral
description: A clean neutral business presentation design system for editable PPTX generation.
colors:
  primary: "#2563EB"
  secondary: "#475569"
  accent: "#0EA5E9"
  background: "#FFFFFF"
  surface: "#F8FAFC"
  surfaceAlt: "#EFF6FF"
  text: "#111827"
  textMuted: "#64748B"
  border: "#E2E8F0"
  success: "#16A34A"
  warning: "#F59E0B"
  danger: "#DC2626"
typography:
  title:
    fontFamily: "Microsoft YaHei"
    fontSize: 32
    fontWeight: 700
    lineHeight: 1.18
  subtitle:
    fontFamily: "Microsoft YaHei"
    fontSize: 20
    fontWeight: 500
    lineHeight: 1.35
  heading:
    fontFamily: "Microsoft YaHei"
    fontSize: 22
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "Microsoft YaHei"
    fontSize: 15
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "Microsoft YaHei"
    fontSize: 11
    fontWeight: 400
    lineHeight: 1.35
  metric:
    fontFamily: "Arial"
    fontSize: 42
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 36
rounded:
  sm: 4
  md: 8
  lg: 14
  xl: 20
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: 20
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: 16
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xl}"
    padding: 8
---

# Business Neutral

## Overview

Business Neutral is a clean, neutral modern presentation design system for enterprise briefings, product summaries, technical proposals, and roadshow decks. It prioritizes clarity, hierarchy, and editable PowerPoint objects.

## Colors

Use white and light blue surfaces as the foundation. Use primary blue for emphasis, section titles, badges, table headers, and key lines. Do not introduce random gradients or decorative color accents unless the user explicitly asks for a more expressive style.

## Typography

Use Microsoft YaHei for Chinese business decks and Arial for large metrics. Keep slide titles large and concise. Body copy should remain readable and should not drop below 11pt.

## Layout

Use generous whitespace around the page edges. Group related content into cards. Align cards to consistent grids. Avoid dense paragraphs inside small containers.

## Elevation & Depth

Use light borders and subtle filled surfaces instead of heavy shadows. Keep the presentation easy to print and easy to edit.

## Shapes

Prefer native PowerPoint rounded rectangles, lines, arrows, and circles. Keep corners moderate and consistent.

## Components

Use hero cards for major messages, content cards for grouped points, badges for short labels, and native tables when data has rows and columns.

## Presentation Patterns

### Cover Slide

Use a large title, a concise subtitle, and one supporting visual block. Avoid dense paragraphs on the cover.

### Four-card Overview

Use four equal cards in a 2x2 grid. Each card should contain one heading, one short paragraph, and optionally one badge.

### Metrics Slide

Use 3-5 metric cards. Each metric should have one large number, a short label, and one explanatory sentence.

### Architecture Slide

Use clear grouping, simple connectors, and left-to-right or top-to-bottom flow. Avoid decorative arrows that do not carry meaning.

### Roadmap Slide

Use a horizontal timeline for quarterly plans and a vertical timeline for process phases.

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

For business presentations, target Level 4 or above. For screenshot recreation, target Level 3 or above. For complex posters or marketing visuals, Level 2 or Level 3 is acceptable if reported clearly.

## Do's and Don'ts

### Do

- Use generous whitespace around major sections.
- Keep each slide focused on one central message.
- Use the primary color for emphasis, not decoration.
- Use cards to group related content.
- Use consistent spacing between cards.
- Use native text boxes for all generated copy.

### Don't

- Do not use more than three font sizes on a single slide.
- Do not place dense paragraphs inside small cards.
- Do not use low-contrast text.
- Do not use random gradients or decorative icons outside the design system.
- Do not rasterize text unless unavoidable.
- Do not create full-slide screenshots as PPT pages by default.
